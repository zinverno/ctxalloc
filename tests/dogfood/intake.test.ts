import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { NodeFileSourceReader, MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import {
  parseSettings,
  parseAnnotations,
  operating,
  requireHuman,
} from '../../benchmarks/dogfood/schema.js';
import { prepare, mapEvidence, worksheet, writeLocal } from '../../benchmarks/dogfood/prepare.js';
import { runDogfood } from '../../benchmarks/dogfood/commands.js';
import { toy } from './fixtures.js';

const tokenizer = new O200kBaseTokenizer();
const roots: string[] = [];
async function fixture() {
  const f = await toy(tokenizer);
  roots.push(f.root);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Phase 22B human intake and source preparation', () => {
  it('keeps production operating decisions unset in the blank template', () => {
    const settings = parseSettings(
      JSON.parse(readFileSync('benchmarks/dogfood/templates/settings.json', 'utf8')),
    );
    expect(() => operating(settings)).toThrow('operating_decisions_required');
    expect(settings.availableTokens).toBeNull();
    expect(settings.maxCandidates).toBeNull();
    expect(settings.scope).toBeNull();
  });
  it('rejects runtime-policy fields in evaluator annotations', async () => {
    const f = await fixture();
    expect(() => parseAnnotations({ ...f.annotations, priorities: {} })).toThrow('invalid_fields');
    expect(() =>
      parseAnnotations({
        ...f.annotations,
        tasks: [{ ...f.annotations.tasks[0], required: true }],
      }),
    ).toThrow('invalid_fields');
    expect(() => requireHuman(f.tasks, f.annotations)).toThrow('human_data_checkpoint');
  });
  it('rejects a conversation origin relabeled as plain text', async () => {
    const f = await fixture();
    expect(() =>
      parseSettings({
        ...f.settings,
        sources: [{ ...f.settings.sources[0], origin: 'conversation-history' }],
      }),
    ).toThrow('inconsistent_source_origin');
  });
  it('INV-PROV-005: exercises all three actual reader/chunker owners and exact locations', async () => {
    const f = await fixture(),
      review = worksheet(f.prepared);
    expect(new Set(review.blocks.map((b) => b.sourceType))).toEqual(
      new Set(['markdown', 'text', 'conversation']),
    );
    expect(review.blocks.filter((b) => b.sourceType === 'conversation')).toHaveLength(2);
    expect(f.prepared.sources.find((s) => s.id === 'history')!.logicalContentHash).not.toBe(
      `sha256:${f.prepared.sources.find((s) => s.id === 'history')!.rawSha256}`,
    );
    expect(
      mapEvidence(f.annotations.tasks[0]!, f.prepared).every(
        (e) => e.sourceAvailable && e.blockIds.length,
      ),
    ).toBe(true);
    expect(JSON.stringify(review)).not.toMatch(/"(?:score|rank|compiledContext|retrieval)":/);
  });
  it('reconciles a span across multiple prepared chunks without dropping carriers', async () => {
    const f = await fixture(),
      raw = f.content.text;
    const a = {
      ...f.annotations.tasks[0]!,
      useful: [
        {
          id: 'span',
          sourceId: 'note',
          location: {
            kind: 'text-range' as const,
            startOffset: 0,
            endOffset: raw.trimEnd().length,
          },
          quote: raw.trimEnd(),
        },
      ],
      facts: [],
      irrelevantBlockIds: [],
    };
    const mapped = mapEvidence(a, f.prepared);
    expect(mapped[0]!.blockIds.length).toBeGreaterThan(0);
    const incomplete = {
      ...f.prepared,
      corpus: {
        ...f.prepared.corpus,
        blocks: f.prepared.corpus.blocks.filter((b) => b.sourceType !== 'text'),
      },
    };
    expect(mapEvidence(a, incomplete)[0]).toMatchObject({ sourceAvailable: true, blockIds: [] });
  });
  it('retains declared missing sources and refuses mismatched source quotations', async () => {
    const f = await fixture();
    const settings = parseSettings({
      ...f.settings,
      sources: [
        ...f.settings.sources,
        {
          id: 'missing',
          locator: null,
          sourceType: 'text',
          origin: 'developer-reference',
          language: 'en',
          available: false,
        },
      ],
    });
    const p = await prepare(settings, f.base, tokenizer, f.root);
    const a = {
      ...f.annotations.tasks[0]!,
      useful: [{ id: 'missing-unit', sourceId: 'missing', location: null, quote: null }],
      facts: [],
    };
    expect(mapEvidence(a, p)).toEqual([
      { id: 'missing-unit', sourceAvailable: false, blockIds: [] },
    ]);
    const altered = structuredClone(f.annotations.tasks[0]!);
    altered.useful[0]!.quote = 'wrong quotation';
    expect(() => mapEvidence(altered, p)).toThrow('annotation_source_mismatch');
  });
  it('rejects orphan and contradictory negative block judgments', async () => {
    const f = await fixture();
    for (const id of ['unknown-block', f.prepared.corpus.blocks[0]!.id])
      expect(() =>
        mapEvidence({ ...f.annotations.tasks[0]!, irrelevantBlockIds: [id] }, f.prepared),
      ).toThrow('invalid_negative_judgment');
  });
  it('status and human-checkpoint failure run neither source reads nor retrieval', async () => {
    const f = await fixture(),
      reader = vi.spyOn(NodeFileSourceReader.prototype, 'read'),
      provider = vi.spyOn(MiniSearchCandidateProvider.prototype, 'getCandidates');
    expect((await runDogfood(['status'], f.root)).report.status).toBe('READY_FOR_HUMAN_DATA');
    const result = await runDogfood(
      [
        'freeze',
        '--local',
        f.paths.settings,
        '--tasks',
        f.paths.tasks,
        '--annotations',
        f.paths.annotations,
        '--out',
        join(f.base, 'freeze.json'),
      ],
      f.root,
    );
    expect(result.report.status).toBe('READY_FOR_HUMAN_DATA');
    expect(result.exitCode).toBe(2);
    expect(reader).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it('writes a local score-free worksheet without invoking the provider', async () => {
    const f = await fixture(),
      provider = vi.spyOn(MiniSearchCandidateProvider.prototype, 'getCandidates'),
      out = join(f.base, 'review.json');
    const result = await runDogfood(['prepare', '--local', f.paths.settings, '--out', out], f.root);
    expect(result.exitCode).toBe(0);
    expect(provider).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(out, 'utf8')).purpose).toBe('LOCAL_HUMAN_REVIEW_NO_RETRIEVAL');
    expect(() => writeLocal(out, {}, f.root)).toThrow();
  });
  it('INV-SEC-001: rejects source symlink escapes and emits only bounded errors', async () => {
    const f = await fixture(),
      secret = 'PRIVATE_CANARY_22B_DO_NOT_PUBLISH';
    const outside = join(f.base, 'private.txt');
    writeFileSync(outside, secret);
    symlinkSync(outside, join(f.snapshot, 'escape.txt'));
    const settings = {
      ...f.settings,
      sources: [{ ...f.settings.sources[1], locator: 'escape.txt' }],
    };
    writeFileSync(f.paths.settings, JSON.stringify(settings));
    const result = await runDogfood(
      ['prepare', '--local', f.paths.settings, '--out', join(f.base, 'review.json')],
      f.root,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(f.root);
  });
  it('INV-SEC-001: rejects output parent symlink escapes and invalid local JSON fields', async () => {
    const f = await fixture();
    symlinkSync('/tmp', join(f.base, 'escape'));
    expect(() => writeLocal(join(f.base, 'escape', 'no-write.json'), {}, f.root)).toThrow(
      'local_boundary',
    );
    writeFileSync(f.paths.settings, '{"secret":"PRIVATE_CANARY_INVALID_JSON"}');
    const result = await runDogfood(
      ['prepare', '--local', f.paths.settings, '--out', join(f.base, 'review.json')],
      f.root,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });
});

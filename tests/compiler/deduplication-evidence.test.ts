import { CandidateDeduplicator, CandidateValidator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import type { ContextBlock } from '../../packages/domain/src/index.js';
import {
  candidate,
  input,
  sourceDocument,
  validate,
  wordTokenizer,
} from './deduplication-fixtures.js';

const deduplicator = new CandidateDeduplicator();

const SHARED = 'the migration runs before the deploy';

const BATCH = {
  sourceDocuments: [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })],
  candidates: [
    candidate(
      {
        id: 'block-a',
        sourceDocumentId: 'doc-1',
        content: SHARED,
        headingPath: ['Runbook', 'Deploy'],
        metadata: { origin: 'inbox', tags: ['ops'] },
      },
      { providerId: 'fts', providerVersion: '1', rank: 2 },
    ),
    candidate(
      {
        id: 'block-a',
        sourceDocumentId: 'doc-1',
        content: SHARED,
        headingPath: ['Runbook', 'Deploy'],
        metadata: { origin: 'inbox', tags: ['ops'] },
      },
      {
        providerId: 'vec',
        providerVersion: '2',
        score: { value: -0.4, semantics: 'distance', higherIsBetter: false },
      },
    ),
    candidate({
      id: 'block-z',
      sourceDocumentId: 'doc-2',
      content: SHARED,
      headingPath: ['Decisions'],
      attributes: { required: true },
      metadata: { origin: 'adr' },
    }),
    candidate({ id: 'block-q', sourceDocumentId: 'doc-2', content: 'an unrelated paragraph' }),
  ],
} as const;

describe('INV-DEDUP-003: deduplication preserves every piece of evidence', () => {
  const validated = validate(BATCH);
  const result = deduplicator.deduplicate(validated);
  const members = result.candidates.flatMap((group) => group.members);

  it('INV-TRACE-001: every input wrapper appears exactly once across all members', () => {
    expect(members).toHaveLength(validated.candidates.length);

    const seen = members.map((member) => member.candidate);
    for (const wrapper of validated.candidates) {
      expect(seen.filter((entry) => entry === wrapper)).toHaveLength(1);
    }
  });

  it('places each wrapper in exactly one group', () => {
    const groupsHolding = validated.candidates.map(
      (wrapper) =>
        result.candidates.filter((group) =>
          group.members.some((member) => member.candidate === wrapper),
        ).length,
    );
    expect(groupsHolding).toEqual([1, 1, 1, 1]);
  });

  it('INV-PROV-002: keeps every duplicate source reference recoverable', () => {
    const duplicateGroup = result.candidates.find((group) => group.members.length > 1);
    const sourceIds = (duplicateGroup?.members ?? []).map(
      (member) => member.candidate.block.sourceDocumentId,
    );
    expect(new Set(sourceIds)).toEqual(new Set(['doc-1', 'doc-2']));
  });

  it('INV-PROV-002: keeps source locations, heading paths, and metadata recoverable', () => {
    const duplicateGroup = result.candidates.find((group) => group.members.length > 1);
    const blockWithId = (id: string): ContextBlock | undefined =>
      (duplicateGroup?.members ?? []).find((member) => member.candidate.block.id === id)?.candidate
        .block;

    expect(blockWithId('block-a')?.headingPath).toEqual(['Runbook', 'Deploy']);
    expect(blockWithId('block-a')?.metadata).toEqual({ origin: 'inbox', tags: ['ops'] });
    expect(blockWithId('block-a')?.sourceLocation).toEqual({
      kind: 'text-range',
      startOffset: 0,
      endOffset: SHARED.length,
    });
    expect(blockWithId('block-z')?.headingPath).toEqual(['Decisions']);
    expect(blockWithId('block-z')?.metadata).toEqual({ origin: 'adr' });
  });

  it('keeps every duplicate block identifier recoverable', () => {
    const duplicateGroup = result.candidates.find((group) => group.members.length > 1);
    const duplicateIds = (duplicateGroup?.members ?? [])
      .map((member) => member.candidate.block.id)
      .filter((id) => id !== duplicateGroup?.canonicalBlock.id);
    expect(new Set(duplicateIds)).toEqual(new Set(['block-a']));
  });

  it('INV-TRACE-002: states an explicit selection reason and an explicit match reason', () => {
    for (const group of result.candidates) {
      expect([
        'single-block',
        'required-block',
        'required-then-stable-block-id',
        'stable-block-id',
      ]).toContain(group.canonicalSelectionReason);
      for (const member of group.members) {
        expect(['same-block-id', 'same-normalized-content']).toContain(member.matchReason);
      }
    }
  });

  it('gives the required duplicate group a required canonical block', () => {
    const duplicateGroup = result.candidates.find((group) => group.members.length > 1);
    expect(duplicateGroup?.canonicalBlock.id).toBe('block-z');
    expect(duplicateGroup?.canonicalSelectionReason).toBe('required-block');
    expect(duplicateGroup?.canonicalBlock.attributes.required).toBe(true);
  });

  it('INV-ADAPTER-001: exposes arrays, not mutable collections', () => {
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(Array.isArray(result.sourceDocuments)).toBe(true);
    expect(Array.isArray(result.candidates[0]?.members)).toBe(true);
    expect(result.candidates).not.toBeInstanceOf(Map);
    expect(result.candidates).not.toBeInstanceOf(Set);
  });
});

describe('Phase 7 regression: validation and deduplication stay separate stages', () => {
  it('CandidateValidator still does not deduplicate', () => {
    const validated = new CandidateValidator(wordTokenizer).validate(
      input({ candidates: [candidate(), candidate(), candidate()] }),
    );
    expect(validated.candidates).toHaveLength(3);
  });

  it('CandidateValidator still preserves duplicate wrappers in input order', () => {
    const validated = new CandidateValidator(wordTokenizer).validate(
      input({
        candidates: [
          candidate({ id: 'block-z', content: SHARED }),
          candidate({ id: 'block-a', content: SHARED }),
        ],
      }),
    );
    expect(validated.candidates.map((entry) => entry.block.id)).toEqual(['block-z', 'block-a']);
  });

  it('CandidateValidator still rejects one block ID attached to different records', () => {
    expect(() =>
      new CandidateValidator(wordTokenizer).validate(
        input({
          candidates: [
            candidate({ id: 'block-1', content: 'one' }),
            candidate({ id: 'block-1', content: 'two' }),
          ],
        }),
      ),
    ).toThrow(/conflicting|different canonical/i);
  });
});

import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '@ctxalloc/compiler';
import type { CandidateBlock } from '@ctxalloc/domain';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import {
  prepareDocument,
  SCOPE,
  REFERENCE_TIME,
} from '../../benchmarks/retrieval-calibration/data.js';
import { NATIVE } from '../../benchmarks/retrieval-calibration/observe.js';
import {
  mapNative,
  PROFILE,
  profilePolicy,
  retrieveForProfile,
} from '../../benchmarks/retrieval-calibration/profile.js';

const tokenizer = new O200kBaseTokenizer();
// Algorithm contract fixtures only; no usefulness annotations and no calibration claims.
const doc = prepareDocument(
  {
    id: 'contract',
    sourceType: 'text',
    blocks: [
      { id: 'a', content: 'alpha' },
      { id: 'b', content: 'alpha beta' },
    ],
  },
  tokenizer,
);
const native = (): CandidateBlock[] =>
  doc.blocks.map((block, rank) => ({
    schemaVersion: 1,
    block,
    retrieval: {
      providerId: NATIVE.providerId,
      providerVersion: NATIVE.providerVersion,
      rank,
      score: {
        value: rank === 0 ? 999999 : 0.000001,
        semantics: NATIVE.semantics,
        higherIsBetter: true,
      },
    },
  }));

describe('Phase 22A provider profile boundary', () => {
  it('preserves blocks and separates reciprocal rank from native score semantics', () => {
    const raw = native(),
      mapped = mapNative(raw);
    expect(mapped.map((c) => c.retrieval!.score!.value)).toEqual([1, 0.5]);
    expect(mapped[1]!.block).toBe(raw[1]!.block);
    expect(raw[1]!.retrieval!.score!.value).toBe(0.000001);
    expect(mapped[0]!.retrieval!.providerId).not.toBe(NATIVE.providerId);
  });
  it('is invariant to wrapper arrival order', () => {
    expect(mapNative([...native()].reverse())).toEqual(mapNative(native()));
  });
  it('admits an empty retrieved batch', () => expect(mapNative([])).toEqual([]));
  it.each([
    'provider',
    'version',
    'semantics',
    'direction',
    'missing-rank',
    'gap',
    'nonfinite',
    'nonpositive',
    'reversed-score',
    'duplicate',
  ] as const)('rejects unsupported evidence: %s', (kind) => {
    const raw = native();
    if (kind === 'duplicate') raw.push(raw[0]!);
    else {
      const r = raw[0]!.retrieval!;
      raw[0] = {
        ...raw[0]!,
        retrieval: {
          ...r,
          ...(kind === 'provider' ? { providerId: 'other' } : {}),
          ...(kind === 'version' ? { providerVersion: '2' } : {}),
          ...(kind === 'gap' ? { rank: 9 } : {}),
          score: {
            ...r.score!,
            ...(kind === 'semantics' ? { semantics: 'probability' } : {}),
            ...(kind === 'direction' ? { higherIsBetter: false } : {}),
            ...(kind === 'nonfinite' ? { value: Infinity } : {}),
            ...(kind === 'nonpositive' ? { value: 0 } : {}),
            ...(kind === 'reversed-score' ? { value: 0.0000001 } : {}),
          },
        },
      };
      if (kind === 'missing-rank') {
        const { rank: _rank, ...withoutRank } = raw[0]!.retrieval!;
        void _rank;
        raw[0] = { ...raw[0]!, retrieval: withoutRank };
      }
    }
    expect(() => mapNative(raw)).toThrow();
  });
  it('canonicalizes real provider input without changing its native identity', async () => {
    const input = {
      scope: SCOPE,
      query: 'alpha beta',
      referenceTime: REFERENCE_TIME,
      blocks: doc.blocks,
      sourceDocuments: [doc.sourceDocument],
    };
    const a = await retrieveForProfile(input),
      b = await retrieveForProfile({ ...input, blocks: [...doc.blocks].reverse() });
    expect(a).toEqual(b);
    expect(a.native[0]!.retrieval!.providerId).toBe(NATIVE.providerId);
  });
  it('declares incomplete evidence and no restrictive minimum', () => {
    expect(PROFILE.completeness).toBe('incomplete');
    expect(profilePolicy().filtering).toMatchObject({
      schemaVersion: 3,
      onIncompleteEvidence: 'admit',
    });
    expect(profilePolicy().filtering).not.toHaveProperty('minimumTotalScore');
  });
  it('preserves low-ranked retrieved context and runtime required context through the real compiler', () => {
    const cs = mapNative(native());
    const compiler = new ContextCompiler(
      {
        schemaVersion: 1,
        compilerId: 'contract',
        compilerVersion: '1',
        maxCorrectionSelections: 10,
      },
      tokenizer,
    );
    const result = compiler.compile({
      schemaVersion: 1,
      id: 'contract',
      scope: SCOPE,
      query: 'alpha',
      referenceTime: REFERENCE_TIME,
      sourceDocuments: [doc.sourceDocument],
      candidates: cs.map((c, i) =>
        i === 0 ? { ...c, block: { ...c.block, attributes: { required: true } } } : c,
      ),
      budget: { totalTokens: 10000, reservedOutputTokens: 0 },
      policy: profilePolicy(),
    });
    expect(result.includedBlocks).toHaveLength(2);
    expect(result.trace.groups.every((g) => g.filtering.decision === 'eligible')).toBe(true);
  });
});

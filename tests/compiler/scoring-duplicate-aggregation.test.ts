import { CandidateScorer } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  deduplicateCandidates,
  policy,
  reversed,
  rule,
  score,
  scoredRetrieval,
} from './scoring-fixtures.js';

const AGGREGATION_POLICY = policy({
  retrieval: {
    weight: 1,
    aggregation: 'max',
    rules: [
      rule({ ruleId: 'cosine' }),
      rule({
        ruleId: 'other-cosine',
        providerId: 'qdrant-like',
        providerVersion: '4.0.0',
        semantics: 'cosine-similarity',
      }),
    ],
  },
});

/** The same exact content wrapped `count` times, each carrying `value`. */
function repeated(count: number, values: readonly number[]): Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) =>
    candidate({}, scoredRetrieval(values[index] ?? values[0] ?? 0)),
  );
}

describe('CandidateScorer: duplicate retrieval aggregation', () => {
  it('INV-DEDUP-003: one wrapper and twenty identical wrappers score the same', () => {
    const single = score([candidate({}, scoredRetrieval(0.8))], AGGREGATION_POLICY);
    const twenty = score(repeated(20, [0.8]), AGGREGATION_POLICY);

    expect(twenty.candidates).toHaveLength(1);
    expect(twenty.candidates[0]?.score.retrieval?.normalizedValue).toBe(0.8);
    expect(twenty.candidates[0]?.score.total).toBe(single.candidates[0]?.score.total);
    // Every wrapper survived Phase 8 and is visible as evidence; only its count
    // is not utility.
    expect(twenty.candidates[0]?.candidate.members).toHaveLength(20);
    expect(twenty.candidates[0]?.score.retrieval?.evidence).toHaveLength(20);
  });

  it('one strong signal plus nineteen weak ones still aggregates to the strong one', () => {
    const values = [0.8, ...Array.from({ length: 19 }, () => 0.1)];
    const result = score(repeated(20, values), AGGREGATION_POLICY);

    expect(result.candidates[0]?.score.retrieval?.normalizedValue).toBe(0.8);
    expect(result.candidates[0]?.score.retrieval?.evidence).toHaveLength(20);
  });

  it('takes the maximum across two different normalized provider contracts', () => {
    const result = score(
      [
        candidate({}, scoredRetrieval(0.7)),
        candidate(
          {},
          scoredRetrieval(0.9, { providerId: 'qdrant-like', providerVersion: '4.0.0' }),
        ),
      ],
      AGGREGATION_POLICY,
    );

    expect(result.candidates[0]?.score.retrieval?.normalizedValue).toBe(0.9);
    expect(
      result.candidates[0]?.score.retrieval?.evidence.map((record) => record.normalizedValue),
      // Evidence is ordered by block ID, then provider identity: "qdrant-like"
      // precedes "sqlite-fts5" by code unit.
    ).toEqual([0.9, 0.7]);
  });

  it('never lets duplicate evidence count raise the normalized value above its maximum', () => {
    for (const count of [1, 2, 5, 20, 50]) {
      const result = score(repeated(count, [0.3]), AGGREGATION_POLICY);
      expect(result.candidates[0]?.score.retrieval?.normalizedValue, String(count)).toBe(0.3);
      expect(result.candidates[0]?.score.total, String(count)).toBe(0.3);
    }
  });

  it('reports the aggregation rule it applied', () => {
    const result = score(repeated(3, [0.5]), AGGREGATION_POLICY);
    expect(result.candidates[0]?.score.retrieval?.aggregation).toBe('max');
  });

  it('INV-DET-002: orders evidence stably and independently of member order', () => {
    const candidates = [
      candidate({}, scoredRetrieval(0.9, { providerId: 'qdrant-like', providerVersion: '4.0.0' })),
      candidate({}, scoredRetrieval(0.2)),
      candidate({}, scoredRetrieval(0.7)),
    ];
    const batch = deduplicateCandidates(candidates);
    const scorer = new CandidateScorer(AGGREGATION_POLICY);

    const declared = scorer.score(batch, '2026-06-01T12:00:00.000Z');
    const flipped = scorer.score(reversed(batch), '2026-06-01T12:00:00.000Z');

    // The scored groups themselves are carried by reference, so a caller that
    // reordered the members still sees its own member order. What must not move
    // is the scoring decision or the ranking.
    const decisions = (set: typeof declared): unknown =>
      set.candidates.map((entry) => [entry.candidate.canonicalBlock.id, entry.score]);
    expect(decisions(flipped)).toEqual(decisions(declared));
    // Ordered by provider identity first, then by raw value.
    expect(
      declared.candidates[0]?.score.retrieval?.evidence.map((record) => [
        record.providerId,
        record.rawValue,
      ]),
    ).toEqual([
      ['qdrant-like', 0.9],
      ['sqlite-fts5', 0.2],
      ['sqlite-fts5', 0.7],
    ]);
  });

  it('aggregates evidence carried by distinct duplicate blocks, not only the canonical one', () => {
    // Two distinct blocks with exactly equal content: Phase 8 makes `block-1`
    // canonical, and the stronger signal belongs to `block-2`.
    const result = score(
      [
        candidate({ id: 'block-1' }, scoredRetrieval(0.2)),
        candidate({ id: 'block-2' }, scoredRetrieval(0.95)),
      ],
      AGGREGATION_POLICY,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.candidate.canonicalBlock.id).toBe('block-1');
    expect(result.candidates[0]?.score.retrieval?.normalizedValue).toBe(0.95);
    expect(result.candidates[0]?.score.retrieval?.evidence.map((record) => record.blockId)).toEqual(
      ['block-1', 'block-2'],
    );
  });

  it('does not sum, average, or count duplicate evidence', () => {
    const result = score(repeated(4, [0.25, 0.25, 0.25, 0.25]), AGGREGATION_POLICY);
    const normalized = result.candidates[0]?.score.retrieval?.normalizedValue;

    expect(normalized).toBe(0.25);
    expect(normalized).not.toBe(1);
    expect(normalized).not.toBe(4);
  });
});

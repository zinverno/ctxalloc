import { describe, expect, it } from 'vitest';
import {
  candidate,
  issueCodesOf,
  issuesOf,
  policy,
  retrieval,
  rule,
  score,
  scoredRetrieval,
} from './scoring-fixtures.js';

/** A cosine similarity in [0, 1], a vector distance in [0, 4], and a BM25-like scale. */
const CONTRACTS = policy({
  retrieval: {
    weight: 1,
    aggregation: 'max',
    rules: [
      rule({
        ruleId: 'cosine',
        semantics: 'cosine-similarity',
        higherIsBetter: true,
        min: 0,
        max: 1,
      }),
      rule({
        ruleId: 'distance',
        semantics: 'l2-distance',
        higherIsBetter: false,
        min: 0,
        max: 4,
      }),
      rule({
        ruleId: 'bm25',
        providerId: 'bm25-provider',
        providerVersion: '2.0.0',
        semantics: 'bm25',
        higherIsBetter: true,
        min: 0,
        max: 20,
      }),
      rule({
        ruleId: 'signed',
        providerId: 'signed-provider',
        providerVersion: '1.0.0',
        semantics: 'signed-relevance',
        higherIsBetter: true,
        min: -1,
        max: 1,
      }),
    ],
  },
});

function normalizedOf(candidates: readonly Record<string, unknown>[]): number | undefined {
  return score(candidates, CONTRACTS).candidates[0]?.score.retrieval?.normalizedValue;
}

describe('CandidateScorer: retrieval normalization', () => {
  it('INV-SCORE-002: maps a higher-is-better contract across its declared range', () => {
    expect(normalizedOf([candidate({}, scoredRetrieval(0))])).toBe(0);
    expect(normalizedOf([candidate({}, scoredRetrieval(0.5))])).toBe(0.5);
    expect(normalizedOf([candidate({}, scoredRetrieval(1))])).toBe(1);
  });

  it('INV-SCORE-002: inverts a lower-is-better contract', () => {
    const distance = (value: number): Record<string, unknown> =>
      scoredRetrieval(value, {}, { semantics: 'l2-distance', higherIsBetter: false });

    expect(normalizedOf([candidate({}, distance(0))])).toBe(1);
    expect(normalizedOf([candidate({}, distance(2))])).toBe(0.5);
    expect(normalizedOf([candidate({}, distance(4))])).toBe(0);
  });

  it('maps a BM25-like positive scale onto the same normalized range', () => {
    const bm25 = (value: number): Record<string, unknown> =>
      scoredRetrieval(
        value,
        { providerId: 'bm25-provider', providerVersion: '2.0.0' },
        { semantics: 'bm25' },
      );

    expect(normalizedOf([candidate({}, bm25(0))])).toBe(0);
    expect(normalizedOf([candidate({}, bm25(5))])).toBe(0.25);
    expect(normalizedOf([candidate({}, bm25(20))])).toBe(1);
  });

  it('maps a negative policy range without clamping the midpoint', () => {
    const signed = (value: number): Record<string, unknown> =>
      scoredRetrieval(
        value,
        { providerId: 'signed-provider', providerVersion: '1.0.0' },
        { semantics: 'signed-relevance' },
      );

    expect(normalizedOf([candidate({}, signed(-1))])).toBe(0);
    expect(normalizedOf([candidate({}, signed(0))])).toBe(0.5);
    expect(normalizedOf([candidate({}, signed(1))])).toBe(1);
  });

  it('INV-SCORE-004: rejects a raw score outside the declared range rather than clamping it', () => {
    for (const value of [-0.0001, 1.0001, 2, -5]) {
      const issues = issuesOf(() => score([candidate({}, scoredRetrieval(value))], CONTRACTS));
      expect(
        issues.map((issue) => issue.code),
        String(value),
      ).toEqual(['retrieval_score_out_of_range']);
      expect(issues[0]?.message).toContain('[0, 1]');
      expect(issues[0]?.message).toContain('"cosine"');
    }
  });

  it('requires an exact match on every element of the contract tuple', () => {
    const mismatches: readonly [string, Record<string, unknown>][] = [
      ['providerId', scoredRetrieval(0.5, { providerId: 'other-provider' })],
      ['providerVersion', scoredRetrieval(0.5, { providerVersion: '9.9.9' })],
      ['semantics', scoredRetrieval(0.5, {}, { semantics: 'cosine_similarity' })],
      ['higherIsBetter', scoredRetrieval(0.5, {}, { higherIsBetter: false })],
    ];
    for (const [label, wrapper] of mismatches) {
      expect(
        issueCodesOf(() => score([candidate({}, wrapper)], CONTRACTS)),
        label,
      ).toEqual(['retrieval_score_rule_not_found']);
    }
  });

  it('rejects a scored record the policy does not configure at all', () => {
    const issues = issuesOf(() =>
      score(
        [candidate({}, scoredRetrieval(0.5))],
        policy({ retrieval: { weight: 1, aggregation: 'max', rules: [] } }),
      ),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['retrieval_score_rule_not_found']);
    expect(issues[0]?.message).toContain('"sqlite-fts5"');
    expect(issues[0]?.pointer).toBe('candidates.block-1.members.block-1.retrieval.score');
  });

  it('INV-PROV-003: treats a retrieval record with no score as no relevance evidence', () => {
    const result = score([candidate({}, retrieval({ rank: 0 }))], CONTRACTS);
    const component = result.candidates[0]?.score.retrieval;

    expect(component?.evidence).toEqual([]);
    expect(component?.normalizedValue).toBe(0);
  });

  it('INV-PROV-003: never reads rank, provider identity, or provider metadata as relevance', () => {
    const first = score(
      [candidate({}, scoredRetrieval(0.4, { rank: 0, metadata: { pointId: 'a' } }))],
      CONTRACTS,
    );
    const second = score(
      [candidate({}, scoredRetrieval(0.4, { rank: 999, metadata: { pointId: 'zzz', boost: 10 } }))],
      CONTRACTS,
    );

    expect(second.candidates[0]?.score.retrieval?.normalizedValue).toBe(
      first.candidates[0]?.score.retrieval?.normalizedValue,
    );
    expect(first.candidates[0]?.score.retrieval?.normalizedValue).toBe(0.4);
  });

  it('scores nothing from retrieval when the component is not configured', () => {
    const result = score([candidate({}, scoredRetrieval(0.9))], policy());

    expect(result.candidates[0]?.score.retrieval).toBeUndefined();
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('publishes the raw value, the rule, and the contract behind every normalized value', () => {
    const result = score([candidate({}, scoredRetrieval(0.75))], CONTRACTS);

    expect(result.candidates[0]?.score.retrieval?.evidence).toEqual([
      {
        blockId: 'block-1',
        providerId: 'sqlite-fts5',
        providerVersion: '1.2.3',
        semantics: 'cosine-similarity',
        higherIsBetter: true,
        rawValue: 0.75,
        normalizedValue: 0.75,
        ruleId: 'cosine',
      },
    ]);
  });

  it('reports every unusable retrieval record in one error', () => {
    const codes = issueCodesOf(() =>
      score(
        [
          candidate({ id: 'block-1' }, scoredRetrieval(5)),
          candidate(
            { id: 'block-2', content: 'Second block.' },
            scoredRetrieval(0.5, { providerId: 'unknown' }),
          ),
        ],
        CONTRACTS,
      ),
    );

    expect([...codes].sort()).toEqual([
      'retrieval_score_out_of_range',
      'retrieval_score_rule_not_found',
    ]);
  });

  it('canonicalizes a negative-zero provider score to positive zero', () => {
    const result = score([candidate({}, scoredRetrieval(-0))], CONTRACTS);
    const evidence = result.candidates[0]?.score.retrieval?.evidence[0];

    expect(Object.is(evidence?.rawValue, -0)).toBe(false);
    expect(Object.is(evidence?.normalizedValue, -0)).toBe(false);
    expect(evidence?.rawValue).toBe(0);
  });

  it('INV-DET-001: does not normalize relative to the other candidates in the batch', () => {
    const alone = score([candidate({}, scoredRetrieval(0.5))], CONTRACTS);
    const withNeighbours = score(
      [
        candidate({}, scoredRetrieval(0.5)),
        candidate({ id: 'block-2', content: 'A much better match.' }, scoredRetrieval(1)),
        candidate({ id: 'block-3', content: 'A much worse match.' }, scoredRetrieval(0.1)),
      ],
      CONTRACTS,
    );
    const scored = withNeighbours.candidates.find(
      (entry) => entry.candidate.canonicalBlock.id === 'block-1',
    );

    expect(scored?.score.retrieval?.normalizedValue).toBe(
      alone.candidates[0]?.score.retrieval?.normalizedValue,
    );
    expect(scored?.score.retrieval?.normalizedValue).toBe(0.5);
  });
});

describe('CandidateScorer: retrieval normalization arithmetic', () => {
  it('INV-SCORE-004: rejects a normalization that overflows to a non-finite value', () => {
    const extreme = policy({
      retrieval: {
        weight: 1,
        aggregation: 'max',
        rules: [rule({ ruleId: 'extreme', min: -Number.MAX_VALUE, max: Number.MAX_VALUE })],
      },
    });

    expect(
      issueCodesOf(() => score([candidate({}, scoredRetrieval(Number.MAX_VALUE))], extreme)),
    ).toEqual(['non_finite_score_result']);
  });

  it('still normalizes an ordinary value inside a very wide range', () => {
    const wide = policy({
      retrieval: {
        weight: 1,
        aggregation: 'max',
        rules: [rule({ ruleId: 'wide', min: -Number.MAX_VALUE, max: Number.MAX_VALUE })],
      },
    });
    const result = score([candidate({}, scoredRetrieval(0))], wide);

    expect(Number.isFinite(result.candidates[0]?.score.retrieval?.normalizedValue)).toBe(true);
  });
});

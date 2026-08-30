import { describe, expect, it } from 'vitest';
import {
  decisionFor,
  eligibleIds,
  filter,
  filteringPolicy,
  reasonsOf,
} from './filtering-fixtures.js';

/**
 * Threshold semantics and the required bypass (DEC-036).
 *
 * The fixture scoring policy normalizes authored priority over `[0, 1000]` with
 * weight `1`, so a candidate with priority `p` has `score.total === p / 1000`
 * exactly.
 */
describe('CandidateFilter threshold', () => {
  it('keeps every candidate when no minimum is configured', () => {
    const result = filter([
      { id: 'a', priority: 0 },
      { id: 'b', priority: 500 },
      { id: 'c', priority: 1000 },
    ]);

    expect(eligibleIds(result)).toEqual(['c', 'b', 'a']);
    expect(reasonsOf(result)).toEqual({
      a: 'ELIGIBLE_POLICY',
      b: 'ELIGIBLE_POLICY',
      c: 'ELIGIBLE_POLICY',
    });
  });

  it('states no minimum on a decision the policy took without one', () => {
    const result = filter([{ id: 'a', priority: 250 }]);
    const decision = decisionFor(result, 'a');

    expect(decision).toEqual({
      candidate: result.scored.candidates[0],
      decision: 'eligible',
      reason: 'ELIGIBLE_POLICY',
      scoreTotal: 0.25,
    });
    expect(Object.keys(decision)).not.toContain('minimumTotalScore');
  });

  it('filters a candidate strictly below the minimum', () => {
    const result = filter([{ id: 'low', priority: 100 }], {
      policy: filteringPolicy({ minimumTotalScore: 0.5 }),
    });

    expect(eligibleIds(result)).toEqual([]);
    expect(decisionFor(result, 'low')).toEqual({
      candidate: result.scored.candidates[0],
      decision: 'filtered',
      reason: 'FILTERED_SCORE_BELOW_MINIMUM',
      scoreTotal: 0.1,
      minimumTotalScore: 0.5,
    });
  });

  it('keeps a candidate exactly at the minimum: equality survives', () => {
    const result = filter([{ id: 'exact', priority: 500 }], {
      policy: filteringPolicy({ minimumTotalScore: 0.5 }),
    });

    expect(eligibleIds(result)).toEqual(['exact']);
    expect(decisionFor(result, 'exact')).toEqual({
      candidate: result.scored.candidates[0],
      decision: 'eligible',
      reason: 'ELIGIBLE_POLICY',
      scoreTotal: 0.5,
      minimumTotalScore: 0.5,
    });
  });

  it('keeps a candidate above the minimum', () => {
    const result = filter([{ id: 'high', priority: 900 }], {
      policy: filteringPolicy({ minimumTotalScore: 0.5 }),
    });

    expect(eligibleIds(result)).toEqual(['high']);
    expect(decisionFor(result, 'high').reason).toBe('ELIGIBLE_POLICY');
  });

  it('separates a batch exactly at the boundary', () => {
    const result = filter(
      [
        { id: 'below', priority: 499 },
        { id: 'equal', priority: 500 },
        { id: 'above', priority: 501 },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    expect(eligibleIds(result)).toEqual(['above', 'equal']);
    expect(reasonsOf(result)).toEqual({
      above: 'ELIGIBLE_POLICY',
      below: 'FILTERED_SCORE_BELOW_MINIMUM',
      equal: 'ELIGIBLE_POLICY',
    });
  });

  it('keeps a zero-scoring candidate under a minimum of zero', () => {
    const result = filter([{ id: 'zero', priority: 0 }], {
      policy: filteringPolicy({ minimumTotalScore: 0 }),
    });

    expect(eligibleIds(result)).toEqual(['zero']);
    expect(decisionFor(result, 'zero')).toMatchObject({
      reason: 'ELIGIBLE_POLICY',
      scoreTotal: 0,
      minimumTotalScore: 0,
    });
  });

  it('filters every optional candidate when the minimum is unreachable', () => {
    const result = filter(
      [
        { id: 'a', priority: 1000 },
        { id: 'b', priority: 999 },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 2 }) },
    );

    expect(eligibleIds(result)).toEqual([]);
    expect(result.eligible.candidates).toEqual([]);
    expect(result.decisions).toHaveLength(2);
  });

  it('compares the exact total: it rounds, clamps, and normalizes nothing', () => {
    // 1/1000 is not exactly representable, so a rounded comparison would admit
    // this candidate and an exact one must not.
    const scoreTotal = 1 / 1000;
    const result = filter([{ id: 'tiny', priority: 1 }], {
      policy: filteringPolicy({ minimumTotalScore: 0.0010000000000000002 }),
    });

    expect(decisionFor(result, 'tiny')).toMatchObject({
      reason: 'FILTERED_SCORE_BELOW_MINIMUM',
      scoreTotal,
    });
    expect(result.scored.candidates[0]?.score.total).toBe(scoreTotal);
  });

  it('applies no score-per-token logic: a large low-scoring block is judged on score alone', () => {
    const result = filter(
      [
        { id: 'big', priority: 900, tokens: 400 },
        { id: 'small', priority: 100, tokens: 1 },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    expect(eligibleIds(result)).toEqual(['big']);
  });
});

/**
 * INV-BUDGET-003 and INV-SCORE-003: required blocks are a separate allocation
 * class, so a policy threshold never reaches them.
 */
describe('INV-SCORE-003: CandidateFilter required bypass', () => {
  it('keeps a required block scoring zero under a threshold of one thousand', () => {
    const result = filter([{ id: 'must', priority: 0, required: true }], {
      policy: filteringPolicy({ minimumTotalScore: 1000 }),
    });

    expect(eligibleIds(result)).toEqual(['must']);
    expect(decisionFor(result, 'must')).toEqual({
      candidate: result.scored.candidates[0],
      decision: 'eligible',
      reason: 'ELIGIBLE_REQUIRED',
    });
  });

  it('does not boost, rewrite, or restate the score of a required block', () => {
    const result = filter([{ id: 'must', priority: 0, required: true }], {
      policy: filteringPolicy({ minimumTotalScore: 1000 }),
    });
    const decision = decisionFor(result, 'must');

    expect(result.scored.candidates[0]?.score.total).toBe(0);
    expect(result.eligible.candidates[0]?.score.total).toBe(0);
    // The threshold played no part, so neither operand is published as if it had.
    expect(Object.keys(decision).sort()).toEqual(['candidate', 'decision', 'reason']);
  });

  it('bypasses the threshold without failing the batch', () => {
    expect(() =>
      filter([{ id: 'must', priority: 0, required: true }], {
        policy: filteringPolicy({ minimumTotalScore: 1000 }),
      }),
    ).not.toThrow();
  });

  it('keeps required blocks while filtering optional ones in the same batch', () => {
    const result = filter(
      [
        { id: 'must-low', priority: 0, required: true },
        { id: 'opt-low', priority: 0 },
        { id: 'opt-high', priority: 900 },
        { id: 'must-high', priority: 900, required: true },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    expect(reasonsOf(result)).toEqual({
      'must-high': 'ELIGIBLE_REQUIRED',
      'must-low': 'ELIGIBLE_REQUIRED',
      'opt-high': 'ELIGIBLE_POLICY',
      'opt-low': 'FILTERED_SCORE_BELOW_MINIMUM',
    });
    expect([...eligibleIds(result)].sort()).toEqual(['must-high', 'must-low', 'opt-high']);
  });

  it('treats an explicit required:false and an absent required alike', () => {
    const result = filter(
      [
        { id: 'explicit', priority: 0, required: false },
        { id: 'absent', priority: 0 },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    expect(reasonsOf(result)).toEqual({
      absent: 'FILTERED_SCORE_BELOW_MINIMUM',
      explicit: 'FILTERED_SCORE_BELOW_MINIMUM',
    });
  });

  it('bypasses required blocks even when no threshold is configured', () => {
    const result = filter([{ id: 'must', priority: 400, required: true }]);
    expect(decisionFor(result, 'must').reason).toBe('ELIGIBLE_REQUIRED');
  });
});

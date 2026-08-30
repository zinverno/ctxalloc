import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  excludedIds,
  includedIds,
  permutations,
  reasonsOf,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * Optional selection is `score-desc-greedy` (DEC-033).
 *
 * Candidates are considered by score descending, then by block identifier, and a
 * candidate that does not fit is skipped rather than ending the traversal. It is
 * deliberately not knapsack, total-utility maximization, or score-per-token.
 */

describe('DEC-033: score-desc-greedy optional selection', () => {
  const GREEDY_FIXTURE: readonly CandidateSpec[] = [
    { id: 'a', tokens: 11, priority: 1000 },
    { id: 'b', tokens: 6, priority: 900 },
    { id: 'c', tokens: 4, priority: 800 },
  ];

  it('selects by score descending', () => {
    const result = allocate(
      [
        { id: 'low', tokens: 1, priority: 100 },
        { id: 'high', tokens: 1, priority: 900 },
        { id: 'mid', tokens: 1, priority: 500 },
      ],
      { available: 20 },
    );

    expect(includedIds(result)).toEqual(['high', 'mid', 'low']);
  });

  it('INV-DET-005: breaks a score tie by block identifier ascending', () => {
    const result = allocate(
      [
        { id: 'z', tokens: 1, priority: 500 },
        { id: 'a', tokens: 1, priority: 500 },
        { id: 'm', tokens: 1, priority: 500 },
      ],
      { available: 20 },
    );

    expect(includedIds(result)).toEqual(['a', 'm', 'z']);
  });

  it('keeps scanning past a high-score candidate that does not fit', () => {
    const result = allocate(GREEDY_FIXTURE, { available: 10 });

    expect(reasonsOf(result)).toEqual({
      a: 'EXCLUDED_BUDGET_EXHAUSTED',
      b: 'INCLUDED_SCORE_ORDER',
      c: 'INCLUDED_SCORE_ORDER',
    });
    expect(result.selectedBlockContentTokens).toBe(10);
    expect(result.unallocatedBlockContentTokens).toBe(0);
  });

  it('lets a high-score candidate consume most of the budget', () => {
    const result = allocate(
      [
        { id: 'big', tokens: 9, priority: 1000 },
        { id: 'small', tokens: 5, priority: 900 },
      ],
      { available: 10 },
    );

    expect(reasonsOf(result)).toEqual({
      big: 'INCLUDED_SCORE_ORDER',
      small: 'EXCLUDED_BUDGET_EXHAUSTED',
    });
  });

  it('never prefers a lower-score candidate for a better score-per-token ratio', () => {
    // `cheap` has ten times the score per token of `rich`, and `rich` alone
    // exhausts the budget. A ratio-driven or utility-maximizing allocator would
    // take `cheap` twice over; `score-desc-greedy` takes `rich` first.
    const result = allocate(
      [
        { id: 'rich', tokens: 10, priority: 1000 },
        { id: 'cheap', tokens: 1, priority: 900 },
      ],
      { available: 10 },
    );

    expect(includedIds(result)).toEqual(['rich']);
    expect(excludedIds(result)).toEqual(['cheap']);
  });

  it('never substitutes a knapsack-optimal set for the greedy one', () => {
    // The optimal total-utility set at 10 tokens is `m1 + m2` (1.8), while
    // greedy takes `big` (1.0) and leaves 0 tokens. Greedy is the contract.
    const result = allocate(
      [
        { id: 'big', tokens: 10, priority: 1000 },
        { id: 'm1', tokens: 5, priority: 900 },
        { id: 'm2', tokens: 5, priority: 900 },
      ],
      { available: 10 },
    );

    expect(includedIds(result)).toEqual(['big']);
    expect(excludedIds(result)).toEqual(['m1', 'm2']);
  });

  it('INV-ALLOC-005: candidate input order does not change the result', () => {
    const expected = allocate(GREEDY_FIXTURE, { available: 10 });
    for (const permutation of permutations(GREEDY_FIXTURE)) {
      expect(allocate(permutation, { available: 10 })).toEqual(expected);
    }
  });
});

describe('INV-TRACE-001: every candidate gets exactly one decision', () => {
  it('decides every candidate exactly once across included and excluded', () => {
    const specs: CandidateSpec[] = [
      { id: 'r1', tokens: 2, priority: 0, required: true },
      { id: 'm1', tokens: 1, priority: 100, category: 'facts' },
      { id: 'm2', tokens: 9, priority: 900, category: 'facts' },
      { id: 'x1', tokens: 3, priority: 800, category: 'capped' },
      { id: 'x2', tokens: 3, priority: 700, category: 'capped' },
      { id: 'o1', tokens: 50, priority: 600 },
    ];
    const result = allocate(specs, {
      available: 12,
      policy: allocationPolicy({
        categoryConstraints: [
          { category: 'facts', minBlocks: 1 },
          { category: 'capped', maxBlocks: 1 },
        ],
      }),
    });

    const decided = [...includedIds(result), ...excludedIds(result)];
    expect(decided).toHaveLength(specs.length);
    expect(new Set(decided).size).toBe(specs.length);
    expect(new Set(decided)).toEqual(new Set(specs.map((spec) => spec.id)));
  });

  it('INV-TRACE-002: publishes only the documented machine-readable reasons', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 2, priority: 0, required: true },
        { id: 'm1', tokens: 1, priority: 100, category: 'facts' },
        { id: 's1', tokens: 1, priority: 950 },
        { id: 'x1', tokens: 1, priority: 900, category: 'capped' },
        { id: 'x2', tokens: 1, priority: 800, category: 'capped' },
        { id: 'e1', tokens: 99, priority: 700 },
      ],
      {
        available: 6,
        policy: allocationPolicy({
          categoryConstraints: [
            { category: 'facts', minBlocks: 1 },
            { category: 'capped', maxBlocks: 1 },
          ],
        }),
      },
    );

    expect(reasonsOf(result)).toEqual({
      r1: 'INCLUDED_REQUIRED',
      m1: 'INCLUDED_CATEGORY_MINIMUM',
      s1: 'INCLUDED_SCORE_ORDER',
      x1: 'INCLUDED_SCORE_ORDER',
      x2: 'EXCLUDED_CATEGORY_MAXIMUM',
      e1: 'EXCLUDED_BUDGET_EXHAUSTED',
    });
    expect(result.included.every((decision) => decision.decision === 'included')).toBe(true);
    expect(result.excluded.every((decision) => decision.decision === 'excluded')).toBe(true);
  });

  it('orders included decisions as required, then minimums, then score order', () => {
    const result = allocate(
      [
        { id: 'score', tokens: 1, priority: 1000 },
        { id: 'minimum', tokens: 1, priority: 100, category: 'facts' },
        { id: 'required', tokens: 1, priority: 0, required: true },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
      },
    );

    expect(includedIds(result)).toEqual(['required', 'minimum', 'score']);
  });
});

describe('INV-TRACE-003: block-content accounting reconciles exactly', () => {
  const SPECS: readonly CandidateSpec[] = [
    { id: 'r1', tokens: 3, priority: 0, required: true },
    { id: 'm1', tokens: 2, priority: 100, category: 'facts' },
    { id: 's1', tokens: 4, priority: 900 },
    { id: 'e1', tokens: 40, priority: 800 },
  ];

  it('subtracts exactly the content tokens on every inclusion', () => {
    const result = allocate(SPECS, {
      available: 12,
      policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
    });

    for (const decision of result.included) {
      expect(decision.remainingAfter).toBe(decision.remainingBefore - decision.contentTokens);
    }
    expect(result.included.map((decision) => decision.remainingBefore)).toEqual([12, 9, 7]);
    expect(result.included.map((decision) => decision.remainingAfter)).toEqual([9, 7, 3]);
  });

  it('leaves the remainder unchanged on every exclusion', () => {
    const result = allocate(SPECS, {
      available: 12,
      policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
    });

    expect(result.excluded.map((decision) => decision.remainingTokens)).toEqual([3]);
    expect(result.unallocatedBlockContentTokens).toBe(3);
  });

  it('reports the exact sum of the included canonical token counts', () => {
    const result = allocate(SPECS, {
      available: 12,
      policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
    });

    const sum = result.included.reduce((total, decision) => total + decision.contentTokens, 0);
    expect(result.selectedBlockContentTokens).toBe(sum);
    expect(result.selectedBlockContentTokens).toBe(9);
    expect(result.unallocatedBlockContentTokens).toBe(
      result.availableInputTokens - result.selectedBlockContentTokens,
    );
  });

  it('counts the canonical block once, never its duplicate wrappers', () => {
    const shared = 'one exact shared sentence';
    const result = allocate(
      [
        { id: 'w1', content: shared, priority: 900 },
        { id: 'w2', content: shared, priority: 100 },
      ],
      { available: 20 },
    );

    expect(result.included).toHaveLength(1);
    expect(result.selectedBlockContentTokens).toBe(4);
  });

  it('reads the canonical block token count as the allocation cost', () => {
    const result = allocate([{ id: 'b1', tokens: 7, priority: 100 }], { available: 20 });
    const canonical = result.included[0]?.candidate.candidate.canonicalBlock;

    expect(result.included[0]?.contentTokens).toBe(canonical?.tokenCount);
    expect(canonical?.tokenCount).toBe(7);
  });
});

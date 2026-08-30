import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  excludedIds,
  includedIds,
  issuesOf,
  permutations,
  reasonsOf,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * Category constraints are exact block counts in schema version 1 (DEC-033).
 *
 * A category is the canonical block's own `attributes.category`, matched by
 * exact string equality. Required blocks count toward both bounds, minimums are
 * satisfied with the cheapest candidates that reach the count, and an impossible
 * constraint fails with a structured error rather than being relaxed
 * (INV-ALLOC-003).
 */

function constraints(...list: readonly Record<string, unknown>[]): Record<string, unknown> {
  return allocationPolicy({ categoryConstraints: list });
}

describe('INV-ALLOC-003: category maximums', () => {
  it('excludes every optional candidate of a category capped at zero', () => {
    const result = allocate(
      [
        { id: 'a1', tokens: 2, priority: 900, category: 'notes' },
        { id: 'b1', tokens: 2, priority: 100, category: 'facts' },
      ],
      { available: 20, policy: constraints({ category: 'notes', maxBlocks: 0 }) },
    );

    expect(reasonsOf(result)).toEqual({
      a1: 'EXCLUDED_CATEGORY_MAXIMUM',
      b1: 'INCLUDED_SCORE_ORDER',
    });
  });

  it('accepts a required count exactly equal to the maximum', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 2, category: 'notes', required: true },
        { id: 'r2', tokens: 2, category: 'notes', required: true },
        { id: 'o1', tokens: 2, priority: 900, category: 'notes' },
      ],
      { available: 20, policy: constraints({ category: 'notes', maxBlocks: 2 }) },
    );

    expect(reasonsOf(result)).toEqual({
      r1: 'INCLUDED_REQUIRED',
      r2: 'INCLUDED_REQUIRED',
      o1: 'EXCLUDED_CATEGORY_MAXIMUM',
    });
  });

  it('fails when the required count exceeds the maximum, and removes no required block', () => {
    const issues = issuesOf(() =>
      allocate(
        [
          { id: 'r1', tokens: 2, category: 'notes', required: true },
          { id: 'r2', tokens: 2, category: 'notes', required: true },
          { id: 'r3', tokens: 2, category: 'notes', required: true },
        ],
        { available: 100, policy: constraints({ category: 'notes', maxBlocks: 2 }) },
      ),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['required_category_maximum_exceeded']);
    expect(issues[0]?.pointer).toBe('categoryConstraints.notes.maxBlocks');
    expect(issues[0]?.message).toContain('must not be removed');
  });

  it('stops optional inclusion once the maximum is reached', () => {
    const result = allocate(
      [
        { id: 'a1', tokens: 1, priority: 900, category: 'notes' },
        { id: 'a2', tokens: 1, priority: 800, category: 'notes' },
        { id: 'a3', tokens: 1, priority: 700, category: 'notes' },
      ],
      { available: 20, policy: constraints({ category: 'notes', maxBlocks: 2 }) },
    );

    expect(includedIds(result)).toEqual(['a1', 'a2']);
    expect(excludedIds(result)).toEqual(['a3']);
    expect(result.excluded[0]?.reason).toBe('EXCLUDED_CATEGORY_MAXIMUM');
  });

  it('checks the maximum before the budget, so a blocked candidate spends nothing', () => {
    const result = allocate(
      [
        { id: 'a1', tokens: 4, priority: 900, category: 'notes' },
        { id: 'a2', tokens: 4, priority: 800, category: 'notes' },
        { id: 'b1', tokens: 4, priority: 700, category: 'facts' },
      ],
      { available: 8, policy: constraints({ category: 'notes', maxBlocks: 1 }) },
    );

    expect(reasonsOf(result)).toEqual({
      a1: 'INCLUDED_SCORE_ORDER',
      a2: 'EXCLUDED_CATEGORY_MAXIMUM',
      b1: 'INCLUDED_SCORE_ORDER',
    });
    // The blocked candidate left the budget untouched for the next one.
    expect(result.excluded[0]?.remainingTokens).toBe(4);
    expect(result.selectedBlockContentTokens).toBe(8);
  });

  it('matches categories exactly: case, whitespace, and absence are all distinct', () => {
    const result = allocate(
      [
        { id: 'exact', tokens: 1, priority: 900, category: 'notes' },
        { id: 'cased', tokens: 1, priority: 800, category: 'Notes' },
        { id: 'spaced', tokens: 1, priority: 700, category: 'notes ' },
        { id: 'absent', tokens: 1, priority: 600 },
      ],
      { available: 20, policy: constraints({ category: 'notes', maxBlocks: 0 }) },
    );

    expect(reasonsOf(result)).toEqual({
      exact: 'EXCLUDED_CATEGORY_MAXIMUM',
      cased: 'INCLUDED_SCORE_ORDER',
      spaced: 'INCLUDED_SCORE_ORDER',
      absent: 'INCLUDED_SCORE_ORDER',
    });
  });

  it('counts only the canonical category, never a duplicate member category', () => {
    const shared = 'one exact shared sentence';
    const result = allocate(
      [
        { id: 'canonical', content: shared, priority: 900, category: 'notes' },
        { id: 'duplicate', content: shared, priority: 100, category: 'facts' },
      ],
      { available: 20, policy: constraints({ category: 'facts', maxBlocks: 0 }) },
    );

    // One selected block, whose category is the canonical block's alone. The
    // duplicate's `facts` category is provenance, not a second selectable block.
    expect(result.included).toHaveLength(1);
    expect(result.included[0]?.reason).toBe('INCLUDED_SCORE_ORDER');
  });
});

describe('INV-ALLOC-003: category minimum reachability', () => {
  it('counts required blocks toward the minimum', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 2, category: 'facts', required: true },
        { id: 'o1', tokens: 2, priority: 100, category: 'other' },
      ],
      { available: 20, policy: constraints({ category: 'facts', minBlocks: 1 }) },
    );

    expect(reasonsOf(result)).toEqual({ r1: 'INCLUDED_REQUIRED', o1: 'INCLUDED_SCORE_ORDER' });
  });

  it('fails when too few candidates of the category exist', () => {
    const issues = issuesOf(() =>
      allocate([{ id: 'f1', tokens: 2, category: 'facts' }], {
        available: 100,
        policy: constraints({ category: 'facts', minBlocks: 3 }),
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['category_minimum_unreachable']);
    expect(issues[0]?.pointer).toBe('categoryConstraints.facts.minBlocks');
  });

  it('collects every impossible minimum in one error, in category order', () => {
    const issues = issuesOf(() =>
      allocate([{ id: 'x1', tokens: 2 }], {
        available: 100,
        policy: constraints(
          { category: 'zulu', minBlocks: 1 },
          { category: 'alpha', minBlocks: 2 },
          { category: 'mike', minBlocks: 1 },
        ),
      }),
    );

    expect(issues.map((issue) => issue.pointer)).toEqual([
      'categoryConstraints.alpha.minBlocks',
      'categoryConstraints.mike.minBlocks',
      'categoryConstraints.zulu.minBlocks',
    ]);
    expect(new Set(issues.map((issue) => issue.code))).toEqual(
      new Set(['category_minimum_unreachable']),
    );
  });

  it('needs nothing for a minimum of zero', () => {
    const result = allocate([{ id: 'x1', tokens: 2, priority: 100 }], {
      available: 20,
      policy: constraints({ category: 'facts', minBlocks: 0 }),
    });
    expect(result.included).toHaveLength(1);
  });

  it('does not let an uncategorized candidate satisfy a named minimum', () => {
    const issues = issuesOf(() =>
      allocate([{ id: 'x1', tokens: 2 }], {
        available: 100,
        policy: constraints({ category: 'facts', minBlocks: 1 }),
      }),
    );
    expect(issues.map((issue) => issue.code)).toEqual(['category_minimum_unreachable']);
  });

  it('counts one exact-content group as one selectable block, not one per wrapper', () => {
    const shared = 'one exact shared sentence';
    const issues = issuesOf(() =>
      allocate(
        [
          { id: 'w1', content: shared, category: 'facts' },
          { id: 'w2', content: shared, category: 'facts' },
        ],
        { available: 100, policy: constraints({ category: 'facts', minBlocks: 2 }) },
      ),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['category_minimum_unreachable']);
    expect(issues[0]?.message).toContain('1 optional');
  });
});

describe('DEC-033: hard minimums use the minimum-content-cost selection', () => {
  const PROOF_FIXTURE: readonly CandidateSpec[] = [
    { id: 'a1', tokens: 100, priority: 1000, category: 'a' },
    { id: 'a2', tokens: 10, priority: 100, category: 'a' },
    { id: 'a3', tokens: 11, priority: 900, category: 'a' },
  ];

  it('chooses the K cheapest blocks even when a larger block scores higher', () => {
    const result = allocate(PROOF_FIXTURE, {
      available: 21,
      policy: constraints({ category: 'a', minBlocks: 2 }),
    });

    expect(includedIds(result)).toEqual(['a2', 'a3']);
    expect(
      result.included.every((decision) => decision.reason === 'INCLUDED_CATEGORY_MINIMUM'),
    ).toBe(true);
    expect(excludedIds(result)).toEqual(['a1']);
    expect(result.selectedBlockContentTokens).toBe(21);
  });

  it('breaks a token-count tie by score, then by block identifier', () => {
    const result = allocate(
      [
        { id: 'p1', tokens: 5, priority: 100, category: 'a' },
        { id: 'p2', tokens: 5, priority: 900, category: 'a' },
        { id: 'p3', tokens: 5, priority: 900, category: 'a' },
      ],
      { available: 10, policy: constraints({ category: 'a', minBlocks: 2 }) },
    );

    // Equal cost: the higher score wins, and the identifier settles the tie
    // between the two equal scores.
    expect(includedIds(result)).toEqual(['p2', 'p3']);
  });

  it('INV-ALLOC-005: the minimum selection does not depend on input order', () => {
    const expected = includedIds(
      allocate(PROOF_FIXTURE, {
        available: 21,
        policy: constraints({ category: 'a', minBlocks: 2 }),
      }),
    );

    for (const permutation of permutations(PROOF_FIXTURE)) {
      expect(
        includedIds(
          allocate(permutation, {
            available: 21,
            policy: constraints({ category: 'a', minBlocks: 2 }),
          }),
        ),
      ).toEqual(expected);
    }
  });

  it('processes categories independently and orders the union deterministically', () => {
    const result = allocate(
      [
        { id: 'b1', tokens: 3, priority: 100, category: 'b' },
        { id: 'b2', tokens: 2, priority: 100, category: 'b' },
        { id: 'a1', tokens: 9, priority: 1000, category: 'a' },
        { id: 'a2', tokens: 4, priority: 100, category: 'a' },
      ],
      {
        available: 6,
        policy: constraints({ category: 'b', minBlocks: 1 }, { category: 'a', minBlocks: 1 }),
      },
    );

    // The union is ordered by category, then token count: `a2` before `b2`.
    expect(includedIds(result)).toEqual(['a2', 'b2']);
    expect(result.included.map((decision) => decision.remainingBefore)).toEqual([6, 2]);
  });
});

describe('DEC-033: category minimum content-budget feasibility', () => {
  const TWO_CATEGORIES: readonly CandidateSpec[] = [
    { id: 'a1', tokens: 10, priority: 1000, category: 'a' },
    { id: 'a2', tokens: 4, priority: 100, category: 'a' },
    { id: 'b1', tokens: 9, priority: 1000, category: 'b' },
    { id: 'b2', tokens: 3, priority: 100, category: 'b' },
  ];
  const bothMinimums = constraints(
    { category: 'a', minBlocks: 1 },
    { category: 'b', minBlocks: 1 },
  );

  it('proceeds when the minimum-cost union fits', () => {
    const result = allocate(TWO_CATEGORIES, { available: 7, policy: bothMinimums });

    expect(includedIds(result)).toEqual(['a2', 'b2']);
    expect(result.selectedBlockContentTokens).toBe(7);
    expect([...excludedIds(result)].sort()).toEqual(['a1', 'b1']);
  });

  it('fails when the minimum-cost union does not fit after required allocation', () => {
    const issues = issuesOf(() =>
      allocate([...TWO_CATEGORIES, { id: 'r1', tokens: 5, required: true }], {
        available: 10,
        policy: bothMinimums,
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['category_minimums_exceed_content_budget']);
    expect(issues[0]?.pointer).toBe('categoryConstraints');
  });

  it('never substitutes a higher-scoring, more expensive block for the hard minimum', () => {
    // Choosing by score would take `a1` (10) and `b1` (9) and fail at 7 tokens.
    const result = allocate(TWO_CATEGORIES, { available: 7, policy: bothMinimums });
    expect(includedIds(result)).not.toContain('a1');
    expect(includedIds(result)).not.toContain('b1');
  });

  it('INV-DET-002: the failure does not depend on the constraint declaration order', () => {
    const reversedPolicy = constraints(
      { category: 'b', minBlocks: 1 },
      { category: 'a', minBlocks: 1 },
    );
    const specs = [...TWO_CATEGORIES, { id: 'r1', tokens: 5, required: true }];

    expect(issuesOf(() => allocate(specs, { available: 10, policy: reversedPolicy }))).toEqual(
      issuesOf(() => allocate(specs, { available: 10, policy: bothMinimums })),
    );
  });

  it('reports a global hard-minimum infeasibility, not a single blamed category', () => {
    const issues = issuesOf(() => allocate(TWO_CATEGORIES, { available: 5, policy: bothMinimums }));

    expect(issues[0]?.pointer).toBe('categoryConstraints');
    expect(issues[0]?.message).toContain('every category minimum');
  });
});

describe('DEC-033: category maximum and optional greedy interaction', () => {
  it('counts required and hard-minimum picks toward the maximum', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 2, category: 'a', required: true },
        { id: 'm1', tokens: 1, priority: 100, category: 'a' },
        { id: 'o1', tokens: 3, priority: 900, category: 'a' },
      ],
      {
        available: 20,
        policy: constraints({ category: 'a', minBlocks: 2, maxBlocks: 2 }),
      },
    );

    expect(reasonsOf(result)).toEqual({
      r1: 'INCLUDED_REQUIRED',
      m1: 'INCLUDED_CATEGORY_MINIMUM',
      o1: 'EXCLUDED_CATEGORY_MAXIMUM',
    });
  });

  it('excludes a candidate at the maximum even when it would fit the budget', () => {
    const result = allocate(
      [
        { id: 'a1', tokens: 1, priority: 900, category: 'a' },
        { id: 'a2', tokens: 1, priority: 800, category: 'a' },
      ],
      { available: 100, policy: constraints({ category: 'a', maxBlocks: 1 }) },
    );

    expect(result.excluded[0]?.reason).toBe('EXCLUDED_CATEGORY_MAXIMUM');
    expect(result.unallocatedBlockContentTokens).toBe(99);
  });
});

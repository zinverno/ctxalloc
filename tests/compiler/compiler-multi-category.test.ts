import { describe, expect, it } from 'vitest';
import {
  allocationSlice,
  blockPenaltyTokenizer,
  compile,
  compilerPolicy,
  failureOf,
  finalReasons,
  includedIds,
  permutations,
  recordingTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

/**
 * Deterministic enumeration across several constrained categories (DEC-038).
 *
 * ```text
 * constrained categories   sorted by project-owned code-unit comparison
 * candidates in a category tokenCount asc -> score.total desc -> block ID asc
 * combinations of size k   lexicographic index order over that sorted list
 * the Cartesian product    first category slowest, last category fastest
 * ```
 *
 * The last rule is what makes the very first hard base the allocator's own
 * preferred category-minimum choice.
 */

/** Categories `B` and `a`: code-unit order puts `B` first, locale order does not. */
const TWO_CATEGORY_POLICY = compilerPolicy({
  allocation: allocationSlice([
    { category: 'a', minBlocks: 1 },
    { category: 'B', minBlocks: 1 },
  ]),
});

const TWO_CATEGORY_SPECS: readonly CandidateSpec[] = [
  { id: 'req', tokens: 2, required: true, priority: 0 },
  { id: 'aOne', tokens: 1, category: 'a', priority: 400 },
  { id: 'aTwo', tokens: 4, category: 'a', priority: 300 },
  { id: 'bOne', tokens: 1, category: 'B', priority: 200 },
  { id: 'bTwo', tokens: 4, category: 'B', priority: 100 },
];

/** Only `aOne` renders expensively, so `{bOne, aTwo}` is the first fitting base. */
const ONE_PENALTY = blockPenaltyTokenizer({ aOne: 20 }, 'test:one-penalty');

/** Both cheap-by-content minimums render expensively, so nothing fits. */
const TWO_PENALTIES = blockPenaltyTokenizer({ aOne: 20, bOne: 20 }, 'test:two-penalties');

function twoCategories(tokenizer = ONE_PENALTY, available = 8): ReturnType<typeof compile> {
  return compile({ specs: TWO_CATEGORY_SPECS, available, policy: TWO_CATEGORY_POLICY }, tokenizer);
}

describe('DEC-038: multi-category hard-base enumeration', () => {
  it('INV-DET-002: sorts constrained categories by code unit, never by locale', () => {
    const result = twoCategories();

    // After the required-only probe, code-unit order visits {bOne, aOne} then
    // {bOne, aTwo}, and the second one fits. A locale order ("a" before "B")
    // would need one visit more.
    expect(result.trace.settlement.fallbackSearch.selectionsVisited).toBe(3);
    expect(result.trace.settlement.fallbackSearch.phase).toBe('hard-base');
    expect([...includedIds(result)].sort()).toEqual(['aTwo', 'bOne', 'req']);
    expect('B'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('orders candidates inside a category by tokenCount, then score, then ID', () => {
    // Two `a` candidates of equal token cost: the higher score is preferred, and
    // the identifier settles a genuine tie.
    const specs: readonly CandidateSpec[] = [
      { id: 'req', tokens: 2, required: true, priority: 0 },
      { id: 'aLow', tokens: 1, category: 'a', priority: 100 },
      { id: 'aHigh', tokens: 1, category: 'a', priority: 900 },
    ];
    const policy = compilerPolicy({
      allocation: allocationSlice([{ category: 'a', minBlocks: 1 }]),
    });
    // `aHigh` renders too expensively, so the search must move on to `aLow`.
    const result = compile(
      { specs, available: 5, policy },
      blockPenaltyTokenizer({ aHigh: 20 }, 'test:high-penalty'),
    );

    expect(result.trace.settlement.fallbackSearch.selectionsVisited).toBe(3);
    expect([...includedIds(result)].sort()).toEqual(['aLow', 'req']);
    expect(finalReasons(result)['aLow']).toBe('INCLUDED_CATEGORY_MINIMUM');
    expect(finalReasons(result)['aHigh']).toBe('EXCLUDED_RENDER_AWARE_CORRECTION');
  });

  it('varies the last category fastest, so the first base is the allocator preference', () => {
    const failure = failureOf(() => twoCategories(TWO_PENALTIES));
    const issue = failure.issues[0] as { code: string } | undefined;

    // Four combinations, in this order: (bOne,aOne) — the allocator's own
    // minimum-cost choice — then (bOne,aTwo), (bTwo,aOne), (bTwo,aTwo).
    expect(issue?.code).toBe('rendered_hard_constraints_exceed_budget');
    let message = '';
    try {
      twoCategories(TWO_PENALTIES);
    } catch (error) {
      message = (error as Error).message;
    }
    // The exhaustion and the work are stated separately: the visit count is
    // work, not a count of policy-valid final selections.
    expect(message).toContain('fallback search exhausted after visiting');
    expect(message).toContain(
      'no policy-valid final selection satisfying every required block and every category block-count constraint',
    );
    expect(message).not.toMatch(/\d+ policy-valid selection\(s\)/);
  });

  it('counts a content-over-budget base as visited but never renders it', () => {
    const calls: string[] = [];
    failureOf(() =>
      compile(
        { specs: TWO_CATEGORY_SPECS, available: 8, policy: TWO_CATEGORY_POLICY },
        recordingTokenizer(calls, TWO_PENALTIES),
      ),
    );

    // {req, bTwo, aTwo} costs 10 content tokens against an 8-token ceiling, so it
    // is visited — it counts toward the search bound — and never rendered. The
    // other three bases are content-valid and are all measured exactly.
    const renders = calls.filter((text) => text.includes('"blockId":'));
    expect(renders.some((text) => text.includes('"blockId":"aTwo"'))).toBe(true);
    expect(renders.some((text) => text.includes('"blockId":"bTwo"'))).toBe(true);
    expect(
      renders.filter(
        (text) => text.includes('"blockId":"aTwo"') && text.includes('"blockId":"bTwo"'),
      ),
    ).toHaveLength(0);
  });

  it('INV-BUDGET-003: every settled hard base holds every required block', () => {
    const result = twoCategories();
    expect(includedIds(result)).toContain('req');
    expect(finalReasons(result)['req']).toBe('INCLUDED_REQUIRED');
  });

  it('INV-ALLOC-003: satisfies each category minimum exactly, with no surplus', () => {
    const result = twoCategories();
    const ids = includedIds(result);

    expect(ids.filter((id) => id.startsWith('a'))).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith('b'))).toHaveLength(1);
  });

  it('INV-ALLOC-003: never exceeds a category maximum', () => {
    const policy = compilerPolicy({
      allocation: allocationSlice([{ category: 'a', minBlocks: 1, maxBlocks: 1 }]),
    });
    const result = compile(
      {
        specs: [
          { id: 'req', tokens: 2, required: true, priority: 0 },
          { id: 'aOne', tokens: 1, category: 'a', priority: 400 },
          { id: 'aTwo', tokens: 3, category: 'a', priority: 300 },
        ],
        available: 6,
        policy,
      },
      blockPenaltyTokenizer({ aOne: 20 }, 'test:max-penalty'),
    );

    expect(includedIds(result).filter((id) => id.startsWith('a'))).toHaveLength(1);
    expect([...includedIds(result)].sort()).toEqual(['aTwo', 'req']);
  });

  it('INV-DET-001, INV-ALLOC-005: enumeration is stable under input permutation', () => {
    const optional = TWO_CATEGORY_SPECS.filter((spec) => spec.id !== 'req');
    const results = permutations([...optional]).map((specs) =>
      compile(
        {
          specs: [TWO_CATEGORY_SPECS[0] as CandidateSpec, ...specs],
          available: 8,
          policy: TWO_CATEGORY_POLICY,
        },
        ONE_PENALTY,
      ),
    );
    const [first] = results;
    for (const result of results) {
      expect(result.compiledContext).toBe(first?.compiledContext);
      expect(result.trace.settlement.fallbackSearch).toEqual(
        first?.trace.settlement.fallbackSearch,
      );
    }
  });

  it('settles the first exact-render fitting base and stops searching', () => {
    const result = twoCategories();
    expect(result.trace.settlement.fallbackSearch.selectionsVisited).toBe(3);
    expect(result.trace.settlement.fallbackSearch.chosenBlockIds).toEqual(['aTwo', 'bOne', 'req']);
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(8);
  });
});

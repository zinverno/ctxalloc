import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  budget,
  includedIds,
  issuesOf,
  permutations,
  reasonsOf,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * Required blocks are a separate allocation class.
 *
 * They are resolved before every optional block, they are never removed to
 * repair a budget or a category maximum, and they are never expressed as a large
 * score (INV-ALLOC-001, INV-BUDGET-003, INV-SCORE-003).
 */

describe('INV-ALLOC-001: required blocks are resolved before optional blocks', () => {
  it('includes a required block before a higher-scoring optional one', () => {
    const result = allocate(
      [
        { id: 'opt', tokens: 3, priority: 1000 },
        { id: 'req', tokens: 3, priority: 0, required: true },
      ],
      { available: 20 },
    );

    expect(includedIds(result)).toEqual(['req', 'opt']);
    expect(result.included[0]?.reason).toBe('INCLUDED_REQUIRED');
    expect(result.included[1]?.reason).toBe('INCLUDED_SCORE_ORDER');
  });

  it('INV-SCORE-003: a required block scoring zero still precedes every optional block', () => {
    const result = allocate(
      [
        { id: 'a', tokens: 1, priority: 900 },
        { id: 'z', tokens: 1, priority: 0, required: true },
      ],
      { available: 20 },
    );

    expect(includedIds(result)).toEqual(['z', 'a']);
    expect(result.included[0]?.candidate.score.total).toBe(0);
  });

  it('INV-DET-005: orders required decisions by block identifier, never by score', () => {
    const result = allocate(
      [
        { id: 'r-c', tokens: 1, priority: 1000, required: true },
        { id: 'r-a', tokens: 1, priority: 0, required: true },
        { id: 'r-b', tokens: 1, priority: 500, required: true },
      ],
      { available: 20 },
    );

    expect(includedIds(result)).toEqual(['r-a', 'r-b', 'r-c']);
  });

  it('spends the required budget before any optional candidate is considered', () => {
    const result = allocate(
      [
        { id: 'opt', tokens: 5, priority: 1000 },
        { id: 'req', tokens: 8, priority: 0, required: true },
      ],
      { available: 10 },
    );

    expect(reasonsOf(result)).toEqual({
      req: 'INCLUDED_REQUIRED',
      opt: 'EXCLUDED_BUDGET_EXHAUSTED',
    });
    expect(result.excluded[0]?.remainingTokens).toBe(2);
  });

  it('INV-ALLOC-006: no required block appears in the eviction order', () => {
    const result = allocate(
      [
        { id: 'req', tokens: 2, priority: 0, required: true },
        { id: 'opt', tokens: 2, priority: 1000 },
      ],
      { available: 20 },
    );

    expect(result.optionalEvictionOrder).toEqual(['opt']);
  });

  it('reads required status from the canonical block after deduplication', () => {
    // Two wrappers of the same exact content, one optional and one required:
    // Phase 8 makes the required block canonical, and this stage reads that
    // canonical group contract rather than inspecting a duplicate member
    // (INV-DEDUP-002).
    const shared = 'one exact shared sentence';
    const result = allocate(
      [
        { id: 'dup-optional', content: shared, priority: 900 },
        { id: 'dup-required', content: shared, priority: 0, required: true },
      ],
      { available: 20 },
    );

    expect(result.included).toHaveLength(1);
    expect(includedIds(result)).toEqual(['dup-required']);
    expect(result.included[0]?.reason).toBe('INCLUDED_REQUIRED');
    expect(result.optionalEvictionOrder).toEqual([]);
  });
});

describe('INV-BUDGET-004: required block content over the ceiling fails explicitly', () => {
  it('fails when one required block is larger than the available budget', () => {
    const issues = issuesOf(() =>
      allocate([{ id: 'req', tokens: 11, required: true }], { available: 10 }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
    expect(issues[0]?.pointer).toBe('candidates.req.tokenCount');
    expect(issues[0]?.message).toContain('11');
  });

  it('fails when several individually small required blocks are collectively too large', () => {
    const issues = issuesOf(() =>
      allocate(
        [
          { id: 'r1', tokens: 4, required: true },
          { id: 'r2', tokens: 4, required: true },
          { id: 'r3', tokens: 4, required: true },
        ],
        { available: 10 },
      ),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
    // Traversal is by block identifier, so the witness is the third block.
    expect(issues[0]?.pointer).toBe('candidates.r3.tokenCount');
  });

  it('succeeds when required content exactly equals the available content budget', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 6, required: true },
        { id: 'r2', tokens: 4, required: true },
      ],
      { available: 10 },
    );

    expect(result.selectedBlockContentTokens).toBe(10);
    expect(result.unallocatedBlockContentTokens).toBe(0);
  });

  it('returns no partial result and removes no required block', () => {
    let result: unknown;
    try {
      result = allocate(
        [
          { id: 'r1', tokens: 9, required: true },
          { id: 'r2', tokens: 9, required: true },
        ],
        { available: 10 },
      );
    } catch {
      expect(result).toBeUndefined();
      return;
    }
    throw new Error('expected the impossible required content to be rejected');
  });

  it('INV-ALLOC-005: input order does not change the failure', () => {
    const specs: CandidateSpec[] = [
      { id: 'r1', tokens: 7, priority: 100, required: true },
      { id: 'r2', tokens: 7, priority: 900, required: true },
      { id: 'o1', tokens: 1, priority: 500 },
    ];
    const expected = issuesOf(() => allocate(specs, { available: 10 }));

    for (const permutation of permutations(specs)) {
      expect(issuesOf(() => allocate(permutation, { available: 10 }))).toEqual(expected);
    }
  });

  it('stays exact for token counts near Number.MAX_SAFE_INTEGER', () => {
    // Two blocks whose counts would each fit but whose sum overflows the safe
    // range if it were added before being compared.
    const huge = Number.MAX_SAFE_INTEGER - 1;
    const scoredSpecs: CandidateSpec[] = [{ id: 'r1', tokens: 3, required: true }];
    const result = allocate(scoredSpecs, {
      budget: { totalTokens: huge, reservedOutputTokens: 1 },
    });

    expect(result.availableInputTokens).toBe(huge - 1);
    expect(result.unallocatedBlockContentTokens).toBe(huge - 4);
    expect(Number.isSafeInteger(result.unallocatedBlockContentTokens)).toBe(true);
  });

  it('makes no claim about the rendered budget', () => {
    const result = allocate([{ id: 'req', tokens: 10, required: true }], { available: 10 });
    // The block content fits exactly. Whatever a renderer adds — labels,
    // separators, wrappers — has no room left, and this stage does not pretend
    // otherwise: it publishes block-content metrics only (INV-BUDGET-002).
    expect(Object.keys(result)).not.toContain('compiledTokens');
    expect(Object.keys(result)).not.toContain('unusedTokens');
    expect(result.selectedBlockContentTokens).toBe(10);
  });
});

describe('required blocks and the eviction order', () => {
  it('never evicts a required block even when nothing else is selected', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 4, required: true },
        { id: 'r2', tokens: 4, required: true },
      ],
      { available: 10, policy: allocationPolicy() },
    );

    expect(result.optionalEvictionOrder).toEqual([]);
  });

  it('accepts a required-only batch with a zero available budget only when it is empty', () => {
    expect(() =>
      allocate([{ id: 'r1', tokens: 1, required: true }], { budget: budget(0) }),
    ).toThrowError(/required block content does not fit/);
  });
});

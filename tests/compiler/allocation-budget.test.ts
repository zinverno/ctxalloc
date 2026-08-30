import { BudgetAllocator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { availableInputTokens, TokenBudgetSchema } from '../../packages/domain/src/index.js';
import {
  allocate,
  allocationPolicy,
  budget,
  issueCodesOf,
  scoreSpecs,
} from './allocation-fixtures.js';
import { REFERENCE_TIME } from './scoring-fixtures.js';

/**
 * Budget validation and the basic allocation contract.
 *
 * The budget is validated with the existing `TokenBudgetSchema` and its ceiling
 * comes from the existing `availableInputTokens()`. This stage restates neither
 * rule and adds no reserve of its own (DEC-033, INV-BUDGET-001, INV-BUDGET-005).
 */

function rejectBudget(value: unknown): readonly string[] {
  return issueCodesOf(() => allocate([{ id: 'b1' }], { budget: value }));
}

describe('BudgetAllocator budget validation', () => {
  it('accepts a valid budget and reports the ceiling of the existing helper', () => {
    const supplied = {
      totalTokens: 1000,
      reservedOutputTokens: 200,
      reservedSystemTokens: 50,
      reservedToolTokens: 25,
      reservedProtocolTokens: 5,
    };
    const result = allocate([{ id: 'b1', tokens: 4 }], { budget: supplied });
    const parsed = TokenBudgetSchema.parse(supplied);

    expect(result.availableInputTokens).toBe(availableInputTokens(parsed));
    expect(result.availableInputTokens).toBe(720);
    expect(result.tokenBudget).toEqual(supplied);
  });

  it('INV-BUDGET-001: adds no hidden reserve of its own', () => {
    const result = allocate([{ id: 'b1', tokens: 4 }], {
      budget: { totalTokens: 100, reservedOutputTokens: 10 },
    });
    // No rendering reserve, no safety margin, no rounding: exactly the helper.
    expect(result.availableInputTokens).toBe(90);
    expect(result.selectedBlockContentTokens).toBe(4);
    expect(result.unallocatedBlockContentTokens).toBe(86);
  });

  it('keeps an omitted optional reserve absent rather than defaulting it to zero', () => {
    const result = allocate([{ id: 'b1' }], {
      budget: { totalTokens: 50, reservedOutputTokens: 10 },
    });
    expect(Object.keys(result.tokenBudget).sort()).toEqual(['reservedOutputTokens', 'totalTokens']);
  });

  it('accepts a zero available budget when nothing is required', () => {
    const result = allocate([{ id: 'b1', tokens: 3 }], {
      budget: { totalTokens: 10, reservedOutputTokens: 10 },
    });

    expect(result.availableInputTokens).toBe(0);
    expect(result.included).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.reason).toBe('EXCLUDED_BUDGET_EXHAUSTED');
    expect(result.selectedBlockContentTokens).toBe(0);
    expect(result.unallocatedBlockContentTokens).toBe(0);
  });

  it('INV-BUDGET-005: rejects a budget that is not made of non-negative integers', () => {
    for (const invalid of [
      undefined,
      null,
      'budget',
      { totalTokens: -1, reservedOutputTokens: 0 },
      { totalTokens: 10.5, reservedOutputTokens: 0 },
      { totalTokens: '100', reservedOutputTokens: 0 },
      { totalTokens: Number.NaN, reservedOutputTokens: 0 },
      { totalTokens: Number.POSITIVE_INFINITY, reservedOutputTokens: 0 },
      { totalTokens: 100 },
      { totalTokens: 100, reservedOutputTokens: 0, unknownReserve: 1 },
    ]) {
      const codes = rejectBudget(invalid);
      expect(codes.length, JSON.stringify(invalid)).toBeGreaterThan(0);
      expect(new Set(codes), JSON.stringify(invalid)).toEqual(new Set(['invalid_budget']));
    }
  });

  it('INV-BUDGET-005: rejects reserves that exceed the total', () => {
    expect(rejectBudget({ totalTokens: 100, reservedOutputTokens: 101 })).toEqual([
      'invalid_budget',
    ]);
    expect(
      rejectBudget({
        totalTokens: 100,
        reservedOutputTokens: 60,
        reservedSystemTokens: 41,
      }),
    ).toEqual(['invalid_budget']);
  });

  it('accepts reserves exactly equal to the total', () => {
    const result = allocate([], { budget: { totalTokens: 100, reservedOutputTokens: 100 } });
    expect(result.availableInputTokens).toBe(0);
  });

  it('does not mutate the caller budget object', () => {
    const supplied = { totalTokens: 100, reservedOutputTokens: 10 };
    const snapshot = structuredClone(supplied);
    allocate([{ id: 'b1', tokens: 2 }], { budget: supplied });
    expect(supplied).toEqual(snapshot);
  });
});

describe('BudgetAllocator basic allocation', () => {
  it('allocates an empty batch successfully', () => {
    const result = allocate([], { available: 50 });

    expect(result.included).toEqual([]);
    expect(result.excluded).toEqual([]);
    expect(result.optionalEvictionOrder).toEqual([]);
    expect(result.selectedBlockContentTokens).toBe(0);
    expect(result.unallocatedBlockContentTokens).toBe(50);
  });

  it('includes one optional candidate that fits, in score order', () => {
    const result = allocate([{ id: 'b1', tokens: 4, priority: 500 }], { available: 10 });

    expect(result.included).toHaveLength(1);
    expect(result.included[0]?.reason).toBe('INCLUDED_SCORE_ORDER');
    expect(result.included[0]?.contentTokens).toBe(4);
    expect(result.included[0]?.remainingBefore).toBe(10);
    expect(result.included[0]?.remainingAfter).toBe(6);
  });

  it('excludes one optional candidate that does not fit', () => {
    const result = allocate([{ id: 'b1', tokens: 11 }], { available: 10 });

    expect(result.included).toEqual([]);
    expect(result.excluded[0]?.reason).toBe('EXCLUDED_BUDGET_EXHAUSTED');
    expect(result.excluded[0]?.contentTokens).toBe(11);
    expect(result.excluded[0]?.remainingTokens).toBe(10);
    expect(result.unallocatedBlockContentTokens).toBe(10);
  });

  it('includes one required candidate that fits', () => {
    const result = allocate([{ id: 'b1', tokens: 4, required: true }], { available: 10 });

    expect(result.included[0]?.reason).toBe('INCLUDED_REQUIRED');
    expect(result.selectedBlockContentTokens).toBe(4);
  });

  it('preserves the scope, the scoring identity, and the reference time', () => {
    const scored = scoreSpecs([{ id: 'b1', tokens: 2 }]);
    const result = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(10));

    expect(result.scope).toEqual(scored.scope);
    expect(result.scoringPolicyId).toBe('scoring');
    expect(result.scoringPolicyVersion).toBe('1.0.0');
    expect(result.allocationPolicyId).toBe('allocation');
    expect(result.allocationPolicyVersion).toBe('1.0.0');
    expect(result.referenceTime).toBe(REFERENCE_TIME);
  });

  it('returns the same source records, sorted by identifier', () => {
    const scored = scoreSpecs([{ id: 'b1', tokens: 2 }]);
    const registry = [
      { ...(scored.sourceDocuments[0] as object), id: 'doc-9' },
      scored.sourceDocuments[0],
      { ...(scored.sourceDocuments[0] as object), id: 'doc-2' },
    ] as typeof scored.sourceDocuments;
    const result = new BudgetAllocator(allocationPolicy()).allocate(
      { ...scored, sourceDocuments: registry },
      budget(10),
    );

    expect(result.sourceDocuments.map((document) => document.id)).toEqual([
      'doc-1',
      'doc-2',
      'doc-9',
    ]);
    // The same records by reference: nothing is rebuilt or rewritten.
    expect(result.sourceDocuments[0]).toBe(registry[1]);
    expect(registry.map((document) => document?.id)).toEqual(['doc-9', 'doc-1', 'doc-2']);
  });

  it('INV-ALLOC-004: mutates no part of the scored input', () => {
    const scored = scoreSpecs([
      { id: 'b1', tokens: 3, priority: 100, category: 'a' },
      { id: 'b2', tokens: 3, priority: 900, required: true },
    ]);
    const snapshot = structuredClone(scored);

    new BudgetAllocator(
      allocationPolicy({ categoryConstraints: [{ category: 'a', minBlocks: 1 }] }),
    ).allocate(scored, budget(10));

    expect(scored).toEqual(snapshot);
  });

  it('carries every scored candidate through by reference', () => {
    const scored = scoreSpecs([{ id: 'b1', tokens: 2 }]);
    const result = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(10));
    expect(result.included[0]?.candidate).toBe(scored.candidates[0]);
  });
});

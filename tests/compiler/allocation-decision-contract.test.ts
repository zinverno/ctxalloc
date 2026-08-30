import type {
  AllocationDecisionReason,
  ExcludedCandidateDecision,
  IncludedCandidateDecision,
  ScoredCandidate,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { allocate, allocationPolicy, scoreSpecs } from './allocation-fixtures.js';

/**
 * The decision records are correctly discriminated (DEC-033).
 *
 * `AllocationDecisionReason` remains the full vocabulary for a consumer that
 * handles both arrays together, but neither record accepts all of it: an
 * inclusion carries only an `INCLUDED_*` reason and an exclusion only an
 * `EXCLUDED_*` one, so an impossible pairing is not expressible in the published
 * contract, exactly as it is unreachable at runtime (INV-TRACE-002).
 *
 * These are compile-time assertions first: the `@ts-expect-error` comments fail
 * the build if either interface is ever widened back to the full union.
 */

const SCORED: ScoredCandidate = scoreSpecs([{ id: 'b1', tokens: 2, priority: 900 }])
  .candidates[0] as ScoredCandidate;

describe('INV-TRACE-002: allocation decision reasons are class-specific', () => {
  it('accepts every inclusion reason on an included decision', () => {
    const decisions: IncludedCandidateDecision[] = (
      ['INCLUDED_REQUIRED', 'INCLUDED_CATEGORY_MINIMUM', 'INCLUDED_SCORE_ORDER'] as const
    ).map((reason) => ({
      candidate: SCORED,
      decision: 'included',
      reason,
      contentTokens: 2,
      remainingBefore: 5,
      remainingAfter: 3,
    }));

    expect(decisions.map((decision) => decision.reason)).toEqual([
      'INCLUDED_REQUIRED',
      'INCLUDED_CATEGORY_MINIMUM',
      'INCLUDED_SCORE_ORDER',
    ]);
  });

  it('accepts every exclusion reason on an excluded decision', () => {
    const decisions: ExcludedCandidateDecision[] = (
      ['EXCLUDED_CATEGORY_MAXIMUM', 'EXCLUDED_BUDGET_EXHAUSTED'] as const
    ).map((reason) => ({
      candidate: SCORED,
      decision: 'excluded',
      reason,
      contentTokens: 2,
      remainingTokens: 5,
    }));

    expect(decisions.map((decision) => decision.reason)).toEqual([
      'EXCLUDED_CATEGORY_MAXIMUM',
      'EXCLUDED_BUDGET_EXHAUSTED',
    ]);
  });

  it('rejects an exclusion reason on an included decision', () => {
    const budgetExhausted: IncludedCandidateDecision = {
      candidate: SCORED,
      decision: 'included',
      // @ts-expect-error an included decision must not carry an exclusion reason
      reason: 'EXCLUDED_BUDGET_EXHAUSTED',
      contentTokens: 2,
      remainingBefore: 5,
      remainingAfter: 3,
    };
    const categoryMaximum: IncludedCandidateDecision = {
      candidate: SCORED,
      decision: 'included',
      // @ts-expect-error an included decision must not carry an exclusion reason
      reason: 'EXCLUDED_CATEGORY_MAXIMUM',
      contentTokens: 2,
      remainingBefore: 5,
      remainingAfter: 3,
    };

    // The values exist only so the compile-time assertions above are checked.
    expect([budgetExhausted.decision, categoryMaximum.decision]).toEqual(['included', 'included']);
  });

  it('rejects an inclusion reason on an excluded decision', () => {
    const required: ExcludedCandidateDecision = {
      candidate: SCORED,
      decision: 'excluded',
      // @ts-expect-error an excluded decision must not carry an inclusion reason
      reason: 'INCLUDED_REQUIRED',
      contentTokens: 2,
      remainingTokens: 5,
    };
    const categoryMinimum: ExcludedCandidateDecision = {
      candidate: SCORED,
      decision: 'excluded',
      // @ts-expect-error an excluded decision must not carry an inclusion reason
      reason: 'INCLUDED_CATEGORY_MINIMUM',
      contentTokens: 2,
      remainingTokens: 5,
    };
    const scoreOrder: ExcludedCandidateDecision = {
      candidate: SCORED,
      decision: 'excluded',
      // @ts-expect-error an excluded decision must not carry an inclusion reason
      reason: 'INCLUDED_SCORE_ORDER',
      contentTokens: 2,
      remainingTokens: 5,
    };

    expect([required.decision, categoryMinimum.decision, scoreOrder.decision]).toEqual([
      'excluded',
      'excluded',
      'excluded',
    ]);
  });

  it('keeps all five machine-readable codes in AllocationDecisionReason', () => {
    // Every code is assignable to the published union, and the union is the sum
    // of the two narrower classes: a consumer handling both arrays together
    // still has one vocabulary to switch on.
    const vocabulary: readonly AllocationDecisionReason[] = [
      'INCLUDED_REQUIRED',
      'INCLUDED_CATEGORY_MINIMUM',
      'INCLUDED_SCORE_ORDER',
      'EXCLUDED_CATEGORY_MAXIMUM',
      'EXCLUDED_BUDGET_EXHAUSTED',
    ];
    const inclusionReason: AllocationDecisionReason = 'INCLUDED_REQUIRED' as const;
    const exclusionReason: AllocationDecisionReason = 'EXCLUDED_BUDGET_EXHAUSTED' as const;

    expect(vocabulary).toHaveLength(5);
    expect(new Set(vocabulary).size).toBe(5);
    expect([inclusionReason, exclusionReason]).toEqual([
      'INCLUDED_REQUIRED',
      'EXCLUDED_BUDGET_EXHAUSTED',
    ]);
  });

  it('produces byte-identical runtime output under the narrowed contract', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 2, priority: 0, required: true },
        { id: 'm1', tokens: 1, priority: 100, category: 'facts' },
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

    expect(
      result.included.map((decision) => ({
        id: decision.candidate.candidate.canonicalBlock.id,
        decision: decision.decision,
        reason: decision.reason,
        contentTokens: decision.contentTokens,
        remainingBefore: decision.remainingBefore,
        remainingAfter: decision.remainingAfter,
      })),
    ).toEqual([
      {
        id: 'r1',
        decision: 'included',
        reason: 'INCLUDED_REQUIRED',
        contentTokens: 2,
        remainingBefore: 6,
        remainingAfter: 4,
      },
      {
        id: 'm1',
        decision: 'included',
        reason: 'INCLUDED_CATEGORY_MINIMUM',
        contentTokens: 1,
        remainingBefore: 4,
        remainingAfter: 3,
      },
      {
        id: 'x1',
        decision: 'included',
        reason: 'INCLUDED_SCORE_ORDER',
        contentTokens: 1,
        remainingBefore: 3,
        remainingAfter: 2,
      },
    ]);
    expect(
      result.excluded.map((decision) => ({
        id: decision.candidate.candidate.canonicalBlock.id,
        decision: decision.decision,
        reason: decision.reason,
        contentTokens: decision.contentTokens,
        remainingTokens: decision.remainingTokens,
      })),
    ).toEqual([
      {
        id: 'x2',
        decision: 'excluded',
        reason: 'EXCLUDED_CATEGORY_MAXIMUM',
        contentTokens: 1,
        remainingTokens: 2,
      },
      {
        id: 'e1',
        decision: 'excluded',
        reason: 'EXCLUDED_BUDGET_EXHAUSTED',
        contentTokens: 99,
        remainingTokens: 2,
      },
    ]);
    expect(result.selectedBlockContentTokens).toBe(4);
    expect(result.unallocatedBlockContentTokens).toBe(2);
    expect(result.optionalEvictionOrder).toEqual(['x1']);
  });
});

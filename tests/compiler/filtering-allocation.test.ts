import { readFileSync } from 'node:fs';
import { BudgetAllocator, CandidateFilter, type AllocatedCandidateSet } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  allocationPolicy,
  budget,
  eligibleIds,
  filteringPolicy,
  includedIds,
  scoreSpecs,
  type CandidateSpec,
} from './filtering-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/** Allocates a scored batch after filtering it with the supplied policy. */
function filterThenAllocate(
  specs: readonly CandidateSpec[],
  options: {
    readonly filtering?: Record<string, unknown>;
    readonly allocation?: Record<string, unknown>;
    readonly available?: number;
  } = {},
): AllocatedCandidateSet {
  const filtered = new CandidateFilter(options.filtering ?? filteringPolicy()).filter(
    scoreSpecs(specs),
  );
  return new BudgetAllocator(options.allocation ?? allocationPolicy()).allocate(
    filtered.eligible,
    budget(options.available ?? 1000),
  );
}

const BATCH = [
  { id: 'high', priority: 900, tokens: 5 },
  { id: 'mid', priority: 500, tokens: 5 },
  { id: 'low', priority: 100, tokens: 5 },
] as const;

/**
 * The filter feeds the existing allocator (DEC-036).
 *
 * The eligible set is a `ScoredCandidateSet`, so `BudgetAllocator` consumes it
 * with no change to its signature, its policy, or its behavior.
 */
describe('INV-ALLOC-002: CandidateFilter hands eligibility to the unchanged allocator', () => {
  it('allocates the eligible set directly', () => {
    const result = filterThenAllocate(BATCH, {
      filtering: filteringPolicy({ minimumTotalScore: 0.4 }),
    });

    expect(includedIds(result)).toEqual(['high', 'mid']);
    expect(result.excluded).toEqual([]);
  });

  it('removes a low-scoring optional candidate before allocation, not during it', () => {
    const filtered = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(
      scoreSpecs(BATCH),
    );
    const result = new BudgetAllocator(allocationPolicy()).allocate(
      filtered.eligible,
      budget(1000),
    );

    // The allocator never saw `low`, so it produced no decision about it: the
    // filter's decision is the only one, and it is not an allocation decision.
    expect(eligibleIds(filtered)).not.toContain('low');
    expect([
      ...includedIds(result),
      ...result.excluded.map((d) => d.candidate.candidate.canonicalBlock.id),
    ]).not.toContain('low');
    expect(result.optionalEvictionOrder).not.toContain('low');
  });

  it('a no-op filter allocates exactly what the direct scored input allocates', () => {
    const scored = scoreSpecs(BATCH);
    const direct = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(1000));
    const filtered = new CandidateFilter(filteringPolicy()).filter(scored);
    const throughFilter = new BudgetAllocator(allocationPolicy()).allocate(
      filtered.eligible,
      budget(1000),
    );

    expect(throughFilter).toEqual(direct);
  });

  it('INV-BUDGET-003: a required low-scoring block reaches the allocator as required', () => {
    const result = filterThenAllocate(
      [
        { id: 'must', priority: 0, tokens: 5, required: true },
        { id: 'high', priority: 900, tokens: 5 },
      ],
      { filtering: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    expect(includedIds(result)).toEqual(['must', 'high']);
    const required = result.included.find(
      (decision) => decision.candidate.candidate.canonicalBlock.id === 'must',
    );
    expect(required?.reason).toBe('INCLUDED_REQUIRED');
    // Required blocks are never eviction candidates.
    expect(result.optionalEvictionOrder).not.toContain('must');
  });

  it('INV-BUDGET-004: an unfittable required block still fails in the allocator', () => {
    expect(() =>
      filterThenAllocate([{ id: 'must', priority: 0, tokens: 50, required: true }], {
        filtering: filteringPolicy({ minimumTotalScore: 1000 }),
        available: 10,
      }),
    ).toThrowError(/REQUIRED_CONTENT_EXCEEDS_BUDGET|budget/i);
  });

  it('leaves category constraints to the allocator', () => {
    const result = filterThenAllocate(
      [
        { id: 'f1', priority: 900, tokens: 5, category: 'facts' },
        { id: 'f2', priority: 800, tokens: 5, category: 'facts' },
        { id: 'f3', priority: 700, tokens: 5, category: 'facts' },
      ],
      {
        filtering: filteringPolicy(),
        allocation: allocationPolicy({
          categoryConstraints: [{ category: 'facts', maxBlocks: 2 }],
        }),
      },
    );

    expect(includedIds(result)).toEqual(['f1', 'f2']);
    expect(result.excluded[0]?.reason).toBe('EXCLUDED_CATEGORY_MAXIMUM');
  });

  it('leaves budget exhaustion to the allocator', () => {
    const result = filterThenAllocate(BATCH, { filtering: filteringPolicy(), available: 12 });

    expect(includedIds(result)).toEqual(['high', 'mid']);
    expect(result.excluded.map((decision) => decision.reason)).toEqual([
      'EXCLUDED_BUDGET_EXHAUSTED',
    ]);
  });

  it('carries the scoring identity and reference time through the filter into the allocation', () => {
    const scored = scoreSpecs(BATCH);
    const filtered = new CandidateFilter(filteringPolicy()).filter(scored);
    const result = new BudgetAllocator(allocationPolicy()).allocate(
      filtered.eligible,
      budget(1000),
    );

    expect(result.scoringPolicyId).toBe(scored.policyId);
    expect(result.scoringPolicyVersion).toBe(scored.policyVersion);
    expect(result.referenceTime).toBe(scored.referenceTime);
    expect(result.scope).toBe(scored.scope);
  });

  it('BudgetAllocator keeps its documented signature', () => {
    // Comments are stripped: the allocator's TSDoc names its neighbours to
    // describe the topology, which is documentation, not a runtime coupling.
    const source = readFileSync(
      new URL('packages/compiler/src/budget-allocator.ts', rootUrl),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    expect(source).toContain(
      'allocate(input: ScoredCandidateSet, budget: unknown): AllocatedCandidateSet',
    );
    // The allocator learns nothing about filtering: no filtered set, no
    // filtering policy, and no eligibility reason reaches it.
    for (const filteringConcept of [
      'FilteredCandidateSet',
      'CandidateFilteringPolicy',
      'CandidateFilter',
      'ELIGIBLE_POLICY',
      'ELIGIBLE_REQUIRED',
      'FILTERED_SCORE_BELOW_MINIMUM',
      'minimumTotalScore',
    ]) {
      expect(source, `allocator names ${filteringConcept}`).not.toContain(filteringConcept);
    }
  });
});

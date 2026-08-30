import { BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION, BudgetAllocator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { allocate, allocationPolicy, issueCodesOf, issuesOf } from './allocation-fixtures.js';

/**
 * Allocation policy validation.
 *
 * The policy is external configuration and therefore a runtime boundary: it is
 * validated strictly, nothing is coerced, no default is injected, and no
 * declaration order may change a result (DEC-033).
 */

function reject(policy: unknown): readonly string[] {
  return issueCodesOf(() => new BudgetAllocator(policy));
}

describe('BudgetAllocator policy validation', () => {
  it('accepts the minimal policy and publishes its identity verbatim', () => {
    const result = allocate([{ id: 'b1', tokens: 3 }], {
      policy: allocationPolicy({ policyId: ' spaced Id ', policyVersion: '2.0.0-rc.1' }),
    });

    expect(result.allocationPolicyId).toBe(' spaced Id ');
    expect(result.allocationPolicyVersion).toBe('2.0.0-rc.1');
  });

  it('publishes the schema version of the policy contract', () => {
    expect(BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('rejects a policy that is not an object', () => {
    for (const invalid of [undefined, null, 'policy', 7, [], true]) {
      expect(reject(invalid)).toEqual(['invalid_policy']);
    }
  });

  it('rejects an unsupported schema version', () => {
    expect(reject(allocationPolicy({ schemaVersion: 2 }))).toEqual(['invalid_policy']);
    expect(reject(allocationPolicy({ schemaVersion: '1' }))).toEqual(['invalid_policy']);
  });

  it('rejects a blank policy identity', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(reject(allocationPolicy({ policyId: blank }))).toEqual(['invalid_policy']);
      expect(reject(allocationPolicy({ policyVersion: blank }))).toEqual(['invalid_policy']);
    }
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 in policy strings and categories', () => {
    const loneSurrogate = '\ud800';
    expect(reject(allocationPolicy({ policyId: `p${loneSurrogate}` }))).toEqual(['invalid_policy']);
    expect(reject(allocationPolicy({ policyVersion: `1${loneSurrogate}` }))).toEqual([
      'invalid_policy',
    ]);
    expect(
      reject(
        allocationPolicy({
          categoryConstraints: [{ category: loneSurrogate, minBlocks: 1 }],
        }),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('rejects an unknown policy field rather than stripping it', () => {
    expect(reject(allocationPolicy({ evictionOrder: 'score-asc' }))).toEqual(['invalid_policy']);
    expect(
      reject(allocationPolicy({ categoryConstraints: [{ category: 'a', minTokens: 5 }] })),
    ).toEqual(['invalid_policy']);
  });

  it('rejects an unsupported optional selection strategy', () => {
    for (const strategy of ['knapsack', 'score-per-token', 'random', '', undefined]) {
      expect(reject(allocationPolicy({ optionalSelection: strategy }))).toEqual(['invalid_policy']);
    }
  });

  it('accepts an absent and an empty category constraint list', () => {
    expect(() => new BudgetAllocator(allocationPolicy())).not.toThrow();
    expect(() => new BudgetAllocator(allocationPolicy({ categoryConstraints: [] }))).not.toThrow();
  });

  it('accepts the empty category, which ContextBlock also permits', () => {
    const result = allocate([{ id: 'b1', tokens: 2, category: '' }], {
      policy: allocationPolicy({ categoryConstraints: [{ category: '', maxBlocks: 0 }] }),
    });
    expect(result.included).toHaveLength(0);
    expect(result.excluded[0]?.reason).toBe('EXCLUDED_CATEGORY_MAXIMUM');
  });

  it('accepts minBlocks alone, maxBlocks alone, both, zero, and equal bounds', () => {
    for (const constraint of [
      { category: 'a', minBlocks: 1 },
      { category: 'a', maxBlocks: 1 },
      { category: 'a', minBlocks: 1, maxBlocks: 2 },
      { category: 'a', minBlocks: 0 },
      { category: 'a', maxBlocks: 0 },
      { category: 'a', minBlocks: 2, maxBlocks: 2 },
      { category: 'a', minBlocks: 0, maxBlocks: 0 },
    ]) {
      expect(
        () => new BudgetAllocator(allocationPolicy({ categoryConstraints: [constraint] })),
        JSON.stringify(constraint),
      ).not.toThrow();
    }
  });

  it('rejects a negative, fractional, unsafe, or non-numeric block count', () => {
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '2',
      null,
    ]) {
      expect(
        reject(allocationPolicy({ categoryConstraints: [{ category: 'a', minBlocks: invalid }] })),
        `minBlocks ${String(invalid)}`,
      ).toEqual(['invalid_policy']);
      expect(
        reject(allocationPolicy({ categoryConstraints: [{ category: 'a', maxBlocks: invalid }] })),
        `maxBlocks ${String(invalid)}`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('rejects a constraint that declares neither bound', () => {
    expect(reject(allocationPolicy({ categoryConstraints: [{ category: 'a' }] }))).toEqual([
      'invalid_policy',
    ]);
  });

  it('rejects minBlocks greater than maxBlocks', () => {
    expect(
      reject(
        allocationPolicy({ categoryConstraints: [{ category: 'a', minBlocks: 3, maxBlocks: 2 }] }),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('INV-DET-002: rejects two constraints owning the same exact category', () => {
    const issues = issuesOf(
      () =>
        new BudgetAllocator(
          allocationPolicy({
            categoryConstraints: [
              { category: 'facts', minBlocks: 1 },
              { category: 'facts', maxBlocks: 4 },
            ],
          }),
        ),
    );
    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_category_constraint']);
    expect(issues[0]?.pointer).toBe('categoryConstraints[1].category');
    expect(issues[0]?.message).toContain('categoryConstraints[0]');
  });

  it('treats categories that differ only in case or whitespace as distinct', () => {
    expect(
      () =>
        new BudgetAllocator(
          allocationPolicy({
            categoryConstraints: [
              { category: 'facts', maxBlocks: 1 },
              { category: 'Facts', maxBlocks: 1 },
              { category: 'facts ', maxBlocks: 1 },
            ],
          }),
        ),
    ).not.toThrow();
  });

  it('INV-DET-002: constraint declaration order does not change the result', () => {
    const specs = [
      { id: 'a1', tokens: 2, priority: 100, category: 'a' },
      { id: 'a2', tokens: 2, priority: 900, category: 'a' },
      { id: 'b1', tokens: 2, priority: 500, category: 'b' },
    ];
    const forward = allocate(specs, {
      available: 4,
      policy: allocationPolicy({
        categoryConstraints: [
          { category: 'a', maxBlocks: 1 },
          { category: 'b', minBlocks: 1 },
        ],
      }),
    });
    const reversed = allocate(specs, {
      available: 4,
      policy: allocationPolicy({
        categoryConstraints: [
          { category: 'b', minBlocks: 1 },
          { category: 'a', maxBlocks: 1 },
        ],
      }),
    });
    expect(reversed).toEqual(forward);
  });

  it('does not mutate or reorder the caller policy object', () => {
    const constraints = [
      { category: 'b', maxBlocks: 2 },
      { category: 'a', minBlocks: 1 },
    ];
    const policy = allocationPolicy({ categoryConstraints: constraints });
    const snapshot = structuredClone(policy);

    const result = allocate(
      [
        { id: 'a1', tokens: 2, priority: 100, category: 'a' },
        { id: 'b1', tokens: 2, priority: 900, category: 'b' },
      ],
      { available: 10, policy },
    );

    expect(result.included).toHaveLength(2);
    expect(policy).toEqual(snapshot);
    expect(constraints[0]?.category).toBe('b');
  });
});

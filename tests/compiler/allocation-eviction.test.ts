import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  includedIds,
  permutations,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * The deterministic optional eviction order (INV-ALLOC-006).
 *
 * Phase 10 precomputes the order in which a future render-correction loop may
 * remove optional blocks. It removes nothing itself, invokes no renderer, and
 * never lists a required block or a block whose removal would break a category
 * minimum.
 */

/** Applies the whole eviction order to the included set. */
function survivorsAfterFullEviction(
  included: readonly string[],
  order: readonly string[],
): readonly string[] {
  const evicted = new Set(order);
  return included.filter((id) => !evicted.has(id));
}

describe('INV-ALLOC-006: optional eviction order', () => {
  it('evicts the lowest-scoring optional block first', () => {
    const result = allocate(
      [
        { id: 'high', tokens: 1, priority: 900 },
        { id: 'mid', tokens: 1, priority: 500 },
        { id: 'low', tokens: 1, priority: 100 },
      ],
      { available: 20 },
    );

    expect(result.optionalEvictionOrder).toEqual(['low', 'mid', 'high']);
  });

  it('INV-DET-005: breaks a score tie by block identifier descending', () => {
    const result = allocate(
      [
        { id: 'a', tokens: 1, priority: 500 },
        { id: 'b', tokens: 1, priority: 500 },
        { id: 'c', tokens: 1, priority: 500 },
      ],
      { available: 20 },
    );

    expect(result.optionalEvictionOrder).toEqual(['c', 'b', 'a']);
  });

  it('makes every unconstrained optional block evictable', () => {
    const result = allocate(
      [
        { id: 'o1', tokens: 1, priority: 900 },
        { id: 'o2', tokens: 1, priority: 100 },
      ],
      { available: 20 },
    );

    expect([...result.optionalEvictionOrder].sort()).toEqual([...includedIds(result)].sort());
  });

  it('INV-BUDGET-003: never lists a required block', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 1, priority: 1000, required: true },
        { id: 'r2', tokens: 1, priority: 0, required: true },
        { id: 'o1', tokens: 1, priority: 500 },
      ],
      { available: 20 },
    );

    expect(result.optionalEvictionOrder).toEqual(['o1']);
  });

  it('protects the blocks a category minimum still needs', () => {
    const result = allocate(
      [
        { id: 'f1', tokens: 1, priority: 900, category: 'facts' },
        { id: 'f2', tokens: 1, priority: 100, category: 'facts' },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 2 }] }),
      },
    );

    expect([...includedIds(result)].sort()).toEqual(['f1', 'f2']);
    expect(result.optionalEvictionOrder).toEqual([]);
  });

  it('evicts category surplus down to exactly minBlocks', () => {
    const result = allocate(
      [
        { id: 'f1', tokens: 1, priority: 900, category: 'facts' },
        { id: 'f2', tokens: 1, priority: 500, category: 'facts' },
        { id: 'f3', tokens: 1, priority: 100, category: 'facts' },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 2 }] }),
      },
    );

    expect(result.optionalEvictionOrder).toEqual(['f3']);
    expect(
      survivorsAfterFullEviction(includedIds(result), result.optionalEvictionOrder),
    ).toHaveLength(2);
  });

  it('lets a required block satisfy the minimum, freeing every optional block', () => {
    const result = allocate(
      [
        { id: 'r1', tokens: 1, priority: 0, category: 'facts', required: true },
        { id: 'f1', tokens: 1, priority: 900, category: 'facts' },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
      },
    );

    expect(result.optionalEvictionOrder).toEqual(['f1']);
  });

  it('makes a minimum pick evictable once later selections created surplus', () => {
    const result = allocate(
      [
        // The cheapest block of the category satisfies the minimum, then two
        // higher-scoring blocks of the same category are selected on score.
        { id: 'cheap', tokens: 1, priority: 100, category: 'facts' },
        { id: 'rich1', tokens: 2, priority: 900, category: 'facts' },
        { id: 'rich2', tokens: 2, priority: 800, category: 'facts' },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'facts', minBlocks: 1 }] }),
      },
    );

    expect(result.included[0]?.reason).toBe('INCLUDED_CATEGORY_MINIMUM');
    // Lowest score first: the minimum pick itself is evictable, because two
    // blocks of its category would remain.
    expect(result.optionalEvictionOrder).toEqual(['cheap', 'rich2']);
    expect(survivorsAfterFullEviction(includedIds(result), result.optionalEvictionOrder)).toEqual([
      'rich1',
    ]);
  });

  it('leaves every configured minimum satisfied after the whole order is applied', () => {
    const specs: CandidateSpec[] = [
      { id: 'a1', tokens: 1, priority: 100, category: 'a' },
      { id: 'a2', tokens: 1, priority: 900, category: 'a' },
      { id: 'a3', tokens: 1, priority: 500, category: 'a' },
      { id: 'b1', tokens: 1, priority: 200, category: 'b' },
      { id: 'b2', tokens: 1, priority: 800, category: 'b' },
      { id: 'r1', tokens: 1, priority: 0, category: 'b', required: true },
      { id: 'u1', tokens: 1, priority: 300 },
    ];
    const result = allocate(specs, {
      available: 20,
      policy: allocationPolicy({
        categoryConstraints: [
          { category: 'a', minBlocks: 2 },
          { category: 'b', minBlocks: 2 },
        ],
      }),
    });

    const survivors = survivorsAfterFullEviction(includedIds(result), result.optionalEvictionOrder);
    const categoryOf = new Map(specs.map((spec) => [spec.id, spec.category]));
    expect(survivors.filter((id) => categoryOf.get(id) === 'a')).toHaveLength(2);
    expect(survivors.filter((id) => categoryOf.get(id) === 'b')).toHaveLength(2);
    expect(survivors).toContain('r1');
  });

  it('does not let a maximum prevent eviction', () => {
    const result = allocate(
      [
        { id: 'a1', tokens: 1, priority: 900, category: 'a' },
        { id: 'a2', tokens: 1, priority: 100, category: 'a' },
      ],
      {
        available: 20,
        policy: allocationPolicy({ categoryConstraints: [{ category: 'a', maxBlocks: 2 }] }),
      },
    );

    expect(result.optionalEvictionOrder).toEqual(['a2', 'a1']);
  });

  it('INV-ALLOC-005: the eviction order is stable under candidate permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'a1', tokens: 1, priority: 100, category: 'a' },
      { id: 'a2', tokens: 1, priority: 900, category: 'a' },
      { id: 'u1', tokens: 1, priority: 500 },
    ];
    const policy = allocationPolicy({ categoryConstraints: [{ category: 'a', minBlocks: 1 }] });
    const expected = allocate(specs, { available: 20, policy }).optionalEvictionOrder;

    for (const permutation of permutations(specs)) {
      expect(allocate(permutation, { available: 20, policy }).optionalEvictionOrder).toEqual(
        expected,
      );
    }
  });

  it('is empty when nothing optional was selected', () => {
    const result = allocate([{ id: 'o1', tokens: 99, priority: 900 }], { available: 10 });
    expect(result.optionalEvictionOrder).toEqual([]);
  });
});

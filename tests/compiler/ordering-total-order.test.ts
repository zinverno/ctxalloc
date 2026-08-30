import { describe, expect, it } from 'vitest';
import {
  permutations,
  renderOrderOf,
  sourceDocument,
  type CandidateSpec,
} from './ordering-fixtures.js';

/**
 * The render comparator is a genuine total order (INV-DET-001, INV-DET-005).
 *
 * A comparator that is not transitive makes `Array.prototype.sort` an
 * implementation detail rather than a contract: the specification leaves the
 * result implementation-defined, so a different engine, a different array
 * length, or a different input permutation may produce a different sequence.
 *
 * The v1 rule is therefore a plain lexicographic composition of total orders —
 * source document, then location kind, then offsets or message chronology, then
 * the block identifier — with no key that applies only when both blocks happen
 * to carry it. These tests pin that property through the public API, by
 * enumerating every permutation of fixtures built to break a weaker rule.
 */

function at(startOffset: number, endOffset: number, lines?: readonly [number, number]) {
  return {
    kind: 'text-range',
    startOffset,
    endOffset,
    ...(lines === undefined ? {} : { startLine: lines[0], endLine: lines[1] }),
  };
}

function message(messageId: string, messageIndex?: number) {
  return {
    kind: 'conversation-message',
    messageId,
    ...(messageIndex === undefined ? {} : { messageIndex }),
  };
}

/** Every permutation of the fixture must produce one and the same sequence. */
function singleOrderOf(
  specs: readonly CandidateSpec[],
  options: Parameters<typeof renderOrderOf>[1] = {},
): readonly string[] {
  const results = permutations(specs).map((permutation) =>
    renderOrderOf(permutation, options).join(','),
  );
  const distinct = [...new Set(results)];
  expect(results, 'every permutation was enumerated').toHaveLength(factorial(specs.length));
  expect(distinct, `permutations disagreed: ${distinct.join(' | ')}`).toHaveLength(1);
  return (distinct[0] ?? '').split(',');
}

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

describe('INV-DET-005: the optional line fields cannot create a comparator cycle', () => {
  /**
   * The exact fixture that broke the first Phase 11 rule.
   *
   * Comparing lines "only when both blocks carry one" made `a < b` and `b < c`
   * fall to the identifier while `c < a` came from the lines, so the three
   * pairwise results could not all hold in any total order.
   */
  const CYCLE: readonly CandidateSpec[] = [
    { id: 'a', sourceLocation: at(10, 20, [2, 2]) },
    { id: 'b', sourceLocation: at(10, 20) },
    { id: 'c', sourceLocation: at(10, 20, [1, 1]) },
  ];

  it('orders all six permutations of the cycle fixture identically', () => {
    // Offsets tie and lines do not participate, so the identifier alone decides.
    expect(singleOrderOf(CYCLE)).toEqual(['a', 'b', 'c']);
  });

  it('holds the three pairwise comparisons that used to contradict each other', () => {
    const [a, b, c] = CYCLE as readonly [CandidateSpec, CandidateSpec, CandidateSpec];

    expect(renderOrderOf([a, b])).toEqual(['a', 'b']);
    expect(renderOrderOf([b, c])).toEqual(['b', 'c']);
    // This is the pair that used to invert: `c` carried the earlier line.
    expect(renderOrderOf([c, a])).toEqual(['a', 'c']);
  });

  it('stays consistent when the cycle fixture is embedded in a longer array', () => {
    // Past the run length where a sort switches from insertion sort to merging,
    // an intransitive comparator is free to produce a different sequence.
    const padding: CandidateSpec[] = Array.from({ length: 30 }, (_, index) => ({
      id: `p${String(index).padStart(2, '0')}`,
      sourceLocation: at(10, 20, [2, 2]),
    }));
    const results = permutations(CYCLE).map((permutation) =>
      renderOrderOf([...padding, ...permutation]).join(','),
    );

    expect(new Set(results).size).toBe(1);
    // The three sort ahead of every `p*` identifier, in their own fixed order.
    expect(results[0]?.split(',').slice(0, 3)).toEqual(['a', 'b', 'c']);
  });

  it('orders by line-disagreeing identifiers the same way in every permutation', () => {
    // Line order is the exact reverse of identifier order, so a rule that read
    // lines at all would disagree with this result.
    const specs: CandidateSpec[] = [
      { id: 'a', sourceLocation: at(5, 6, [30, 30]) },
      { id: 'b', sourceLocation: at(5, 6, [20, 20]) },
      { id: 'c', sourceLocation: at(5, 6, [10, 10]) },
    ];
    expect(singleOrderOf(specs)).toEqual(['a', 'b', 'c']);
  });
});

describe('INV-DET-001: the comparator is total over representative fixtures', () => {
  it('orders distinct offsets identically in every permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'third', sourceLocation: at(200, 210) },
      { id: 'first', sourceLocation: at(0, 10) },
      { id: 'second', sourceLocation: at(100, 110) },
    ];
    expect(singleOrderOf(specs)).toEqual(['first', 'second', 'third']);
  });

  it('orders an equal startOffset by endOffset in every permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'c-long', sourceLocation: at(10, 90) },
      { id: 'a-short', sourceLocation: at(10, 20) },
      { id: 'b-medium', sourceLocation: at(10, 50) },
    ];
    expect(singleOrderOf(specs)).toEqual(['a-short', 'b-medium', 'c-long']);
  });

  it('orders located and unlocated blocks identically in every permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'a-unlocated', sourceLocation: null },
      { id: 'b-late', sourceLocation: at(900, 950) },
      { id: 'c-early', sourceLocation: at(0, 10) },
      { id: 'd-unlocated', sourceLocation: null },
    ];
    expect(singleOrderOf(specs)).toEqual(['c-early', 'b-late', 'a-unlocated', 'd-unlocated']);
  });

  it('orders indexed and unindexed conversation messages identically in every permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'a-none', sourceType: 'conversation', sourceLocation: message('m-9') },
      { id: 'b-two', sourceType: 'conversation', sourceLocation: message('m-2', 2) },
      { id: 'c-one', sourceType: 'conversation', sourceLocation: message('m-1', 1) },
      { id: 'd-none', sourceType: 'conversation', sourceLocation: message('m-0') },
    ];
    // Indexed first in index order, then unindexed by messageId.
    expect(
      singleOrderOf(specs, {
        sourceDocuments: [sourceDocument({ sourceType: 'conversation' })],
      }),
    ).toEqual(['c-one', 'b-two', 'd-none', 'a-none']);
  });

  it('orders across source documents identically in every permutation', () => {
    const specs: CandidateSpec[] = [
      { id: 'x', sourceDocumentId: 'doc-2', sourceLocation: at(0, 5) },
      { id: 'y', sourceDocumentId: 'doc-1', sourceLocation: null },
      { id: 'z', sourceDocumentId: 'doc-1', sourceLocation: at(50, 55) },
    ];
    expect(
      singleOrderOf(specs, {
        sourceDocuments: [sourceDocument(), sourceDocument({ id: 'doc-2' })],
      }),
    ).toEqual(['z', 'y', 'x']);
  });
});

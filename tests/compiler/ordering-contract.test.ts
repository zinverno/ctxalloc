import { readFileSync } from 'node:fs';
import { ContextOrderer, type AllocatedCandidateSet } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  order,
  orderedIds,
  orderingPolicy,
  permutations,
  sourceDocument,
  type CandidateSpec,
} from './ordering-fixtures.js';

/**
 * The conservation, determinism, and isolation contract of the ordering stage
 * (DEC-034).
 *
 * Ordering changes no decision, invents no input, and touches nothing the
 * allocator produced except the sequence of the included array.
 */

const rootUrl = new URL('../../', import.meta.url);

const ORDERER_SOURCE = readFileSync(
  new URL('packages/compiler/src/context-orderer.ts', rootUrl),
  'utf8',
);

/** Source with documentation comments removed: declared code only. */
const ORDERER_CODE = ORDERER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function at(startOffset: number, endOffset: number) {
  return { kind: 'text-range', startOffset, endOffset };
}

const MIXED: readonly CandidateSpec[] = [
  { id: 'r1', tokens: 2, priority: 0, required: true, sourceLocation: at(400, 410) },
  { id: 'm1', tokens: 1, priority: 100, category: 'facts', sourceLocation: at(300, 310) },
  { id: 's1', tokens: 1, priority: 900, sourceLocation: at(200, 210) },
  { id: 'e1', tokens: 99, priority: 800, sourceLocation: at(100, 110) },
];

const MIXED_POLICY = allocationPolicy({
  categoryConstraints: [{ category: 'facts', minBlocks: 1 }],
});

function mixedAllocation(): AllocatedCandidateSet {
  return allocate(MIXED, { available: 6, policy: MIXED_POLICY });
}

describe('INV-TRACE-001: ordering conserves every allocation decision', () => {
  it('carries every included decision through exactly once', () => {
    const allocation = mixedAllocation();
    const result = order(allocation);

    expect(result.orderedIncluded).toHaveLength(allocation.included.length);
    expect(new Set(result.orderedIncluded).size).toBe(allocation.included.length);
    // The same decision objects, as a set: only their sequence differs.
    expect(new Set(result.orderedIncluded)).toEqual(new Set(allocation.included));
    expect([...orderedIds(result)].sort()).toEqual(
      allocation.included.map((decision) => decision.candidate.candidate.canonicalBlock.id).sort(),
    );
  });

  it('INV-ALLOC-004: reuses the decision objects by reference, cloning nothing', () => {
    const allocation = mixedAllocation();
    const result = order(allocation);

    for (const decision of allocation.included) {
      expect(result.orderedIncluded).toContain(decision);
    }
    // The blocks are the same objects too: no ContextBlock is synthesized.
    for (const decision of result.orderedIncluded) {
      const block = decision.candidate.candidate.canonicalBlock;
      expect(
        allocation.included.some(
          (original) => original.candidate.candidate.canonicalBlock === block,
        ),
      ).toBe(true);
    }
  });

  it('lets no excluded decision enter the ordered sequence', () => {
    const allocation = mixedAllocation();
    const result = order(allocation);
    const excludedIds = allocation.excluded.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );

    expect(excludedIds).toEqual(['e1']);
    expect(orderedIds(result)).not.toContain('e1');
    for (const decision of allocation.excluded) {
      expect(result.orderedIncluded).not.toContain(decision);
    }
  });

  it('changes no decision reason', () => {
    const allocation = mixedAllocation();
    const result = order(allocation);

    expect([...result.orderedIncluded].map((decision) => decision.reason).sort()).toEqual(
      [...allocation.included.map((decision) => decision.reason)].sort(),
    );
    for (const decision of result.orderedIncluded) {
      expect(decision.decision).toBe('included');
    }
  });

  it('does not mutate the supplied allocation', () => {
    const allocation = mixedAllocation();
    const snapshot = structuredClone(allocation);
    const includedOrder = allocation.included.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );

    order(allocation);

    expect(allocation).toEqual(snapshot);
    expect(
      allocation.included.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    ).toEqual(includedOrder);
  });

  it('nests the allocation by reference, so every Phase 10 fact stays reachable', () => {
    const allocation = mixedAllocation();
    const result = order(allocation);

    expect(result.allocation).toBe(allocation);
    expect(result.allocation.selectedBlockContentTokens).toBe(
      allocation.selectedBlockContentTokens,
    );
    expect(result.allocation.excluded).toBe(allocation.excluded);
    expect(result.allocation.allocationPolicyId).toBe('allocation');
  });

  it('adds no position field to a block or a decision', () => {
    const result = order(mixedAllocation());
    const decision = result.orderedIncluded[0];
    if (decision === undefined) throw new Error('expected one decision');

    for (const forbidden of ['position', 'index', 'order', 'rank', 'sequence']) {
      expect(Object.keys(decision), `decision exposes ${forbidden}`).not.toContain(forbidden);
      expect(
        Object.keys(decision.candidate.candidate.canonicalBlock),
        `block exposes ${forbidden}`,
      ).not.toContain(forbidden);
    }
    expect(Object.keys(result).sort()).toEqual([
      'allocation',
      'orderedIncluded',
      'orderingPolicyId',
      'orderingPolicyVersion',
    ]);
  });
});

describe('INV-ALLOC-006: the eviction order is untouched and is not render order', () => {
  it('carries optionalEvictionOrder through unchanged', () => {
    const allocation = mixedAllocation();
    const before = [...allocation.optionalEvictionOrder];
    const result = order(allocation);

    expect(result.allocation.optionalEvictionOrder).toBe(allocation.optionalEvictionOrder);
    expect(result.allocation.optionalEvictionOrder).toEqual(before);
  });

  it('differs from render order, because the two answer different questions', () => {
    // Eviction runs by ascending score; rendering runs by source position. The
    // fixture makes the two disagree on purpose.
    const specs: CandidateSpec[] = [
      { id: 'early-weak', priority: 100, sourceLocation: at(0, 10) },
      { id: 'late-strong', priority: 900, sourceLocation: at(500, 510) },
    ];
    const allocation = allocate(specs, { available: 100 });
    const result = order(allocation);

    expect(allocation.optionalEvictionOrder).toEqual(['early-weak', 'late-strong']);
    expect(orderedIds(result)).toEqual(['early-weak', 'late-strong']);

    const reversed = allocate(
      [
        { id: 'early-strong', priority: 900, sourceLocation: at(0, 10) },
        { id: 'late-weak', priority: 100, sourceLocation: at(500, 510) },
      ],
      { available: 100 },
    );
    // Same render order, opposite eviction order: the sequences are independent.
    expect(orderedIds(order(reversed))).toEqual(['early-strong', 'late-weak']);
    expect(reversed.optionalEvictionOrder).toEqual(['late-weak', 'early-strong']);
  });
});

describe('INV-DET-001: ordering is deterministic', () => {
  it('INV-ALLOC-005: gives the same sequence for every input permutation', () => {
    const expected = orderedIds(order(mixedAllocation()));

    for (const permutation of permutations(MIXED)) {
      expect(
        orderedIds(order(allocate(permutation, { available: 6, policy: MIXED_POLICY }))),
      ).toEqual(expected);
    }
  });

  it('gives the same sequence when the included array itself is reversed', () => {
    const allocation = mixedAllocation();
    const reversed: AllocatedCandidateSet = {
      ...allocation,
      included: [...allocation.included].reverse(),
    };

    expect(orderedIds(order(reversed))).toEqual(orderedIds(order(allocation)));
  });

  it('repeats exactly on a second call with the same orderer', () => {
    const orderer = new ContextOrderer(orderingPolicy());
    const allocation = mixedAllocation();
    expect(orderer.order(allocation)).toEqual(orderer.order(allocation));
  });

  it('INV-DET-005: is total for a defensive input mixing location kinds', () => {
    // `CandidateValidator` rejects a batch whose location kind disagrees with
    // its source type, so this cannot come through the pipeline. The comparator
    // is still total: text-range precedes conversation-message, and the result
    // is a decision rather than a sort-stability artifact.
    const specs: CandidateSpec[] = [
      {
        id: 'talk',
        sourceDocumentId: 'doc-2',
        sourceType: 'conversation',
        sourceLocation: { kind: 'conversation-message', messageId: 'm', messageIndex: 0 },
      },
      { id: 'text', sourceDocumentId: 'doc-1', sourceLocation: at(900, 910) },
    ];
    const allocation = allocate(specs, {
      available: 100,
      sourceDocuments: [
        sourceDocument(),
        sourceDocument({ id: 'doc-2', sourceType: 'conversation' }),
      ],
    });

    const mixedIntoOneDocument: AllocatedCandidateSet = {
      ...allocation,
      included: allocation.included.map((decision) => ({
        ...decision,
        candidate: {
          ...decision.candidate,
          candidate: {
            ...decision.candidate.candidate,
            canonicalBlock: {
              ...decision.candidate.candidate.canonicalBlock,
              sourceDocumentId: allocation.included[0]?.candidate.candidate.canonicalBlock
                .sourceDocumentId as never,
            },
          },
        },
      })),
    };

    const forward = orderedIds(order(mixedIntoOneDocument));
    const backward = orderedIds(
      order({ ...mixedIntoOneDocument, included: [...mixedIntoOneDocument.included].reverse() }),
    );

    expect(forward).toEqual(['text', 'talk']);
    expect(backward).toEqual(forward);
  });
});

describe('INV-DEP-002: ordering reaches nothing outside its input', () => {
  it('imports only the domain, its own stage types, and the validation library', () => {
    const specifiers = [...ORDERER_SOURCE.matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );

    expect(specifiers.sort()).toEqual([
      './budget-allocator.js',
      './canonical-json.js',
      '@ctxalloc/domain',
      'zod',
    ]);
  });

  it('INV-DET-003: reads no clock, random value, environment, or identifier source', () => {
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'randomUUID',
      'crypto',
      'process.env',
      'hostname',
      'fetch(',
      'node:',
      'localeCompare',
      'Intl',
    ]) {
      expect(ORDERER_CODE, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('calls no tokenizer, renderer, or provider and measures no overhead', () => {
    for (const forbidden of [
      'Tokenizer',
      'countTokens',
      'render',
      'Renderer',
      'overhead',
      'compiledTokens',
      'separator',
      'sourceLabel',
      'CompilationTrace',
      'CandidateFilter',
    ]) {
      expect(ORDERER_CODE, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('reads no score, reason, category, or required status', () => {
    // The comparator sees canonical block fields only. These names must not
    // appear in the declared code at all.
    for (const forbidden of [
      'score',
      'reason',
      'required',
      'attributes',
      'headingPath',
      'retrieval',
      'members',
      'createdAt',
      'updatedAt',
      'metadata',
    ]) {
      expect(ORDERER_CODE, `reads ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('needs only a policy to construct', () => {
    expect(ContextOrderer.length).toBe(1);
    expect(() => new ContextOrderer(orderingPolicy())).not.toThrow();
  });
});

describe('ContextOrderer basic behavior', () => {
  it('orders an empty allocation to an empty sequence', () => {
    const result = order(allocate([], { available: 50 }));

    expect(result.orderedIncluded).toEqual([]);
    expect(result.allocation.included).toEqual([]);
  });

  it('orders a single included decision to itself', () => {
    const allocation = allocate([{ id: 'only', tokens: 2 }], { available: 50 });
    const result = order(allocation);

    expect(result.orderedIncluded).toHaveLength(1);
    expect(result.orderedIncluded[0]).toBe(allocation.included[0]);
  });

  it('orders an allocation whose included array is empty but excluded is not', () => {
    const allocation = allocate([{ id: 'too-big', tokens: 99 }], { available: 5 });
    const result = order(allocation);

    expect(result.orderedIncluded).toEqual([]);
    expect(result.allocation.excluded).toHaveLength(1);
  });
});

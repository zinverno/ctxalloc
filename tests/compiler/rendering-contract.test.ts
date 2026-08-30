import { readFileSync } from 'node:fs';
import type { IncludedCandidateDecision } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  fixedTokenizer,
  linesOf,
  orderCandidates,
  orderSpecs,
  orderedBlocks,
  orderedIds,
  permutations,
  recordsOf,
  render,
  withOrder,
} from './rendering-fixtures.js';

/**
 * The renderer's stage contract: it obeys the order it is given, changes no
 * decision, mutates nothing, and depends on nothing but its inputs (DEC-035).
 */

/** A located block whose offsets fix its render position inside `doc-1`. */
function located(id: string, content: string, startOffset: number): Record<string, unknown> {
  return candidate({
    id,
    content,
    sourceLocation: { kind: 'text-range', startOffset, endOffset: startOffset + content.length },
  });
}

/** The same object with its own keys in reverse insertion order. */
function reorderKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
}

/** The same decisions carrying key-reordered copies of their canonical blocks. */
function reorderedBlocks(
  decisions: readonly IncludedCandidateDecision[],
): readonly IncludedCandidateDecision[] {
  return decisions.map((decision) => ({
    ...decision,
    candidate: {
      ...decision.candidate,
      candidate: {
        ...decision.candidate.candidate,
        canonicalBlock: reorderKeys(decision.candidate.candidate.canonicalBlock),
      },
    },
  }));
}

describe('INV-RENDER-001: orderedIncluded is the whole ordering contract', () => {
  const ordered = orderCandidates([
    located('block-a', 'alpha content', 0),
    located('block-b', 'beta content', 100),
    located('block-c', 'gamma content', 200),
  ]);

  it('renders the array it receives, in that exact order', () => {
    for (const permutation of permutations([...ordered.orderedIncluded])) {
      const result = render(withOrder(ordered, permutation), fixedTokenizer(0));
      expect(recordsOf(result).map((record) => record['blockId'])).toEqual(
        permutation.map((decision) => decision.candidate.candidate.canonicalBlock.id),
      );
    }
  });

  it('does not re-run the orderer on a reversed sequence', () => {
    const forward = render(ordered, fixedTokenizer(0));
    const reverse = render(
      withOrder(ordered, [...ordered.orderedIncluded].reverse()),
      fixedTokenizer(0),
    );

    expect(recordsOf(forward).map((record) => record['blockId'])).toEqual([
      'block-a',
      'block-b',
      'block-c',
    ]);
    expect(recordsOf(reverse).map((record) => record['blockId'])).toEqual([
      'block-c',
      'block-b',
      'block-a',
    ]);
    // Both sets carry the same nested allocation: only render order differs.
    expect(reverse.ordered.allocation).toBe(forward.ordered.allocation);
  });

  it('consults neither source position nor the eviction order', () => {
    // The eviction order and the source order both disagree with the supplied
    // array, and the supplied array still wins.
    const shuffled = [
      ordered.orderedIncluded[1],
      ordered.orderedIncluded[2],
      ordered.orderedIncluded[0],
    ].filter((decision): decision is IncludedCandidateDecision => decision !== undefined);
    const result = render(withOrder(ordered, shuffled), fixedTokenizer(0));

    expect(recordsOf(result).map((record) => record['blockId'])).toEqual([
      'block-b',
      'block-c',
      'block-a',
    ]);
    expect(result.ordered.allocation.optionalEvictionOrder).toBe(
      ordered.allocation.optionalEvictionOrder,
    );
  });
});

describe('INV-ALLOC-002: rendering changes no decision', () => {
  it('renders every included block exactly once', () => {
    const ordered = orderCandidates([
      located('block-a', 'alpha content', 0),
      located('block-b', 'beta content', 100),
      located('block-c', 'gamma content', 200),
    ]);
    const ids = recordsOf(render(ordered, fixedTokenizer(0))).map((record) => record['blockId']);

    expect(ids).toEqual(orderedIds(ordered));
    expect(new Set(ids).size).toBe(ids.length);
    expect(linesOf(render(ordered, fixedTokenizer(0)))).toHaveLength(
      ordered.orderedIncluded.length,
    );
  });

  it('never renders an excluded block', () => {
    // The budget admits the two higher-priority blocks only.
    const ordered = orderSpecs(
      [
        { id: 'block-a', tokens: 4, priority: 900 },
        { id: 'block-b', tokens: 4, priority: 800 },
        { id: 'block-c', tokens: 4, priority: 100 },
      ],
      { available: 8 },
    );
    const excluded = ordered.allocation.excluded.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );
    expect(excluded).toEqual(['block-c']);

    const result = render(ordered, fixedTokenizer(0));
    const rendered = recordsOf(result).map((record) => record['blockId']);

    expect(rendered).toEqual(orderedIds(ordered));
    expect(rendered).not.toContain('block-c');
    expect(result.renderedContext).not.toContain('block-c');
  });

  it('returns the ordered set by reference and mutates no input', () => {
    const ordered = orderCandidates([
      located('block-a', 'alpha content', 0),
      located('block-b', 'beta content', 100),
    ]);
    const before = JSON.stringify(ordered);

    const result = render(ordered, fixedTokenizer(3));

    expect(result.ordered).toBe(ordered);
    expect(result.ordered.allocation).toBe(ordered.allocation);
    expect(result.ordered.orderedIncluded).toBe(ordered.orderedIncluded);
    result.ordered.orderedIncluded.forEach((decision, index) => {
      expect(decision).toBe(ordered.orderedIncluded[index]);
      expect(decision.candidate.candidate.canonicalBlock).toBe(
        ordered.orderedIncluded[index]?.candidate.candidate.canonicalBlock,
      );
    });
    expect(JSON.stringify(ordered)).toBe(before);
  });

  it('adds, clones, and synthesizes no block', () => {
    const ordered = orderCandidates([located('block-a', 'alpha content', 0)]);
    const rendered = orderedBlocks(ordered);
    const result = render(ordered, fixedTokenizer(0));

    expect(linesOf(result)).toHaveLength(1);
    expect(result.ordered.orderedIncluded[0]?.candidate.candidate.canonicalBlock).toBe(rendered[0]);
  });

  it('evicts nothing and fails nothing when the attempt overruns', () => {
    const ordered = orderSpecs(
      [
        { id: 'block-a', tokens: 4, required: true },
        { id: 'block-b', tokens: 4 },
      ],
      { available: 20 },
    );
    const result = render(ordered, fixedTokenizer(1_000_000));

    expect(result.fitsAvailableInputBudget).toBe(false);
    expect(result.ordered.orderedIncluded).toBe(ordered.orderedIncluded);
    expect(linesOf(result)).toHaveLength(2);
    expect(result.ordered.allocation.optionalEvictionOrder).toBe(
      ordered.allocation.optionalEvictionOrder,
    );
    expect(result.ordered.allocation.excluded).toBe(ordered.allocation.excluded);
  });
});

describe('INV-DET-001: rendering is deterministic', () => {
  it('produces a deep-equal result for identical inputs', () => {
    const ordered = orderCandidates([
      located('block-a', 'alpha content', 0),
      located('block-b', 'beta content', 100),
    ]);

    const first = render(ordered, fixedTokenizer(17));
    const second = render(ordered, fixedTokenizer(17));

    expect(second).toEqual(first);
    expect(second.renderedContext).toBe(first.renderedContext);
  });

  it('INV-DET-002: object property insertion order cannot change the rendered JSON', () => {
    const ordered = orderCandidates([
      located('block-a', 'alpha content', 0),
      located('block-b', 'beta content', 100),
    ]);
    const permuted = withOrder(ordered, reorderedBlocks(ordered.orderedIncluded));

    // Canonical serialization owns key order, so a differently built block
    // record serializes identically.
    expect(render(permuted, fixedTokenizer(0)).renderedContext).toBe(
      render(ordered, fixedTokenizer(0)).renderedContext,
    );
  });

  it('renders keys in one canonical order regardless of the block record', () => {
    const ordered = orderCandidates([candidate({ headingPath: ['Guide'] })]);
    const permuted = withOrder(ordered, reorderedBlocks(ordered.orderedIncluded));
    const line = linesOf(render(permuted, fixedTokenizer(0)))[0] ?? '';

    expect(line.indexOf('"blockId"')).toBeLessThan(line.indexOf('"content"'));
    expect(line.indexOf('"content"')).toBeLessThan(line.indexOf('"headingPath"'));
    expect(line.indexOf('"headingPath"')).toBeLessThan(line.indexOf('"sourceDocumentId"'));
    expect(line.indexOf('"sourceDocumentId"')).toBeLessThan(line.indexOf('"sourceType"'));
  });
});

describe('INV-DET-003, INV-DET-004, INV-DEP-002: the renderer reads no hidden input', () => {
  const source = readFileSync(
    new URL('../../packages/compiler/src/context-renderer.ts', import.meta.url),
    'utf8',
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it.each([
    'Date.now',
    'new Date',
    'Math.random',
    'crypto',
    'randomUUID',
    'localeCompare',
    'Intl',
    'process.env',
    'readFile',
    'fetch',
    'hostname',
    'performance.now',
  ])('does not use %s', (forbidden) => {
    expect(code).not.toContain(forbidden);
  });

  it('imports only the domain, the ports, the validation library, and its own modules', () => {
    const specifiers = [...source.matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );
    expect(specifiers.sort()).toEqual([
      './canonical-json.js',
      './context-orderer.js',
      './validation-issues.js',
      '@ctxalloc/domain',
      '@ctxalloc/ports',
      'zod',
    ]);
  });

  it('constructs no tokenizer implementation of its own', () => {
    for (const forbidden of [
      'O200kBaseTokenizer',
      'FakeTokenizer',
      '@ctxalloc/tokenization',
      '@ctxalloc/testing',
      'js-tiktoken',
    ]) {
      expect(source, `references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('calls no earlier compiler stage', () => {
    for (const stage of ['new BudgetAllocator', 'new ContextOrderer', 'new CandidateScorer']) {
      expect(code, `calls ${stage}`).not.toContain(stage);
    }
  });

  it('publishes no final compilation failure of a future stage', () => {
    expect(code).not.toContain('REQUIRED_CONTENT_EXCEEDS_BUDGET');
    expect(code).not.toContain('CompilationResult');
    expect(code).not.toContain('CompilationTrace');
  });
});

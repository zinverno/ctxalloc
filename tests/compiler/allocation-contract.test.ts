import { readFileSync } from 'node:fs';
import { BudgetAllocator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  allocate,
  allocationPolicy,
  budget,
  permutations,
  reasonsOf,
  scoreSpecs,
  reversedSet,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * The block-content contract, determinism, and the absence of hidden inputs.
 *
 * Phase 10 allocates canonical block content and nothing else. It must not claim
 * a rendered-budget guarantee it cannot prove, and it must reach no clock,
 * tokenizer, renderer, or environment (DEC-033, INV-BUDGET-002, INV-DET-003).
 */

const rootUrl = new URL('../../', import.meta.url);

const ALLOCATOR_SOURCE = readFileSync(
  new URL('packages/compiler/src/budget-allocator.ts', rootUrl),
  'utf8',
);

/** Source with documentation comments removed: declared code only. */
const ALLOCATOR_CODE = ALLOCATOR_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
);

describe('INV-BUDGET-002: block content is not the rendered context', () => {
  it('publishes provisional block-content metrics, not final compiled ones', () => {
    const result = allocate([{ id: 'b1', tokens: 4, priority: 900 }], { available: 10 });

    expect(Object.keys(result).sort()).toEqual([
      'allocationPolicyId',
      'allocationPolicyVersion',
      'availableInputTokens',
      'excluded',
      'included',
      'optionalEvictionOrder',
      'referenceTime',
      'scope',
      'scoringPolicyId',
      'scoringPolicyVersion',
      'selectedBlockContentTokens',
      'sourceDocuments',
      'tokenBudget',
      'unallocatedBlockContentTokens',
    ]);
  });

  it('exposes no compiledTokens, unusedTokens, or rendering overhead estimate', () => {
    const result: object = allocate([{ id: 'b1', tokens: 2 }], { available: 10 });

    for (const forbidden of [
      'compiledTokens',
      'unusedTokens',
      'renderingOverheadTokens',
      'renderedTokens',
      'compiledContext',
      'renderedContext',
      'includedContentTokens',
      'budgetUtilization',
    ]) {
      expect(Object.keys(result), `publishes ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('names no renderer concept anywhere in its declared code', () => {
    for (const forbidden of [
      'compiledTokens',
      'unusedTokens',
      'renderingOverhead',
      'separator',
      'sourceLabel',
      'prefix',
      'suffix',
      'wrapper',
      'render(',
      'Renderer',
      'scorePerToken',
      'knapsack',
    ]) {
      expect(ALLOCATOR_CODE, `mentions ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('INV-DEP-002: calls no tokenizer, renderer, provider, model, or storage', () => {
    const specifiers = [...ALLOCATOR_SOURCE.matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );

    expect(specifiers.sort()).toEqual([
      './candidate-scorer.js',
      './canonical-json.js',
      './validation-issues.js',
      '@ctxalloc/domain',
      'zod',
    ]);
    expect(ALLOCATOR_SOURCE).not.toContain('@ctxalloc/ports');
    expect(ALLOCATOR_SOURCE).not.toContain('countTokens');
    expect(ALLOCATOR_SOURCE).not.toContain('Tokenizer');
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
    ]) {
      expect(ALLOCATOR_CODE, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('needs only a policy to construct', () => {
    expect(() => new BudgetAllocator(allocationPolicy())).not.toThrow();
    expect(BudgetAllocator.length).toBe(1);
  });

  it('re-counts no token: the canonical count is the cost', () => {
    const scored = scoreSpecs([{ id: 'b1', tokens: 6, priority: 900 }]);
    const result = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(20));

    expect(result.included[0]?.contentTokens).toBe(
      scored.candidates[0]?.candidate.canonicalBlock.tokenCount,
    );
  });
});

describe('INV-DET-001: identical inputs produce identical output', () => {
  const SPECS: readonly CandidateSpec[] = [
    { id: 'r1', tokens: 2, priority: 0, category: 'a', required: true },
    { id: 'a1', tokens: 3, priority: 900, category: 'a' },
    { id: 'a2', tokens: 1, priority: 100, category: 'a' },
    { id: 'b1', tokens: 4, priority: 800, category: 'b' },
  ];
  const POLICY = allocationPolicy({
    categoryConstraints: [
      { category: 'a', minBlocks: 2, maxBlocks: 3 },
      { category: 'b', minBlocks: 1 },
    ],
  });

  it('produces a deep-equal result for every candidate permutation', () => {
    const expected = allocate(SPECS, { available: 12, policy: POLICY });
    for (const permutation of permutations(SPECS)) {
      expect(allocate(permutation, { available: 12, policy: POLICY })).toEqual(expected);
    }
  });

  it('produces a deep-equal result for a reversed scored set and registry', () => {
    const scored = scoreSpecs(SPECS);
    const allocator = new BudgetAllocator(POLICY);

    expect(allocator.allocate(reversedSet(scored), budget(12))).toEqual(
      allocator.allocate(scored, budget(12)),
    );
  });

  it('produces a deep-equal result for a reversed constraint declaration', () => {
    const reversedPolicy = allocationPolicy({
      categoryConstraints: [
        { category: 'b', minBlocks: 1 },
        { category: 'a', minBlocks: 2, maxBlocks: 3 },
      ],
    });

    expect(allocate(SPECS, { available: 12, policy: reversedPolicy })).toEqual(
      allocate(SPECS, { available: 12, policy: POLICY }),
    );
  });

  it('repeats exactly on a second call with the same allocator instance', () => {
    const allocator = new BudgetAllocator(POLICY);
    const scored = scoreSpecs(SPECS);

    expect(allocator.allocate(scored, budget(12))).toEqual(allocator.allocate(scored, budget(12)));
  });

  it('produces the same decisions and reasons whatever the input order', () => {
    const expected = reasonsOf(allocate(SPECS, { available: 12, policy: POLICY }));
    for (const permutation of permutations(SPECS)) {
      expect(reasonsOf(allocate(permutation, { available: 12, policy: POLICY }))).toEqual(expected);
    }
  });
});

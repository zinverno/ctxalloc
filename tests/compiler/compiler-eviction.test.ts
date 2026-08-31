import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  compile,
  finalDecisionFor,
  finalReasons,
  includedIds,
  jsonlOverheadTokenizer,
  renderedIds,
  requestInput,
  type CandidateSpec,
} from './compiler-fixtures.js';

/**
 * The cheap correction path: the exact `optionalEvictionOrder` prefix (DEC-038).
 *
 * The allocator's content selection fits its provisional budget and the full
 * JSONL render does not, so the correction gives back the surplus the allocator
 * itself declared safe — one entry at a time, in the exact published order,
 * re-rendering and re-measuring after every removal. The first fitting prefix
 * wins.
 */

/** Four blocks of 2 content tokens each, plus 3 rendered tokens per record. */
const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 2, required: true, priority: 0 },
  { id: 'high', tokens: 2, priority: 900 },
  { id: 'mid', tokens: 2, priority: 500 },
  { id: 'low', tokens: 2, priority: 100 },
];

const TOKENIZER = jsonlOverheadTokenizer(3);

/** The allocator's own published eviction order for this batch. */
function evictionOrder(
  available: number,
  specs: readonly CandidateSpec[] = SPECS,
): readonly string[] {
  const request = new CompilationRequestValidator().validate(requestInput({ specs, available }));
  const validated = new CandidateValidator(TOKENIZER).validate({
    scope: request.scope,
    sourceDocuments: request.sourceDocuments,
    candidates: request.candidates,
  });
  const scored = new CandidateScorer(request.policy.scoring).score(
    new CandidateDeduplicator().deduplicate(validated),
    request.referenceTime,
  );
  const filtered = new CandidateFilter(request.policy.filtering).filter(scored);
  return new BudgetAllocator(request.policy.allocation).allocate(filtered.eligible, request.budget)
    .optionalEvictionOrder;
}

describe('ContextCompiler: cheap eviction along optionalEvictionOrder', () => {
  it('evicts exactly the first entry when that is enough', () => {
    // content 6 <= 12, rendered 6 + 3*3 = 15 > 12; after evicting `low`,
    // rendered 4 + 2*3 = 10 <= 12.
    const result = compile(
      { specs: SPECS.filter((spec) => spec.id !== 'mid'), available: 12 },
      TOKENIZER,
    );

    expect(result.trace.settlement.correctionApplied).toBe(true);
    expect(result.trace.settlement.evictedBlockIds).toEqual(['low']);
    expect([...includedIds(result)].sort()).toEqual(['high', 'must']);
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(12);
  });

  it('leaves every later eviction entry in place', () => {
    const specs = SPECS.filter((spec) => spec.id !== 'mid');
    const order = evictionOrder(12, specs);
    const result = compile({ specs, available: 12 }, TOKENIZER);
    expect(order).toEqual(['low', 'high']);
    expect(includedIds(result)).toContain('high');
  });

  it('INV-BUDGET-003: the required block is never evicted', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    expect(includedIds(result)).toContain('must');
    expect(result.trace.settlement.evictedBlockIds).not.toContain('must');
    expect(finalReasons(result)['must']).toBe('INCLUDED_REQUIRED');
  });

  it('stops at the first FITTING prefix rather than evicting everything', () => {
    // rendered 8 + 4*3 = 20 > 14; drop `low` -> 6 + 9 = 15 > 14; drop `mid` ->
    // 4 + 6 = 10 <= 14. Two evictions, and `high` survives.
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);

    expect(result.trace.settlement.evictedBlockIds).toEqual(['low', 'mid']);
    expect([...includedIds(result)].sort()).toEqual(['high', 'must']);
    expect(result.trace.settlement.hardMinimumSearch.used).toBe(false);
  });

  it('consumes optionalEvictionOrder in its exact published order, unsorted', () => {
    const order = evictionOrder(14);
    const evicted = compile({ specs: SPECS, available: 14 }, TOKENIZER).trace.settlement
      .evictedBlockIds;

    // Score ascending, then identifier descending — deliberately not alphabetical.
    expect(order).toEqual(['low', 'mid', 'high']);
    expect([...order].sort()).toEqual(['high', 'low', 'mid']);
    expect(evicted).toEqual(order.slice(0, evicted.length));
  });

  it('INV-ALLOC-006: category minimums survive every eviction prefix', () => {
    const policy = requestInput().policy as Record<string, unknown>;
    const withCategory = {
      ...policy,
      allocation: {
        schemaVersion: 1,
        policyId: 'allocation',
        policyVersion: '4.0.0',
        optionalSelection: 'score-desc-greedy',
        categoryConstraints: [{ category: 'facts', minBlocks: 1 }],
      },
    };
    const result = compile(
      {
        specs: [
          { id: 'must', tokens: 2, required: true, priority: 0 },
          { id: 'f1', tokens: 2, category: 'facts', priority: 900 },
          { id: 'f2', tokens: 2, category: 'facts', priority: 100 },
        ],
        available: 12,
        policy: withCategory,
      },
      TOKENIZER,
    );

    const facts = includedIds(result).filter((id) => id.startsWith('f'));
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(12);
  });

  it('re-orders the corrected selection with the ContextOrderer semantics', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    // Render order is source position, not allocation chronology and not the
    // eviction order: `high` precedes `must` because its content is shorter.
    expect(renderedIds(result)).toEqual(includedIds(result));
    expect(includedIds(result)).toEqual(['high', 'must']);
  });

  it('INV-BUDGET-002: tokenizes the exact full string after every correction', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    expect(result.usage.compiledTokens).toBe(TOKENIZER.countTokens(result.compiledContext));
    expect(result.usage.compiledTokens).toBe(10);
  });

  it('marks an evicted block EXCLUDED_RENDER_AWARE_CORRECTION', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    for (const evicted of ['low', 'mid']) {
      const decision = finalDecisionFor(result, evicted);
      expect(decision.disposition).toBe('excluded');
      expect(decision.reason).toBe('EXCLUDED_RENDER_AWARE_CORRECTION');
      // The code that belongs to the allocator's content decision is not reused.
      expect(decision.reason).not.toBe('EXCLUDED_BUDGET_EXHAUSTED');
    }
  });

  it('leaves the original allocation evidence untouched in the base trace', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);

    // The allocator included all four; the settlement removed two. Both facts
    // are readable, side by side.
    expect([...result.trace.allocation.includedBlockIds].sort()).toEqual([
      'high',
      'low',
      'mid',
      'must',
    ]);
    expect(result.trace.ordering.orderedBlockIds).toHaveLength(4);
    expect(result.trace.rendering.fitsAvailableInputBudget).toBe(false);
    for (const id of ['low', 'mid']) {
      const group = result.trace.groups.find((candidate) => candidate.canonical.id === id);
      expect(group?.allocation).toEqual({ decision: 'included', reason: 'INCLUDED_SCORE_ORDER' });
      expect(group?.currentDisposition).toBe('included');
    }
  });

  it('records the initial over-budget measurement beside the settled one', () => {
    const result = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    expect(result.trace.settlement.initialRenderedTokens).toBe(20);
    expect(result.trace.rendering.renderedTokens).toBe(20);
    expect(result.trace.settlement.rendering.compiledTokens).toBe(10);
  });

  it('INV-BUDGET-001: the settled result is within the available budget', () => {
    for (const available of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
      const result = compile({ specs: SPECS, available }, TOKENIZER);
      expect(result.usage.compiledTokens, `available ${String(available)}`).toBeLessThanOrEqual(
        available,
      );
      expect(result.usage.unusedTokens).toBe(available - result.usage.compiledTokens);
    }
  });

  it('INV-ALLOC-005: candidate input order does not change the correction', () => {
    const forward = compile({ specs: SPECS, available: 14 }, TOKENIZER);
    const reversed = compile({ specs: [...SPECS].reverse(), available: 14 }, TOKENIZER);

    expect(reversed.compiledContext).toBe(forward.compiledContext);
    expect(reversed.trace.settlement.evictedBlockIds).toEqual(
      forward.trace.settlement.evictedBlockIds,
    );
    expect(reversed.usage).toEqual(forward.usage);
  });
});

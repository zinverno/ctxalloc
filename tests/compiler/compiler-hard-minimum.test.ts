import { readFileSync } from 'node:fs';
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
  COUNTEREXAMPLE_AVAILABLE,
  COUNTEREXAMPLE_SPECS,
  COUNTEREXAMPLE_TOKENIZER,
  COUNTEREXAMPLE_WITH_SURPLUS_SPECS,
  FACTS_MINIMUM_POLICY,
  SURPLUS_AVAILABLE,
  compile,
  finalDecisionFor,
  finalReasons,
  includedIds,
  recordingTokenizer,
  renderedIds,
  requestInput,
  permutations,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The hard-minimum replacement search (DEC-038).
 *
 * This is the Phase 10 counterexample made real. `BudgetAllocator` picks the
 * category-minimum block that minimizes **canonical content** cost, and rendering
 * overhead varies per block, so the protected choice can render far more
 * expensively than an unselected candidate satisfying the same minimum.
 *
 * Exhausting `optionalEvictionOrder` therefore proves nothing about feasibility.
 * Declaring infeasibility there would be wrong, and this file pins that it does
 * not happen.
 */

function counterexample(): ReturnType<typeof compile> {
  return compile(
    {
      specs: COUNTEREXAMPLE_SPECS,
      available: COUNTEREXAMPLE_AVAILABLE,
      policy: FACTS_MINIMUM_POLICY,
    },
    COUNTEREXAMPLE_TOKENIZER,
  );
}

/** The allocation the compiler starts from, reproduced stage by stage. */
function allocationOf(
  specs: readonly CandidateSpec[],
  available: number,
): ReturnType<BudgetAllocator['allocate']> {
  const request = new CompilationRequestValidator().validate(
    requestInput({ specs, available, policy: FACTS_MINIMUM_POLICY }),
  );
  const validated = new CandidateValidator(COUNTEREXAMPLE_TOKENIZER).validate({
    scope: request.scope,
    sourceDocuments: request.sourceDocuments,
    candidates: request.candidates,
  });
  const scored = new CandidateScorer(request.policy.scoring).score(
    new CandidateDeduplicator().deduplicate(validated),
    request.referenceTime,
  );
  const filtered = new CandidateFilter(request.policy.filtering).filter(scored);
  return new BudgetAllocator(request.policy.allocation).allocate(filtered.eligible, request.budget);
}

describe('DEC-038: render-aware replacement of a protected category minimum', () => {
  it('BudgetAllocator chooses the cheaper-by-content candidate A initially', () => {
    const allocated = allocationOf(COUNTEREXAMPLE_SPECS, COUNTEREXAMPLE_AVAILABLE);
    const included = allocated.included.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );

    expect(included.sort()).toEqual(['a', 'req']);
    expect(
      allocated.included.find((d) => d.candidate.candidate.canonicalBlock.id === 'a')?.reason,
    ).toBe('INCLUDED_CATEGORY_MINIMUM');
    expect(
      allocated.excluded.find((d) => d.candidate.candidate.canonicalBlock.id === 'b')?.reason,
    ).toBe('EXCLUDED_BUDGET_EXHAUSTED');
  });

  it('optionalEvictionOrder cannot remove A, because it is the protected minimum', () => {
    const allocated = allocationOf(COUNTEREXAMPLE_SPECS, COUNTEREXAMPLE_AVAILABLE);
    expect(allocated.optionalEvictionOrder).toEqual([]);
  });

  it('the initial protected render is over budget', () => {
    const result = counterexample();
    // 3 content tokens + 10 rendered penalty tokens for `a`.
    expect(result.trace.settlement.initialRenderedTokens).toBe(13);
    expect(result.trace.rendering.fitsAvailableInputBudget).toBe(false);
  });

  it('does not fail: an exhausted eviction order is not a feasibility proof', () => {
    expect(counterexample).not.toThrow();
    expect(counterexample().trace.settled).toBe(true);
  });

  it('visits the allocator-preferred base A first, then reaches B', () => {
    const search = counterexample().trace.settlement.fallbackSearch;

    expect(search.used).toBe(true);
    // Three selections: the required-only probe, then {req, a} — the allocator's
    // own preference — then {req, b}.
    expect(search.selectionsVisited).toBe(3);
    expect(search.maxSelections).toBe(64);
    expect(search.phase).toBe('hard-base');
  });

  it("B's exact rendered string fits, and B is what settles", () => {
    const result = counterexample();

    expect([...includedIds(result)].sort()).toEqual(['b', 'req']);
    expect(includedIds(result)).not.toContain('a');
    expect(result.usage.compiledTokens).toBe(8);
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(COUNTEREXAMPLE_AVAILABLE);
    expect(result.trace.settlement.fallbackSearch.chosenBlockIds).toEqual(['b', 'req']);
    expect(result.trace.settlement.fallbackSearch.phase).toBe('hard-base');
  });

  it('records B as a category minimum and A as a correction exclusion', () => {
    const result = counterexample();

    expect(finalReasons(result)).toEqual({
      a: 'EXCLUDED_RENDER_AWARE_CORRECTION',
      b: 'INCLUDED_CATEGORY_MINIMUM',
      req: 'INCLUDED_REQUIRED',
    });
    const excluded = finalDecisionFor(result, 'a');
    expect(excluded.disposition).toBe('excluded');
  });

  it('keeps the original allocation evidence showing A selected', () => {
    const result = counterexample();

    expect([...result.trace.allocation.includedBlockIds].sort()).toEqual(['a', 'req']);
    const groupA = result.trace.groups.find((group) => group.canonical.id === 'a');
    expect(groupA?.allocation).toEqual({
      decision: 'included',
      reason: 'INCLUDED_CATEGORY_MINIMUM',
    });
    expect(groupA?.currentDisposition).toBe('included');
    // The settlement states the final verdict separately, without rewriting it.
    expect(result.trace.settlement.decisions).toContainEqual({
      blockId: 'a',
      disposition: 'excluded',
      reason: 'EXCLUDED_RENDER_AWARE_CORRECTION',
    });
  });

  it('compiles B into the rendered string and leaves A out of it', () => {
    const result = counterexample();

    expect(renderedIds(result)).toEqual(includedIds(result));
    expect(result.compiledContext).toContain('"blockId":"b"');
    expect(result.compiledContext).not.toContain('"blockId":"a"');
  });

  it('INV-BUDGET-001: the hard budget is satisfied and the minimum still holds', () => {
    const result = counterexample();
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(result.usage.availableTokens);
    expect(result.usage.unusedTokens).toBe(0);
    // Category `facts` still has its one required block.
    expect(includedIds(result).filter((id) => id === 'b')).toHaveLength(1);
  });

  it('INV-ALLOC-005: input permutation reaches the identical settled result', () => {
    const results = permutations([...COUNTEREXAMPLE_SPECS]).map((specs) =>
      compile(
        { specs, available: COUNTEREXAMPLE_AVAILABLE, policy: FACTS_MINIMUM_POLICY },
        COUNTEREXAMPLE_TOKENIZER,
      ),
    );
    const [first] = results;
    for (const result of results) {
      expect(result.compiledContext).toBe(first?.compiledContext);
      expect(result.usage).toEqual(first?.usage);
      expect(result.trace.settlement.fallbackSearch).toEqual(
        first?.trace.settlement.fallbackSearch,
      );
    }
  });

  it('does not tokenize the already-measured protected selection twice', () => {
    const calls: string[] = [];
    compile(
      {
        specs: COUNTEREXAMPLE_SPECS,
        available: COUNTEREXAMPLE_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
      },
      recordingTokenizer(calls, COUNTEREXAMPLE_TOKENIZER),
    );

    const renders = calls.filter((text) => text.includes('"blockId":'));
    const protectedRenders = renders.filter(
      (text) => text.includes('"blockId":"a"') && text.includes('"blockId":"req"'),
    );
    // {req, a} is measured once by ContextRenderer and reused from the cache when
    // the enumerator reaches the same block-ID set.
    expect(protectedRenders).toHaveLength(1);
  });

  it('INV-BUDGET-002: every feasibility decision measured one complete string', () => {
    const calls: string[] = [];
    compile(
      {
        specs: COUNTEREXAMPLE_SPECS,
        available: COUNTEREXAMPLE_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
      },
      recordingTokenizer(calls, COUNTEREXAMPLE_TOKENIZER),
    );

    const renders = calls.filter((text) => text.includes('"blockId":'));
    // The required-only probe, and the {req, b} base. {req, a} came from the
    // renderer's own attempt.
    expect(renders).toContain(
      '{"blockId":"req","content":"req w0","sourceDocumentId":"doc-1","sourceType":"markdown"}',
    );
    expect(renders.every((text) => text.startsWith('{"blockId":'))).toBe(true);
  });
});

describe('DEC-038: version 1 never re-augments a settled hard base', () => {
  function withSurplus(): ReturnType<typeof compile> {
    return compile(
      {
        specs: COUNTEREXAMPLE_WITH_SURPLUS_SPECS,
        available: SURPLUS_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
      },
      COUNTEREXAMPLE_TOKENIZER,
    );
  }

  it('settles the hard base alone', () => {
    const result = withSurplus();
    expect([...includedIds(result)].sort()).toEqual(['b', 'req']);
    expect(result.trace.settlement.fallbackSearch.used).toBe(true);
  });

  it('leaves an unconstrained optional block excluded even though it would fit', () => {
    const result = withSurplus();
    const decision = finalDecisionFor(result, 'extra');

    expect(decision.disposition).toBe('excluded');
    expect(decision.reason).toBe('EXCLUDED_RENDER_AWARE_CORRECTION');

    // Adding `extra` would render to exactly the available budget. v1 does not.
    const wouldFit = COUNTEREXAMPLE_TOKENIZER.countTokens(
      `${result.compiledContext}\n{"blockId":"extra","content":"extra","sourceDocumentId":"doc-1","sourceType":"markdown"}`,
    );
    expect(wouldFit).toBeLessThanOrEqual(SURPLUS_AVAILABLE);
  });

  it('claims no maximum utilization, score, or block count', () => {
    const result = withSurplus();
    expect(result.usage.unusedTokens).toBe(1);
    for (const invented of [
      'budgetUtilization',
      'maximized',
      'optimal',
      'tokenReduction',
      'reductionRatio',
    ]) {
      expect(Object.keys(result.usage), `usage exposes ${invented}`).not.toContain(invented);
    }
  });

  it('pins the no-re-augmentation rule in the source and the decision log', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    expect(source).toContain('Version 1 adds no optional');
    const decisions = readFileSync(new URL('docs/DECISIONS.md', rootUrl), 'utf8');
    expect(decisions).toContain('A Fitting Hard Base Is Never Re-Augmented');
  });
});

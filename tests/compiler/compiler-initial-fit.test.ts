import {
  COMPILATION_RESULT_SCHEMA_VERSION,
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextOrderer,
  ContextRenderer,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  compile,
  compilerConfig,
  countWords,
  finalReasons,
  includedIds,
  jsonlOverheadTokenizer,
  recordingTokenizer,
  renderedIds,
  requestInput,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

/**
 * The initial-fit path: every stage runs, nothing is corrected (DEC-038).
 *
 * No stage is skipped because the first render happens to fit. The settled
 * result is exactly what the hand-composed pipeline produces, and the settlement
 * records that no correction was applied.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 3, required: true, priority: 0 },
  { id: 'high', tokens: 3, priority: 900 },
  { id: 'low', tokens: 3, priority: 100 },
];

/** The same stages, composed by hand, for a byte-for-byte comparison. */
function byHand(options: Parameters<typeof compile>[0] = { specs: SPECS }): {
  readonly renderedContext: string;
  readonly renderedTokens: number;
  readonly includedIds: readonly string[];
} {
  const input = requestInput(options);
  const request = new CompilationRequestValidator().validate(input);
  const validated = new CandidateValidator(wordTokenizer).validate({
    scope: request.scope,
    sourceDocuments: request.sourceDocuments,
    candidates: request.candidates,
  });
  const deduplicated = new CandidateDeduplicator().deduplicate(validated);
  const scored = new CandidateScorer(request.policy.scoring).score(
    deduplicated,
    request.referenceTime,
  );
  const filtered = new CandidateFilter(request.policy.filtering).filter(scored);
  const allocated = new BudgetAllocator(request.policy.allocation).allocate(
    filtered.eligible,
    request.budget,
  );
  const ordered = new ContextOrderer(request.policy.ordering).order(allocated);
  const attempt = new ContextRenderer(request.policy.rendering, wordTokenizer).render(ordered);
  return {
    renderedContext: attempt.renderedContext,
    renderedTokens: attempt.renderedTokens,
    includedIds: ordered.orderedIncluded.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    ),
  };
}

describe('ContextCompiler: the initial render fits', () => {
  it('runs the whole named pipeline and returns a settled result', () => {
    const result = compile({ specs: SPECS, available: 100 });

    expect(result.schemaVersion).toBe(COMPILATION_RESULT_SCHEMA_VERSION);
    expect(result.requestId).toBe('req-compile-1');
    expect(result.trace.settled).toBe(true);
    expect(result.trace.groups).toHaveLength(3);
  });

  it('applies no correction', () => {
    const settlement = compile({ specs: SPECS, available: 100 }).trace.settlement;

    expect(settlement.correctionApplied).toBe(false);
    expect(settlement.evictedBlockIds).toEqual([]);
    expect(settlement.fallbackSearch.used).toBe(false);
    expect(settlement.fallbackSearch.selectionsVisited).toBe(0);
    expect(settlement.fallbackSearch).not.toHaveProperty('chosenBlockIds');
  });

  it('DEC-035: compiledContext is exactly the ContextRenderer string', () => {
    const result = compile({ specs: SPECS, available: 100 });
    const manual = byHand({ specs: SPECS, available: 100 });

    expect(result.compiledContext).toBe(manual.renderedContext);
    expect(result.usage.compiledTokens).toBe(manual.renderedTokens);
    expect(includedIds(result)).toEqual(manual.includedIds);
  });

  it('INV-BUDGET-002: compiledTokens counts the exact complete string', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(result.usage.compiledTokens).toBe(countWords(result.compiledContext));
    expect(result.trace.settlement.initialRenderedTokens).toBe(result.usage.compiledTokens);
  });

  it('INV-RENDER-001: includedBlocks follow the exact render order of the string', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(includedIds(result)).toEqual(renderedIds(result));
  });

  it('INV-BUDGET-003: the required block is included', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(includedIds(result)).toContain('must');
    expect(finalReasons(result)['must']).toBe('INCLUDED_REQUIRED');
  });

  it('INV-BUDGET-006: unusedTokens is exact', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(result.usage.unusedTokens).toBe(100 - result.usage.compiledTokens);
    expect(result.usage.availableTokens).toBe(100);
  });

  it('METRICS 8.6: renderingTokenDelta is the exact signed difference', () => {
    const result = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(2));
    expect(result.usage.renderingTokenDelta).toBe(
      result.usage.compiledTokens - result.usage.includedContentTokens,
    );
    expect(result.usage.renderingTokenDelta).toBe(2 * result.includedBlocks.length);
  });

  it('DEC-038: publishes validation-and-rendering coverage', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(result.trace.composition.tokenizerCoverage).toBe('validation-and-rendering');
  });

  it('binds the same compilation identifier to the result and to the trace', () => {
    const result = compile({ specs: SPECS, available: 100 });
    expect(result.trace.compilationId).toBe(result.compilationId);
  });

  it('is JSON-safe apart from the canonical domain blocks it carries by reference', () => {
    const result = compile({ specs: SPECS, available: 100 });
    const roundTripped = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(roundTripped).toEqual(result);
    expect(JSON.parse(JSON.stringify(result.trace))).toEqual(result.trace);
    // The blocks are the validated domain records themselves, not copies.
    expect(roundTripped.includedBlocks).toEqual(result.includedBlocks);
  });

  it('INV-DET-001: compiling the same request twice returns a deep-equal result', () => {
    const first = compile({ specs: SPECS, available: 100 });
    const second = compile({ specs: SPECS, available: 100 });
    expect(second).toEqual(first);
    expect(second.compiledContext).toBe(first.compiledContext);
  });

  it('DEC-038: one tokenizer object validates the blocks and measures the render', () => {
    const calls: string[] = [];
    compile({ specs: SPECS, available: 100 }, recordingTokenizer(calls));

    // Every block content was counted, and so was the exact rendered string.
    for (const spec of SPECS) {
      expect(calls.some((text) => text.startsWith(`${spec.id} `))).toBe(true);
    }
    expect(calls.some((text) => text.includes('"blockId":'))).toBe(true);
  });

  it('compiles an empty candidate batch to the exact empty string', () => {
    const result = compile({ specs: [], sourceDocuments: [], available: 100 });

    expect(result.compiledContext).toBe('');
    expect(result.includedBlocks).toEqual([]);
    expect(result.usage.compiledTokens).toBe(0);
    expect(result.usage.candidateTokens).toBe(0);
    expect(result.usage.includedContentTokens).toBe(0);
    expect(result.usage.unusedTokens).toBe(100);
    expect(result.usage.renderingTokenDelta).toBe(0);
    expect(result.trace.settlement.decisions).toEqual([]);
  });

  it('publishes exactly the documented result keys', () => {
    const result = compile({ specs: SPECS, available: 100 }, wordTokenizer, compilerConfig());
    expect(Object.keys(result).sort()).toEqual([
      'compilationId',
      'compiledContext',
      'includedBlocks',
      'requestId',
      'schemaVersion',
      'trace',
      'usage',
    ]);
  });
});

import { readFileSync } from 'node:fs';
import * as compiler from '@ctxalloc/compiler';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextOrderer,
  ContextRenderer,
  type CompilationRequest,
  type RenderedContextAttempt,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import { compilationPolicy } from './compilation-fixtures.js';
import { candidateOf } from './filtering-fixtures.js';
import { SCOPE, countWords, sourceDocument, wordTokenizer } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The named pipeline, composed by hand in the test (DEC-036).
 *
 * No `ContextCompiler` exists, so this file is the only place the stages are
 * joined. That is deliberate: composing them is the future orchestration's
 * responsibility, and a test that composes them proves the contracts fit without
 * inventing the component that will own them.
 *
 * One tokenizer is used for `CandidateValidator` block-count validation and for
 * `ContextRenderer` final-string measurement, which is exactly the composition
 * requirement DEC-035 records.
 */

const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

/** A policy that filters optional candidates scoring below 0.4. */
function policy(): Record<string, unknown> {
  return compilationPolicy({
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '3.0.0',
      minimumTotalScore: 0.4,
    },
  });
}

function requestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-pipeline-1',
    schemaVersion: 1,
    scope: { ...SCOPE },
    query: 'how does allocation work?',
    referenceTime: REFERENCE_TIME,
    candidates: [
      candidateOf({ id: 'must', priority: 0, tokens: 4, required: true }),
      candidateOf({ id: 'high', priority: 900, tokens: 4 }),
      candidateOf({ id: 'mid', priority: 500, tokens: 4 }),
      candidateOf({ id: 'low', priority: 100, tokens: 4 }),
    ],
    sourceDocuments: [sourceDocument()],
    budget: { totalTokens: 1000, reservedOutputTokens: 100 },
    policy: policy(),
    ...overrides,
  };
}

interface PipelineRun {
  readonly request: CompilationRequest;
  readonly filtered: ReturnType<CandidateFilter['filter']>;
  readonly allocated: ReturnType<BudgetAllocator['allocate']>;
  readonly attempt: RenderedContextAttempt;
}

/**
 * Runs the whole named pipeline once:
 *
 * ```text
 * CompilationRequest validation
 *   -> CandidateValidator -> CandidateDeduplicator -> CandidateScorer
 *   -> CandidateFilter -> BudgetAllocator -> ContextOrderer -> ContextRenderer
 * ```
 */
function run(
  input: Record<string, unknown> = requestInput(),
  tokenizer: Tokenizer = wordTokenizer,
): PipelineRun {
  const request = new CompilationRequestValidator().validate(input);

  const validated = new CandidateValidator(tokenizer).validate({
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
  const attempt = new ContextRenderer(request.policy.rendering, tokenizer).render(ordered);

  return { request, filtered, allocated, attempt };
}

function idsOf(attempt: RenderedContextAttempt): readonly string[] {
  return attempt.renderedContext
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { blockId: string }).blockId);
}

describe('named compiler pipeline', () => {
  it('filters a low-scoring optional candidate before allocation', () => {
    const { filtered, allocated } = run();

    expect(
      filtered.decisions.find((d) => d.candidate.candidate.canonicalBlock.id === 'low')?.reason,
    ).toBe('FILTERED_SCORE_BELOW_MINIMUM');
    expect(filtered.eligible.candidates.map((c) => c.candidate.canonicalBlock.id)).not.toContain(
      'low',
    );
    // The allocator never saw it, so it produced no decision about it at all.
    const allocationIds = [...allocated.included, ...allocated.excluded].map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );
    expect(allocationIds).not.toContain('low');
    expect(allocationIds.sort()).toEqual(['high', 'mid', 'must']);
  });

  it('INV-BUDGET-003: a required block scoring zero survives the filter and is included', () => {
    const { filtered, allocated, attempt } = run();

    expect(
      filtered.decisions.find((d) => d.candidate.candidate.canonicalBlock.id === 'must')?.reason,
    ).toBe('ELIGIBLE_REQUIRED');
    expect(
      allocated.included.find((d) => d.candidate.candidate.canonicalBlock.id === 'must')?.reason,
    ).toBe('INCLUDED_REQUIRED');
    expect(idsOf(attempt)).toContain('must');
  });

  it('INV-DET-004: the request reference time reaches the scorer', () => {
    const { allocated } = run();
    expect(allocated.referenceTime).toBe(REFERENCE_TIME);

    const other = run(requestInput({ referenceTime: '2020-01-01T00:00:00.000Z' }));
    expect(other.allocated.referenceTime).toBe('2020-01-01T00:00:00.000Z');
    expect(other.filtered.eligible.referenceTime).toBe('2020-01-01T00:00:00.000Z');
  });

  it('INV-BUDGET-002: the render attempt measures the exact string it produced', () => {
    const { attempt } = run();

    expect(attempt.renderedTokens).toBe(countWords(attempt.renderedContext));
    expect(attempt.tokenizerId).toBe(wordTokenizer.id);
    expect(attempt.fitsAvailableInputBudget).toBe(
      attempt.renderedTokens <= attempt.ordered.allocation.availableInputTokens,
    );
  });

  it('publishes no attempt-level token delta', () => {
    const { attempt } = run();
    for (const absent of [
      'renderedTokenDelta',
      'renderingTokenDelta',
      'renderingOverheadTokens',
      'compiledTokens',
      'unusedTokens',
    ]) {
      expect(Object.keys(attempt), `exposes ${absent}`).not.toContain(absent);
    }
  });

  it('renders exactly the included blocks in source order', () => {
    const { allocated, attempt } = run();
    expect(idsOf(attempt)).toHaveLength(allocated.included.length);
    expect(new Set(idsOf(attempt))).toEqual(
      new Set(allocated.included.map((d) => d.candidate.candidate.canonicalBlock.id)),
    );
  });

  it('INV-DET-001: the same request compiles to the same rendered string', () => {
    expect(run().attempt.renderedContext).toBe(run().attempt.renderedContext);
  });

  it('INV-ALLOC-005: candidate order in the request does not change the result', () => {
    const forward = run();
    const reversed = run(
      requestInput({ candidates: [...(requestInput().candidates as unknown[])].reverse() }),
    );

    expect(reversed.attempt.renderedContext).toBe(forward.attempt.renderedContext);
  });

  it('carries the request identity and query without letting them reach a stage', () => {
    const { request, attempt } = run(requestInput({ query: '   ' }));

    expect(request.id).toBe('req-pipeline-1');
    expect(request.query).toBe('   ');
    // The query is never rendered, never scored, and never filtered on.
    expect(attempt.renderedContext).not.toContain('req-pipeline-1');
  });

  it('exposes no orchestrator or correction loop to compose it for us', () => {
    for (const absent of ['ContextCompiler', 'CompilationResult', 'compile']) {
      expect(Object.keys(compiler), `exports ${absent}`).not.toContain(absent);
    }

    const sources = [
      'packages/compiler/src/index.ts',
      'packages/compiler/src/candidate-filter.ts',
      'packages/compiler/src/compilation-policy.ts',
      'packages/compiler/src/compilation-request.ts',
    ].map((path) => readFileSync(new URL(path, rootUrl), 'utf8'));

    for (const source of sources) {
      expect(source).not.toContain('class ContextCompiler');
      expect(source).not.toContain('renderingTokenDelta');
    }
  });
});

/**
 * INV-DET-001 and DEC-036: the request is caller-supplied request data, not the
 * whole deterministic input.
 *
 * The tokenizer is configured composition, external to the request. Composing
 * one byte-identical request with two different tokenizers is a legitimate pair
 * of runs whose measurements may differ — which is exactly why the request alone
 * does not determine the result. Neither run is wrong, and the two are
 * deliberately not asserted equal.
 */
describe('INV-DET-001: the deterministic input is the request plus its composition', () => {
  /**
   * Counts words plus double quotes.
   *
   * On quote-free block content it agrees with `wordTokenizer` exactly, so both
   * tokenizers accept the same candidates at validation. The rendered JSONL is
   * full of quotes, so the two disagree about the rendered string.
   */
  const quoteAwareTokenizer: Tokenizer = {
    id: 'test:word-plus-quotes',
    version: '1',
    countTokens: (text: string): number => countWords(text) + (text.match(/"/g) ?? []).length,
  };

  it('the request value carries no tokenizer, compiler version, or component instance', () => {
    const { request } = run();

    for (const composition of [
      'tokenizer',
      'tokenizerId',
      'tokenizerVersion',
      'compilerVersion',
      'rendererId',
      'rendererVersion',
      'renderer',
      'validator',
      'scorer',
      'allocator',
    ]) {
      expect(Object.keys(request), `request carries ${composition}`).not.toContain(composition);
    }
    // Nothing reachable from the request is a component instance or a function.
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });

  it('accepts the same request data under two different configured tokenizers', () => {
    const input = requestInput();
    expect(() => run(input, wordTokenizer)).not.toThrow();
    expect(() => run(input, quoteAwareTokenizer)).not.toThrow();
  });

  it('renders the same string but measures it differently under each tokenizer', () => {
    const input = requestInput();
    const a = run(input, wordTokenizer);
    const b = run(input, quoteAwareTokenizer);

    // The request decides the content: same selection, same rendered bytes.
    expect(b.attempt.renderedContext).toBe(a.attempt.renderedContext);
    // The composition decides the measurement.
    expect(a.attempt.tokenizerId).toBe('test:word');
    expect(b.attempt.tokenizerId).toBe('test:word-plus-quotes');
    expect(b.attempt.renderedTokens).not.toBe(a.attempt.renderedTokens);
    expect(b.attempt.renderedTokens).toBeGreaterThan(a.attempt.renderedTokens);
  });

  it('can reach different budget feasibility from one identical request', () => {
    const measured = run(requestInput(), wordTokenizer).attempt.renderedTokens;
    const larger = run(requestInput(), quoteAwareTokenizer).attempt.renderedTokens;
    // A budget one tokenizer's measurement fits and the other's does not.
    const available = Math.floor((measured + larger) / 2);
    expect(available).toBeGreaterThanOrEqual(measured);
    expect(available).toBeLessThan(larger);

    const input = requestInput({
      budget: { totalTokens: available + 10, reservedOutputTokens: 10 },
    });
    const a = run(input, wordTokenizer);
    const b = run(input, quoteAwareTokenizer);

    expect(a.attempt.fitsAvailableInputBudget).toBe(true);
    expect(b.attempt.fitsAvailableInputBudget).toBe(false);
    // Neither run is wrong. Determinism holds only when the tokenizer input is
    // identical too, which is why the request alone is not the whole input.
    expect(run(input, wordTokenizer).attempt).toEqual(a.attempt);
    expect(run(input, quoteAwareTokenizer).attempt).toEqual(b.attempt);
  });

  it('introduces no ContextCompiler to bind that composition', () => {
    expect(Object.keys(compiler)).not.toContain('ContextCompiler');
  });
});

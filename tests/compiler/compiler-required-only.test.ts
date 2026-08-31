import {
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
  failureOf,
  jsonlOverheadTokenizer,
  requestInput,
  type CandidateSpec,
} from './compiler-fixtures.js';

/**
 * The rendered form of INV-BUDGET-004 (DEC-038).
 *
 * `BudgetAllocator` already fails when required **block content** alone exceeds
 * the ceiling. The converse never held: required content that fits the content
 * ceiling is not proof that the rendered required context fits. This is the
 * failure only a component that renders and tokenizes can prove.
 *
 * ```text
 * must     required, 2 content tokens
 * opt      optional, 2 content tokens
 * overhead 8 rendered tokens per JSONL record
 * available 6
 *
 * required content     2  <= 6      BudgetAllocator succeeds
 * {must, opt} rendered 4 + 16 = 20  > 6
 * {must}      rendered 2 +  8 = 10  > 6   definitive
 * ```
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 2, required: true, priority: 0 },
  { id: 'opt', tokens: 2, priority: 900 },
];

const TOKENIZER = jsonlOverheadTokenizer(8, 'test:heavy-jsonl');
const AVAILABLE = 6;

function run(): unknown {
  return compile({ specs: SPECS, available: AVAILABLE }, TOKENIZER);
}

describe('INV-BUDGET-004: required content exceeds the rendered budget', () => {
  it('BudgetAllocator itself succeeds on the block-content ceiling', () => {
    const request = new CompilationRequestValidator().validate(
      requestInput({ specs: SPECS, available: AVAILABLE }),
    );
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
    const allocated = new BudgetAllocator(request.policy.allocation).allocate(
      filtered.eligible,
      request.budget,
    );

    expect(allocated.selectedBlockContentTokens).toBe(4);
    expect(allocated.selectedBlockContentTokens).toBeLessThanOrEqual(AVAILABLE);
    expect(allocated.optionalEvictionOrder).toEqual(['opt']);

    // And the render attempt is over budget, reported rather than raised.
    const ordered = new ContextOrderer(request.policy.ordering).order(allocated);
    const attempt = new ContextRenderer(request.policy.rendering, TOKENIZER).render(ordered);
    expect(attempt.renderedTokens).toBe(20);
    expect(attempt.fitsAvailableInputBudget).toBe(false);
  });

  it('exhausts every safe optional eviction before deciding', () => {
    const failure = failureOf(run);
    expect(failure.stage).toBe('correction');
    // The optional block was given back, the required-only render was measured,
    // and only then did the compilation fail.
    expect(failure.issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
  });

  it('raises the REQUIRED_CONTENT_EXCEEDS_BUDGET category', () => {
    const failure = failureOf(run);
    expect(failure.name).toBe('ContextCompilationError');
    expect(failure.code).toBe('CONTEXT_COMPILATION_FAILED');
    const message = failure.issues[0] as { code: string; pointer: string } | undefined;
    expect(message?.code).toBe('required_content_exceeds_budget');
    expect(message?.pointer).toBe('correction.requiredBlocks');
    let text = '';
    try {
      run();
    } catch (error) {
      text = (error as Error).message;
    }
    expect(text).toContain('REQUIRED_CONTENT_EXCEEDS_BUDGET');
  });

  it('returns no successful result', () => {
    expect(run).toThrow();
    let returned: unknown;
    try {
      returned = run();
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('INV-BUDGET-003: the required block is never removed to repair the overrun', () => {
    const failure = failureOf(run);
    const trace = failure.trace as { allocation: { includedBlockIds: readonly string[] } };
    expect(trace.allocation.includedBlockIds).toContain('must');
    // No settled trace exists, so no final selection dropped it either.
    expect(failure.trace).not.toHaveProperty('settlement');
  });

  it('carries the compilation identifier of the failed invocation', () => {
    const failure = failureOf(run);
    const fingerprint = (failure.trace as { request: { fingerprint: string } }).request.fingerprint;

    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The identifier names the deterministic invocation, not a successful
    // output, and it is not the request fingerprint.
    expect(failure.compilationId).not.toBe(fingerprint);
    expect(failureOf(run).compilationId).toBe(failure.compilationId);
  });

  it('carries the coherent unsettled snapshot of the attempt that failed', () => {
    const failure = failureOf(run);
    const trace = failure.trace as {
      schemaVersion: number;
      settled: boolean;
      composition: { tokenizerCoverage: string };
      rendering: { renderedTokens: number; fitsAvailableInputBudget: boolean };
      totals: { candidateTokens: number };
    };

    expect(trace.schemaVersion).toBe(2);
    expect(trace.settled).toBe(false);
    expect(trace.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    expect(trace.rendering.renderedTokens).toBe(20);
    expect(trace.rendering.fitsAvailableInputBudget).toBe(false);
    expect(trace.totals.candidateTokens).toBe(4);
  });

  it('INV-SEC-003: neither the error nor the trace carries raw content', () => {
    const failure = failureOf(run);
    const serialized = JSON.stringify({ issues: failure.issues, trace: failure.trace });

    expect(serialized).not.toContain('which blocks explain allocation?');
    expect(serialized).not.toContain('must w0');
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"renderedContext"');
    expect(serialized).not.toContain('"compiledContext"');
  });

  it('INV-ADAPTER-003: exposes no nested error object', () => {
    let thrown: unknown;
    try {
      run();
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as { issues: readonly unknown[] };
    expect(JSON.stringify(failure.issues)).not.toContain('stack');
    for (const issue of failure.issues) {
      expect(Object.keys(issue as object).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });
});

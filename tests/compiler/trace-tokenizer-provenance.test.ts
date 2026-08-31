import { readFileSync } from 'node:fs';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextOrderer,
  ContextRenderer,
  TraceBuilder,
  type CompilationTrace,
  type CompilationTraceTokenizerCoverage,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  TRACE_CONFIG,
  buildTrace,
  contextBlock,
  countWords,
  requestInput,
  runPipeline,
  sourceDocument,
  trace,
  type CandidateSpec,
} from './trace-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * Tokenizer provenance coverage (DEC-037).
 *
 * `composition.tokenizer` is the tokenizer the **renderer** was given. It proves
 * which tokenizer measured the rendered string, and nothing else: no stage
 * contract from `ValidatedCandidateSet` through `OrderedCandidateSet` carries the
 * identity of the tokenizer that produced the validated block counts (DEC-035,
 * DEC-036), so `TraceBuilder` cannot see it and cannot detect a mismatch.
 *
 * `composition.tokenizerCoverage` states the scope of the claim instead of
 * widening it, and Phase 14 always publishes `rendering-attempt-only`.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'alpha', tokens: 4, priority: 900 },
  { id: 'beta', tokens: 6, priority: 500 },
];

/** One token per whitespace-separated word — the counts the fixtures declare. */
const TOK_A: Tokenizer = { id: 'tok-A', version: '1', countTokens: countWords };

/**
 * A second tokenizer that agrees with `tok-A` on quote-free block content and
 * disagrees on the rendered JSONL, which is full of quotes.
 *
 * Agreement on block content is what makes the miscomposition *reachable*:
 * `CandidateValidator` accepts the declared counts under either tokenizer, so the
 * pipeline runs to completion and the mismatch stays invisible to every stage.
 */
const TOK_B: Tokenizer = {
  id: 'tok-B',
  version: '1',
  countTokens: (text: string): number => countWords(text) + (text.match(/"/g) ?? []).length,
};

/**
 * Composes the pipeline by hand with two different tokenizers.
 *
 * This is a legitimate manual composition today: no stage rejects it, because no
 * stage can compare an identity it never receives (DEC-035). It is exactly the
 * arrangement the coverage field exists to describe honestly.
 */
function miscomposedRun(
  validationTokenizer: Tokenizer,
  renderingTokenizer: Tokenizer,
): { readonly trace: CompilationTrace; readonly renderedTokens: number } {
  const request = new CompilationRequestValidator().validate(
    requestInput({ specs: SPECS, available: 100 }),
  );

  const validated = new CandidateValidator(validationTokenizer).validate({
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
  const rendered = new ContextRenderer(request.policy.rendering, renderingTokenizer).render(
    ordered,
  );

  return {
    trace: new TraceBuilder({ ...TRACE_CONFIG }).build({
      request,
      validated,
      deduplicated,
      filtered,
      rendered,
    }),
    renderedTokens: rendered.renderedTokens,
  };
}

describe('DEC-037: a miscomposed pipeline is traced honestly, not repaired', () => {
  it('validates under tok-A and renders under tok-B without any stage objecting', () => {
    const { trace: built, renderedTokens } = miscomposedRun(TOK_A, TOK_B);

    // The two tokenizers genuinely disagree about the rendered string.
    expect(renderedTokens).toBeGreaterThan(built.totals.candidateTokens);
    expect(renderedTokens).not.toBe(countWords(''));
    expect(built.schemaVersion).toBe(1);
  });

  it('records the renderer-observed identity with rendering-attempt-only coverage', () => {
    const { trace: built, renderedTokens } = miscomposedRun(TOK_A, TOK_B);

    expect(built.composition.tokenizer).toEqual({ id: 'tok-B', version: '1' });
    expect(built.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    expect(built.rendering.renderedTokens).toBe(renderedTokens);
  });

  it('keeps the content totals the validated tok-A counts produced', () => {
    const { trace: built } = miscomposedRun(TOK_A, TOK_B);

    // 4 (alpha) + 6 (beta), the counts CandidateValidator accepted under tok-A.
    expect(built.totals.candidateTokens).toBe(10);
    expect(built.totals.canonicalContentTokens).toBe(10);
    expect(built.totals.includedContentTokens).toBe(10);
    // The block-content totals still reconcile exactly among themselves.
    expect(built.totals.canonicalContentTokens).toBe(
      built.totals.includedContentTokens + built.totals.excludedCanonicalContentTokens,
    );
  });

  it('claims the validation tokenizer identity nowhere in the trace', () => {
    const { trace: built } = miscomposedRun(TOK_A, TOK_B);

    // tok-A is real and unknown to TraceBuilder, so the record must not name it.
    expect(JSON.stringify(built)).not.toContain('tok-A');
    for (const forbidden of [
      'validationTokenizer',
      'validationTokenizerId',
      'validationTokenizerVersion',
      'candidateTokenizer',
      'blockTokenizer',
    ]) {
      expect(JSON.stringify(built), `the trace exposes ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('builds successfully rather than rejecting the unavailable identity', () => {
    // A trace is never refused merely because the earlier identity is unknown:
    // the pipeline succeeded, and the record says exactly what it can prove.
    expect(() => miscomposedRun(TOK_A, TOK_B)).not.toThrow();
    expect(() => miscomposedRun(TOK_B, TOK_A)).not.toThrow();

    const reversed = miscomposedRun(TOK_B, TOK_A);
    expect(reversed.trace.composition.tokenizer).toEqual({ id: 'tok-A', version: '1' });
    expect(reversed.trace.composition.tokenizerCoverage).toBe('rendering-attempt-only');
  });
});

describe('DEC-037: coverage is never upgraded by evidence', () => {
  it('stays rendering-attempt-only when one tokenizer really did both stages', () => {
    // The composition is sound here — but `TraceBuilder` cannot know that. Its
    // inputs carry one tokenizer identity, from the render attempt, so the
    // strongest honest claim is unchanged.
    const same = miscomposedRun(TOK_A, TOK_A);

    expect(same.trace.composition.tokenizer).toEqual({ id: 'tok-A', version: '1' });
    expect(same.trace.composition.tokenizerCoverage).toBe('rendering-attempt-only');
  });

  it('stays rendering-attempt-only when the counts happen to agree', () => {
    // Matching numbers are not evidence of a matching tokenizer: two tokenizers
    // may agree on one batch and diverge on the next.
    const built = trace({ specs: SPECS, available: 100 });
    expect(built.composition.tokenizerCoverage).toBe('rendering-attempt-only');
  });

  it('stays rendering-attempt-only for an empty selection', () => {
    const empty = trace({ specs: [], sourceDocuments: [] });
    expect(empty.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    expect(empty.totals.candidateTokens).toBe(0);
  });

  it('stays rendering-attempt-only across every fixture shape', () => {
    const shapes: readonly CompilationTrace[] = [
      trace({ specs: SPECS, available: 100 }),
      trace({ specs: [{ id: 'req', tokens: 3, required: true }], available: 100 }),
      trace({
        candidates: [
          { schemaVersion: 1, block: contextBlock({ id: 'solo', content: 'one two three' }) },
        ],
        sourceDocuments: [sourceDocument()],
        available: 100,
      }),
      buildTrace(runPipeline({ specs: SPECS, available: 1 })),
    ];

    for (const built of shapes) {
      expect(built.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    }
  });
});

describe('the tokenizer coverage contract', () => {
  it('publishes exactly the two documented literals', () => {
    const renderingOnly: CompilationTraceTokenizerCoverage = 'rendering-attempt-only';
    const both: CompilationTraceTokenizerCoverage = 'validation-and-rendering';

    expect([renderingOnly, both]).toEqual(['rendering-attempt-only', 'validation-and-rendering']);

    // @ts-expect-error an arbitrary string is not a coverage value
    const arbitrary: CompilationTraceTokenizerCoverage = 'unknown';
    // @ts-expect-error a plausible-sounding neighbour is not one either
    const neighbour: CompilationTraceTokenizerCoverage = 'validation-only';
    // @ts-expect-error the widened primitive is not one either
    const widened: CompilationTraceTokenizerCoverage = String('rendering-attempt-only');

    expect([arbitrary, neighbour, widened]).toHaveLength(3);
  });

  it('is a required field of the published composition', () => {
    const built = trace({ specs: SPECS, available: 100 });

    expect(Object.keys(built.composition).sort()).toEqual([
      'compiler',
      'policy',
      'renderer',
      'tokenizer',
      'tokenizerCoverage',
    ]);
    // It survives the JSON round trip like every other trace field.
    expect((JSON.parse(JSON.stringify(built)) as CompilationTrace).composition).toStrictEqual(
      built.composition,
    );
  });

  it('adds no caller-asserted validation tokenizer to the builder configuration', () => {
    // The manual caller is exactly the party who may miscompose the stages, so an
    // asserted identity would be a claim rather than evidence.
    for (const asserted of [
      { compilerId: 'c', compilerVersion: '1', validationTokenizerId: 'tok-A' },
      { compilerId: 'c', compilerVersion: '1', tokenizerCoverage: 'validation-and-rendering' },
      { compilerId: 'c', compilerVersion: '1', validationTokenizerVersion: '1' },
    ]) {
      expect(() => new TraceBuilder(asserted)).toThrow(/Compilation trace build failed/);
    }
  });
});

describe('Phase 14 never emits validation-and-rendering', () => {
  it('assigns the weaker literal in the only place coverage is projected', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/compilation-trace.ts', rootUrl),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The literal exists in the published type, and is assigned nowhere.
    const assignments = [...source.matchAll(/tokenizerCoverage:\s*'([a-z-]+)'/g)].map(
      (match) => match[1],
    );
    expect(assignments).toEqual(['rendering-attempt-only']);
    expect(source).not.toContain("tokenizerCoverage: 'validation-and-rendering'");
    // The union itself still declares both, so Phase 15 needs no schema change.
    expect(source).toContain("| 'validation-and-rendering'");
  });

  it('never produces the stronger value at runtime, under any composition', () => {
    const traces: readonly CompilationTrace[] = [
      miscomposedRun(TOK_A, TOK_B).trace,
      miscomposedRun(TOK_B, TOK_A).trace,
      miscomposedRun(TOK_A, TOK_A).trace,
      miscomposedRun(TOK_B, TOK_B).trace,
      trace({ specs: [], sourceDocuments: [] }),
    ];

    for (const built of traces) {
      expect(built.composition.tokenizerCoverage).not.toBe('validation-and-rendering');
      expect(built.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    }
  });

  it('keeps every final metric absent, coverage notwithstanding', () => {
    const serialized = JSON.stringify(miscomposedRun(TOK_A, TOK_B).trace);

    for (const absent of [
      'renderedTokenDelta',
      'renderingTokenDelta',
      'renderingOverheadTokens',
      'compiledTokens',
      'unusedTokens',
    ]) {
      expect(serialized, `the trace exposes ${absent}`).not.toContain(absent);
    }
  });
});

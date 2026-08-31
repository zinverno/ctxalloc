import { readFileSync } from 'node:fs';
import { TraceBuilder, type CompilationTrace } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  TRACE_CONFIG,
  buildTrace,
  contextBlock,
  countWords,
  permutations,
  recordingTokenizer,
  runPipeline,
  sourceDocument,
  trace,
  tracePolicy,
  type CandidateSpec,
} from './trace-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * INV-TRACE-006: trace generation is observational.
 *
 * Building a trace must not change any stage's evidence, invoke any stage, call
 * a tokenizer, or depend on anything but the evidence it was given.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'req', tokens: 5, priority: 0, required: true },
  { id: 'high', tokens: 4, priority: 900 },
  { id: 'low', tokens: 7, priority: 100 },
];

describe('INV-TRACE-006: building a trace changes nothing', () => {
  it('mutates no part of the supplied evidence', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const before = JSON.stringify({
      request: run.request,
      validated: run.validated,
      deduplicated: run.deduplicated,
      filtered: run.filtered,
      rendered: run.rendered,
    });

    buildTrace(run);

    expect(
      JSON.stringify({
        request: run.request,
        validated: run.validated,
        deduplicated: run.deduplicated,
        filtered: run.filtered,
        rendered: run.rendered,
      }),
    ).toBe(before);
  });

  it('leaves the rendered context byte-for-byte unchanged', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const rendered = run.rendered.renderedContext;

    buildTrace(run);

    expect(run.rendered.renderedContext).toBe(rendered);
    expect(run.rendered.renderedTokens).toBe(countWords(rendered));
  });

  it('does not reorder the arrays the stages published', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const includedIds = run.allocated.included.map(
      (decision) => decision.candidate.candidate.canonicalBlock.id,
    );
    const evictionOrder = [...run.allocated.optionalEvictionOrder];
    const members = run.deduplicated.candidates.map((group) =>
      group.members.map((member) => member.candidate.block.id),
    );

    buildTrace(run);

    expect(
      run.allocated.included.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    ).toEqual(includedIds);
    expect(run.allocated.optionalEvictionOrder).toEqual(evictionOrder);
    expect(
      run.deduplicated.candidates.map((group) => group.members.map((m) => m.candidate.block.id)),
    ).toEqual(members);
  });

  it('never calls the tokenizer', () => {
    const calls: string[] = [];
    const tokenizer = recordingTokenizer(calls);
    const run = runPipeline({ specs: SPECS, available: 20, tokenizer });

    const duringPipeline = calls.length;
    expect(duringPipeline).toBeGreaterThan(0);

    buildTrace(run);
    expect(calls.length).toBe(duringPipeline);
  });

  it('invokes no compiler stage', () => {
    // Only declared code is inspected; the module documentation legitimately
    // names the stages whose evidence it observes.
    const source = readFileSync(
      new URL('packages/compiler/src/compilation-trace.ts', rootUrl),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const stage of [
      /new CandidateValidator/,
      /new CandidateDeduplicator/,
      /new CandidateScorer/,
      /new CandidateFilter/,
      /new BudgetAllocator/,
      /new ContextOrderer/,
      /new ContextRenderer/,
      // No tokenizer port reaches it, and no hash rule is recomputed. The
      // pattern is word-bounded: `CompilationTraceTokenizerCoverage` is a
      // published trace type, while the bare `Tokenizer` is the port.
      /\bTokenizer\b/,
      /\bcountTokens\b/,
      /calculateNormalizedContentHash/,
      /normalizeContextBlockContentForHash/,
    ]) {
      expect(stage.test(source), `the trace module uses ${stage.source}`).toBe(false);
    }
    // Every stage type it does name arrives as a type-only import.
    for (const module of [
      './budget-allocator.js',
      './candidate-filter.js',
      './candidate-deduplicator.js',
      './candidate-scorer.js',
      './candidate-validator.js',
      './compilation-request.js',
      './context-renderer.js',
    ]) {
      expect(source).toContain(`} from '${module}'`);
      expect(source.slice(0, source.indexOf(`} from '${module}'`))).toMatch(/import type \{[^}]*$/);
    }
  });

  it('INV-DET-001: the same coherent evidence produces a deep-equal trace', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const first = buildTrace(run);
    const second = buildTrace(run);

    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // And two independent runs of the same request agree too.
    const rebuilt = buildTrace(runPipeline({ specs: SPECS, available: 20 }));
    expect(rebuilt).toStrictEqual(first);
  });

  it('INV-DET-002: does not depend on candidate input order', () => {
    const traces = permutations([...SPECS]).map((specs) =>
      JSON.stringify(trace({ specs, available: 20 })),
    );
    // The request fingerprint is deliberately order-sensitive, so it is compared
    // separately from everything the compiler decided.
    const withoutFingerprint = traces.map((serialized) => {
      const parsed = JSON.parse(serialized) as CompilationTrace;
      const request: Record<string, unknown> = { ...parsed.request };
      delete request['fingerprint'];
      return JSON.stringify({ ...parsed, request });
    });

    expect(new Set(withoutFingerprint).size).toBe(1);
  });

  it('INV-DET-002: does not depend on locale collation or on registry order', () => {
    const documents = [
      sourceDocument({ id: 'a-doc' }),
      sourceDocument({ id: 'B-doc' }),
      sourceDocument({ id: 'A-doc' }),
    ];
    const blocks = documents.map((document, index) => ({
      schemaVersion: 1,
      block: contextBlock({
        id: `block-${String(index)}`,
        content: `content ${String(index)} here`,
        sourceDocumentId: document['id'],
      }),
    }));

    const traces = permutations(documents).map((registry) =>
      trace({ candidates: blocks, sourceDocuments: registry, available: 100 }),
    );

    for (const built of traces) {
      expect(built.sources.map((source) => source.id)).toEqual(['A-doc', 'B-doc', 'a-doc']);
      expect(built.groups.map((group) => group.canonical.id)).toEqual(
        traces[0]?.groups.map((group) => group.canonical.id),
      );
    }
  });
});

describe('DEC-037: the trace is current, not final', () => {
  /**
   * A selection whose rendered form exceeds the budget it was allocated under.
   *
   * The block's heading path renders as an extra whitespace-separated word, so
   * the rendered string measures one token more than the block content the
   * allocator budgeted for.
   */
  function overBudgetRun(): ReturnType<typeof runPipeline> {
    return runPipeline({
      available: 2,
      candidates: [
        {
          schemaVersion: 1,
          block: contextBlock({
            id: 'b1',
            content: 'alpha beta',
            headingPath: ['Chapter One'],
          }),
        },
      ],
      policy: tracePolicy(),
    });
  }

  it('traces an over-budget render attempt successfully', () => {
    const run = overBudgetRun();
    expect(run.rendered.fitsAvailableInputBudget).toBe(false);
    expect(run.rendered.renderedTokens).toBeGreaterThan(run.allocated.availableInputTokens);

    const built = buildTrace(run);
    expect(built.rendering.fitsAvailableInputBudget).toBe(false);
    expect(built.rendering.renderedTokens).toBe(run.rendered.renderedTokens);
    expect(built.groups[0]?.currentDisposition).toBe('included');
  });

  it('emits settled false for a fitting attempt and an over-budget one alike', () => {
    expect(buildTrace(overBudgetRun()).settled).toBe(false);
    expect(trace({ specs: SPECS, available: 100 }).settled).toBe(false);
  });

  it('publishes no final metric, result, or compilation identifier', () => {
    const built = trace({ specs: SPECS, available: 20 });
    const serialized = JSON.stringify(built);

    for (const absent of [
      'compiledTokens',
      'unusedTokens',
      'renderingTokenDelta',
      'renderingOverheadTokens',
      'tokenReduction',
      'budgetUtilization',
      'compilationId',
      'compilationFingerprint',
      'outcome',
      'success',
      'failureCode',
      'warnings',
      'includedBlocks',
      'compiledContext',
    ]) {
      expect(serialized, `the trace exposes ${absent}`).not.toContain(absent);
    }
  });

  it('declares none of those fields on any nested record', () => {
    const built = trace({ specs: SPECS, available: 20 });
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key);
          walk(entry);
        }
      }
    };
    walk(built);

    for (const absent of [
      'compiledTokens',
      'unusedTokens',
      'renderingTokenDelta',
      'compilationId',
    ]) {
      expect([...keys], `a nested record declares ${absent}`).not.toContain(absent);
    }
    expect(keys.has('settled')).toBe(true);
  });
});

describe('DEC-037: the compiler identity is composition, not request data', () => {
  it('changes the composition identity without changing anything else', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const first = buildTrace(run, { ...TRACE_CONFIG });
    const second = buildTrace(run, { compilerId: 'ctxalloc-compiler', compilerVersion: '0.15.0' });

    expect(second.composition.compiler.version).toBe('0.15.0');
    expect(first.composition.compiler.version).toBe('0.14.0');

    const withoutCompiler = (built: CompilationTrace): string => {
      const composition: Record<string, unknown> = { ...built.composition };
      delete composition['compiler'];
      return JSON.stringify({ ...built, composition });
    };
    expect(withoutCompiler(second)).toBe(withoutCompiler(first));
    expect(second.request.fingerprint).toBe(first.request.fingerprint);
  });

  it('leaves every prior stage result untouched by the compiler identity', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });
    const before = JSON.stringify(run.rendered);

    new TraceBuilder({ compilerId: 'a', compilerVersion: '1' }).build(run.input);
    new TraceBuilder({ compilerId: 'b', compilerVersion: '2' }).build(run.input);

    expect(JSON.stringify(run.rendered)).toBe(before);
  });
});

describe('DEC-037: a hand-composed Phase 13 pipeline feeds the trace builder', () => {
  it('builds one trace from the stage results a caller composed itself', () => {
    const run = runPipeline({ specs: SPECS, available: 20 });

    // Exactly the Phase 13 contracts, joined without a ContextCompiler.
    const built = new TraceBuilder({ ...TRACE_CONFIG }).build({
      request: run.request,
      validated: run.validated,
      deduplicated: run.deduplicated,
      filtered: run.filtered,
      rendered: run.rendered,
    });

    expect(built.totals.deduplicatedGroupCount).toBe(run.deduplicated.candidates.length);
    expect(built.ordering.orderedBlockIds).toHaveLength(run.ordered.orderedIncluded.length);
    expect(built.composition.tokenizer.id).toBe(run.rendered.tokenizerId);
    expect(built.composition.renderer.version).toBe(run.rendered.rendererVersion);
  });
});

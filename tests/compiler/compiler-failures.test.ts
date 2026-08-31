import { readFileSync } from 'node:fs';
import { ContextCompiler } from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  allocationSlice,
  compile,
  compilerConfig,
  compilerPolicy,
  contextBlock,
  failureOf,
  fixedTokenizer,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * One structured failure type for the whole compilation (DEC-038).
 *
 * ```text
 * code   CONTEXT_COMPILATION_FAILED   always
 * stage  where it happened
 * issues the owning stage's own focused codes, re-addressed under that stage
 * ```
 *
 * A stage's exact reason is wrapped, never replaced by a generic one, and no
 * validation-library error, nested stage error object, or tokenizer-library
 * exception escapes the boundary.
 */

const SPECS: readonly CandidateSpec[] = [{ id: 'one', tokens: 3, priority: 900 }];

/** A tokenizer that always throws, to prove failures are wrapped, not leaked. */
const exploding: Tokenizer = {
  id: 'test:exploding',
  version: '1',
  countTokens: (): number => {
    throw new Error('encoder exploded');
  },
};

describe('ContextCompilationError', () => {
  it('rejects an invalid raw request with no identifier and no trace', () => {
    const failure = failureOf(() =>
      new ContextCompiler(compilerConfig(), wordTokenizer).compile({ id: 'incomplete' }),
    );

    expect(failure.name).toBe('ContextCompilationError');
    expect(failure.code).toBe('CONTEXT_COMPILATION_FAILED');
    expect(failure.stage).toBe('request-validation');
    expect(failure.compilationId).toBeUndefined();
    expect(failure.trace).toBeUndefined();
    // The request validator's own code survives, addressed under its stage.
    expect(failure.issues.map((issue) => issue.code)).toContain('invalid_request');
    expect(failure.issues.every((issue) => issue.pointer.startsWith('request-validation'))).toBe(
      true,
    );
  });

  it('wraps a nested policy failure with the slice code the owner gave it', () => {
    const failure = failureOf(() =>
      compile({
        specs: SPECS,
        policy: compilerPolicy({
          ordering: {
            schemaVersion: 1,
            policyId: 'ordering',
            policyVersion: '5.0.0',
            strategy: 'score-desc',
          },
        }),
      }),
    );

    expect(failure.stage).toBe('request-validation');
    expect(failure.issues.map((issue) => issue.code)).toContain('invalid_ordering_policy');
    expect(failure.issues[0]?.pointer).toContain('policy.ordering.strategy');
  });

  it('wraps a candidate validation failure with the identifier and no trace', () => {
    const failure = failureOf(() =>
      compile({
        candidates: [{ schemaVersion: 1, block: contextBlock({ id: 'stale', tokenCount: 99 }) }],
      }),
    );

    expect(failure.stage).toBe('candidate-validation');
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Nothing rendered, so no coherent snapshot exists to attach.
    expect(failure.trace).toBeUndefined();
    expect(failure.issues.map((issue) => issue.code)).toContain('invalid_token_count');
    expect(failure.issues.every((issue) => issue.pointer.startsWith('candidate-validation'))).toBe(
      true,
    );
  });

  it('wraps a BudgetAllocator required-content failure at the allocation stage', () => {
    const failure = failureOf(() =>
      compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 }),
    );

    expect(failure.stage).toBe('allocation');
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(failure.trace).toBeUndefined();
    // The allocator's own block-content code, not the compiler's rendered one.
    expect(failure.issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
    expect(failure.issues[0]?.pointer).toBe('allocation.candidates.must.tokenCount');
  });

  it('wraps an unreachable category minimum at the allocation stage', () => {
    const failure = failureOf(() =>
      compile({
        specs: SPECS,
        available: 40,
        policy: compilerPolicy({
          allocation: allocationSlice([{ category: 'facts', minBlocks: 2 }]),
        }),
      }),
    );

    expect(failure.stage).toBe('allocation');
    expect(failure.issues.map((issue) => issue.code)).toEqual(['category_minimum_unreachable']);
  });

  it('wraps a throwing tokenizer at the rendering stage', () => {
    // An empty batch never reaches the tokenizer during candidate validation, so
    // the renderer is the first component to call it.
    const failure = failureOf(() =>
      compile({ specs: [], sourceDocuments: [], available: 40 }, exploding),
    );

    expect(failure.stage).toBe('rendering');
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(failure.trace).toBeUndefined();
    expect(failure.issues.map((issue) => issue.code)).toEqual(['tokenizer_failed']);
    expect(failure.issues[0]?.pointer).toBe('rendering.renderedContext');
  });

  it('INV-ADAPTER-003: describes a thrown value without attaching the object', () => {
    let thrown: unknown;
    try {
      compile({ specs: [], sourceDocuments: [], available: 40 }, exploding);
    } catch (error) {
      thrown = error;
    }
    const failure = thrown as { issues: readonly { message: string }[]; cause?: unknown };

    expect(failure.issues[0]?.message).toContain('Error: encoder exploded');
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure.issues)).not.toContain('stack');
  });

  it('wraps a trace-build contradiction at the trace stage', () => {
    // Two optional blocks whose declared counts sum past the exact safe integer
    // range: the allocator excludes both, and the trace refuses to publish a
    // total it cannot state exactly (INV-BUDGET-005).
    const huge = 2 ** 52;
    const tokenizer = fixedTokenizer(huge, 'test:huge');
    const failure = failureOf(() =>
      compile(
        {
          candidates: [
            { schemaVersion: 1, block: contextBlock({ id: 'big-1', tokenCount: huge }) },
            {
              schemaVersion: 1,
              block: contextBlock({ id: 'big-2', content: 'other content', tokenCount: huge }),
            },
          ],
          available: 100,
        },
        tokenizer,
      ),
    );

    expect(failure.stage).toBe('trace');
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(failure.trace).toBeUndefined();
    expect(failure.issues.map((issue) => issue.code)).toEqual(['invalid_trace_result']);
    expect(failure.issues[0]?.pointer).toBe('trace.totals');
  });

  it('raises a correction failure at the correction stage, with the snapshot', () => {
    const failure = failureOf(() =>
      compile(
        { specs: [{ id: 'must', tokens: 2, required: true }], available: 3 },
        { id: 'test:heavy', version: '1', countTokens: (text) => (text === 'must w0' ? 2 : 40) },
      ),
    );

    expect(failure.stage).toBe('correction');
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((failure.trace as { settled: boolean }).settled).toBe(false);
    expect(failure.issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
  });

  it('declares a result stage for the reconciliation guard', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    expect(source).toContain("| 'result'");
    expect(source).toContain("throw new ContextCompilationError('result', issues, {");
    // The guard is a defence against a future edit, so it must cover every
    // property a success claims (INV-BUDGET-001, INV-BUDGET-006, INV-TRACE-003).
    const guard = source.slice(source.indexOf('function verifyResult('));
    for (const property of [
      "['usage', 'compiledTokens']",
      "['usage', 'unusedTokens']",
      "['usage', 'renderingTokenDelta']",
      "['usage', 'includedContentTokens']",
      "['usage', 'candidateTokens']",
      "['includedBlocks']",
      "['compiledContext']",
      "['trace', 'settled']",
      "['trace', 'compilationId']",
      "['trace', 'composition', 'tokenizerCoverage']",
      "['trace', 'settlement', 'ordering', 'orderedBlockIds']",
      "['trace', 'settlement', 'rendering', 'compiledTokens']",
      "['trace', 'settlement', 'rendering', 'renderedContextHash']",
      "['trace', 'settlement', 'usage']",
      "['trace', 'settlement', 'decisions']",
    ]) {
      expect(guard, `omits ${property}`).toContain(property);
    }
  });

  it('INV-DET-001: issues are deterministic and serializable', () => {
    const run = (): unknown =>
      compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 });
    const first = failureOf(run).issues;
    const second = failureOf(run).issues;

    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    for (const issue of first) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });

  it('returns no partial result on any failure', () => {
    const failing: readonly (() => unknown)[] = [
      () => new ContextCompiler(compilerConfig(), wordTokenizer).compile({}),
      () =>
        compile({ candidates: [{ schemaVersion: 1, block: contextBlock({ tokenCount: 99 }) }] }),
      () => compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 }),
      () => compile({ specs: [], sourceDocuments: [], available: 40 }, exploding),
    ];
    for (const run of failing) {
      let returned: unknown = 'sentinel';
      try {
        returned = run();
      } catch {
        returned = undefined;
      }
      expect(returned).toBeUndefined();
    }
  });

  it('INV-SEC-001: quotes no unbounded source string in an issue message', () => {
    const long = Array.from({ length: 400 }, (_, index) => `w${String(index)}`).join(' ');
    const failure = failureOf(() =>
      compile({
        candidates: [
          { schemaVersion: 1, block: contextBlock({ id: long, content: long, tokenCount: 1 }) },
        ],
      }),
    );
    for (const issue of failure.issues) {
      expect(issue.message.length).toBeLessThan(500);
    }
  });

  it('never exposes a stage error class through the compilation error', () => {
    const failure = failureOf(() =>
      compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 }),
    );
    expect([...failure.keys].sort()).toEqual(['code', 'compilationId', 'issues', 'name', 'stage']);
    // The optional members are genuinely absent, not present holding `undefined`.
    const invalid = failureOf(() =>
      new ContextCompiler(compilerConfig(), wordTokenizer).compile({}),
    );
    expect([...invalid.keys].sort()).toEqual(['code', 'issues', 'name', 'stage']);
    expect(failure.name).toBe('ContextCompilationError');
    // No nested stage error, no library error, and no `cause` chain.
    expect(failure.keys).not.toContain('cause');
    expect(failure.keys).not.toContain('error');
  });
});

describe('ContextCompilationError: the stage vocabulary', () => {
  it('names every point at which the pipeline can stop', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    for (const stage of [
      'configuration',
      'request-validation',
      'candidate-validation',
      'deduplication',
      'scoring',
      'filtering',
      'allocation',
      'ordering',
      'rendering',
      'trace',
      'correction',
      'result',
    ]) {
      expect(source, `omits stage ${stage}`).toContain(`| '${stage}'`);
    }
  });

  it('prefixes every wrapped issue path with its stage, deterministically', () => {
    const cases: readonly [string, () => unknown][] = [
      [
        'request-validation',
        () => new ContextCompiler(compilerConfig(), wordTokenizer).compile({}),
      ],
      [
        'candidate-validation',
        () =>
          compile({ candidates: [{ schemaVersion: 1, block: contextBlock({ tokenCount: 9 }) }] }),
      ],
      [
        'allocation',
        () => compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 }),
      ],
      ['rendering', () => compile({ specs: [], sourceDocuments: [], available: 40 }, exploding)],
    ];
    for (const [stage, run] of cases) {
      const failure = failureOf(run);
      expect(failure.stage, stage).toBe(stage);
      for (const issue of failure.issues) {
        expect(issue.pointer.startsWith(stage), `${stage}: ${issue.pointer}`).toBe(true);
      }
    }
  });

  it('carries a readable summary naming the stage', () => {
    let message = '';
    try {
      compile({ specs: [{ id: 'must', tokens: 20, required: true }], available: 5 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Context compilation failed at allocation');
  });
});

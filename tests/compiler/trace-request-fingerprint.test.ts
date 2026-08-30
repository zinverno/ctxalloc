import { readFileSync } from 'node:fs';
import * as compiler from '@ctxalloc/compiler';
import {
  COMPILATION_REQUEST_FINGERPRINT_VERSION,
  CompilationRequestValidator,
  fingerprintCompilationRequest,
  type CompilationRequest,
  type CompilationRequestFingerprint,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  TRACE_CONFIG,
  buildTrace,
  candidateOf,
  requestInput,
  runPipeline,
  sourceDocument,
  tracePolicy,
} from './trace-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The deterministic request fingerprint (DEC-037).
 *
 * It identifies the **exact validated caller request value**, so array order
 * participates and property insertion order does not. It is deliberately not the
 * future deterministic compilation identifier: the composition inputs it
 * excludes are recorded beside it in the trace.
 */

const SPECS = [
  { id: 'alpha', tokens: 3, priority: 800 },
  { id: 'beta', tokens: 4, priority: 200 },
] as const;

function validate(input: Record<string, unknown>): CompilationRequest {
  return new CompilationRequestValidator().validate(input);
}

function fingerprintOf(overrides: Record<string, unknown> = {}): CompilationRequestFingerprint {
  return fingerprintCompilationRequest(
    validate({ ...requestInput({ specs: SPECS }), ...overrides }),
  );
}

describe('INV-DET-001: the request fingerprint is exact and reproducible', () => {
  it('produces a byte-identical fingerprint for the same validated request', () => {
    expect(fingerprintOf()).toBe(fingerprintOf());
    // Two independently validated records of the same data agree too.
    expect(fingerprintCompilationRequest(validate(requestInput({ specs: SPECS })))).toBe(
      fingerprintCompilationRequest(validate(requestInput({ specs: SPECS }))),
    );
  });

  it('INV-DET-002: object property insertion order does not change the fingerprint', () => {
    const ordinary = requestInput({ specs: SPECS });
    // The same fields, written in a different order, and with each nested scope
    // object rebuilt with its keys reversed.
    const shuffled: Record<string, unknown> = {
      policy: ordinary['policy'],
      budget: ordinary['budget'],
      sourceDocuments: ordinary['sourceDocuments'],
      candidates: ordinary['candidates'],
      referenceTime: ordinary['referenceTime'],
      query: ordinary['query'],
      scope: { workspaceId: 'default', tenantId: 'local' },
      schemaVersion: ordinary['schemaVersion'],
      id: ordinary['id'],
    };

    expect(fingerprintCompilationRequest(validate(shuffled))).toBe(
      fingerprintCompilationRequest(validate(ordinary)),
    );
  });

  it('publishes an exact lowercase sha256 representation', () => {
    const fingerprint = fingerprintOf();
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fingerprint).toBe(fingerprint.toLowerCase());
    expect(COMPILATION_REQUEST_FINGERPRINT_VERSION).toBe(1);
  });
});

describe('the request fingerprint identifies the exact request value', () => {
  it('changes when the request identifier changes', () => {
    expect(fingerprintOf({ id: 'req-other' })).not.toBe(fingerprintOf());
  });

  it('changes when the query changes, including by whitespace alone', () => {
    const base = fingerprintOf();
    expect(fingerprintOf({ query: 'which blocks explain allocation? ' })).not.toBe(base);
    expect(fingerprintOf({ query: ' which blocks explain allocation?' })).not.toBe(base);
    expect(fingerprintOf({ query: '' })).not.toBe(base);
  });

  it('INV-BLOCK-007: preserves exact Unicode and applies no NFC or NFD normalization', () => {
    // U+00E9 versus "e" + U+0301: the same rendered text, two different strings.
    const composed = fingerprintOf({ query: 'café' });
    const decomposed = fingerprintOf({ query: 'café' });

    expect(composed).not.toBe(decomposed);
    expect('café'.normalize('NFD')).toBe('café');
  });

  it('changes when the candidate array is permuted', () => {
    const forward = requestInput({ specs: SPECS });
    const reversed = requestInput({
      candidates: [...SPECS].reverse().map((spec) => candidateOf(spec)),
    });

    expect(fingerprintCompilationRequest(validate(reversed))).not.toBe(
      fingerprintCompilationRequest(validate(forward)),
    );
  });

  it('INV-ALLOC-005: permuted candidates keep compiling to the same rendered string', () => {
    // The fingerprint and the compiled result answer different questions. The
    // compiler is order-independent; the identity of the caller's payload is not.
    const forward = runPipeline({ specs: SPECS });
    const reversed = runPipeline({
      candidates: [...SPECS].reverse().map((spec) => candidateOf(spec)),
    });

    expect(reversed.rendered.renderedContext).toBe(forward.rendered.renderedContext);
    expect(fingerprintCompilationRequest(reversed.request)).not.toBe(
      fingerprintCompilationRequest(forward.request),
    );
  });

  it('changes when the source document array is permuted', () => {
    const documents = [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })];
    const forward = requestInput({ specs: [], sourceDocuments: documents });
    const reversed = requestInput({ specs: [], sourceDocuments: [...documents].reverse() });

    expect(fingerprintCompilationRequest(validate(reversed))).not.toBe(
      fingerprintCompilationRequest(validate(forward)),
    );
  });

  it('changes when an accepted policy array is permuted', () => {
    const rules = [
      { category: 'facts', value: 0.9 },
      { category: 'notes', value: 0.2 },
    ];
    const policyWith = (byCategory: readonly Record<string, unknown>[]): Record<string, unknown> =>
      tracePolicy({
        scoring: {
          schemaVersion: 1,
          policyId: 'scoring',
          policyVersion: '2.0.0',
          categoryPriority: { weight: 1, defaultValue: 0, byCategory: [...byCategory] },
        },
      });

    const forward = fingerprintCompilationRequest(
      validate(requestInput({ specs: SPECS, policy: policyWith(rules) })),
    );
    const reversed = fingerprintCompilationRequest(
      validate(requestInput({ specs: SPECS, policy: policyWith([...rules].reverse()) })),
    );

    expect(reversed).not.toBe(forward);
  });
});

describe('DEC-037: the request fingerprint is not a compilation identifier', () => {
  it('does not change when the compiler identity changes', () => {
    const run = runPipeline({ specs: SPECS });
    const first = buildTrace(run, { ...TRACE_CONFIG });
    const second = buildTrace(run, { compilerId: 'other-compiler', compilerVersion: '9.9.9' });

    expect(second.request.fingerprint).toBe(first.request.fingerprint);
    expect(second.composition.compiler).not.toEqual(first.composition.compiler);
  });

  it('does not change when the configured tokenizer changes', () => {
    const quoteAware = {
      id: 'test:word-plus-quotes',
      version: '1',
      countTokens: (text: string): number =>
        text.split(/\s+/).filter((word) => word.length > 0).length +
        (text.match(/"/g) ?? []).length,
    };
    const plain = runPipeline({ specs: SPECS });
    const other = runPipeline({ specs: SPECS, tokenizer: quoteAware });

    expect(fingerprintCompilationRequest(other.request)).toBe(
      fingerprintCompilationRequest(plain.request),
    );
    // The measurement legitimately differs; the request value does not.
    expect(other.rendered.renderedTokens).not.toBe(plain.rendered.renderedTokens);
  });

  it('publishes no compilation identifier or composition fingerprint helper', () => {
    for (const name of [
      'compilationId',
      'CompilationId',
      'compilationFingerprint',
      'fingerprintCompilation',
      'requestFingerprint',
      'CompilationFingerprint',
    ]) {
      expect(Object.keys(compiler), `exports ${name}`).not.toContain(name);
    }
    expect(Object.keys(compiler)).toContain('fingerprintCompilationRequest');
  });

  it('records the composition inputs the fingerprint deliberately excludes', () => {
    const built = buildTrace(runPipeline({ specs: SPECS }));
    expect(built.composition.compiler).toEqual({ id: 'ctxalloc-compiler', version: '0.14.0' });
    expect(built.composition.tokenizer.id).toBe('test:word');
    expect(built.composition.renderer.id).toBe('ctxalloc-jsonl');
    expect(Object.keys(built.request)).not.toContain('compilationId');
  });
});

describe('INV-DET-003, INV-DET-004: the fingerprint reads nothing ambient', () => {
  const SOURCES = [
    'packages/compiler/src/request-fingerprint.ts',
    'packages/compiler/src/digest.ts',
  ] as const;

  /** Only declared code is scanned; documentation legitimately names what it forbids. */
  function code(relativePath: string): string {
    return readFileSync(new URL(relativePath, rootUrl), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it.each(SOURCES)('%s reads no clock, random value, environment, or manifest', (relativePath) => {
    const source = code(relativePath);
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'randomUUID',
      'process.env',
      'readFileSync',
      'package.json',
      'execSync',
      'localeCompare',
    ]) {
      expect(source, `${relativePath} uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is a pure function of the request value across repeated calls', () => {
    const request = validate(requestInput({ specs: SPECS }));
    const values = Array.from({ length: 5 }, () => fingerprintCompilationRequest(request));
    expect(new Set(values).size).toBe(1);
  });
});

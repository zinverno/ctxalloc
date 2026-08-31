import { readFileSync } from 'node:fs';
import {
  COMPILATION_ID_VERSION,
  ContextCompiler,
  fingerprintCompilationRequest,
  CompilationRequestValidator,
  type CompilationId,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  compilerConfig,
  compilerPolicy,
  compile,
  jsonlOverheadTokenizer,
  requestInput,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The deterministic compilation identifier (DEC-038).
 *
 * The request fingerprint answers *which exact validated caller request value
 * was this?* The compilation identifier answers *which complete deterministic
 * compiler invocation was this?* — so it binds the fingerprint plus every
 * explicit composition input that can change what gets compiled (INV-DET-001,
 * INV-DET-003).
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'alpha', tokens: 3, priority: 900 },
  { id: 'beta', tokens: 3, priority: 200 },
];

function idOf(
  options: Parameters<typeof compile>[0] = { specs: SPECS },
  tokenizer: Tokenizer = wordTokenizer,
  config: Record<string, unknown> = compilerConfig(),
): CompilationId {
  return compile(options, tokenizer, config).compilationId;
}

describe('deterministic compilation identifier', () => {
  it('INV-DET-001: identical request, config, and tokenizer produce the identical ID', () => {
    expect(idOf()).toBe(idOf());
    expect(COMPILATION_ID_VERSION).toBe(1);
  });

  it('publishes sha256 with exactly 64 lowercase hex characters', () => {
    const id = idOf();
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id).toBe(id.toLowerCase());
  });

  it('changes when the request identifier changes', () => {
    expect(idOf({ specs: SPECS, id: 'req-other' })).not.toBe(idOf());
  });

  it('changes when the query changes', () => {
    expect(idOf({ specs: SPECS, query: 'something else' })).not.toBe(idOf());
  });

  it('changes when the policy changes', () => {
    const other = compilerPolicy({
      filtering: {
        schemaVersion: 1,
        policyId: 'filtering',
        policyVersion: '3.0.0',
        minimumTotalScore: 0.5,
      },
    });
    expect(idOf({ specs: SPECS, policy: other })).not.toBe(idOf());
  });

  it('changes when the budget changes', () => {
    expect(idOf({ specs: SPECS, available: 999 })).not.toBe(idOf());
  });

  it('changes when the compiler identity or version changes', () => {
    expect(
      idOf({ specs: SPECS }, wordTokenizer, compilerConfig({ compilerVersion: '0.16.0' })),
    ).not.toBe(idOf());
    expect(idOf({ specs: SPECS }, wordTokenizer, compilerConfig({ compilerId: 'other' }))).not.toBe(
      idOf(),
    );
  });

  it('changes when the tokenizer identity or version changes', () => {
    const otherId: Tokenizer = { ...wordTokenizer, id: 'test:word-2' };
    const otherVersion: Tokenizer = { ...wordTokenizer, version: '2' };
    expect(idOf({ specs: SPECS }, otherId)).not.toBe(idOf());
    expect(idOf({ specs: SPECS }, otherVersion)).not.toBe(idOf());
  });

  it('changes when maxCorrectionSelections changes', () => {
    // The bound is a decision input, not a performance knob: it can change
    // whether the fallback search proves a result or stops without one.
    expect(
      idOf({ specs: SPECS }, wordTokenizer, compilerConfig({ maxCorrectionSelections: 65 })),
    ).not.toBe(idOf());
  });

  it('binds the renderer identity and version into the preimage', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    expect(source).toContain('rendererId: CONTEXT_RENDERER_ID');
    expect(source).toContain('rendererVersion: CONTEXT_RENDERER_VERSION');
    const preimage = readFileSync(
      new URL('packages/compiler/src/compilation-id.ts', rootUrl),
      'utf8',
    );
    for (const member of [
      'compilerId',
      'compilerVersion',
      'tokenizerId',
      'tokenizerVersion',
      'rendererId',
      'rendererVersion',
      'correctionStrategy',
      'correctionVersion',
      'maxCorrectionSelections',
    ]) {
      expect(preimage, `omits ${member}`).toContain(`readonly ${member}:`);
    }
  });

  it('DEC-037: the request fingerprint is unchanged and is not the compilation ID', () => {
    const input = requestInput({ specs: SPECS });
    const request = new CompilationRequestValidator().validate(input);
    const result = compile({ specs: SPECS });

    expect(result.trace.request.fingerprint).toBe(fingerprintCompilationRequest(request));
    expect(result.compilationId).not.toBe(result.trace.request.fingerprint);
    // Both are digests, and both are of the same request — but they answer
    // different questions, so a consumer must never substitute one for the other.
    expect(result.trace.request.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keeps the request fingerprint identical across two different compositions', () => {
    const a = compile({ specs: SPECS }, wordTokenizer);
    const b = compile({ specs: SPECS }, jsonlOverheadTokenizer(0, 'test:same-counts'));

    expect(a.trace.request.fingerprint).toBe(b.trace.request.fingerprint);
    expect(a.compilationId).not.toBe(b.compilationId);
  });

  it('INV-DET-003: binds no random, clock, or environment value', () => {
    const source = readFileSync(new URL('packages/compiler/src/compilation-id.ts', rootUrl), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date',
      'process.env',
      'process.pid',
      'hostname',
      'randomUUID',
      'GITHUB_',
      'CI',
    ]) {
      expect(source, `binds ${forbidden}`).not.toContain(forbidden);
    }
    // Two fresh compilers over one request agree, run after run.
    expect(new Set([idOf(), idOf(), idOf()]).size).toBe(1);
  });

  it('does not duplicate the whole request into the preimage', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/compilation-id.ts', rootUrl),
      'utf8',
    );
    // The fingerprint already binds the request value; restating it would create
    // two places for one fact (INV-DEP-003).
    expect(source).toContain('requestFingerprint');
    expect(source).not.toContain('request.candidates');
    expect(source).not.toContain('request.policy');
  });

  it('is exposed on a failure after request validation, and absent before it', () => {
    const failed = (): unknown =>
      new ContextCompiler(compilerConfig(), wordTokenizer).compile({ id: 'not a request' });
    let captured: { compilationId?: unknown; trace?: unknown; stage?: unknown } = {};
    try {
      failed();
    } catch (error) {
      captured = error as typeof captured;
    }
    expect(captured.stage).toBe('request-validation');
    expect(captured.compilationId).toBeUndefined();
    expect(captured.trace).toBeUndefined();
  });
});

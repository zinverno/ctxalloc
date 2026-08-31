import { readFileSync } from 'node:fs';
import {
  CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION,
  ContextCompilationError,
  ContextCompiler,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  compilerConfig,
  failureOf,
  issueCodesOf,
  requestInput,
  wordTokenizer,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * `ContextCompilerConfig` and the injected tokenizer (DEC-038).
 *
 * The configuration is external input: it may have been read from a file, sent
 * over HTTP, or assembled by hand, so compile-time types prove nothing about it
 * (INV-BLOCK-005). Nothing is defaulted, coerced, or discovered — least of all
 * the search bound, which decides whether a failure is a proof or a stopping
 * point.
 */

function construct(config: unknown, tokenizer: Tokenizer = wordTokenizer): () => ContextCompiler {
  return () => new ContextCompiler(config, tokenizer);
}

describe('ContextCompiler configuration', () => {
  it('accepts one complete explicit configuration', () => {
    expect(construct(compilerConfig())).not.toThrow();
    expect(CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it('INV-STORE-004: rejects any schema version but the current one', () => {
    for (const schemaVersion of [0, 2, '1', null, undefined]) {
      expect(issueCodesOf(construct(compilerConfig({ schemaVersion })))).toContain(
        'invalid_config',
      );
    }
  });

  it('rejects a blank or malformed compiler identity', () => {
    for (const field of ['compilerId', 'compilerVersion']) {
      for (const value of ['', '   ', '\t\n', '\ud800', 7, null]) {
        expect(
          issueCodesOf(construct(compilerConfig({ [field]: value }))),
          `${field} = ${JSON.stringify(value)}`,
        ).toContain('invalid_config');
      }
    }
  });

  it('preserves a configured identity exactly, without trimming it', () => {
    // A trace records the identity verbatim, so rewriting it here would publish
    // a value the caller never configured (INV-TRACE-005).
    const compiler = new ContextCompiler(
      compilerConfig({ compilerId: ' Ctx Alloc ', compilerVersion: '0.15.0-RC.1 ' }),
      wordTokenizer,
    );
    const result = compiler.compile(requestInput({ specs: [{ id: 'one', tokens: 2 }] }));
    expect(result.trace.composition.compiler).toEqual({
      id: ' Ctx Alloc ',
      version: '0.15.0-RC.1 ',
    });
  });

  it('rejects maxHardMinimumCombinations of 0', () => {
    expect(issueCodesOf(construct(compilerConfig({ maxHardMinimumCombinations: 0 })))).toContain(
      'invalid_config',
    );
  });

  it('INV-BUDGET-005: rejects a negative, fractional, or unsafe search bound', () => {
    for (const value of [
      -1,
      0.5,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      '4',
      null,
    ]) {
      expect(
        issueCodesOf(construct(compilerConfig({ maxHardMinimumCombinations: value }))),
        `bound = ${String(value)}`,
      ).toContain('invalid_config');
    }
    expect(construct(compilerConfig({ maxHardMinimumCombinations: 1 }))).not.toThrow();
    expect(
      construct(compilerConfig({ maxHardMinimumCombinations: Number.MAX_SAFE_INTEGER })),
    ).not.toThrow();
  });

  it('INV-BLOCK-005: rejects an unknown field rather than stripping it', () => {
    expect(
      issueCodesOf(construct(compilerConfig({ correctionStrategy: 'render-aware-v1' }))),
    ).toContain('invalid_config');
    expect(issueCodesOf(construct(compilerConfig({ tokenizerId: 'test:word' })))).toContain(
      'invalid_config',
    );
  });

  it('INV-DET-003: injects no default for any field', () => {
    const complete = compilerConfig();
    for (const field of Object.keys(complete)) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[field];
      expect(issueCodesOf(construct(partial)), `missing ${field}`).toContain('invalid_config');
    }
  });

  it('rejects an invalid tokenizer with the project-owned error', () => {
    const cases: readonly [string, unknown][] = [
      ['not an object', 'tokenizer'],
      ['null', null],
      ['blank id', { id: '  ', version: '1', countTokens: () => 0 }],
      ['blank version', { id: 'x', version: '', countTokens: () => 0 }],
      ['no countTokens', { id: 'x', version: '1' }],
    ];
    for (const [label, tokenizer] of cases) {
      const failure = failureOf(construct(compilerConfig(), tokenizer as Tokenizer));
      expect(failure.name, label).toBe('ContextCompilationError');
      expect(failure.code, label).toBe('CONTEXT_COMPILATION_FAILED');
      expect(failure.stage, label).toBe('configuration');
      expect(
        failure.issues.map((issue) => issue.code),
        label,
      ).toContain('invalid_tokenizer');
    }
  });

  it('reports every configuration and tokenizer problem in one call', () => {
    const codes = issueCodesOf(
      construct(compilerConfig({ compilerId: '' }), {
        id: '',
        version: '',
        countTokens: 1,
      } as unknown as Tokenizer),
    );
    expect(codes).toContain('invalid_config');
    expect(codes).toContain('invalid_tokenizer');
  });

  it('INV-TRACE-005: records the exact configured tokenizer identity', () => {
    const tokenizer: Tokenizer = { id: ' Odd-Id ', version: ' 9 ', countTokens: () => 0 };
    const result = new ContextCompiler(compilerConfig(), tokenizer).compile(
      requestInput({ specs: [] }),
    );
    expect(result.trace.composition.tokenizer).toEqual({ id: ' Odd-Id ', version: ' 9 ' });
  });

  it('INV-DET-003, INV-DET-004: reads no package, environment, git, or clock value', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'process.env',
      'process.pid',
      'Date.now',
      'new Date',
      'Math.random',
      'randomUUID',
      'package.json',
      'hostname',
      'node:fs',
      'node:os',
      'node:child_process',
      'fetch(',
      'localeCompare',
      'Intl.',
      'O200kBaseTokenizer',
      '@ctxalloc/tokenization',
      '@ctxalloc/application',
      'js-tiktoken',
    ]) {
      expect(source, `references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('ContextCompilationError is a project-owned Error with a stable code', () => {
    expect(ContextCompilationError.prototype).toBeInstanceOf(Error);
    const failure = failureOf(construct({}));
    expect(failure.code).toBe('CONTEXT_COMPILATION_FAILED');
    expect(failure.stage).toBe('configuration');
    // A configuration failure precedes every request, so neither a compilation
    // identifier nor a trace exists to attach.
    expect(failure.compilationId).toBeUndefined();
    expect(failure.trace).toBeUndefined();
  });
});

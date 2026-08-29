import { readFileSync } from 'node:fs';
import * as compiler from '@ctxalloc/compiler';
import {
  CandidateValidationError,
  CandidateValidator,
  type CandidateValidationInput,
  type ValidatedCandidateSet,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import type { CandidateBlock, Scope, SourceDocument } from '../../packages/domain/src/index.js';
import { candidate, countWords, input, sourceDocument, wordTokenizer } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/compiler/package.json', rootUrl), 'utf8'),
) as Manifest;

const SOURCE_FILES = [
  'packages/compiler/src/index.ts',
  'packages/compiler/src/candidate-validator.ts',
] as const;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function importSpecifiers(relativePath: string): string[] {
  return [...readSource(relativePath).matchAll(/from '(?<specifier>[^']+)'/g)].map(
    (match) => match.groups?.specifier ?? '',
  );
}

describe('@ctxalloc/compiler public API', () => {
  it('exports the validator and its error type only', () => {
    expect(Object.keys(compiler).sort()).toEqual([
      'CandidateValidationError',
      'CandidateValidator',
    ]);
  });

  it('exports the documented public types from its entry point', () => {
    const exported = [...readSource('packages/compiler/src/index.ts').matchAll(/type (\w+),/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'CandidateValidationInput',
      'CandidateValidationIssueCode',
      'ValidatedCandidateSet',
    ]);
  });

  it('accepts the documented public input shape and returns the documented result', () => {
    const tokenizer: Tokenizer = wordTokenizer;
    const validator = new CandidateValidator(tokenizer);

    const scope: Scope = { tenantId: 'local', workspaceId: 'default' };
    const validated: ValidatedCandidateSet = validator.validate(input());

    const documents: readonly SourceDocument[] = validated.sourceDocuments;
    const candidates: readonly CandidateBlock[] = validated.candidates;
    // The validated result is itself a valid input for a later call, which is
    // what makes the two structures composable.
    const roundTrip: CandidateValidationInput = {
      scope: validated.scope,
      sourceDocuments: documents,
      candidates,
    };

    expect(validator.validate(roundTrip)).toEqual(validated);
    expect(validated.scope).toEqual(scope);
    expect(CandidateValidationError.prototype).toBeInstanceOf(Error);
  });

  it('accepts unknown at the runtime boundary', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const untyped: unknown = input();
    expect(() => validator.validate(untyped)).not.toThrow();
  });

  it('publishes a stable top-level error code', () => {
    const validator = new CandidateValidator(wordTokenizer);
    try {
      validator.validate({});
    } catch (error) {
      expect((error as CandidateValidationError).code).toBe('CANDIDATE_VALIDATION_FAILED');
      return;
    }
    throw new Error('expected the empty object to be rejected');
  });

  it('exports no later compiler stage and no retrieval port', () => {
    for (const name of [
      'Deduplicator',
      'CandidateScorer',
      'BudgetAllocator',
      'ContextOrderer',
      'ContextRenderer',
      'TraceBuilder',
      'ContextCompiler',
      'CandidateProvider',
      'FakeCandidateProvider',
      'CompilationRequestSchema',
      'CompilationPolicy',
      'CompilationResult',
      'CompilationTrace',
      'compile',
      'deduplicate',
      'score',
      'allocate',
      'render',
    ]) {
      expect(Object.keys(compiler), `exports ${name}`).not.toContain(name);
    }
  });

  it('exposes no ingestion, chunking, or tokenizer implementation', () => {
    for (const name of [
      'ingestSource',
      'MarkdownChunker',
      'FakeTokenizer',
      'O200kBaseTokenizer',
      'SourceReader',
    ]) {
      expect(Object.keys(compiler), `exports ${name}`).not.toContain(name);
    }
  });

  it('declares only the dependencies it imports', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      zod: '^4.4.3',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-002: declares no retrieval, model, storage, or application dependency', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      '@ctxalloc/application',
      '@ctxalloc/tokenization',
      '@ctxalloc/testing',
      '@ctxalloc/evaluation',
      'js-tiktoken',
      'better-sqlite3',
      'obsidian',
    ]) {
      expect(declared).not.toContain(forbidden);
    }
    expect(declared).toContain('@ctxalloc/domain');
    expect(declared).toContain('@ctxalloc/ports');
  });

  it('imports only its declared dependencies', () => {
    const allowed = new Set(['@ctxalloc/domain', '@ctxalloc/ports', 'zod']);
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(
          specifier.startsWith('./') || allowed.has(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('INV-DEP-001: imports no Node standard library module', () => {
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(specifier.startsWith('node:'), `${file} imports ${specifier}`).toBe(false);
      }
    }
  });

  it('INV-ADAPTER-001: leaks no validation-library type through its public surface', () => {
    const entry = readSource('packages/compiler/src/index.ts');
    expect(entry).not.toContain('zod');
    expect(entry).not.toContain('node:');

    const declaredExports = readSource('packages/compiler/src/candidate-validator.ts')
      .split('\n')
      .filter((line) => line.startsWith('export '))
      .join('\n');
    for (const leaked of ['z.', 'Zod', 'Buffer', 'Hash', 'createHash', 'Map<', 'Set<']) {
      expect(declaredExports, `candidate-validator exposes ${leaked}`).not.toContain(leaked);
    }
  });

  it('INV-ADAPTER-001: exposes no mutable collection in the public contract', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const result = validator.validate(input({ candidates: [candidate()] }));
    expect(result.candidates).toBeInstanceOf(Array);
    expect(result.sourceDocuments).toBeInstanceOf(Array);
    expect(result.candidates).not.toBeInstanceOf(Map);
    expect(result.sourceDocuments).not.toBeInstanceOf(Set);
  });

  it('reuses the project-owned ValidationIssue shape', () => {
    const validator = new CandidateValidator(wordTokenizer);
    try {
      validator.validate(input({ sourceDocuments: [sourceDocument(), sourceDocument()] }));
    } catch (error) {
      for (const issue of (error as CandidateValidationError).issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
        expect(typeof issue.code).toBe('string');
        expect(Array.isArray(issue.path)).toBe(true);
        expect(typeof issue.pointer).toBe('string');
        expect(typeof issue.message).toBe('string');
      }
      return;
    }
    throw new Error('expected the duplicate source ID to be rejected');
  });

  it('renders indexed pointers the same way the domain does', () => {
    const validator = new CandidateValidator(wordTokenizer);
    const schemaPointer = pointerOfFirstIssue(
      validator,
      input({ candidates: [candidate({ tokenCount: 'x' })] }),
    );
    const crossRecordPointer = pointerOfFirstIssue(
      validator,
      input({ candidates: [candidate({ tokenCount: 99 })] }),
    );
    // The first comes from the domain schema, the second from a cross-record
    // rule. Both must address the same field the same way.
    expect(schemaPointer).toBe('candidates[0].block.tokenCount');
    expect(crossRecordPointer).toBe('candidates[0].block.tokenCount');
  });

  it('countWords stays a genuine tokenizer for these tests', () => {
    expect(countWords('a b  c')).toBe(3);
  });
});

function pointerOfFirstIssue(validator: CandidateValidator, batch: unknown): string {
  try {
    validator.validate(batch);
  } catch (error) {
    return (error as CandidateValidationError).issues[0]?.pointer ?? '';
  }
  throw new Error('expected the batch to be rejected');
}

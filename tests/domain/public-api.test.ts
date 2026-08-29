import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as domain from '../../packages/domain/src/index.js';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/domain/package.json', rootUrl), 'utf8'),
) as Manifest;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function sourceFiles(): string[] {
  return [...readSource('packages/domain/src/index.ts').matchAll(/from '\.\/(?<file>[\w-]+)\.js'/g)]
    .map((match) => `packages/domain/src/${match.groups?.file ?? ''}.ts`)
    .sort();
}

describe('@ctxalloc/domain public API', () => {
  it('exports exactly the documented runtime surface', () => {
    expect(Object.keys(domain).sort()).toEqual([
      'CANDIDATE_BLOCK_SCHEMA_VERSION',
      'CONTEXT_BLOCK_SCHEMA_VERSION',
      'CandidateBlockSchema',
      'CandidateRetrievalSchema',
      'CandidateRetrievalScoreSchema',
      'ContentHashSchema',
      'ContextBlockIdSchema',
      'ContextBlockSchema',
      'DomainValidationError',
      'JsonObjectSchema',
      'JsonValueSchema',
      'SOURCE_DOCUMENT_SCHEMA_VERSION',
      'SOURCE_TYPES',
      'ScopeSchema',
      'SourceDocumentIdSchema',
      'SourceDocumentSchema',
      'SourceLocationSchema',
      'SourceTypeSchema',
      'TimestampSchema',
      'TokenBudgetSchema',
      'availableInputTokens',
      'calculateNormalizedContentHash',
      'configuredReservedTokens',
      'findLoneSurrogate',
      'normalizeContextBlockContentForHash',
      'parseOrThrow',
      'safeParse',
      'scopesEqual',
    ]);
  });

  it('exports the documented public types', () => {
    const exported = [
      ...readSource('packages/domain/src/index.ts').matchAll(/\btype (\w+)\s*[,}]/g),
    ]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'CandidateBlock',
      'CandidateRetrieval',
      'CandidateRetrievalScore',
      'ContentHash',
      'ContextBlock',
      'ContextBlockAttributes',
      'ContextBlockId',
      'ConversationMessageLocation',
      'JsonObject',
      'JsonValue',
      'Scope',
      'SourceDocument',
      'SourceDocumentId',
      'SourceLocation',
      'SourceType',
      'TextRangeLocation',
      'Timestamp',
      'TokenBudget',
      'ValidationIssue',
      'ValidationResult',
    ]);
  });

  it('INV-DEP-001: declares only the validation library', () => {
    expect(manifest.dependencies).toEqual({ zod: '^4.4.3' });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-001: imports no workspace package and no infrastructure library', () => {
    for (const file of sourceFiles()) {
      const specifiers = [...readSource(file).matchAll(/from '(?<specifier>[^']+)'/g)].map(
        (match) => match.groups?.specifier ?? '',
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./') || specifier === 'zod' || specifier === 'node:crypto',
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('INV-DEP-001: uses node:crypto in the hash module only', () => {
    const users = sourceFiles().filter((file) => readSource(file).includes('node:crypto'));
    expect(users).toEqual(['packages/domain/src/block-content-hash.ts']);
  });

  it('INV-ADAPTER-001: leaks no validation-library or Node type through the entry point', () => {
    const entry = readSource('packages/domain/src/index.ts');
    expect(entry).not.toContain('zod');
    expect(entry).not.toContain('node:');
    expect(entry).not.toContain('createHash');
  });

  it('exposes no compiler, application, retrieval, or infrastructure behavior', () => {
    for (const name of [
      'CandidateValidator',
      'Deduplicator',
      'BudgetAllocator',
      'ContextRenderer',
      'TraceBuilder',
      'ContextCompiler',
      'CandidateProvider',
      'Tokenizer',
      'FakeTokenizer',
      'countTokens',
      'ingestSource',
      'MarkdownChunker',
      'SourceReader',
      'compile',
      'allocate',
    ]) {
      expect(Object.keys(domain), `exports ${name}`).not.toContain(name);
    }
  });
});

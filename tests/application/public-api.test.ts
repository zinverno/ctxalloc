import { readFileSync } from 'node:fs';
import * as application from '@ctxalloc/application';
import {
  SourceIngestionValidationError,
  ingestSource,
  type IngestedSource,
  type SourceIdentity,
  type SourceIngestionInput,
} from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import type { Timestamp } from '../../packages/domain/src/index.js';
import { validInput } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/application/package.json', rootUrl), 'utf8'),
) as Manifest;

const SOURCE_FILES = [
  'packages/application/src/index.ts',
  'packages/application/src/source-ingestion.ts',
  'packages/application/src/markdown-chunker.ts',
  'packages/application/src/chunking-primitives.ts',
  'packages/application/src/canonical-record.ts',
  'packages/application/src/text-chunker.ts',
  'packages/application/src/conversation-source.ts',
  'packages/application/src/conversation-chunker.ts',
  'packages/application/src/compile-local-context-service.ts',
] as const;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function importSpecifiers(relativePath: string): string[] {
  return [...readSource(relativePath).matchAll(/from '(?<specifier>[^']+)'/g)].map(
    (match) => match.groups?.specifier ?? '',
  );
}

describe('@ctxalloc/application public API', () => {
  it('exports the implemented use cases and their error types only', () => {
    expect(Object.keys(application).sort()).toEqual([
      'CONVERSATION_SOURCE_SCHEMA_VERSION',
      'CompileLocalContextService',
      'ConversationChunker',
      'ConversationChunkingError',
      'ConversationChunkingValidationError',
      'ConversationSourceValidationError',
      'LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION',
      'LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION',
      'LocalSourcePipelineError',
      'MarkdownChunker',
      'MarkdownChunkingError',
      'MarkdownChunkingValidationError',
      'SourceIngestionValidationError',
      'TextChunker',
      'TextChunkingError',
      'TextChunkingValidationError',
      'ingestConversationSource',
      'ingestSource',
      'parseConversationSourceJson',
      'validateConversationSourcePayload',
    ]);
  });

  it('exports no internal chunking primitive', () => {
    // The shared split, group, hash, and identity helpers are mechanics, not a
    // contract: publishing one would invite a caller to depend on a splitting
    // detail a future chunking decision may change (DEC-029, DEC-039).
    for (const name of [
      'scanLines',
      'splitRange',
      'groupRanges',
      'sliceCounter',
      'contextBlockId',
      'contextBlockIdPayload',
      'cloneJsonValue',
      'sha256',
      'canonicalConversationContent',
      'ChunkingOptionsSchema',
      'canonicalRecordJson',
      'tryCanonicalRecordJson',
      'tryCloneJsonRecord',
      'cloneRecord',
    ]) {
      expect(Object.keys(application), `exports ${name}`).not.toContain(name);
    }
  });

  it('exports the documented public types from its entry point', () => {
    const exported = [...readSource('packages/application/src/index.ts').matchAll(/type (\w+),/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'ConversationChunkingErrorCode',
      'ConversationIngestionInput',
      'ConversationSourceMessage',
      'ConversationSourcePayload',
      'IngestedConversationSource',
      'IngestedSource',
      'LocalCompilationRequest',
      'LocalCompilationResult',
      'LocalCompileServiceConfig',
      'LocalSourcePipelineStage',
      'MarkdownChunkingErrorCode',
      'MarkdownChunkingOptions',
      'MarkdownChunkingRange',
      'SourceIdentity',
      'SourceIngestionInput',
      'TextChunkingErrorCode',
      'TextChunkingOptions',
      'TextChunkingRange',
    ]);
  });

  it('accepts the documented public input shape and returns the documented result', () => {
    // `createdAt` and `updatedAt` are branded domain `Timestamp` values, so a
    // typed caller supplies them from a validated source rather than a literal.
    const createdAt: Timestamp | undefined = ingestSource(
      validInput({ createdAt: '2026-01-31T09:15:00.000Z' }),
    ).document.createdAt;

    const identity: SourceIdentity = { namespace: 'vault:notes', key: 'projects/ctxalloc.md' };
    const input: SourceIngestionInput = {
      scope: { tenantId: 'local', workspaceId: 'default' },
      sourceType: 'markdown',
      identity,
      content: '# Title\n',
      title: 'Project notes',
      ...(createdAt !== undefined ? { createdAt } : {}),
      metadata: { path: 'projects/ctxalloc.md' },
    };

    const result: IngestedSource = ingestSource(input);

    expect(result.content).toBe('# Title\n');
    expect(result.document.title).toBe('Project notes');
    expect(result.document.createdAt).toBe('2026-01-31T09:15:00.000Z');
    expect(typeof result.document.id).toBe('string');
    expect(ingestSource).toBeInstanceOf(Function);
    expect(SourceIngestionValidationError.prototype).toBeInstanceOf(Error);
  });

  it('exposes no reader, tokenizer, compiler, allocator, or internal scanner type', () => {
    for (const name of [
      'MarkdownSourceReader',
      'NodeFileSourceReader',
      'readSource',
      'createBlock',
      'FakeTokenizer',
      'O200kBaseTokenizer',
      'countTokens',
      'ContextCompiler',
      'allocate',
      'TraceStore',
      'SourceLine',
      'LogicalBlock',
      'BlockGroup',
      'HeadingInfo',
      'findLoneSurrogate',
      'calculateNormalizedContentHash',
      'CandidateBlock',
      'CandidateValidator',
    ]) {
      expect(Object.keys(application), `exports ${name}`).not.toContain(name);
    }
  });

  it('declares only the dependencies it imports', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/compiler': 'workspace:*',
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      zod: '^4.4.3',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-002: depends on the compiler and the ports, never on an adapter', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      '@ctxalloc/tokenization',
      '@ctxalloc/adapters',
      '@ctxalloc/testing',
      'js-tiktoken',
      'obsidian',
      'better-sqlite3',
    ]) {
      expect(declared).not.toContain(forbidden);
    }
    expect(declared).toContain('@ctxalloc/domain');
    // Every chunker and the service take the Tokenizer port, never a concrete
    // tokenizer, and filesystem access arrives through the SourceReader port
    // (DEC-029, DEC-039).
    expect(declared).toContain('@ctxalloc/ports');
    // The application composes the kernel; the kernel never sees the application.
    expect(declared).toContain('@ctxalloc/compiler');
  });

  it('INV-DEP-002: reads no file, clock, environment variable, or random value', () => {
    // Documentation comments legitimately name what the code refuses to do, so
    // only declared code is inspected.
    const stripped = (content: string): string =>
      content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const file of SOURCE_FILES) {
      const code = stripped(readSource(file));
      for (const forbidden of [
        'node:fs',
        'node:path',
        'node:os',
        'node:child_process',
        'process.env',
        'Date.now(',
        'Math.random(',
        'localeCompare',
      ]) {
        expect(code, `${file} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('imports only its declared dependencies and the Node standard library', () => {
    const allowed = new Set([
      '@ctxalloc/compiler',
      '@ctxalloc/domain',
      '@ctxalloc/ports',
      'zod',
      'node:crypto',
    ]);
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(
          specifier.startsWith('./') || allowed.has(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('INV-ADAPTER-001: leaks no validation-library or Node type through its public surface', () => {
    const entry = readSource('packages/application/src/index.ts');
    expect(entry).not.toContain('zod');
    expect(entry).not.toContain('node:');

    for (const file of [
      'source-ingestion',
      'markdown-chunker',
      'text-chunker',
      'conversation-source',
      'conversation-chunker',
      'compile-local-context-service',
    ]) {
      const declaredExports = readSource(`packages/application/src/${file}.ts`)
        .split('\n')
        .filter((line) => line.startsWith('export '))
        .join('\n');
      for (const leaked of ['z.', 'Zod', 'Buffer', 'Hash', 'createHash']) {
        expect(declaredExports, `${file} exposes ${leaked}`).not.toContain(leaked);
      }
    }
  });

  it('INV-ADAPTER-001: imports no Obsidian API anywhere in the package', () => {
    // Documentation comments legitimately name the reference plugin the scanner
    // design was adapted from (DEC-029), so only declared code is inspected.
    const stripComments = (content: string): string =>
      content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    for (const file of SOURCE_FILES) {
      expect(importSpecifiers(file), `${file} imports obsidian`).not.toContain('obsidian');
      const code = stripComments(readSource(file));
      for (const forbidden of ['CachedMetadata', 'HeadingCache', 'TFile', 'Vault', 'stableHash']) {
        expect(code, `${file} references ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('INV-DEP-001: keeps application vocabulary out of the domain package', () => {
    const domainManifest = JSON.parse(
      readFileSync(new URL('packages/domain/package.json', rootUrl), 'utf8'),
    ) as Manifest;
    expect(domainManifest.dependencies).toEqual({ zod: '^4.4.3' });

    const domainEntry = readSource('packages/domain/src/index.ts');
    for (const name of ['ingestSource', 'SourceIdentity', 'createHash', 'sha256', 'Markdown']) {
      expect(domainEntry).not.toContain(name);
    }
  });
});

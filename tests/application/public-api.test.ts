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
  it('exports the two use cases and their error types only', () => {
    expect(Object.keys(application).sort()).toEqual([
      'MarkdownChunker',
      'MarkdownChunkingError',
      'MarkdownChunkingValidationError',
      'SourceIngestionValidationError',
      'ingestSource',
    ]);
  });

  it('exports the documented public types from its entry point', () => {
    const exported = [...readSource('packages/application/src/index.ts').matchAll(/type (\w+),/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual([
      'IngestedSource',
      'MarkdownChunkingErrorCode',
      'MarkdownChunkingOptions',
      'MarkdownChunkingRange',
      'SourceIdentity',
      'SourceIngestionInput',
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
      'SourceReader',
      'MarkdownSourceReader',
      'readSource',
      'createBlock',
      'Tokenizer',
      'FakeTokenizer',
      'O200kBaseTokenizer',
      'countTokens',
      'compile',
      'allocate',
      'CandidateProvider',
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
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      zod: '^4.4.3',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-002: depends on the domain and the ports, never on a tokenizer implementation', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      '@ctxalloc/tokenization',
      '@ctxalloc/compiler',
      '@ctxalloc/testing',
      'js-tiktoken',
      'obsidian',
    ]) {
      expect(declared).not.toContain(forbidden);
    }
    expect(declared).toContain('@ctxalloc/domain');
    // The chunker takes the Tokenizer port, never a concrete tokenizer (DEC-029).
    expect(declared).toContain('@ctxalloc/ports');
  });

  it('imports only its declared dependencies and the Node standard library', () => {
    const allowed = new Set(['@ctxalloc/domain', '@ctxalloc/ports', 'zod', 'node:crypto']);
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

    for (const file of ['source-ingestion', 'markdown-chunker']) {
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

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
  it('exports the ingestion use case and its error type only', () => {
    expect(Object.keys(application).sort()).toEqual([
      'SourceIngestionValidationError',
      'ingestSource',
    ]);
  });

  it('exports the documented public types from its entry point', () => {
    const exported = [...readSource('packages/application/src/index.ts').matchAll(/type (\w+),/g)]
      .map((match) => match[1])
      .sort();
    expect(exported).toEqual(['IngestedSource', 'SourceIdentity', 'SourceIngestionInput']);
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

  it('exposes no reader, chunker, block factory, tokenizer, compiler, or allocator', () => {
    for (const name of [
      'SourceReader',
      'MarkdownSourceReader',
      'readSource',
      'chunk',
      'ContextBlock',
      'createBlock',
      'Tokenizer',
      'countTokens',
      'compile',
      'allocate',
      'CandidateProvider',
      'TraceStore',
    ]) {
      expect(Object.keys(application), `exports ${name}`).not.toContain(name);
    }
  });

  it('declares only the dependencies it imports', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/domain': 'workspace:*',
      zod: '^4.4.3',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-DEP-002: depends on the domain, never on tokenization or the compiler', () => {
    const declared = Object.keys(manifest.dependencies ?? {});
    for (const forbidden of [
      '@ctxalloc/tokenization',
      '@ctxalloc/ports',
      '@ctxalloc/compiler',
      '@ctxalloc/testing',
      'js-tiktoken',
    ]) {
      expect(declared).not.toContain(forbidden);
    }
    expect(declared).toContain('@ctxalloc/domain');
  });

  it('imports only its declared dependencies and the Node standard library', () => {
    const allowed = new Set(['@ctxalloc/domain', 'zod', 'node:crypto']);
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

    const declaredExports = readSource('packages/application/src/source-ingestion.ts')
      .split('\n')
      .filter((line) => line.startsWith('export '))
      .join('\n');
    for (const leaked of ['z.', 'Zod', 'Buffer', 'Hash', 'createHash']) {
      expect(declaredExports, `public declaration exposes ${leaked}`).not.toContain(leaked);
    }
  });

  it('keeps the domain package unchanged by this phase', () => {
    const domainManifest = JSON.parse(
      readFileSync(new URL('packages/domain/package.json', rootUrl), 'utf8'),
    ) as Manifest;
    expect(domainManifest.dependencies).toEqual({ zod: '^4.4.3' });

    const domainEntry = readSource('packages/domain/src/index.ts');
    for (const name of ['ingestSource', 'SourceIdentity', 'createHash', 'sha256']) {
      expect(domainEntry).not.toContain(name);
    }
  });
});

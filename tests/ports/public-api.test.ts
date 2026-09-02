import { readFileSync } from 'node:fs';
import * as ports from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const PORT_FILES = [
  'packages/ports/src/index.ts',
  'packages/ports/src/tokenizer.ts',
  'packages/ports/src/source-reader.ts',
  'packages/ports/src/control-store.ts',
  'packages/ports/src/candidate-provider.ts',
] as const;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(new URL(`${relativeDir}/package.json`, rootUrl), 'utf8'),
  ) as Manifest;
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function importSpecifiers(relativePath: string): string[] {
  return [...readSource(relativePath).matchAll(/from '(?<specifier>[^']+)'/g)].map(
    (match) => match.groups?.specifier ?? '',
  );
}

describe('@ctxalloc/ports public API', () => {
  it('exposes every capability as a type-only contract', () => {
    // Every port is an interface, so the compiled entry point has no runtime
    // export. A runtime export here would mean a port started carrying behavior.
    expect(Object.keys(ports)).toEqual([]);
  });

  it('exports exactly the four contracts that have a consumer', () => {
    const entry = readSource('packages/ports/src/index.ts');
    const exported = [...entry.matchAll(/export type \{(?<names>[^}]+)\} from/g)]
      .flatMap((match) => (match.groups?.names ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort();
    expect(exported).toEqual([
      'CandidateProvider',
      'CandidateProviderRequest',
      'ControlStore',
      'SourceReadRequest',
      'SourceReadResult',
      'SourceReader',
      'SourceRegistration',
      'Tokenizer',
    ]);
    expect(entry).not.toMatch(/export (const|function|class|enum|let|var)/);
  });

  it('defines no speculative port for this phase', () => {
    const entry = readSource('packages/ports/src/index.ts');
    for (const name of [
      'TraceStore',
      'ModelProvider',
      'Clock',
      'DocumentConverter',
      'EmbeddingProvider',
      'TelemetrySink',
      'JobQueue',
      'ObjectStore',
    ]) {
      expect(entry, `declares ${name}`).not.toContain(`${name},`);
    }
  });

  it('INV-ADAPTER-001: declares the domain as its only dependency', () => {
    const manifest = readManifest('packages/ports');
    expect(manifest.dependencies).toEqual({ '@ctxalloc/domain': 'workspace:*' });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-ADAPTER-001: imports only project-owned domain types, and only as types', () => {
    for (const file of PORT_FILES) {
      const source = readSource(file);
      for (const specifier of importSpecifiers(file)) {
        expect(
          specifier.startsWith('./') || specifier === '@ctxalloc/domain',
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
      // A value import would give a port a runtime dependency, which is the one
      // thing this package must never have.
      expect(source, `${file} imports a value`).not.toMatch(
        /^import (?!type )[^;]*from '@ctxalloc\/domain'/m,
      );
    }
  });

  it('INV-ADAPTER-001: names no external system, SDK, or Node type', () => {
    for (const file of PORT_FILES) {
      const declarations = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of [
        'node:',
        'Buffer',
        'Stats',
        'Dirent',
        'PathLike',
        'Tiktoken',
        'sqlite',
        'Qdrant',
        'obsidian',
        'zod',
      ]) {
        expect(declarations, `${file} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('describes a synchronous non-negative integer token count', () => {
    const source = readSource('packages/ports/src/tokenizer.ts');
    expect(source).toContain('countTokens(text: string): number;');
    expect(source).not.toContain('Promise');
  });

  it('describes a source read that returns exact text for an adapter locator', () => {
    const source = readSource('packages/ports/src/source-reader.ts');
    expect(source).toContain('readonly locator: string;');
    expect(source).toContain('readonly content: string;');
    expect(source).toContain('read(request: SourceReadRequest): Promise<SourceReadResult>;');
  });

  it('INV-ADAPTER-002: separates logical source identity from the adapter locator', () => {
    const source = readSource('packages/ports/src/control-store.ts');
    expect(source).toContain('readonly identity: {');
    expect(source).toContain('readonly namespace: string;');
    expect(source).toContain('readonly key: string;');
    expect(source).toContain('readonly locator: string;');
  });

  it('keeps the control store read-only in this phase', () => {
    const source = readSource('packages/ports/src/control-store.ts');
    expect(source).toContain('listSources(scope: Scope): Promise<readonly SourceRegistration[]>;');
    for (const write of [
      'registerSource',
      'updateSource',
      'removeSource',
      'deleteSource',
      'saveSource',
    ]) {
      expect(source, `declares ${write}`).not.toContain(write);
    }
  });

  it('INV-DEP-002: gives the candidate provider the corpus and the query, never compiler policy', () => {
    const source = readSource('packages/ports/src/candidate-provider.ts');
    expect(source).toContain('readonly sourceDocuments: readonly SourceDocument[];');
    expect(source).toContain('readonly blocks: readonly ContextBlock[];');
    expect(source).toContain('readonly referenceTime: Timestamp;');
    expect(source).toContain(
      'getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]>;',
    );

    const declarations = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'TokenBudget',
      'CompilationPolicy',
      'CompilationRequest',
      'Tokenizer',
    ]) {
      expect(declarations, `names ${forbidden}`).not.toContain(forbidden);
    }
  });
});

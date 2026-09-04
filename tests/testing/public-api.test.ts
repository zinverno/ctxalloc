import { readFileSync } from 'node:fs';
import type {
  CandidateProvider,
  ControlStore,
  ControlStoreWriter,
  SourceReader,
  Tokenizer,
  TraceStore,
} from '@ctxalloc/ports';
import * as testing from '@ctxalloc/testing';
import {
  FakeCandidateProvider,
  FakeTokenizer,
  InMemoryControlStore,
  InMemorySourceReader,
  InMemoryTraceStore,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const SOURCE_FILES = [
  'packages/testing/src/index.ts',
  'packages/testing/src/fake-tokenizer.ts',
  'packages/testing/src/in-memory-source-reader.ts',
  'packages/testing/src/in-memory-control-store.ts',
  'packages/testing/src/fake-candidate-provider.ts',
  'packages/testing/src/in-memory-trace-store.ts',
] as const;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/testing/package.json', rootUrl), 'utf8'),
) as Manifest;

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

describe('@ctxalloc/testing public API', () => {
  it('exports the seven doubles and their error types from the package entry point', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'FakeCandidateProvider',
      'FakeCandidateProviderError',
      'FakeModelProvider',
      'FakeModelProviderConfigurationError',
      'FakeModelProviderScriptedFailureError',
      'FakeModelProviderUnscriptedCallError',
      'FakeMonotonicClock',
      'FakeMonotonicClockConfigurationError',
      'FakeMonotonicClockExhaustedError',
      'FakeTokenizer',
      'FakeTokenizerConfigurationError',
      'FakeTokenizerUnknownTextError',
      'InMemoryControlStore',
      'InMemoryControlStoreConfigurationError',
      'InMemoryControlStoreWriteError',
      'InMemorySourceReader',
      'InMemorySourceReaderConfigurationError',
      'InMemorySourceReaderUnknownLocatorError',
      'InMemoryTraceStore',
      'InMemoryTraceStoreConfigurationError',
      'InMemoryTraceStoreError',
    ]);
  });

  it('exports a double only for a port that exists', () => {
    // `FakeModelProvider` and `FakeMonotonicClock` arrived with their ports in
    // Phase 17, and `InMemoryTraceStore` with `TraceStore` in Phase 19. A
    // general wall clock still has no port, and a fake for one would invite a
    // test to depend on a contract nothing implements (DEC-040, DEC-042).
    for (const name of ['FakeClock', 'FakeWallClock', 'FakeWallClockProvider']) {
      expect(Object.keys(testing), `exports ${name}`).not.toContain(name);
    }
  });

  it('INV-ADAPTER-005: provides an implementation assignable to the Tokenizer port', () => {
    const tokenizer: Tokenizer = new FakeTokenizer([{ text: '', tokens: 0 }]);
    expect(tokenizer.countTokens('')).toBe(0);
    expect(typeof tokenizer.id).toBe('string');
    expect(typeof tokenizer.version).toBe('string');
  });

  it('INV-ADAPTER-005: provides implementations assignable to the local ports', () => {
    const reader: SourceReader = new InMemorySourceReader([{ locator: 'a.md', content: '# A' }]);
    const store: ControlStore = new InMemoryControlStore([]);
    const writer: ControlStoreWriter = new InMemoryControlStore([]);
    const traces: TraceStore = new InMemoryTraceStore();
    const provider: CandidateProvider = new FakeCandidateProvider();

    for (const port of [reader, store, writer, traces, provider]) {
      expect(typeof port.id).toBe('string');
      expect(port.id.length).toBeGreaterThan(0);
      expect(typeof port.version).toBe('string');
      expect(port.version.length).toBeGreaterThan(0);
    }
    expect(typeof reader.read).toBe('function');
    expect(typeof store.listSources).toBe('function');
    expect(typeof writer.registerSource).toBe('function');
    expect(typeof writer.updateSource).toBe('function');
    expect(typeof writer.removeSource).toBe('function');
    expect(typeof traces.putTrace).toBe('function');
    expect(typeof traces.getTrace).toBe('function');
    expect(typeof provider.getCandidates).toBe('function');
  });

  it('depends only on the internal packages it imports', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
    });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('INV-ADAPTER-001: imports no external package in its sources', () => {
    for (const file of SOURCE_FILES) {
      const specifiers = [...readSource(file).matchAll(/from '(?<specifier>[^']+)'/g)].map(
        (match) => match.groups?.specifier ?? '',
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./') ||
            specifier === '@ctxalloc/ports' ||
            specifier === '@ctxalloc/domain',
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('contains no real tokenizer, retrieval, or filesystem implementation', () => {
    for (const file of SOURCE_FILES) {
      // Documentation is stripped first. A double's comment legitimately names
      // the real adapter whose behavior it mirrors — `InMemoryTraceStore` says
      // it matches `SQLiteTraceStore` conflict semantics, which is exactly the
      // claim its contract test proves — and this check is about what the double
      // *does*, not what its prose refers to.
      const source = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .toLowerCase();
      for (const name of [
        'tiktoken',
        'transformers',
        'anthropic',
        'openai',
        'node:fs',
        'node:path',
        'sqlite',
        'qdrant',
        'bm25',
        'math.random',
        'date.now',
      ]) {
        expect(source, `${file} contains ${name}`).not.toContain(name);
      }
    }
  });
});

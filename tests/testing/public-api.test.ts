import { readFileSync } from 'node:fs';
import type { CandidateProvider, ControlStore, SourceReader, Tokenizer } from '@ctxalloc/ports';
import * as testing from '@ctxalloc/testing';
import {
  FakeCandidateProvider,
  FakeTokenizer,
  InMemoryControlStore,
  InMemorySourceReader,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const SOURCE_FILES = [
  'packages/testing/src/index.ts',
  'packages/testing/src/fake-tokenizer.ts',
  'packages/testing/src/in-memory-source-reader.ts',
  'packages/testing/src/in-memory-control-store.ts',
  'packages/testing/src/fake-candidate-provider.ts',
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
  it('exports the four doubles and their error types from the package entry point', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'FakeCandidateProvider',
      'FakeCandidateProviderError',
      'FakeTokenizer',
      'FakeTokenizerConfigurationError',
      'FakeTokenizerUnknownTextError',
      'InMemoryControlStore',
      'InMemoryControlStoreConfigurationError',
      'InMemorySourceReader',
      'InMemorySourceReaderConfigurationError',
      'InMemorySourceReaderUnknownLocatorError',
    ]);
  });

  it('exports no model provider, because no ModelProvider port exists yet', () => {
    for (const name of ['FakeModelProvider', 'InMemoryTraceStore', 'FakeClock']) {
      expect(Object.keys(testing), `exports ${name}`).not.toContain(name);
    }
  });

  it('INV-ADAPTER-005: provides an implementation assignable to the Tokenizer port', () => {
    const tokenizer: Tokenizer = new FakeTokenizer([{ text: '', tokens: 0 }]);
    expect(tokenizer.countTokens('')).toBe(0);
    expect(typeof tokenizer.id).toBe('string');
    expect(typeof tokenizer.version).toBe('string');
  });

  it('INV-ADAPTER-005: provides implementations assignable to the three new ports', () => {
    const reader: SourceReader = new InMemorySourceReader([{ locator: 'a.md', content: '# A' }]);
    const store: ControlStore = new InMemoryControlStore([]);
    const provider: CandidateProvider = new FakeCandidateProvider();

    for (const port of [reader, store, provider]) {
      expect(typeof port.id).toBe('string');
      expect(port.id.length).toBeGreaterThan(0);
      expect(typeof port.version).toBe('string');
      expect(port.version.length).toBeGreaterThan(0);
    }
    expect(typeof reader.read).toBe('function');
    expect(typeof store.listSources).toBe('function');
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
      const source = readSource(file).toLowerCase();
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

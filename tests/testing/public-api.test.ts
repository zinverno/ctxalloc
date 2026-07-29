import { readFileSync } from 'node:fs';
import type { Tokenizer } from '@ctxalloc/ports';
import * as testing from '@ctxalloc/testing';
import { FakeTokenizer } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('packages/testing/package.json', rootUrl), 'utf8'),
) as Manifest;

describe('@ctxalloc/testing public API', () => {
  it('exports the fake tokenizer and its error types from the package entry point', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'FakeTokenizer',
      'FakeTokenizerConfigurationError',
      'FakeTokenizerUnknownTextError',
    ]);
  });

  it('INV-ADAPTER-005: provides an implementation assignable to the Tokenizer port', () => {
    const tokenizer: Tokenizer = new FakeTokenizer([{ text: '', tokens: 0 }]);
    expect(tokenizer.countTokens('')).toBe(0);
    expect(typeof tokenizer.id).toBe('string');
    expect(typeof tokenizer.version).toBe('string');
  });

  it('depends only on the internal package it imports', () => {
    expect(manifest.dependencies).toEqual({ '@ctxalloc/ports': 'workspace:*' });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('INV-ADAPTER-001: imports no external package in its sources', () => {
    for (const file of [
      'packages/testing/src/index.ts',
      'packages/testing/src/fake-tokenizer.ts',
    ]) {
      const source = readFileSync(new URL(file, rootUrl), 'utf8');
      const specifiers = [...source.matchAll(/from '(?<specifier>[^']+)'/g)].map(
        (match) => match.groups?.specifier ?? '',
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./') || specifier === '@ctxalloc/ports',
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('contains no real tokenizer implementation', () => {
    const source = readFileSync(new URL('packages/testing/src/fake-tokenizer.ts', rootUrl), 'utf8');
    for (const name of ['tiktoken', 'transformers', 'anthropic', 'openai']) {
      expect(source.toLowerCase()).not.toContain(name);
    }
  });
});

import { readFileSync } from 'node:fs';
import { ingestSource } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { validInput } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

const SOURCE_FILES = [
  'packages/application/src/index.ts',
  'packages/application/src/source-ingestion.ts',
] as const;

/**
 * Returns the declared code of a source file with its comments removed.
 *
 * The comments legitimately name what this phase does *not* do, so only real code
 * is inspected for forbidden behavior.
 */
function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('INV-DET-001: source ingestion is deterministic', () => {
  it('returns a deep-equal result for repeated ingestion of the same input', () => {
    const input = validInput({
      title: 'Project notes',
      createdAt: '2026-01-31T09:15:00.000Z',
      updatedAt: '2026-02-01T10:00:00Z',
      metadata: { path: 'projects/ctxalloc.md', tags: ['notes'] },
    });

    expect(ingestSource(input)).toStrictEqual(ingestSource(input));
  });

  it('INV-DET-002: returns a deep-equal result for a different property order', () => {
    const ordered = validInput({ title: 'Project notes' });
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());

    expect(ingestSource(reversed)).toStrictEqual(ingestSource(ordered));
  });

  it('INV-DET-002: returns a deep-equal result for a reordered identity object', () => {
    const identity = { namespace: 'vault:notes', key: 'projects/ctxalloc.md' };
    const reversedIdentity = { key: identity.key, namespace: identity.namespace };

    expect(ingestSource(validInput({ identity: reversedIdentity }))).toStrictEqual(
      ingestSource(validInput({ identity })),
    );
  });

  it('INV-DET-004: adds no timestamp when the caller supplied none', () => {
    const { document } = ingestSource(validInput());
    expect('createdAt' in document).toBe(false);
    expect('updatedAt' in document).toBe(false);
  });

  it('injects no metadata field', () => {
    const supplied = { path: 'projects/ctxalloc.md' };
    const { document } = ingestSource(validInput({ metadata: supplied }));

    expect(document.metadata).toEqual(supplied);
    expect(Object.keys(document.metadata)).toEqual(['path']);
  });
});

describe('INV-DEP-002: source ingestion has no hidden inputs', () => {
  it.each(SOURCE_FILES)('%s reads no clock, randomness, or ambient state', (relativePath) => {
    const source = readSource(relativePath);
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date',
      'crypto.randomUUID',
      'randomUUID',
      'process.env',
      'process.pid',
      'hostname',
    ]) {
      expect(source, `${relativePath} uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(SOURCE_FILES)('%s performs no filesystem or network access', (relativePath) => {
    const source = readSource(relativePath);
    for (const forbidden of [
      'node:fs',
      'node:path',
      'readFile',
      'writeFile',
      'readdir',
      'fetch(',
      'node:http',
      'XMLHttpRequest',
    ]) {
      expect(source, `${relativePath} uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(SOURCE_FILES)('%s invokes no tokenizer and creates no block', (relativePath) => {
    const source = readSource(relativePath);
    for (const forbidden of [
      'countTokens',
      'Tokenizer',
      'tiktoken',
      'ContextBlock',
      'tokenCount',
      'SourceReader',
      'chunk',
    ]) {
      expect(source, `${relativePath} references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(SOURCE_FILES)('%s does not normalize source text', (relativePath) => {
    const source = readSource(relativePath);
    for (const forbidden of [
      '.normalize(',
      '.trimStart(',
      '.trimEnd(',
      '.toLowerCase(',
      '.toUpperCase(',
      '.replaceAll(',
      'replace(/',
    ]) {
      expect(source, `${relativePath} uses ${forbidden}`).not.toContain(forbidden);
    }
  });
});

import { MINISEARCH_LIBRARY_VERSION, MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { block, providerRequest } from './minisearch-fixtures.js';

/**
 * The retrieval dependency stays narrow, offline, and behind the adapter
 * (DEC-041, RETRIEVAL_SPIKE.md).
 *
 * These are the spike's hard gates, kept as regressions. A future dependency
 * bump that reintroduced a model, a native module, a database, or a network
 * call would fail here rather than in production.
 */

const rootUrl = new URL('../../', import.meta.url);

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, rootUrl), 'utf8')) as T;
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('GATE 8: the retrieval dependency is narrow', () => {
  it('is the only retrieval dependency the adapters package declares', () => {
    const manifest = readJson<{ dependencies: Record<string, string> }>(
      'packages/adapters/package.json',
    );
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/domain': 'workspace:*',
      '@ctxalloc/ports': 'workspace:*',
      minisearch: MINISEARCH_LIBRARY_VERSION,
    });
  });

  it('has no transitive dependencies of its own', () => {
    // Zero dependencies is what keeps the retrieval surface auditable: there is
    // no second package that could add a model, a native binding, or telemetry.
    const manifest = readJson<{ dependencies?: Record<string, string>; version: string }>(
      'packages/adapters/node_modules/minisearch/package.json',
    );
    expect(manifest.version).toBe(MINISEARCH_LIBRARY_VERSION);
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('adds no model, embedding, vector, reranker, or database package to the workspace', () => {
    const lock = readSource('pnpm-lock.yaml');
    for (const forbidden of [
      'node-llama-cpp',
      'better-sqlite3',
      'sqlite-vec',
      '@tobilu/qmd',
      'onnxruntime',
      'transformers',
      '@xenova',
      'tree-sitter',
      'qdrant',
    ]) {
      expect(lock, `the lockfile contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('GATE 3 and GATE 6: the adapter is offline and stateless', () => {
  const source = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));

  it('reads no clock, no random value, no environment, and no filesystem', () => {
    for (const forbidden of [
      'Date.now',
      'new Date',
      'performance.now',
      'Math.random',
      'process.env',
      'node:fs',
      'node:path',
      'node:os',
      'readFile',
      'cwd(',
    ]) {
      expect(source, `uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('makes no network call and opens no database', () => {
    for (const forbidden of [
      'fetch(',
      'http',
      'XMLHttpRequest',
      'WebSocket',
      'sqlite',
      'Database',
    ]) {
      expect(source.toLowerCase(), `uses ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
  });

  it('names no embedding, vector, reranking, or query-expansion capability', () => {
    for (const forbidden of [
      'searchVector',
      'expandQuery',
      'rerank(',
      'embedding(',
      'embed(',
      'cosine',
    ]) {
      expect(source, `names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('selects the plain lexical mode explicitly rather than inheriting a default', () => {
    // Prefix and fuzzy expansion are the library's defaults today. Naming them
    // keeps a future default change from quietly turning this provider into an
    // approximate matcher.
    expect(source).toContain('prefix: false');
    expect(source).toContain('fuzzy: false');
  });

  it('keeps no state between calls', async () => {
    // The index is built per call from the request corpus. A provider reused
    // across two different corpora cannot leak one into the other.
    const provider = new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates: 10 });
    const first = await provider.getCandidates(
      providerRequest({ query: 'reticulator', blocks: [block('blk-1', 'reticulator one')] }),
    );
    const second = await provider.getCandidates(
      providerRequest({ query: 'reticulator', blocks: [block('blk-2', 'reticulator two')] }),
    );
    const third = await provider.getCandidates(
      providerRequest({ query: 'reticulator', blocks: [block('blk-1', 'reticulator one')] }),
    );
    expect(first.map((c) => c.block.id)).toEqual(['blk-1']);
    expect(second.map((c) => c.block.id)).toEqual(['blk-2']);
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('leaves no artefact behind: an empty corpus does not even build an index', async () => {
    const provider = new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates: 10 });
    await expect(
      provider.getCandidates(providerRequest({ query: 'anything', blocks: [] })),
    ).resolves.toEqual([]);
  });
});

describe('GATE 1: one CtxAlloc block is one retrieval record', () => {
  const source = codeOf(readSource('packages/adapters/src/minisearch-candidate-provider.ts'));

  it('indexes the block identifier as the record identifier and content as the only field', () => {
    expect(source).toContain("idField: 'id'");
    expect(source).toContain('fields: [INDEXED_FIELD]');
    expect(source).toContain("const INDEXED_FIELD = 'content'");
  });

  it('does not re-chunk, overlap, or rewrite block content', () => {
    for (const forbidden of ['chunk', 'overlap', 'substring', 'toLowerCase', 'normalize(']) {
      expect(source, `performs ${forbidden}`).not.toContain(forbidden);
    }
    // The one `slice` is the retrieval bound applied to the ranked result list,
    // never to a block's text.
    expect(source.match(/\.slice\(/g) ?? []).toHaveLength(1);
    expect(source).toContain('resolved.slice(0, this.#maxCandidates)');
  });

  it('preserves every block exactly, whatever its length or content', async () => {
    // One long block stays one record: nothing is split, and the returned block
    // is the request block rather than a fragment of it.
    const long = block('blk-long', `reticulator ${'paragraph filler text. '.repeat(400).trim()}`);
    const provider = new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates: 10 });
    const got = await provider.getCandidates(
      providerRequest({ query: 'reticulator', blocks: [long] }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.block).toStrictEqual(long);
    expect(got[0]?.block.content).toBe(long.content);
  });

  it('gives the library minimal documents rather than the live blocks', () => {
    // A retrieval library holding the live block could mutate its content, its
    // attributes, or its token count in place, and `readonly` stops nothing at
    // run time.
    expect(source).toContain('interface RetrievalDocument');
    expect(source).toContain('documents.push({ id, content })');
  });
});

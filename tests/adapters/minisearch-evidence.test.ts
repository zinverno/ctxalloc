import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_LIBRARY_NAME,
  MINISEARCH_LIBRARY_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_HIGHER_IS_BETTER,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  MiniSearchCandidateProvider,
} from '@ctxalloc/adapters';
import { CANDIDATE_BLOCK_SCHEMA_VERSION, CandidateBlockSchema } from '@ctxalloc/domain';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { block, providerRequest } from './minisearch-fixtures.js';

/**
 * The retrieval evidence this provider publishes (DEC-041).
 *
 * The evidence is a claim about one retrieval of one block for one query, and it
 * must be truthful in every part: whose score it is, which version produced it,
 * what the number means, which direction is better, and where the result sat in
 * the ranking. A consumer normalizes it only under an exact matching rule, so an
 * untruthful field here would silently change how a compilation scores
 * (INV-SCORE-002).
 */

function provider(maxCandidates = 10): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates });
}

const CORPUS = [
  block('blk-01', 'The reticulator calibrates the budget allocator.'),
  block('blk-02', 'A budget reserve is subtracted before selection.'),
  block('blk-03', 'Deterministic token budget allocation runs first.'),
  block('blk-04', 'Ferries leave the harbour at noon.'),
];

async function candidates(
  query = 'budget',
): ReturnType<MiniSearchCandidateProvider['getCandidates']> {
  return provider().getCandidates(providerRequest({ query, blocks: CORPUS }));
}

describe('INV-TRACE-005: the provider publishes a stable identity', () => {
  it('reports the exact documented identifier and version', () => {
    const instance = provider();
    expect(instance.id).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
    expect(instance.id).toBe('ctxalloc-minisearch-bm25');
    expect(instance.version).toBe(MINISEARCH_CANDIDATE_PROVIDER_VERSION);
    expect(instance.version).toBe('1+minisearch@7.2.0');
  });

  it('names the retrieval implementation and its exact version in the identity', () => {
    // A score is produced by one library version's BM25+ implementation and its
    // tokenizer, so a different version is a different metric under one name.
    expect(MINISEARCH_CANDIDATE_PROVIDER_VERSION).toContain(MINISEARCH_LIBRARY_NAME);
    expect(MINISEARCH_CANDIDATE_PROVIDER_VERSION).toContain(MINISEARCH_LIBRARY_VERSION);
  });

  it('keeps the declared library version equal to the manifest pin', () => {
    // The literal never drifts from the dependency it describes, and the adapter
    // still reads no `package.json` at runtime to discover who it is.
    const manifest = JSON.parse(
      readFileSync(new URL('../../packages/adapters/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies[MINISEARCH_LIBRARY_NAME]).toBe(MINISEARCH_LIBRARY_VERSION);
  });

  it('pins the dependency exactly, with no caret or tilde range', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../packages/adapters/package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.minisearch).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('every candidate carries truthful retrieval evidence', () => {
  it('is a valid CandidateBlock under the current domain schema', async () => {
    for (const candidate of await candidates()) {
      expect(() => CandidateBlockSchema.parse(candidate)).not.toThrow();
      expect(candidate.schemaVersion).toBe(CANDIDATE_BLOCK_SCHEMA_VERSION);
    }
  });

  it('reports the exact provider identifier and version on every wrapper', async () => {
    for (const candidate of await candidates()) {
      expect(candidate.retrieval?.providerId).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
      expect(candidate.retrieval?.providerVersion).toBe(MINISEARCH_CANDIDATE_PROVIDER_VERSION);
    }
  });

  it('names what the score actually is, and never calls it plain BM25', async () => {
    // MiniSearch returns the sum of per-term BM25+ scores multiplied by the
    // number of matched query terms. Calling that "BM25" or "relevance" would be
    // a claim the library does not support.
    expect(MINISEARCH_RETRIEVAL_SCORE_SEMANTICS).toBe(
      'minisearch-bm25plus-sum-times-matched-query-terms',
    );
    for (const candidate of await candidates()) {
      expect(candidate.retrieval?.score?.semantics).toBe(MINISEARCH_RETRIEVAL_SCORE_SEMANTICS);
    }
  });

  it('declares the direction truthfully', async () => {
    expect(MINISEARCH_RETRIEVAL_SCORE_HIGHER_IS_BETTER).toBe(true);
    const got = await candidates();
    for (const candidate of got) expect(candidate.retrieval?.score?.higherIsBetter).toBe(true);
    // The published order agrees with the declared direction.
    const values = got.map((candidate) => candidate.retrieval?.score?.value ?? 0);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
  });

  it('INV-SCORE-004: every score is a finite number', async () => {
    for (const candidate of await candidates()) {
      const value = candidate.retrieval?.score?.value;
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isNaN(value)).toBe(false);
    }
  });

  it('emits no zero and no negative score, because a match always scores above zero', async () => {
    // BM25+ adds a positive floor per matched term, and a block with no matched
    // term is simply not returned rather than returned with a zero. This is
    // pinned rather than assumed: it is a property of this library, not of BM25
    // in general.
    for (const query of ['budget', 'reticulator', 'budget allocation', 'the']) {
      for (const candidate of await provider().getCandidates(
        providerRequest({ query, blocks: CORPUS }),
      )) {
        expect(candidate.retrieval?.score?.value ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('carries a very small and a comparatively large finite score without transformation', async () => {
    const large = await provider().getCandidates(
      providerRequest({ query: 'reticulator calibrates budget allocator', blocks: CORPUS }),
    );
    const small = await provider().getCandidates(
      providerRequest({
        query: 'budget',
        blocks: [
          block('blk-dense', `budget ${'filler '.repeat(200).trim()}`),
          block('blk-a', 'budget alone'),
        ],
      }),
    );
    const largest = Math.max(...large.map((c) => c.retrieval?.score?.value ?? 0));
    const smallest = Math.min(...small.map((c) => c.retrieval?.score?.value ?? 0));
    expect(largest).toBeGreaterThan(1);
    expect(smallest).toBeGreaterThan(0);
    expect(smallest).toBeLessThan(1);
    // Neither is clamped into [0, 1] or otherwise rescaled.
    expect(Number.isFinite(largest) && Number.isFinite(smallest)).toBe(true);
  });

  it('publishes a zero-based rank equal to the array position', async () => {
    const got = await candidates();
    expect(got.map((candidate) => candidate.retrieval?.rank)).toEqual(
      got.map((_candidate, index) => index),
    );
    expect(got[0]?.retrieval?.rank).toBe(0);
  });

  it('renumbers rank from zero after the bound truncates the ranking', async () => {
    const bounded = await provider(2).getCandidates(
      providerRequest({ query: 'budget', blocks: CORPUS }),
    );
    expect(bounded).toHaveLength(2);
    expect(bounded.map((candidate) => candidate.retrieval?.rank)).toEqual([0, 1]);
  });
});

describe('INV-SEC-003: retrieval evidence is minimal', () => {
  it('carries no metadata at all', async () => {
    for (const candidate of await candidates()) {
      expect(candidate.retrieval).not.toHaveProperty('metadata');
      expect(Object.keys(candidate.retrieval ?? {}).sort()).toEqual([
        'providerId',
        'providerVersion',
        'rank',
        'score',
      ]);
    }
  });

  it('copies neither the raw query nor any block content into the evidence', async () => {
    const query = 'SECRET-QUERY-TOKEN budget';
    const corpus = [block('blk-secret', 'SECRET-CONTENT-TOKEN budget line')];
    for (const candidate of await provider().getCandidates(
      providerRequest({ query, blocks: corpus }),
    )) {
      const evidence = JSON.stringify(candidate.retrieval);
      expect(evidence).not.toContain('SECRET-QUERY-TOKEN');
      expect(evidence).not.toContain('SECRET-CONTENT-TOKEN');
    }
  });

  it('publishes no library-internal result field', async () => {
    // MiniSearch results carry `terms`, `queryTerms`, and `match`. None of them
    // is a machine-readable fact about the search mode, and `match` names corpus
    // terms.
    for (const candidate of await candidates()) {
      const serialized = JSON.stringify(candidate);
      for (const internal of ['queryTerms', '"terms"', '"match"']) {
        expect(serialized).not.toContain(internal);
      }
    }
  });
});

describe('the adapter sets no compiler-owned field', () => {
  it('publishes exactly a schema version, a block, and retrieval evidence', async () => {
    for (const candidate of await candidates()) {
      expect(Object.keys(candidate).sort()).toEqual(['block', 'retrieval', 'schemaVersion']);
    }
  });

  it('adds no required flag, priority, category, or compiler score of its own', async () => {
    // Those are authored block attributes and compiler results. A provider that
    // wrote one would be making an allocation decision under another name.
    const original = block('blk-plain', 'A plain budget line with no attributes.');
    const [candidate] = await provider().getCandidates(
      providerRequest({ query: 'budget', blocks: [original] }),
    );
    expect(candidate?.block.attributes).toStrictEqual({});
    expect(candidate).not.toHaveProperty('score');
    expect(candidate).not.toHaveProperty('required');
    expect(candidate).not.toHaveProperty('priority');
    expect(candidate).not.toHaveProperty('category');
    expect(candidate).not.toHaveProperty('sourceAuthority');
  });
});

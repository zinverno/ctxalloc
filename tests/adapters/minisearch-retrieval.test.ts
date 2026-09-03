import { MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import type { CandidateBlock } from '@ctxalloc/domain';
import { describe, expect, it } from 'vitest';
import { block, permutations, providerRequest } from './minisearch-fixtures.js';

/**
 * What the lexical provider actually retrieves, and in what order (DEC-041).
 *
 * Every expectation here is about lexical relevance over exact block content.
 * None of them is about compiler selection: a block ranked first by retrieval
 * may be excluded by allocation, and that is the seam working as designed
 * (INV-ALLOC-002).
 */

function provider(maxCandidates: number): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates });
}

async function idsFor(
  query: string,
  blocks: readonly ReturnType<typeof block>[],
  maxCandidates = 10,
): Promise<readonly string[]> {
  const got = await provider(maxCandidates).getCandidates(providerRequest({ query, blocks }));
  return got.map((candidate) => candidate.block.id);
}

const CORPUS = [
  block('blk-01', 'The quantum reticulator calibrates the allocator before every run.'),
  block('blk-02', 'The identifier INV-BUDGET-001 names the hard budget guarantee.'),
  block('blk-03', 'Deterministic token budget allocation resolves required blocks first.'),
  block('blk-04', 'Компилятор распределяет бюджет токенов и записывает трассировку.'),
  block('blk-05', 'The renderer serializes every selected block as one JSON line.'),
  block('blk-06', 'Трассировка содержит providerId и providerVersion кандидата.'),
  block('blk-07', 'Call ctx_alloc::allocate(budget) once per request.'),
  block('blk-90', 'Помидоры в теплице созревают к середине июля.'),
  block('blk-91', 'The gardener repotted the fern on a rainy afternoon.'),
  block('blk-92', 'Ferry timetables change without warning in October.'),
];

describe('lexical retrieval over exact block content', () => {
  it('finds a rare exact term', async () => {
    expect(await idsFor('reticulator', CORPUS)).toEqual(['blk-01']);
  });

  it('ranks the block carrying an exact technical identifier first', async () => {
    const ids = await idsFor('INV-BUDGET-001', CORPUS);
    expect(ids[0]).toBe('blk-02');
  });

  it('ranks a multi-word technical query on the block carrying every term', async () => {
    const ids = await idsFor('deterministic token budget allocation', CORPUS);
    expect(ids[0]).toBe('blk-03');
  });

  it('matches a Russian-language query', async () => {
    expect(await idsFor('записывает трассировку', CORPUS)).toEqual(['blk-04']);
  });

  it('matches an English-language query', async () => {
    expect(await idsFor('renderer serializes', CORPUS)).toEqual(['blk-05']);
  });

  it('matches a mixed Russian and English technical query', async () => {
    expect(await idsFor('providerVersion кандидата', CORPUS)).toEqual(['blk-06']);
  });

  it('returns no distractor from a distractor-heavy corpus', async () => {
    const ids = await idsFor('reticulator calibrates', CORPUS);
    expect(ids).toEqual(['blk-01']);
    expect(ids.some((id) => id.startsWith('blk-9'))).toBe(false);
  });

  it('returns every block carrying a shared term', async () => {
    const ids = await idsFor('budget', CORPUS);
    expect(new Set(ids)).toEqual(new Set(['blk-02', 'blk-03', 'blk-07']));
  });

  it('handles a punctuation-heavy code token', async () => {
    expect(await idsFor('ctx_alloc::allocate', CORPUS)).toEqual(['blk-07']);
  });

  it('INV-ADAPTER-003: proposes nothing when no block shares a term', async () => {
    // No match is a real answer. A lexical retriever must not invent a candidate
    // to avoid returning an empty list.
    expect(await idsFor('xylophone bathysphere', CORPUS)).toEqual([]);
  });

  it('never returns a block unrelated to the query', async () => {
    for (const query of ['reticulator', 'renderer', 'трассировку', 'ctx_alloc::allocate']) {
      const ids = await idsFor(query, CORPUS);
      expect(ids.every((id) => CORPUS.some((entry) => entry.id === id))).toBe(true);
      expect(ids).not.toContain('blk-90');
      expect(ids).not.toContain('blk-91');
      expect(ids).not.toContain('blk-92');
    }
  });

  it('keeps duplicate-content blocks with different identifiers both addressable', async () => {
    const shared = 'The reticulator entry recorded verbatim.';
    const ids = await idsFor('reticulator', [
      block('blk-dup-b', shared),
      block('blk-dup-a', shared),
      block('blk-other', 'Ferries again.'),
    ]);
    expect(ids).toEqual(['blk-dup-a', 'blk-dup-b']);
  });
});

describe('INV-DET-005: ranking is a total order', () => {
  const TIED = [
    block('blk-tie-c', 'gamma delta epsilon reticulator'),
    block('blk-tie-a', 'alpha beta zeta reticulator'),
    block('blk-tie-b', 'eta theta iota reticulator'),
  ];

  it('breaks equal scores by block identifier over UTF-16 code units', async () => {
    const got = await provider(10).getCandidates(
      providerRequest({ query: 'reticulator', blocks: TIED }),
    );
    const scores = got.map((candidate) => candidate.retrieval?.score?.value);
    expect(new Set(scores).size).toBe(1);
    expect(got.map((candidate) => candidate.block.id)).toEqual([
      'blk-tie-a',
      'blk-tie-b',
      'blk-tie-c',
    ]);
  });

  it('INV-ALLOC-005: input permutation does not change the ranked result', async () => {
    // The library keeps tied results in insertion order, so without the
    // adapter's own tie-break this is exactly where a corpus reordering would
    // change the answer.
    const expected = await idsFor('reticulator', TIED);
    for (const ordering of permutations(TIED)) {
      expect(await idsFor('reticulator', ordering)).toEqual(expected);
    }
  });

  it('INV-ALLOC-005: permutation does not change the ranking of the main corpus', async () => {
    const expected = await idsFor('budget allocation', CORPUS);
    const reversed = await idsFor('budget allocation', [...CORPUS].reverse());
    const rotated = await idsFor('budget allocation', [...CORPUS.slice(3), ...CORPUS.slice(0, 3)]);
    expect(reversed).toEqual(expected);
    expect(rotated).toEqual(expected);
  });

  it('INV-DET-001: two identical calls return deeply equivalent results', async () => {
    const request = providerRequest({ query: 'budget allocation', blocks: CORPUS });
    const first = await provider(10).getCandidates(request);
    const second = await provider(10).getCandidates(request);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('INV-DET-001: two independent provider instances agree', async () => {
    const request = providerRequest({ query: 'budget allocation', blocks: CORPUS });
    const first = await provider(10).getCandidates(request);
    const second = await new MiniSearchCandidateProvider({
      schemaVersion: 1,
      maxCandidates: 10,
    }).getCandidates(request);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('maxCandidates is a retrieval bound, not a token budget', () => {
  it('truncates the ranking to the configured bound', async () => {
    const unbounded = await idsFor('budget', CORPUS, 10);
    expect(unbounded.length).toBe(3);
    expect(await idsFor('budget', CORPUS, 2)).toEqual(unbounded.slice(0, 2));
    expect(await idsFor('budget', CORPUS, 1)).toEqual(unbounded.slice(0, 1));
  });

  it('returns only the actual hits when the bound exceeds them', async () => {
    // The bound caps the result; it never pads it with unrelated blocks to
    // "fill" the request.
    expect(await idsFor('reticulator', CORPUS, 100)).toEqual(['blk-01']);
  });

  it('truncates by lexical rank rather than by token count', async () => {
    const long = 'budget '.repeat(40).trim();
    const blocks = [block('blk-long', `${long} and nothing else`), block('blk-short', 'budget')];
    const bounded = await provider(1).getCandidates(providerRequest({ query: 'budget', blocks }));
    const full: readonly CandidateBlock[] = await provider(2).getCandidates(
      providerRequest({ query: 'budget', blocks }),
    );
    expect(bounded.map((candidate) => candidate.block.id)).toEqual([full[0]?.block.id]);
  });
});

describe('INV-PROV-001: every result resolves to a request block', () => {
  it('returns blocks whose content, token count, and metadata are exactly the request values', async () => {
    const original = block('blk-exact', 'The reticulator entry.', {
      priority: 42,
      category: 'notes',
      headingPath: ['Top'],
      metadata: { origin: 'fixture', nested: { keep: true } },
    });
    const [candidate] = await provider(5).getCandidates(
      providerRequest({ query: 'reticulator', blocks: [original] }),
    );
    expect(candidate?.block).toStrictEqual(original);
    expect(candidate?.block.tokenCount).toBe(original.tokenCount);
    expect(candidate?.block.normalizedContentHash).toBe(original.normalizedContentHash);
    expect(candidate?.block.metadata).toStrictEqual({ origin: 'fixture', nested: { keep: true } });
  });

  it('returns a subset of the request corpus and nothing else', async () => {
    const corpusIds = new Set(CORPUS.map((entry) => String(entry.id)));
    for (const query of ['budget', 'reticulator', 'трассировку', 'block']) {
      for (const id of await idsFor(query, CORPUS)) expect(corpusIds.has(id)).toBe(true);
    }
  });
});

import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MiniSearchCandidateProvider,
  MiniSearchCandidateProviderError,
} from '@ctxalloc/adapters';
import MiniSearch from 'minisearch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { block, providerRequest } from './minisearch-fixtures.js';

/**
 * The explicit search mode, and the raw score it produces (DEC-041).
 *
 * Phase 18 promises a stable, explicit retrieval mode. Three of its four
 * settings — term combination, prefix, fuzzy — and the BM25+ parameters are also
 * MiniSearch 7.2.0's own defaults, so stating them changes no score. They are
 * stated because a mode assembled from library defaults is stable only until the
 * library changes one, and this suite pins both halves of that claim: the mode is
 * what the adapter says it is, and saying it changed nothing.
 */

function provider(maxCandidates = 10): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates });
}

/** Only term A, only term B, and both — the three cases a combiner separates. */
const OR_CORPUS = [
  block('blk-alpha', 'alpha only here'),
  block('blk-beta', 'beta only here'),
  block('blk-both', 'alpha beta together'),
];

describe('terms are combined with OR', () => {
  it('returns blocks matching either term, not only blocks matching all of them', async () => {
    // Under AND this would return `blk-both` alone. OR is deliberate: a longer
    // query must not retrieve strictly less.
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha beta', blocks: OR_CORPUS }),
    );
    expect(new Set(got.map((candidate) => candidate.block.id))).toEqual(
      new Set(['blk-alpha', 'blk-beta', 'blk-both']),
    );
  });

  it('ranks the block matching both terms above the blocks matching one', async () => {
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha beta', blocks: OR_CORPUS }),
    );
    expect(got[0]?.block.id).toBe('blk-both');
    const both = got[0]?.retrieval?.score?.value ?? 0;
    for (const candidate of got.slice(1)) {
      expect(candidate.retrieval?.score?.value ?? 0).toBeLessThan(both);
    }
  });

  it('still returns a single-term query’s only match', async () => {
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha', blocks: OR_CORPUS }),
    );
    expect(new Set(got.map((candidate) => candidate.block.id))).toEqual(
      new Set(['blk-alpha', 'blk-both']),
    );
  });
});

describe('the published score is the library’s raw score, unchanged', () => {
  /**
   * The same corpus and query, run directly against the pinned library with no
   * options at all.
   *
   * This is the control: it is what the adapter produced before the search mode
   * was made explicit. If stating `combineWith`, `prefix`, `fuzzy`, or the BM25+
   * parameters had altered anything, these numbers would diverge.
   */
  function libraryScores(query: string, docs: readonly { id: string; content: string }[]) {
    const index = new MiniSearch<{ id: string; content: string }>({
      idField: 'id',
      fields: ['content'],
      storeFields: [],
    });
    index.addAll([...docs]);
    return new Map(index.search(query).map((result) => [String(result.id), result.score]));
  }

  it.each([
    ['alpha beta', OR_CORPUS],
    ['alpha', OR_CORPUS],
    [
      'budget allocation',
      [
        block('blk-1', 'Deterministic token budget allocation resolves required blocks first.'),
        block('blk-2', 'A budget reserve is subtracted before selection.'),
        block('blk-3', 'Ferries leave the harbour at noon.'),
      ],
    ],
  ])('publishes exactly the library score for %s', async (query, corpus) => {
    const expected = libraryScores(
      query,
      corpus.map((entry) => ({ id: String(entry.id), content: entry.content })),
    );
    const got = await provider().getCandidates(providerRequest({ query, blocks: corpus }));

    expect(got.length).toBe(expected.size);
    for (const candidate of got) {
      // Byte-for-byte: no clamping, no rescaling, no rounding, no transform.
      expect(candidate.retrieval?.score?.value).toBe(expected.get(String(candidate.block.id)));
    }
  });

  it('is unbounded above rather than confined to [0, 1]', async () => {
    // The concrete reason a normalization rule's min/max cannot be "the
    // provider's documented range": there is no finite maximum to document.
    const dense = block('blk-dense', `${'reticulator '.repeat(30).trim()} tail`);
    const got = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: [dense, block('blk-x', 'unrelated')] }),
    );
    expect(got[0]?.retrieval?.score?.value ?? 0).toBeGreaterThan(1);
  });
});

describe('INV-SEC-001: a dependency-owned result identifier is never published', () => {
  /**
   * The real library only ever returns identifiers it was given, so the
   * malformed-result branches have no natural input. They are exercised through
   * the one seam that exists — the `search` method the adapter calls — rather
   * than by adding a public dependency-result payload to the adapter just to make
   * them testable.
   *
   * The spy is restored after every case, and the vitest alias makes this the
   * same module instance the adapter loads.
   */
  const FOREIGN_ID = 'CANARY-FOREIGN-RESULT-ID-7B2E';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function failureFrom(
    results: readonly unknown[],
  ): Promise<MiniSearchCandidateProviderError> {
    vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue(results as never);
    try {
      await provider().getCandidates(providerRequest({ query: 'alpha', blocks: OR_CORPUS }));
    } catch (cause) {
      if (cause instanceof MiniSearchCandidateProviderError) return cause;
      throw cause;
    }
    throw new Error('expected the hostile result to be rejected');
  }

  it('rejects an unknown result identifier without copying it anywhere', async () => {
    const error = await failureFrom([{ id: FOREIGN_ID, score: 1 }]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK');
    // The public `blockId` is documented as a caller-owned value. An identifier
    // the request corpus does not contain is not one, so it is left empty.
    expect(error.blockId).toBe('');
    expect(error.message).not.toContain(FOREIGN_ID);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(FOREIGN_ID);
  });

  it.each([
    ['a non-string id', [{ id: 42, score: 1 }]],
    ['an empty id', [{ id: '', score: 1 }]],
    ['no id at all', [{ score: 1 }]],
  ])('rejects %s with an empty blockId', async (_label, results) => {
    const error = await failureFrom(results);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK');
    expect(error.blockId).toBe('');
  });

  it('names a block on a bad score only because the identifier is already proven', async () => {
    // `blk-alpha` is in the request corpus, so reporting it discloses nothing the
    // caller does not already hold.
    const error = await failureFrom([{ id: 'blk-alpha', score: Number.NaN }]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE');
    expect(error.blockId).toBe('blk-alpha');
  });

  it('reports an unknown identifier before a bad score, so the unknown id stays unpublished', async () => {
    // Order matters: resolution happens first, so a result that is both unknown
    // and malformed can never reach the branch that would name it.
    const error = await failureFrom([{ id: FOREIGN_ID, score: Number.POSITIVE_INFINITY }]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK');
    expect(error.blockId).toBe('');
  });

  it('reports a result whose own reflection throws without leaking its message', async () => {
    const hostile = new Proxy(
      { id: 'blk-alpha', score: 1 },
      {
        getOwnPropertyDescriptor(inner, property) {
          if (property === 'id') throw new Error(FOREIGN_ID);
          return Reflect.getOwnPropertyDescriptor(inner, property);
        },
      },
    );
    const error = await failureFrom([hostile]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED');
    expect(error.blockId).toBe('');
    expect(error.message).not.toContain(FOREIGN_ID);
  });

  it('reports a non-array search result as a search failure', async () => {
    const error = await failureFrom({ length: 1, 0: { id: 'blk-alpha', score: 1 } } as never);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED');
  });

  it.each([
    ['zero', 0],
    ['negative zero', -0],
    ['a negative value', -1],
    ['a large negative value', -1e6],
  ])('rejects %s as a malformed score for this contract', async (_label, score) => {
    // BM25+ adds a positive floor per matched term, and a document matching no
    // term is omitted rather than returned scoring zero. A zero or negative is
    // therefore malformed output for this contract, not a weak match, and
    // publishing it would put a value under the named metric that the metric
    // cannot produce.
    const error = await failureFrom([{ id: 'blk-alpha', score }]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE');
    // The identifier is request-owned, so naming it discloses nothing new.
    expect(error.blockId).toBe('blk-alpha');
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('still rejects %s', async (_label, score) => {
    const error = await failureFrom([{ id: 'blk-alpha', score }]);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE');
  });

  it('accepts the smallest representable positive score', async () => {
    // The rule is `> 0`, not "large enough". Nothing is clamped to a floor.
    vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue([
      { id: 'blk-alpha', score: Number.MIN_VALUE },
    ] as never);
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha', blocks: OR_CORPUS }),
    );
    expect(got).toHaveLength(1);
    expect(got[0]?.retrieval?.score?.value).toBe(Number.MIN_VALUE);
  });

  it('imposes no upper bound: a very large finite score is published unchanged', async () => {
    vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue([
      { id: 'blk-alpha', score: Number.MAX_VALUE },
    ] as never);
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha', blocks: OR_CORPUS }),
    );
    expect(got[0]?.retrieval?.score?.value).toBe(Number.MAX_VALUE);
  });

  it('a real no-match query returns nothing rather than a zero-scored candidate', async () => {
    // The positivity rule and the real library agree: a non-matching block is
    // absent from the result, never present with score 0.
    const got = await provider().getCandidates(
      providerRequest({ query: 'xylophone bathysphere', blocks: OR_CORPUS }),
    );
    expect(got).toEqual([]);
  });

  it('leaves the real library untouched afterwards', async () => {
    const got = await provider().getCandidates(
      providerRequest({ query: 'alpha', blocks: OR_CORPUS }),
    );
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]?.retrieval?.providerId).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
  });
});

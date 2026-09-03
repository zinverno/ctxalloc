import { MiniSearchCandidateProvider, MiniSearchCandidateProviderError } from '@ctxalloc/adapters';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import { OTHER_SCOPE, block, document, providerRequest } from './minisearch-fixtures.js';

/**
 * Request validation, isolation, and the signals retrieval v1 must ignore
 * (DEC-041).
 *
 * The provider validates only what would otherwise reach the dependency as a raw
 * type error. It is deliberately **not** a second `CandidateValidator`: the
 * candidate schema, the scope rule, the hash rule, and the token-count rule are
 * owned by the compiler kernel, and restating them here would create a second
 * owner of one truth (INV-DEP-003).
 */

function provider(maxCandidates = 10): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates });
}

async function rejection(request: unknown): Promise<MiniSearchCandidateProviderError> {
  try {
    await provider().getCandidates(request as CandidateProviderRequest);
  } catch (cause) {
    if (cause instanceof MiniSearchCandidateProviderError) return cause;
    throw cause;
  }
  throw new Error('expected the request to be rejected');
}

const CORPUS = [
  block('blk-a', 'The reticulator calibrates the allocator.'),
  block('blk-b', 'A budget reserve is subtracted first.'),
  block('blk-c', 'Unrelated text about ferries and timetables.'),
];

describe('INV-ADAPTER-003: request validation is project-owned', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'request'],
    ['an array', []],
  ])('rejects %s as a request', async (_label, request) => {
    expect((await rejection(request)).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
  });

  it('reports every failure as a rejected promise, never a synchronous throw', () => {
    // The port declares a `Promise`, so a caller who only attaches a `catch`
    // must still see the failure.
    let threw = false;
    let promise: Promise<unknown> | undefined;
    try {
      promise = provider().getCandidates(null as unknown as CandidateProviderRequest);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    return expect(promise).rejects.toBeInstanceOf(MiniSearchCandidateProviderError);
  });

  it('rejects an unknown request field', async () => {
    const error = await rejection({ ...providerRequest({ query: 'a', blocks: CORPUS }), topK: 3 });
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    expect(error.message).toContain('topK');
  });

  it.each([
    ['a number', 7],
    ['null', null],
    ['an object', {}],
    ['an array', ['a']],
  ])('rejects a query that is %s', async (_label, query) => {
    const request = { ...providerRequest({ query: 'a', blocks: CORPUS }), query };
    expect((await rejection(request)).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
  });

  it('INV-BLOCK-007: rejects a query containing a lone UTF-16 surrogate', async () => {
    // A lone surrogate has no UTF-8 encoding, so it describes text no corpus can
    // hold. It is rejected rather than searched or repaired.
    const request = {
      ...providerRequest({ query: 'a', blocks: CORPUS }),
      query: 'bad \uD800 half',
    };
    const error = await rejection(request);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    expect(error.message).toContain('UTF-16');
  });

  it('accepts a well-formed supplementary-plane query', async () => {
    const corpus = [block('blk-emoji', 'The 🧮 abacus block counts things.')];
    const got = await provider().getCandidates(
      providerRequest({ query: '🧮 abacus', blocks: corpus }),
    );
    expect(got.map((candidate) => candidate.block.id)).toEqual(['blk-emoji']);
  });

  it.each([
    ['blocks', 'blocks'],
    ['sourceDocuments', 'sourceDocuments'],
  ])('rejects a %s field that is not an array', async (_label, field) => {
    const request = { ...providerRequest({ query: 'a', blocks: CORPUS }), [field]: {} };
    expect((await rejection(request)).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', 'tenant'],
    ['missing tenantId', { workspaceId: 'w' }],
    ['a blank workspaceId', { tenantId: 't', workspaceId: '   ' }],
  ])('INV-SCOPE-001: rejects a scope that is %s', async (_label, scope) => {
    const request = { ...providerRequest({ query: 'a', blocks: CORPUS }), scope };
    expect((await rejection(request)).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
  });

  it('rejects a block with no usable identifier or no string content', async () => {
    for (const bad of [{ content: 'x' }, { id: '', content: 'x' }, { id: 'b', content: 42 }]) {
      const request = providerRequest({ query: 'x', blocks: [bad as never] });
      expect((await rejection(request)).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    }
  });

  it('INV-BLOCK-002: rejects duplicate block identifiers rather than overwriting one', async () => {
    // A prepared corpus has unique identifiers, but this provider is public, and
    // a silent overwrite would turn two distinct blocks into one and lose the
    // other without a word.
    const request = providerRequest({
      query: 'reticulator',
      blocks: [block('blk-same', 'first reticulator text'), block('blk-same', 'second one')],
    });
    const error = await rejection(request);
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_DUPLICATE_BLOCK_ID');
    expect(error.blockId).toBe('blk-same');
  });

  it('INV-SEC-001: no failure discloses the query or any block content', async () => {
    const secretQuery = 'CLASSIFIED-QUERY-TOKEN';
    const secretContent = 'CLASSIFIED-CONTENT-TOKEN inside a block';
    const error = await rejection({
      ...providerRequest({
        query: secretQuery,
        blocks: [block('blk-x', secretContent), block('blk-x', secretContent)],
      }),
      unexpected: 1,
    });
    expect(error.message).not.toContain(secretQuery);
    expect(error.message).not.toContain('CLASSIFIED-CONTENT-TOKEN');
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('CLASSIFIED');
  });
});

describe('empty corpus and blank query', () => {
  it('returns an empty result for an empty corpus', async () => {
    await expect(
      provider().getCandidates(providerRequest({ query: 'a', blocks: [] })),
    ).resolves.toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['a single space', ' '],
    ['whitespace only', '\n\t  '],
  ])('returns an empty result for a query that is %s', async (_label, query) => {
    // `LocalCompilationRequest` permits a blank query, so failing on one would
    // break a request the public contract accepts. Proposing nothing is the
    // truthful answer to "what matches this?".
    await expect(
      provider().getCandidates(providerRequest({ query, blocks: CORPUS })),
    ).resolves.toEqual([]);
  });
});

describe('INV-ADAPTER-004: the provider mutates nothing it is given', () => {
  const richBlock = block('blk-rich', 'The reticulator entry with annotations.', {
    headingPath: ['A', 'B'],
    priority: 300,
    category: 'notes',
    required: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    metadata: { origin: 'fixture' },
  });

  it('leaves the request, its blocks, its metadata, and its documents byte-identical', async () => {
    const documents = [document('doc:main', 'main'), document('doc:other', 'other')];
    const blocks = [richBlock, ...CORPUS];
    const request = providerRequest({ query: 'reticulator', blocks, sourceDocuments: documents });
    const before = JSON.stringify(request);

    await provider().getCandidates(request);

    expect(JSON.stringify(request)).toBe(before);
  });

  it('returns the exact request block value, carried by reference', async () => {
    const request = providerRequest({ query: 'annotations', blocks: [richBlock, ...CORPUS] });
    const [candidate] = await provider().getCandidates(request);
    // Identity, not merely equality: nothing was copied, rebuilt, or recomputed,
    // so content, hash, token count, attributes, and metadata cannot have drifted.
    expect(candidate?.block).toBe(richBlock);
    expect(candidate?.block.content).toBe(richBlock.content);
    expect(candidate?.block.tokenCount).toBe(richBlock.tokenCount);
    expect(candidate?.block.normalizedContentHash).toBe(richBlock.normalizedContentHash);
    expect(candidate?.block.metadata).toEqual({ origin: 'fixture' });
  });
});

describe('INV-DET-004: retrieval v1 ranks on lexical relevance alone', () => {
  const ranked = async (blocks: readonly ReturnType<typeof block>[], referenceTime?: string) =>
    (
      await provider().getCandidates(
        providerRequest({
          query: 'budget allocation',
          blocks,
          ...(referenceTime === undefined ? {} : { referenceTime }),
        }),
      )
    ).map((candidate) => [candidate.block.id, candidate.retrieval?.score?.value] as const);

  const plain = [
    block('blk-1', 'Budget allocation resolves required blocks first.'),
    block('blk-2', 'Allocation of the budget happens after scoring.'),
    block('blk-3', 'Ferries leave the harbour at noon.'),
  ];

  it('does not use referenceTime', async () => {
    expect(await ranked(plain, '2026-06-01T12:00:00.000Z')).toEqual(
      await ranked(plain, '1999-01-01T00:00:00.000Z'),
    );
  });

  it('does not use createdAt or updatedAt', async () => {
    const dated = [
      block('blk-1', 'Budget allocation resolves required blocks first.', {
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
      block('blk-2', 'Allocation of the budget happens after scoring.', {
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
      block('blk-3', 'Ferries leave the harbour at noon.'),
    ];
    expect(await ranked(dated)).toEqual(await ranked(plain));
  });

  it('does not use priority, category, or required status', async () => {
    const annotated = [
      block('blk-1', 'Budget allocation resolves required blocks first.', {
        priority: 1,
        category: 'low',
      }),
      block('blk-2', 'Allocation of the budget happens after scoring.', {
        priority: 1000,
        category: 'high',
        required: true,
      }),
      block('blk-3', 'Ferries leave the harbour at noon.', { priority: 999, required: true }),
    ];
    expect(await ranked(annotated)).toEqual(await ranked(plain));
  });

  it('does not index headingPath, source identity, or block metadata', async () => {
    // The query terms appear only in the annotations, never in the content, so a
    // provider that indexed them would return a hit here.
    const decorated = [
      block('blk-h', 'Ferries leave the harbour at noon.', {
        headingPath: ['Budget', 'Allocation'],
        sourceDocumentId: 'doc:budget-allocation',
        category: 'budget allocation',
        metadata: { title: 'budget allocation' },
      }),
    ];
    expect(
      await provider().getCandidates(providerRequest({ query: 'budget', blocks: decorated })),
    ).toEqual([]);
  });

  it('INV-SCOPE-005: searches only the corpus it was given', async () => {
    // Two scopes with lexically identical blocks. Neither call can reach the
    // other's corpus, because neither call has ever seen it.
    const corpusA = [block('blk-a-1', 'The reticulator lives in workspace A.')];
    const corpusB = [
      block('blk-b-1', 'The reticulator lives in workspace B.', { scope: OTHER_SCOPE }),
    ];

    const fromA = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: corpusA }),
    );
    const fromB = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: corpusB, scope: OTHER_SCOPE }),
    );

    expect(fromA.map((candidate) => candidate.block.id)).toEqual(['blk-a-1']);
    expect(fromB.map((candidate) => candidate.block.id)).toEqual(['blk-b-1']);
  });
});

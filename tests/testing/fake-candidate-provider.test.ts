import {
  ContextBlockSchema,
  calculateNormalizedContentHash,
  parseOrThrow,
  type ContextBlock,
  type Scope,
  type Timestamp,
} from '@ctxalloc/domain';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import { FakeCandidateProvider, FakeCandidateProviderError } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

const SCOPE: Scope = { tenantId: 'local', workspaceId: 'default' };
const REFERENCE_TIME = '2026-06-01T12:00:00.000Z' as Timestamp;

function block(id: string, content: string): ContextBlock {
  return parseOrThrow(ContextBlockSchema, {
    id,
    schemaVersion: 1,
    scope: { ...SCOPE },
    sourceDocumentId: 'doc-1',
    sourceType: 'markdown',
    content,
    normalizedContentHash: calculateNormalizedContentHash(content),
    tokenCount: content.split(/\s+/).filter((word) => word.length > 0).length,
    attributes: {},
    metadata: {},
  });
}

const BLOCKS = [
  block('block-a', 'alpha content about budgets'),
  block('block-b', 'beta content about traces'),
  block('block-c', 'gamma content about scope'),
];

function request(overrides: Partial<CandidateProviderRequest> = {}): CandidateProviderRequest {
  return {
    scope: SCOPE,
    query: 'budgets',
    referenceTime: REFERENCE_TIME,
    sourceDocuments: [],
    blocks: BLOCKS,
    ...overrides,
  };
}

describe('FakeCandidateProvider', () => {
  it('proposes every block once, in corpus order, by default', async () => {
    const candidates = await new FakeCandidateProvider().getCandidates(request());
    expect(candidates.map((candidate) => candidate.block.id)).toEqual([
      'block-a',
      'block-b',
      'block-c',
    ]);
    expect(candidates.every((candidate) => candidate.schemaVersion === 1)).toBe(true);
    expect(candidates.every((candidate) => candidate.retrieval === undefined)).toBe(true);
  });

  it('proposes exactly the configured identifiers, in exactly that order', async () => {
    const provider = new FakeCandidateProvider({ blockIds: ['block-c', 'block-a'] });
    const candidates = await provider.getCandidates(request());
    expect(candidates.map((candidate) => candidate.block.id)).toEqual(['block-c', 'block-a']);
  });

  it('emits repeated wrappers for one block when a deduplication test asks for them', async () => {
    const provider = new FakeCandidateProvider({
      blockIds: ['block-a'],
      repeatBlockIds: ['block-a', 'block-a'],
    });
    const candidates = await provider.getCandidates(request());
    expect(candidates.map((candidate) => candidate.block.id)).toEqual([
      'block-a',
      'block-a',
      'block-a',
    ]);
  });

  it('carries exactly the retrieval evidence a test supplies, and invents none', async () => {
    const provider = new FakeCandidateProvider({
      retrieval: {
        'block-a': {
          providerId: 'test-provider',
          providerVersion: '9',
          rank: 0,
          score: { value: 0.75, semantics: 'cosine-similarity', higherIsBetter: true },
        },
      },
    });
    const candidates = await provider.getCandidates(request());
    expect(candidates[0]?.retrieval).toEqual({
      providerId: 'test-provider',
      providerVersion: '9',
      rank: 0,
      score: { value: 0.75, semantics: 'cosine-similarity', higherIsBetter: true },
    });
    expect(candidates[1]?.retrieval).toBeUndefined();
    expect(candidates[2]?.retrieval).toBeUndefined();
  });

  it('INV-DEP-003: applies no query heuristic — the query never changes the result', async () => {
    const provider = new FakeCandidateProvider();
    const forBudgets = await provider.getCandidates(request({ query: 'budgets' }));
    const forNonsense = await provider.getCandidates(request({ query: 'zzzz-unrelated' }));
    const forEmpty = await provider.getCandidates(request({ query: '' }));

    const ids = (candidates: readonly { block: ContextBlock }[]): string[] =>
      candidates.map((candidate) => String(candidate.block.id));
    expect(ids(forBudgets)).toEqual(ids(forNonsense));
    expect(ids(forBudgets)).toEqual(ids(forEmpty));
  });

  it('INV-ADAPTER-002: carries blocks by reference and rewrites nothing', async () => {
    const candidates = await new FakeCandidateProvider().getCandidates(request());
    candidates.forEach((candidate, index) => {
      expect(candidate.block).toBe(BLOCKS[index]);
    });
  });

  it('INV-ADAPTER-003: fails explicitly for a block the corpus does not contain', async () => {
    const provider = new FakeCandidateProvider({ blockIds: ['block-missing'] });
    await expect(provider.getCandidates(request())).rejects.toBeInstanceOf(
      FakeCandidateProviderError,
    );
    await expect(provider.getCandidates(request())).rejects.toMatchObject({
      code: 'FAKE_CANDIDATE_PROVIDER_UNKNOWN_BLOCK',
      blockId: 'block-missing',
    });
  });

  it('copies its configuration, so a later mutation cannot change behavior', async () => {
    const blockIds = ['block-a'];
    const provider = new FakeCandidateProvider({ blockIds });
    blockIds.push('block-b');

    const candidates = await provider.getCandidates(request());
    expect(candidates.map((candidate) => candidate.block.id)).toEqual(['block-a']);
  });

  it('INV-DET-001: returns identical results for repeated identical requests', async () => {
    const provider = new FakeCandidateProvider({ blockIds: ['block-b', 'block-a'] });
    const first = await provider.getCandidates(request());
    const second = await provider.getCandidates(request());
    expect(first).toEqual(second);
  });
});

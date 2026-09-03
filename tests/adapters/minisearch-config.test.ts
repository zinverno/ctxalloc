import {
  MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION,
  MiniSearchCandidateProvider,
  MiniSearchCandidateProviderError,
} from '@ctxalloc/adapters';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';

/**
 * The provider configuration is a runtime boundary (DEC-041).
 *
 * The constructor takes `unknown` because configuration routinely arrives from a
 * file, an environment, or another language, where the compile-time type proves
 * nothing (INV-BLOCK-005). Nothing is defaulted, coerced, or discovered.
 */

function construct(config: unknown): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider(config);
}

function rejection(config: unknown): MiniSearchCandidateProviderError {
  try {
    construct(config);
  } catch (cause) {
    if (cause instanceof MiniSearchCandidateProviderError) return cause;
    throw cause;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('INV-BLOCK-005: MiniSearchCandidateProvider configuration', () => {
  it('accepts exactly the two documented fields', () => {
    const provider = construct({ schemaVersion: 1, maxCandidates: 5 });
    expect(provider.id).toBe('ctxalloc-minisearch-bm25');
    expect(provider.version).toBe('1+minisearch@7.2.0');
  });

  it('publishes schema version 1', () => {
    expect(MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'config'],
    ['a number', 1],
    ['an array', [{ schemaVersion: 1, maxCandidates: 5 }]],
  ])('rejects %s as a configuration', (_label, config) => {
    expect(rejection(config).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // A misspelled bound is a bound the caller believes they set and did not.
    const error = rejection({ schemaVersion: 1, maxCandidates: 5, maxCandidate: 9 });
    expect(error.code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
    expect(error.message).toContain('maxCandidate');
  });

  it('rejects a field that configures behavior this provider does not have', () => {
    for (const extra of [
      { embeddingModel: 'e5' },
      { rerankModel: 'bge' },
      { queryExpansion: true },
      { semanticWeight: 0.5 },
      { hybridWeight: 0.5 },
      { endpoint: 'https://example.test' },
      { apiKey: 'secret' },
      { indexPath: '/tmp/index.sqlite' },
      { fuzzy: 0.2 },
      { prefix: true },
    ]) {
      expect(rejection({ schemaVersion: 1, maxCandidates: 5, ...extra }).code).toBe(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
      );
    }
  });

  it.each([
    ['an absent schemaVersion', { maxCandidates: 5 }],
    ['a wrong schemaVersion', { schemaVersion: 2, maxCandidates: 5 }],
    ['a string schemaVersion', { schemaVersion: '1', maxCandidates: 5 }],
  ])('requires schemaVersion to be exactly 1: %s', (_label, config) => {
    expect(rejection(config).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
  });

  it.each([
    ['absent', { schemaVersion: 1 }],
    ['zero', { schemaVersion: 1, maxCandidates: 0 }],
    ['negative', { schemaVersion: 1, maxCandidates: -1 }],
    ['fractional', { schemaVersion: 1, maxCandidates: 1.5 }],
    ['unsafe', { schemaVersion: 1, maxCandidates: Number.MAX_SAFE_INTEGER + 2 }],
    ['NaN', { schemaVersion: 1, maxCandidates: Number.NaN }],
    ['Infinity', { schemaVersion: 1, maxCandidates: Number.POSITIVE_INFINITY }],
    ['a numeric string', { schemaVersion: 1, maxCandidates: '5' }],
    ['a boolean', { schemaVersion: 1, maxCandidates: true }],
  ])('requires maxCandidates to be a positive safe integer: %s', (_label, config) => {
    // Zero is rejected too: a provider that proposes nothing while looking
    // configured is worse than one that refuses to be built.
    expect(rejection(config).code).toBe('MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
  });

  it('accepts one as the smallest usable bound', () => {
    expect(construct({ schemaVersion: 1, maxCandidates: 1 }).id).toBe('ctxalloc-minisearch-bm25');
  });

  it('does not coerce or mutate the configuration object it was given', () => {
    const config = { schemaVersion: 1, maxCandidates: 5 };
    const before = JSON.stringify(config);
    construct(config);
    expect(JSON.stringify(config)).toBe(before);
    expect(Object.keys(config)).toEqual(['schemaVersion', 'maxCandidates']);
  });

  it('is unaffected by a later mutation of the configuration object', async () => {
    const config = { schemaVersion: 1, maxCandidates: 1 };
    const provider = construct(config);
    (config as { maxCandidates: number }).maxCandidates = 10;
    const candidates = await provider.getCandidates({
      scope: { tenantId: 'a', workspaceId: 'b' },
      query: 'alpha',
      referenceTime: '2026-06-01T12:00:00.000Z',
      sourceDocuments: [],
      blocks: [
        { id: 'b1', content: 'alpha one' },
        { id: 'b2', content: 'alpha two' },
      ],
    } as unknown as CandidateProviderRequest);
    expect(candidates).toHaveLength(1);
  });
});

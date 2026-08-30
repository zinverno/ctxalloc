import type { Tokenizer } from '@ctxalloc/ports';
import { calculateNormalizedContentHash } from '../../packages/domain/src/index.js';

/**
 * Shared fixtures for the candidate validation tests.
 *
 * Fixtures are deliberately untyped plain objects: `CandidateValidator.validate`
 * accepts `unknown`, so the tests exercise the same runtime path that persisted,
 * transported, and adapter-built batches will take (INV-BLOCK-005).
 *
 * Hashes are computed with the real domain helper rather than hard-coded, so a
 * fixture can never claim a hash the canonical rule would not produce, unless a
 * test supplies a deliberately wrong one. Nothing here reads the clock, the
 * filesystem, the environment, or the network.
 */

export const SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

export const DEFAULT_CONTENT = 'The compiler selects final context.';

/** A well-formed `SourceDocument.contentHash`, unrelated to any block content. */
export const SOURCE_CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

/** One token per whitespace-separated word: predictable and genuinely a Tokenizer. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

export const wordTokenizer: Tokenizer = {
  id: 'test:word',
  version: '1',
  countTokens: countWords,
};

/** A tokenizer that always throws, to prove failures are wrapped, not leaked. */
export class ExplodingTokenizerError extends Error {
  readonly libraryDetail = 'internal encoder state';

  constructor() {
    super('encoder exploded');
    this.name = 'ExplodingTokenizerError';
  }
}

export const explodingTokenizer: Tokenizer = {
  id: 'test:exploding',
  version: '1',
  countTokens: (): number => {
    throw new ExplodingTokenizerError();
  },
};

/** A tokenizer that returns one fixed, deliberately unusable value. */
export function brokenTokenizer(value: unknown): Tokenizer {
  return { id: 'test:broken', version: '1', countTokens: (): number => value as number };
}

/** A tokenizer that records every text it was asked to count. */
export function countingTokenizer(calls: string[]): Tokenizer {
  return {
    id: 'test:counting',
    version: '1',
    countTokens: (text: string): number => {
      calls.push(text);
      return countWords(text);
    },
  };
}

export function sourceDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'doc-1',
    schemaVersion: 1,
    scope: { ...SCOPE },
    sourceType: 'markdown',
    contentHash: SOURCE_CONTENT_HASH,
    metadata: {},
    ...overrides,
  };
}

/**
 * A `ContextBlock` whose hash and token count are correct by construction.
 *
 * `content` is read from the overrides before the derived fields are computed, so
 * a test that changes the content still gets a consistent record; a test that
 * wants a stale record overrides `normalizedContentHash` or `tokenCount`
 * explicitly.
 */
export function contextBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = typeof overrides['content'] === 'string' ? overrides['content'] : DEFAULT_CONTENT;
  // The canonical hash is derived only when the test did not supply one, so a
  // fixture built from deliberately malformed content still reaches the
  // validator instead of failing inside the fixture.
  const derived =
    'normalizedContentHash' in overrides
      ? {}
      : { normalizedContentHash: calculateNormalizedContentHash(content) };
  return {
    id: 'block-1',
    schemaVersion: 1,
    scope: { ...SCOPE },
    sourceDocumentId: 'doc-1',
    sourceType: 'markdown',
    sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: content.length },
    content,
    ...derived,
    tokenCount: countWords(content),
    attributes: {},
    metadata: {},
    ...overrides,
  };
}

export function candidate(
  blockOverrides: Record<string, unknown> = {},
  retrieval?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    block: contextBlock(blockOverrides),
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

export function retrieval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { providerId: 'sqlite-fts5', providerVersion: '1.2.3', ...overrides };
}

export function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: { ...SCOPE },
    sourceDocuments: [sourceDocument()],
    candidates: [candidate()],
    ...overrides,
  };
}

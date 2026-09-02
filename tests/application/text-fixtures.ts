import {
  TextChunker,
  ingestSource,
  type IngestedSource,
  type TextChunkingOptions,
} from '@ctxalloc/application';
import type { Tokenizer } from '@ctxalloc/ports';

/**
 * Shared fixtures for the plain-text chunking tests (DEC-039).
 *
 * Sources are built through the real `ingestSource`, so every fixture carries a
 * genuine document identity and a genuine content hash rather than a hand-written
 * one that the chunker's own validation would have to be weakened to accept.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network.
 */

export const SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;

/** One token per whitespace-separated word: predictable and genuinely a Tokenizer. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

export const wordTokenizer: Tokenizer = {
  id: 'test:word',
  version: '1',
  countTokens: countWords,
};

/** One token per code point, so a Unicode boundary test can control exact counts. */
export const codePointTokenizer: Tokenizer = {
  id: 'test:code-point',
  version: '1',
  countTokens: (text: string): number => [...text].length,
};

/**
 * A tokenizer whose counts do not grow monotonically with length.
 *
 * A substring ending in `MERGE` counts as one token however long it is, which is
 * what a subword vocabulary can genuinely do. A chunker that stopped scanning
 * after the first overflowing candidate would never find the longer fitting one.
 */
export const nonMonotonicTokenizer: Tokenizer = {
  id: 'test:non-monotonic',
  version: '1',
  countTokens: (text: string): number => (text.trimEnd().endsWith('MERGE') ? 1 : countWords(text)),
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

/** Ingests one plain-text source through the real use case. */
export function textSource(
  content: string,
  overrides: Record<string, unknown> = {},
): IngestedSource {
  return ingestSource({
    scope: { ...SCOPE },
    sourceType: 'text',
    identity: { namespace: 'vault:notes', key: 'notes.txt' },
    content,
    metadata: {},
    ...overrides,
  });
}

/** Chunks one plain-text string with the word tokenizer and the supplied policy. */
export function chunkText(
  content: string,
  options: TextChunkingOptions = { targetTokens: 20, maxTokens: 40 },
  tokenizer: Tokenizer = wordTokenizer,
  sourceOverrides: Record<string, unknown> = {},
): ReturnType<TextChunker['chunk']> {
  return new TextChunker(tokenizer, options).chunk(textSource(content, sourceOverrides));
}

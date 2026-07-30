import { ingestSource, type IngestedSource } from '@ctxalloc/application';
import type { Tokenizer } from '@ctxalloc/ports';
import type { ContextBlock, TextRangeLocation } from '../../packages/domain/src/index.js';

/**
 * Shared fixtures for the Markdown chunking tests.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network.
 * Sources are built through the real `ingestSource`, so every fixture carries a
 * genuine `contentHash` and the chunker is exercised against the same records
 * Phase 5 actually produces.
 */

/**
 * One token per Unicode code point.
 *
 * A real tokenizer's boundaries are opaque, which makes an assertion about *where*
 * a split happened unreadable. This double keeps token counts exactly predictable
 * while still being a genuine `Tokenizer`: the chunker cannot tell it apart from
 * any other implementation, and an emoji stays one indivisible token, which is
 * what the surrogate-pair tests need.
 */
export const codePointTokenizer: Tokenizer = {
  id: 'test:code-point',
  version: '1',
  countTokens: (text: string): number => [...text].length,
};

/** One token per whitespace-separated word, for grouping tests that read in words. */
export const wordTokenizer: Tokenizer = {
  id: 'test:word',
  version: '1',
  countTokens: (text: string): number => {
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    return words.length;
  },
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

/** Builds a tokenizer that returns one fixed, deliberately unusable value. */
export function brokenTokenizer(value: number): Tokenizer {
  return { id: 'test:broken', version: '1', countTokens: (): number => value };
}

/**
 * A tokenizer whose counts come from an exact-text table, with a fallback.
 *
 * It is fully deterministic and returns finite non-negative integers, so it
 * satisfies the `Tokenizer` port, but its counts are deliberately **not**
 * monotonic in the length of the text: a longer string may cost fewer tokens than
 * a shorter one. Real subword tokenizers can behave this way when extending a
 * string lets tokens merge, and the port never promises monotonicity, so the
 * chunker must not assume it.
 */
export function scriptedTokenizer(
  counts: Readonly<Record<string, number>>,
  fallback: number,
): Tokenizer {
  const table = new Map<string, number>(Object.entries(counts));
  return {
    id: 'test:scripted',
    version: '1',
    countTokens: (text: string): number => table.get(text) ?? fallback,
  };
}

export interface SourceOverrides {
  readonly title?: string;
  readonly sourceType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly key?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly projectId?: string;
}

/** A validated Markdown `IngestedSource` for `content`. */
export function markdownSource(content: string, overrides: SourceOverrides = {}): IngestedSource {
  const { title, sourceType, metadata, key, createdAt, updatedAt, projectId } = overrides;
  return ingestSource({
    scope: {
      tenantId: 'local',
      workspaceId: 'default',
      ...(projectId !== undefined ? { projectId } : {}),
    },
    sourceType: sourceType ?? 'markdown',
    identity: { namespace: 'vault:notes', key: key ?? 'note.md' },
    content,
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    metadata: metadata ?? {},
  });
}

/** The block's text range. Every Markdown block is required to carry one. */
export function range(block: ContextBlock): TextRangeLocation {
  const location = block.sourceLocation;
  if (location === undefined || location.kind !== 'text-range') {
    throw new Error(`Expected a text-range location, received ${String(location?.kind)}`);
  }
  return location;
}

/** True when `value` contains a UTF-16 code unit that is not part of a valid pair. */
export function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** True when `offset` falls between the two halves of one surrogate pair. */
export function isInsideSurrogatePair(content: string, offset: number): boolean {
  if (offset <= 0 || offset >= content.length) return false;
  const previous = content.charCodeAt(offset - 1);
  const next = content.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Builds `count` distinct space-separated words, for paragraphs that must be split. */
export function words(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
}

/**
 * Committed golden identity vectors (DEC-029).
 *
 * They pin the exact ContextBlock ID algorithm: the payload shape, its order, the
 * algorithm version, the duplicate occurrence counter, and the SHA-256
 * representation. A change to any of them breaks these vectors, which is the
 * point — block identity must never drift silently.
 *
 * `GOLDEN_SOURCE` is the source they were produced from.
 */
export const GOLDEN_SOURCE = '# Alpha\nFirst body.\n\n# Beta\nSecond body.\n';

/** The `note.md` document identity every golden vector below is derived from. */
export const GOLDEN_SOURCE_DOCUMENT_ID =
  'source-document:sha256:c6c47e476dcbeea0514fe553739db71bd4c1970ea774faaebfa561fdbd06bfcb';

export const GOLDEN_BLOCKS = [
  {
    headingPath: ['Alpha'],
    content: 'First body.',
    normalizedContentHash:
      'sha256:ff30085e1616a5a5fde4fb8f215684cf9ff5e19aee7849823aac8d29462a158e',
    id: 'context-block:sha256:9bf8803c9b3c550a2d297e0023031a6686086f13a8a9aa04b86f430037cedf5a',
  },
  {
    headingPath: ['Beta'],
    content: 'Second body.',
    normalizedContentHash:
      'sha256:1b7c2530fe0fe41892191627f1c1cb78052a3eae0ed5354c158fa4abcb0bff81',
    id: 'context-block:sha256:6f08f1fbf225fcd1a969b34d02bde6d315c8c3cf2450c58c953ac7f6a11ab392',
  },
] as const;

/** Two identical blocks under heading `Dup`: occurrence 0 and occurrence 1. */
export const GOLDEN_DUPLICATE_IDS = [
  'context-block:sha256:ba1bbaebc6ec3a1f7633afaabc1b76a102adbb8622798b4d4f9ed509a171dcd7',
  'context-block:sha256:d7fa52d2923fd7bd0c015e93598c202f2babffb7517787110e0f5990a9161a87',
] as const;

/** One block whose heading path is absent, so the payload carries `null`. */
export const GOLDEN_NULL_HEADING_PATH_ID =
  'context-block:sha256:45f9996f9a6f61f88d825f8ef42093e5136a2c8d716c49910bc52285eea997f8';

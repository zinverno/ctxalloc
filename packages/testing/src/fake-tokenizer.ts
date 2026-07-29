import type { Tokenizer } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link Tokenizer} port.
 *
 * The fake counts nothing: it returns exactly the count configured for exactly
 * the supplied text. There is no heuristic, no character or word approximation,
 * and no fallback, because an approximation would let a test pass against a
 * token count that no real tokenizer produces. Unconfigured text fails
 * explicitly (INV-ADAPTER-003) so a missing fixture is visible instead of silently
 * changing an allocation result.
 *
 * The fake reads no file, environment variable, clock, random value, or network
 * resource, which keeps core tests offline and reproducible (INV-DET-001,
 * INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'fake';
const DEFAULT_VERSION = '1';
const TEXT_PREVIEW_CODE_POINTS = 40;

/** One exact-text-to-count mapping. */
export interface FakeTokenizerEntry {
  /** Exact text, preserved byte for byte and matched exactly. */
  readonly text: string;
  /** Token count returned for `text`: a finite non-negative integer. */
  readonly tokens: number;
}

/** Optional tokenizer identity, used when a test asserts on trace identity. */
export interface FakeTokenizerOptions {
  readonly id?: string;
  readonly version?: string;
}

/** Rejected {@link FakeTokenizer} configuration. */
export class FakeTokenizerConfigurationError extends Error {
  readonly code = 'FAKE_TOKENIZER_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'FakeTokenizerConfigurationError';
  }
}

/** Lookup of text the {@link FakeTokenizer} was not configured with. */
export class FakeTokenizerUnknownTextError extends Error {
  readonly code = 'FAKE_TOKENIZER_UNKNOWN_TEXT';
  /** The exact text that was requested. */
  readonly text: string;

  constructor(message: string, text: string) {
    super(message);
    this.name = 'FakeTokenizerUnknownTextError';
    this.text = text;
  }
}

/** Bounded, code-point-safe rendering of text for an error message. */
function previewText(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= TEXT_PREVIEW_CODE_POINTS) return JSON.stringify(text);
  const head = codePoints.slice(0, TEXT_PREVIEW_CODE_POINTS).join('');
  return `${JSON.stringify(head)}... (${codePoints.length} code points)`;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.length === 0) {
    throw new FakeTokenizerConfigurationError(`FakeTokenizer ${field} must not be empty.`);
  }
  return value;
}

function requireTokenCount(tokens: number, text: string): number {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new FakeTokenizerConfigurationError(
      `FakeTokenizer count for ${previewText(text)} must be a finite non-negative integer, received ${String(tokens)}.`,
    );
  }
  return tokens;
}

export class FakeTokenizer implements Tokenizer {
  readonly id: string;
  readonly version: string;

  /**
   * A `Map` keyed by the exact text avoids the prototype-key collisions of a
   * plain object (`"__proto__"` and `"constructor"` are ordinary keys here), and
   * the entries are copied so later changes to the caller's array cannot alter
   * counting behavior.
   */
  readonly #counts: ReadonlyMap<string, number>;

  constructor(entries: readonly FakeTokenizerEntry[], options: FakeTokenizerOptions = {}) {
    this.id = requireNonEmpty(options.id ?? DEFAULT_ID, 'id');
    this.version = requireNonEmpty(options.version ?? DEFAULT_VERSION, 'version');

    const counts = new Map<string, number>();
    for (const entry of entries) {
      // A repeated key is rejected rather than resolved by first or last write:
      // either rule would make the configuration order significant.
      if (counts.has(entry.text)) {
        throw new FakeTokenizerConfigurationError(
          `FakeTokenizer received a duplicate mapping for ${previewText(entry.text)}.`,
        );
      }
      counts.set(entry.text, requireTokenCount(entry.tokens, entry.text));
    }
    this.#counts = counts;
  }

  countTokens(text: string): number {
    const tokens = this.#counts.get(text);
    if (tokens === undefined) {
      throw new FakeTokenizerUnknownTextError(
        `FakeTokenizer has no configured count for ${previewText(text)}.`,
        text,
      );
    }
    return tokens;
  }
}

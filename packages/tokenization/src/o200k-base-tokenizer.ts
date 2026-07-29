import type { Tokenizer } from '@ctxalloc/ports';
import { Tiktoken } from 'js-tiktoken/lite';
import o200kBaseRanks from 'js-tiktoken/ranks/o200k_base';

/**
 * First real offline implementation of the {@link Tokenizer} port (DEC-027).
 *
 * The adapter loads the bundled `o200k_base` rank table of `js-tiktoken` and
 * counts exact text with it. It performs no network request, reads no file at
 * runtime, consults no model registry, and maps no model name to an encoding: the
 * encoding is fixed, so a count is reproducible from the recorded tokenizer
 * identity alone (INV-DET-001, INV-TRACE-005).
 *
 * `o200k_base` is a reference encoding, not a universal one. Counts produced here
 * are valid for models that use `o200k_base` and must not be assumed valid for
 * another model family; a different family requires its own adapter or an
 * explicit mapping decision.
 *
 * The library type never crosses the port: the public surface exposes only
 * project-owned types (INV-ADAPTER-001).
 */

/** Stable tokenizer identifier recorded in a compilation trace (INV-TRACE-005). */
export const O200K_BASE_TOKENIZER_ID = 'js-tiktoken:o200k_base';

/**
 * Stable tokenizer version: the exact pinned `js-tiktoken` version.
 *
 * The value is hard-coded rather than read from a manifest at runtime, because a
 * tokenizer version is correctness data recorded in traces and must not depend on
 * the filesystem layout of an installation. A regression test asserts that it
 * still matches the pinned dependency.
 */
export const O200K_BASE_TOKENIZER_VERSION = '1.0.21';

/** Name of the token vocabulary this adapter counts with. */
export const O200K_BASE_ENCODING = 'o200k_base';

/**
 * Text that cannot be counted because it is not well-formed UTF-16.
 *
 * A lone surrogate has no UTF-8 encoding. Encoders normally substitute U+FFFD,
 * which would silently return a count for text the caller never supplied, so the
 * adapter fails instead (INV-ADAPTER-003) and leaves the input untouched
 * (INV-BLOCK-007).
 */
export class TokenizerInvalidUnicodeError extends Error {
  readonly code = 'TOKENIZER_INVALID_UNICODE';
  /** UTF-16 code unit index of the first lone surrogate. */
  readonly index: number;

  constructor(message: string, index: number) {
    super(message);
    this.name = 'TokenizerInvalidUnicodeError';
    this.index = index;
  }
}

/**
 * Unexpected failure inside the tokenizer library.
 *
 * The underlying error is preserved as `cause` for diagnosis, but its type stays
 * inside this adapter: callers see a project-owned error only (INV-ADAPTER-001).
 */
export class TokenizerEncodingFailedError extends Error {
  readonly code = 'TOKENIZER_ENCODING_FAILED';

  constructor(message: string, options: { readonly cause: unknown }) {
    super(message, options);
    this.name = 'TokenizerEncodingFailedError';
  }
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/**
 * Returns the index of the first lone UTF-16 surrogate, or `null` when the string
 * is well-formed.
 *
 * The scan walks code units rather than code points: iterating code points would
 * already have hidden the defect being looked for.
 */
function findLoneSurrogate(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < HIGH_SURROGATE_FIRST || unit > LOW_SURROGATE_LAST) continue;

    // A low surrogate reached here was not consumed as the tail of a valid pair.
    if (unit > HIGH_SURROGATE_LAST) return index;

    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
    if (next >= LOW_SURROGATE_FIRST && next <= LOW_SURROGATE_LAST) {
      index += 1;
      continue;
    }
    return index;
  }
  return null;
}

export class O200kBaseTokenizer implements Tokenizer {
  readonly id = O200K_BASE_TOKENIZER_ID;
  readonly version = O200K_BASE_TOKENIZER_VERSION;

  /**
   * One immutable encoder per tokenizer instance.
   *
   * There is no shared registry and no cache: a process-wide mutable encoder
   * would let one caller change the counts another caller observes, and a result
   * cache would hide a counting failure behind a previously stored number.
   */
  readonly #encoder: Tiktoken;

  constructor() {
    this.#encoder = new Tiktoken(o200kBaseRanks);
  }

  countTokens(text: string): number {
    const loneSurrogateIndex = findLoneSurrogate(text);
    if (loneSurrogateIndex !== null) {
      throw new TokenizerInvalidUnicodeError(
        `Text is not well-formed UTF-16: lone surrogate at code unit ${String(loneSurrogateIndex)}.`,
        loneSurrogateIndex,
      );
    }

    try {
      // Ordinary-text semantics. The first empty list allows no special token, so
      // no substring is ever promoted to a control token; the second disallows
      // none, so text that merely looks like one, such as `<|endoftext|>`, is
      // counted as the literal source text it is instead of raising an error.
      // Source content is data, never an instruction to the tokenizer
      // (INV-SEC-001).
      return this.#encoder.encode(text, [], []).length;
    } catch (cause) {
      throw new TokenizerEncodingFailedError(
        `Tokenizer ${O200K_BASE_TOKENIZER_ID} failed to encode the supplied text.`,
        { cause },
      );
    }
  }
}

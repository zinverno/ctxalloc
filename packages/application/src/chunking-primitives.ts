import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue, ValidationIssue } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';

/**
 * Chunking primitives shared by every deterministic chunker (DEC-039).
 *
 * DEC-029 established these rules for Markdown: how a source is scanned into
 * lines, how an oversized run is split at a sentence, whitespace, or whole
 * code-point boundary, how adjacent pieces are grouped toward a token target,
 * and how a block identity is derived. Phase 16 adds a plain-text chunker that
 * needs exactly the same rules, so they are owned once here instead of copied
 * into a second module where the two could silently diverge (INV-DEP-003).
 *
 * Nothing in this module is exported from the package. These are internal
 * mechanics, not a public contract: publishing them would invite a caller to
 * depend on a splitting detail that a future chunking decision may change
 * (DEC-029).
 *
 * The extraction is behavior-preserving. `MarkdownChunker` keeps its own
 * scanner, its own frontmatter, heading, section, and atomic-span rules, its own
 * option and error types, and its own block construction; only the generic
 * helpers moved, unchanged, so Markdown output, Markdown block identifiers, and
 * Markdown error messages are byte-for-byte what Phase 6 produced.
 *
 * Every function here is pure with respect to its arguments. None reads a clock,
 * a random value, the filesystem, the environment, or the network (INV-DET-001,
 * INV-DET-003, INV-DET-004).
 */

/* -------------------------------------------------------------------------- */
/* Options and dependency validation                                           */
/* -------------------------------------------------------------------------- */

/**
 * The token policy every chunker takes.
 *
 * Each chunker publishes its own named options interface with the same two
 * fields, because the two policies are configured independently and a shared
 * public type would suggest one value serves both.
 */
export interface ChunkingOptions {
  readonly targetTokens: number;
  readonly maxTokens: number;
}

/**
 * Token limits are correctness data, so a numeric string, a fraction, `NaN`,
 * `Infinity`, zero, a negative value, and a value above `Number.MAX_SAFE_INTEGER`
 * are all rejected rather than coerced (INV-BUDGET-005).
 */
const positiveSafeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value > 0, {
  message: 'must be a positive safe integer',
});

export const ChunkingOptionsSchema = z
  .strictObject({
    targetTokens: positiveSafeInteger,
    maxTokens: positiveSafeInteger,
  })
  .refine((options) => options.targetTokens <= options.maxTokens, {
    message: 'must not be greater than maxTokens',
    path: ['targetTokens'],
  });

export function issue(
  path: readonly string[],
  message: string,
  code = 'invalid_value',
): ValidationIssue {
  return { code, path, pointer: path.join('.'), message };
}

/**
 * The tokenizer arrives as an injected dependency, and its identity is copied
 * into block metadata, so its port shape is checked once at construction rather
 * than trusted from the compile-time type alone.
 */
export function validateTokenizer(tokenizer: Tokenizer): readonly ValidationIssue[] {
  if (typeof tokenizer !== 'object' || tokenizer === null) {
    return [issue(['tokenizer'], 'must be a Tokenizer', 'invalid_type')];
  }
  const issues: ValidationIssue[] = [];
  if (typeof tokenizer.id !== 'string' || tokenizer.id.trim().length === 0) {
    issues.push(issue(['tokenizer', 'id'], 'must not be empty or whitespace-only'));
  }
  if (typeof tokenizer.version !== 'string' || tokenizer.version.trim().length === 0) {
    issues.push(issue(['tokenizer', 'version'], 'must not be empty or whitespace-only'));
  }
  if (typeof tokenizer.countTokens !== 'function') {
    issues.push(issue(['tokenizer', 'countTokens'], 'must be a function', 'invalid_type'));
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Hashing and identity                                                        */
/* -------------------------------------------------------------------------- */

/** SHA-256 over the UTF-8 encoding of `text`, rendered as `sha256:<64 lowercase hex>`. */
export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Payload kind, hashed with the identity data so no other payload can collide with it. */
const CONTEXT_BLOCK_ID_PAYLOAD_KIND = 'ctxalloc-context-block-id';

/**
 * Version of the block identity algorithm, hashed with the payload.
 *
 * A change to the canonical tuple must raise this number, which makes the change
 * a visible new identity rather than a silent reinterpretation of stored blocks.
 */
const CONTEXT_BLOCK_ID_ALGORITHM_VERSION = 1;

/**
 * The canonical base payload of an extractive text block identity (DEC-029).
 *
 * It carries the source document, the heading path, and the normalized content
 * hash only. Offsets, line numbers, token counts, tokenizer identity, titles,
 * timestamps, metadata, the clock, and randomness are all absent, so a block
 * whose normalized content and heading path are unchanged keeps its identity
 * even when unrelated earlier text shifted its offsets (INV-BLOCK-001,
 * INV-DET-003).
 *
 * A plain-text block has no heading path and passes `null`, which is exactly the
 * value a Markdown block outside any heading passes.
 */
export function contextBlockIdPayload(
  sourceDocumentId: string,
  headingPath: readonly string[] | null,
  normalizedContentHash: string,
): string {
  return JSON.stringify([
    CONTEXT_BLOCK_ID_PAYLOAD_KIND,
    CONTEXT_BLOCK_ID_ALGORITHM_VERSION,
    sourceDocumentId,
    headingPath,
    normalizedContentHash,
  ]);
}

/**
 * Completes a base payload with the source-order occurrence of an identical
 * block, so duplicates inside one source stay unique (INV-BLOCK-002).
 */
export function contextBlockId(basePayload: string, occurrence: number): string {
  const base: unknown = JSON.parse(basePayload);
  const payload = JSON.stringify([...(base as unknown[]), occurrence]);
  return `context-block:${sha256(payload)}`;
}

/** Deep copy of validated JSON data, so no caller-owned object is shared or mutated. */
export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJsonValue(entry);
    return result;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Token counting                                                              */
/* -------------------------------------------------------------------------- */

/** Counts tokens of the exact candidate substring identified by a half-open range. */
export type CountSlice = (start: number, end: number) => number;

/**
 * Raises the owning chunker's own failure for a tokenizer problem.
 *
 * The message is built here so both chunkers report the same wording, and the
 * error *type* stays the caller's, so a Markdown failure is still a
 * `MarkdownChunkingError` and a text failure a `TextChunkingError`
 * (INV-ADAPTER-003).
 */
export type TokenizerFailure = (message: string, start: number, end: number) => never;

/** Wraps the tokenizer so no external error type and no unusable count escapes. */
export function sliceCounter(
  tokenizer: Tokenizer,
  content: string,
  fail: TokenizerFailure,
): CountSlice {
  return (start: number, end: number): number => {
    const text = content.slice(start, end);
    let count: number;
    try {
      count = tokenizer.countTokens(text);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      fail(
        `Tokenizer "${tokenizer.id}" failed for source range [${String(start)}, ${String(end)}): ${detail}`,
        start,
        end,
      );
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      fail(
        `Tokenizer "${tokenizer.id}" returned ${String(count)} for source range [${String(start)}, ${String(end)}): expected a non-negative safe integer`,
        start,
        end,
      );
    }
    return count;
  };
}

/* -------------------------------------------------------------------------- */
/* Source line scanning                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One physical source line.
 *
 * `contentEndOffset` excludes the line terminator and its `\r`, so a block range
 * built from line offsets is exact for both LF and CRLF sources.
 */
export interface SourceLine {
  /** Zero-based scan index. Public line numbers are one-based. */
  readonly index: number;
  readonly startOffset: number;
  readonly contentEndOffset: number;
  readonly fullEndOffset: number;
  readonly text: string;
}

const CARRIAGE_RETURN = 13;

export function scanLines(content: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const newline = content.indexOf('\n', cursor);
    const fullEndOffset = newline === -1 ? content.length : newline + 1;
    let contentEndOffset = newline === -1 ? content.length : newline;
    if (contentEndOffset > cursor && content.charCodeAt(contentEndOffset - 1) === CARRIAGE_RETURN) {
      contentEndOffset -= 1;
    }
    lines.push({
      index: lines.length,
      startOffset: cursor,
      contentEndOffset,
      fullEndOffset,
      text: content.slice(cursor, contentEndOffset),
    });
    cursor = fullEndOffset;
  }

  return lines;
}

/** One-based line number of the line containing `offset` (SourceLocationSchema requires >= 1). */
export function lineNumberAtOffset(lines: readonly SourceLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const line = lines[middle];
    if (line === undefined) break;
    if (offset < line.startOffset) high = middle - 1;
    else if (offset >= line.fullEndOffset) low = middle + 1;
    else return line.index + 1;
  }
  const fallbackIndex = Math.max(0, Math.min(lines.length - 1, high));
  return (lines[fallbackIndex]?.index ?? 0) + 1;
}

export function isBlank(line: SourceLine): boolean {
  return line.text.trim().length === 0;
}

/* -------------------------------------------------------------------------- */
/* Range splitting                                                             */
/* -------------------------------------------------------------------------- */

/** A half-open source range, addressed by offsets only. */
export interface SourceRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

/** A source range that may not be divided, whatever its token cost. */
export interface AtomicSourceRange extends SourceRange {
  readonly atomic: boolean;
}

export function isWhitespaceAt(content: string, offset: number): boolean {
  return /\s/.test(content.charAt(offset));
}

/** Largest offset `<= end` such that the slice does not end with whitespace. */
export function trimmedEnd(content: string, start: number, end: number): number {
  let result = end;
  while (result > start && isWhitespaceAt(content, result - 1)) result -= 1;
  return result;
}

/** Sentence-ending positions, after optional closing quotes or brackets, before whitespace. */
function sentenceBoundaries(content: string, start: number, end: number): readonly number[] {
  const window = content.slice(start, end);
  const boundaries: number[] = [];
  const pattern = /[.!?…](?:["'»”)\]]*)?(?=\s)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    boundaries.push(start + match.index + match[0].length);
  }
  return boundaries;
}

/** Positions where a whitespace run begins. */
function whitespaceBoundaries(content: string, start: number, end: number): readonly number[] {
  const window = content.slice(start, end);
  const boundaries: number[] = [];
  const pattern = /\s+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(window)) !== null) {
    const boundary = start + match.index;
    if (boundary > start) boundaries.push(boundary);
  }
  return boundaries;
}

interface PieceBoundary {
  /** End of the emitted piece: trailing whitespace excluded. */
  readonly endOffset: number;
  /** Where the next piece starts scanning from. */
  readonly nextCursor: number;
}

/**
 * Chooses the boundary closest to `targetTokens` among the candidates that fit.
 *
 * Every candidate is measured with the exact tokenizer over the exact substring it
 * would produce; no character-count estimate takes part in the decision.
 *
 * The scan deliberately never stops early. The `Tokenizer` port guarantees
 * deterministic exact counts, but it does not guarantee that a count grows as text
 * is extended, and a subword tokenizer can merge a longer substring into fewer
 * tokens than a shorter one. An overflowing candidate therefore says nothing about
 * a later candidate, so every candidate is evaluated rather than inferred away.
 *
 * Equal distances prefer the later boundary, so a tie never depends on iteration
 * accidents (INV-DET-005).
 */
function bestFittingBoundary(
  content: string,
  start: number,
  candidates: readonly number[],
  options: ChunkingOptions,
  countSlice: CountSlice,
): PieceBoundary | null {
  let best: PieceBoundary | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const end = trimmedEnd(content, start, candidate);
    if (end <= start) continue;
    const tokens = countSlice(start, end);
    if (tokens > options.maxTokens) continue;
    const distance = Math.abs(tokens - options.targetTokens);
    if (distance <= bestDistance) {
      best = { endOffset: end, nextCursor: candidate };
      bestDistance = distance;
    }
  }

  return best;
}

/** Width in UTF-16 code units of the code point starting at `offset`. */
function codePointWidth(content: string, offset: number): number {
  const codePoint = content.codePointAt(offset);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

/** Every whole-code-point boundary in `(start, limit]`, so no surrogate pair is divided. */
function codePointBoundaries(content: string, start: number, limit: number): readonly number[] {
  const boundaries: number[] = [];
  let cursor = start;
  while (cursor < limit) {
    cursor = Math.min(cursor + codePointWidth(content, cursor), limit);
    boundaries.push(cursor);
  }
  return boundaries;
}

/**
 * Last resort when no sentence or whitespace boundary fits.
 *
 * The candidates are whole code points, so a surrogate pair is never divided, and
 * all of them are measured: a shorter prefix that overflows never rules out a
 * longer one that fits.
 *
 * Only when no non-empty whole-code-point candidate fits `maxTokens` is the first
 * code point emitted intact, and the caller then marks the block oversized.
 * Truncating it would lose source text and cutting it would create a lone
 * surrogate (INV-BLOCK-007, INV-RENDER-005).
 */
function hardBoundary(
  content: string,
  start: number,
  limit: number,
  options: ChunkingOptions,
  countSlice: CountSlice,
): PieceBoundary {
  const fitting = bestFittingBoundary(
    content,
    start,
    codePointBoundaries(content, start, limit),
    options,
    countSlice,
  );
  if (fitting !== null) return fitting;

  const single = Math.min(start + codePointWidth(content, start), limit);
  return { endOffset: single, nextCursor: single };
}

/**
 * Splits one divisible range that exceeds `maxTokens`.
 *
 * Pieces stay in source order, never overlap, and drop only the whitespace that
 * separates them. Boundaries are preferred in the documented order: sentence,
 * then whitespace, then a Unicode-safe hard boundary.
 */
export function splitRange(
  content: string,
  range: SourceRange,
  options: ChunkingOptions,
  countSlice: CountSlice,
): readonly SourceRange[] {
  if (countSlice(range.startOffset, range.endOffset) <= options.maxTokens) return [range];

  const pieces: SourceRange[] = [];
  let cursor = range.startOffset;

  while (cursor < range.endOffset) {
    while (cursor < range.endOffset && isWhitespaceAt(content, cursor)) cursor += 1;
    if (cursor >= range.endOffset) break;

    const remainderEnd = trimmedEnd(content, cursor, range.endOffset);
    let boundary: PieceBoundary;
    if (remainderEnd > cursor && countSlice(cursor, remainderEnd) <= options.maxTokens) {
      boundary = { endOffset: remainderEnd, nextCursor: range.endOffset };
    } else {
      boundary =
        bestFittingBoundary(
          content,
          cursor,
          sentenceBoundaries(content, cursor, range.endOffset),
          options,
          countSlice,
        ) ??
        bestFittingBoundary(
          content,
          cursor,
          whitespaceBoundaries(content, cursor, range.endOffset),
          options,
          countSlice,
        ) ??
        hardBoundary(content, cursor, range.endOffset, options, countSlice);
    }

    if (boundary.endOffset > cursor) {
      pieces.push({ startOffset: cursor, endOffset: boundary.endOffset });
    }
    // Guaranteed forward progress: every boundary producer returns a cursor
    // strictly greater than the current one.
    cursor = Math.max(boundary.nextCursor, cursor + 1);
  }

  return pieces.length > 0 ? pieces : [range];
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

/** One emitted block's exact source range and its measured token cost. */
export interface RangeGroup {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tokens: number;
}

/**
 * Groups adjacent ranges toward the token target.
 *
 * A group is always the exact contiguous source slice from the first range's
 * start to the last range's end, so the whitespace that separated them stays in
 * the content. Grouping never reorders, never duplicates, and never splits an
 * atomic range.
 *
 * The caller decides what may be grouped: `MarkdownChunker` passes one heading
 * section at a time, so a group never crosses a section, and `TextChunker`
 * passes the whole document, which has no sections to cross.
 */
export function groupRanges(
  ranges: readonly AtomicSourceRange[],
  options: ChunkingOptions,
  countSlice: CountSlice,
): readonly RangeGroup[] {
  const groups: RangeGroup[] = [];
  let start: number | null = null;
  let end = 0;
  let tokens = 0;

  const flush = (): void => {
    if (start === null) return;
    groups.push({ startOffset: start, endOffset: end, tokens });
    start = null;
  };

  for (const range of ranges) {
    const standalone = countSlice(range.startOffset, range.endOffset);

    if (range.atomic && standalone > options.maxTokens) {
      flush();
      groups.push({
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        tokens: standalone,
      });
      continue;
    }

    if (start === null) {
      start = range.startOffset;
      end = range.endOffset;
      tokens = standalone;
      continue;
    }

    const combined = countSlice(start, range.endOffset);
    const closerToTarget =
      Math.abs(combined - options.targetTokens) <= Math.abs(tokens - options.targetTokens);
    if (combined <= options.maxTokens && closerToTarget) {
      end = range.endOffset;
      tokens = combined;
      continue;
    }

    flush();
    start = range.startOffset;
    end = range.endOffset;
    tokens = standalone;
  }

  flush();
  return groups;
}

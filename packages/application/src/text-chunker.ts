import {
  CONTEXT_BLOCK_SCHEMA_VERSION,
  ContextBlockSchema,
  SourceDocumentSchema,
  calculateNormalizedContentHash,
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type JsonObject,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
import {
  ChunkingOptionsSchema,
  cloneJsonValue,
  contextBlockId,
  contextBlockIdPayload,
  groupRanges,
  isBlank,
  issue,
  lineNumberAtOffset,
  scanLines,
  sha256,
  sliceCounter,
  splitRange,
  validateTokenizer,
  type AtomicSourceRange,
  type CountSlice,
  type RangeGroup,
  type SourceLine,
} from './chunking-primitives.js';
import type { IngestedSource } from './source-ingestion.js';

/**
 * Deterministic plain-text chunking (DEC-039).
 *
 * The chunker turns one validated `text` `IngestedSource` (DEC-028) into
 * runtime-validated `ContextBlock` records whose `content` is an exact substring
 * of the ingested content. It reads no file, opens no socket, queries no
 * database, calls no model, reads no clock, and generates no random value: every
 * decision follows from the supplied content, the supplied options, and the
 * injected `Tokenizer` (INV-DET-001, INV-DET-003, INV-DET-004).
 *
 * The structural rule of version 1 is deliberately the weakest one that is
 * always true of plain text:
 *
 * 1. a paragraph is a maximal run of non-blank lines;
 * 2. a run of blank lines separates paragraphs and belongs to neither;
 * 3. adjacent paragraphs may be grouped toward `targetTokens`, and a group is
 *    the exact contiguous slice between its first and last paragraph, so the
 *    blank lines that separated them stay inside the content;
 * 4. a paragraph above `maxTokens` is split at a sentence boundary, else at a
 *    whitespace boundary, else at a whole code-point boundary.
 *
 * There is no heading detection, no list or table recognition, no Markdown
 * interpretation, no semantic segmentation, and no overlap. Plain text carries
 * no promise of structure, and a chunker that guessed one would place block
 * boundaries on a structure the source does not have (DEC-039).
 *
 * Nothing is rewritten. Line endings, indentation, trailing spaces, blank-line
 * runs inside a group, an initial U+FEFF, and Unicode composition all survive
 * into block content exactly as the source holds them, because the block hash
 * must describe text the caller really has (INV-PROV-005).
 *
 * Every candidate boundary is measured with the exact tokenizer over the exact
 * substring it would produce, and no candidate is inferred away from an earlier
 * overflow: a subword tokenizer may count a longer substring as fewer tokens
 * than a shorter one, so token counts are not assumed to grow with length.
 */

/** Stable identity of this chunker, recorded on every block it produces. */
const CHUNKER_ID = 'ctxalloc-text-paragraph';
const CHUNKER_VERSION = '1';

/**
 * Explicit token policy for one chunker instance.
 *
 * Both values are policy input from trusted configuration, never from source
 * content (INV-SEC-001). There is deliberately no overlap option: canonical
 * blocks never overlap, and a retrieval-specific overlapping window would be a
 * separate indexing concern requiring its own decision (DEC-029, DEC-039).
 *
 * The interface repeats the two fields of the Markdown policy rather than
 * aliasing it. The two policies are configured independently — a prose vault and
 * a log file need different sizes — and one shared public type would suggest a
 * single value serves both.
 */
export interface TextChunkingOptions {
  /** Preferred size of one block, in tokens. */
  readonly targetTokens: number;
  /** Hard size limit of one block, in tokens, except for indivisible content. */
  readonly maxTokens: number;
}

/**
 * Invalid chunker construction or chunking input.
 *
 * The issues are project-owned, serializable, and ordered deterministically, so a
 * CLI, an HTTP API, or a trace can report them without re-deriving meaning from a
 * free-text message. Validation-library errors never escape this boundary
 * (INV-ADAPTER-001).
 */
export class TextChunkingValidationError extends Error {
  readonly code = 'TEXT_CHUNKING_INVALID_INPUT';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Text chunking input is invalid: ${summary}`);
    this.name = 'TextChunkingValidationError';
    this.issues = issues;
  }
}

/** Machine-readable categories of a chunking failure that is not an input problem. */
export type TextChunkingErrorCode =
  'TEXT_CHUNKING_TOKENIZER_FAILED' | 'TEXT_CHUNKING_INVALID_BLOCK';

/** Half-open source range that a chunking failure refers to. */
export interface TextChunkingRange {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * A chunking failure that is not caused by the caller's input.
 *
 * Two conditions produce it: the injected tokenizer failed or returned a value
 * that is not a usable count, and an internally derived block failed domain
 * validation. Both are reported with a stable code and the source range being
 * processed, instead of surfacing a tokenizer-library error or a
 * `DomainValidationError` that would suggest the caller supplied a bad block
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class TextChunkingError extends Error {
  readonly code: TextChunkingErrorCode;
  /** The block range being processed, when the failure is attributable to one. */
  readonly range: TextChunkingRange | null;
  /** Structured detail for `TEXT_CHUNKING_INVALID_BLOCK`, empty otherwise. */
  readonly issues: readonly ValidationIssue[];

  constructor(
    code: TextChunkingErrorCode,
    message: string,
    range: TextChunkingRange | null,
    issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'TextChunkingError';
    this.code = code;
    this.range = range;
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

const IngestedSourceSchema = z.strictObject({
  document: SourceDocumentSchema,
  content: z.string(),
});

/**
 * Validates the properties this use case relies on.
 *
 * Ingestion already produced a validated record, but the chunker is still a
 * runtime boundary: an `IngestedSource` can be persisted, transported, or rebuilt
 * by hand, and every guarantee used below is re-established here rather than
 * assumed (INV-BLOCK-005).
 */
function validateSource(source: IngestedSource): {
  readonly document: IngestedSource['document'];
  readonly content: string;
} {
  const parsed = safeParse(IngestedSourceSchema, source);
  if (!parsed.ok) {
    throw new TextChunkingValidationError(parsed.issues);
  }

  const { document, content } = parsed.value;
  const issues: ValidationIssue[] = [];

  if (document.sourceType !== 'text') {
    issues.push(
      issue(
        ['document', 'sourceType'],
        `must be "text", received "${document.sourceType}"`,
        'invalid_source_type',
      ),
    );
  }

  // A lone surrogate has no UTF-8 encoding: encoders substitute U+FFFD, which
  // would hash and tokenize text the caller never supplied (INV-BLOCK-007).
  const loneSurrogate = findLoneSurrogate(content);
  if (loneSurrogate !== null) {
    issues.push(
      issue(
        ['content'],
        `must be well-formed UTF-16: lone surrogate at code unit ${String(loneSurrogate)}`,
        'invalid_unicode',
      ),
    );
  }

  // The document states a hash of its content. Chunking a different string would
  // silently produce blocks whose provenance points at a source that never
  // contained them (INV-PROV-005).
  if (loneSurrogate === null && sha256(content) !== document.contentHash) {
    issues.push(
      issue(
        ['content'],
        'must match document.contentHash: the supplied content hashes to a different value',
        'content_hash_mismatch',
      ),
    );
  }

  if (issues.length > 0) {
    throw new TextChunkingValidationError(issues);
  }

  return { document, content };
}

/* -------------------------------------------------------------------------- */
/* Paragraph scanning                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Splits the source into maximal runs of non-blank lines.
 *
 * A paragraph range starts at the first line's start offset and ends at the last
 * line's content end offset, so the terminating newline — and its `\r` on a CRLF
 * source — stays outside the range. A run whose text is whitespace-only cannot
 * occur by construction, but the check is kept because it is the rule that makes
 * a block an ordinary candidate (INV-BLOCK-004).
 */
function scanParagraphs(
  content: string,
  lines: readonly SourceLine[],
): readonly AtomicSourceRange[] {
  const paragraphs: AtomicSourceRange[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const start = index;
    while (index < lines.length) {
      const current = lines[index];
      if (current === undefined || isBlank(current)) break;
      index += 1;
    }

    const first = lines[start];
    const last = lines[index - 1];
    if (first === undefined || last === undefined) continue;
    if (content.slice(first.startOffset, last.contentEndOffset).trim().length === 0) continue;

    paragraphs.push({
      atomic: false,
      startOffset: first.startOffset,
      endOffset: last.contentEndOffset,
    });
  }

  return paragraphs;
}

/* -------------------------------------------------------------------------- */
/* Chunker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic paragraph-based plain-text chunker.
 *
 * One instance holds one tokenizer and one token policy. `chunk` is pure with
 * respect to its input: it mutates nothing it is given and returns blocks in
 * source order.
 */
export class TextChunker {
  readonly #tokenizer: Tokenizer;
  readonly #options: TextChunkingOptions;

  /**
   * @throws {TextChunkingValidationError} when the tokenizer or the options are invalid.
   */
  constructor(tokenizer: Tokenizer, options: TextChunkingOptions) {
    const tokenizerIssues = validateTokenizer(tokenizer);
    const parsed = safeParse(ChunkingOptionsSchema, options);
    const optionIssues = parsed.ok
      ? []
      : parsed.issues.map((detail) => ({
          ...detail,
          path: ['options', ...detail.path],
          pointer: ['options', ...detail.path].join('.'),
        }));

    const issues = [...tokenizerIssues, ...optionIssues];
    if (issues.length > 0) {
      throw new TextChunkingValidationError(issues);
    }

    this.#tokenizer = tokenizer;
    // A copy, so a later mutation of the caller's object cannot change policy.
    this.#options = {
      targetTokens: parsed.ok ? parsed.value.targetTokens : options.targetTokens,
      maxTokens: parsed.ok ? parsed.value.maxTokens : options.maxTokens,
    };
  }

  /**
   * Splits one ingested plain-text source into `ContextBlock` records.
   *
   * The parameter is validated at runtime even though it is typed: an
   * `IngestedSource` can be persisted and rebuilt, and every property relied on
   * below is re-established rather than assumed (INV-BLOCK-005).
   *
   * A source that is empty, or that contains only blank lines, yields no blocks.
   * That is a correct answer, not a failure: whitespace is not an ordinary
   * candidate (INV-BLOCK-004).
   *
   * @throws {TextChunkingValidationError} when the source is not a valid plain-text ingestion result.
   * @throws {TextChunkingError} when the tokenizer fails or a derived block is not a valid domain record.
   */
  chunk(source: IngestedSource): readonly ContextBlock[] {
    const { document, content } = validateSource(source);
    if (content.length === 0) return [];

    const countSlice = this.#sliceCounter(content);
    const lines = scanLines(content);

    // Splitting happens before grouping so that an oversized paragraph is
    // divided into fitting pieces, and those pieces may then join their
    // neighbours exactly as ordinary paragraphs do.
    const paragraphs = scanParagraphs(content, lines).flatMap((paragraph) =>
      splitRange(content, paragraph, this.#options, countSlice).map((piece) => ({
        atomic: false,
        startOffset: piece.startOffset,
        endOffset: piece.endOffset,
      })),
    );
    if (paragraphs.length === 0) return [];

    const occurrences = new Map<string, number>();
    return groupRanges(paragraphs, this.#options, countSlice).map((group) =>
      this.#buildBlock(document, content, lines, group, occurrences),
    );
  }

  /**
   * Wraps the tokenizer so no external error type and no unusable count escapes.
   *
   * The shared helper builds the message; the raised error stays this module's
   * own, so a text tokenizer failure carries a `TEXT_CHUNKING_*` code and its
   * source range (INV-ADAPTER-003).
   */
  #sliceCounter(content: string): CountSlice {
    return sliceCounter(this.#tokenizer, content, (message, start, end) => {
      throw new TextChunkingError('TEXT_CHUNKING_TOKENIZER_FAILED', message, {
        startOffset: start,
        endOffset: end,
      });
    });
  }

  #buildBlock(
    document: IngestedSource['document'],
    content: string,
    lines: readonly SourceLine[],
    group: RangeGroup,
    occurrences: Map<string, number>,
  ): ContextBlock {
    const blockContent = content.slice(group.startOffset, group.endOffset);
    // The canonical rule is owned by the domain and shared with
    // `CandidateValidator`, so a written hash and a rechecked hash cannot drift
    // apart (DEC-030). `validateSource` has already rejected malformed UTF-16 in
    // the whole source, and block boundaries never split a code point, so this
    // call cannot throw here.
    const normalizedContentHash = calculateNormalizedContentHash(blockContent);

    // Plain text has no heading structure, so the identity payload carries an
    // explicit `null` heading path — the same value a Markdown block outside any
    // heading carries. The document title is deliberately not substituted: a
    // title is a label on the source, not a heading the source contains.
    const basePayload = contextBlockIdPayload(document.id, null, normalizedContentHash);
    const occurrence = occurrences.get(basePayload) ?? 0;
    occurrences.set(basePayload, occurrence + 1);

    const oversized = group.tokens > this.#options.maxTokens;
    const metadata: JsonObject = {
      source: cloneJsonValue(document.metadata),
      chunking: {
        chunkerId: CHUNKER_ID,
        chunkerVersion: CHUNKER_VERSION,
        ...(oversized ? { oversized: true } : {}),
      },
      tokenization: {
        tokenizerId: this.#tokenizer.id,
        tokenizerVersion: this.#tokenizer.version,
      },
    };

    const fields: Record<string, unknown> = {
      id: contextBlockId(basePayload, occurrence),
      schemaVersion: CONTEXT_BLOCK_SCHEMA_VERSION,
      scope: document.scope,
      sourceDocumentId: document.id,
      sourceType: document.sourceType,
      sourceLocation: {
        kind: 'text-range',
        startOffset: group.startOffset,
        endOffset: group.endOffset,
        startLine: lineNumberAtOffset(lines, group.startOffset),
        endLine: lineNumberAtOffset(lines, group.endOffset - 1),
      },
      content: blockContent,
      normalizedContentHash,
      tokenCount: group.tokens,
      ...(document.createdAt !== undefined ? { createdAt: document.createdAt } : {}),
      ...(document.updatedAt !== undefined ? { updatedAt: document.updatedAt } : {}),
      attributes: {},
      metadata,
    };

    const parsed = safeParse(ContextBlockSchema, fields);
    if (!parsed.ok) {
      // Derived data failed the persisted contract. That is a defect in this
      // module, not invalid caller input, so it is reported as a chunking failure
      // rather than a domain validation error.
      throw new TextChunkingError(
        'TEXT_CHUNKING_INVALID_BLOCK',
        `Derived block for source range [${String(group.startOffset)}, ${String(group.endOffset)}) is not a valid ContextBlock`,
        { startOffset: group.startOffset, endOffset: group.endOffset },
        parsed.issues,
      );
    }
    return parsed.value;
  }
}

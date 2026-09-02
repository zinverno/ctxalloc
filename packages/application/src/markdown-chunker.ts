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
  type CountSlice,
  type RangeGroup,
  type SourceLine,
  type SourceRange,
} from './chunking-primitives.js';
import type { IngestedSource } from './source-ingestion.js';

/**
 * Deterministic structural Markdown chunking (DEC-029).
 *
 * The chunker turns one validated Markdown `IngestedSource` (DEC-028) into
 * runtime-validated `ContextBlock` records. It scans the source structurally,
 * never rewrites it, and emits blocks whose `content` is an exact substring of
 * the ingested content.
 *
 * It reads no file, opens no socket, queries no database, calls no model, reads
 * no clock, and generates no random value. Every decision is derived from the
 * supplied content, the supplied options, and the injected `Tokenizer`
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 *
 * The scanner design is adapted from the author's Obsidian plugin
 * `zinverno/obsidian-ai-hub` at commit
 * `e592cbc99d27259db77e05fa06a833f91169cf89`; see `THIRD_PARTY_NOTICES.md`. Only
 * the structural scanning ideas were reused. That implementation renders a
 * breadcrumb into the chunk text, normalizes whitespace, budgets in characters,
 * overlaps chunks, uses a non-cryptographic hash, and depends on the Obsidian
 * metadata cache. None of that behavior is reproduced here.
 */

/** Stable identity of this chunker, recorded on every block it produces. */
const CHUNKER_ID = 'ctxalloc-markdown-structural';
const CHUNKER_VERSION = '1';

/**
 * Explicit token policy for one chunker instance.
 *
 * Both values are policy input from trusted configuration, never from source
 * content (INV-SEC-001). There is deliberately no overlap option: canonical
 * blocks never overlap, and a retrieval-specific overlapping window would be a
 * separate indexing concern requiring its own decision (DEC-029).
 */
export interface MarkdownChunkingOptions {
  /** Preferred size of one block, in tokens. */
  readonly targetTokens: number;
  /** Hard size limit of one block, in tokens, except for indivisible content. */
  readonly maxTokens: number;
}

/**
 * Invalid chunker construction or chunking input.
 *
 * The issues are project-owned, serializable, and ordered deterministically, so a
 * future CLI, HTTP API, or trace can report them without re-deriving meaning from
 * a free-text message. Validation-library errors never escape this boundary
 * (INV-ADAPTER-001).
 */
export class MarkdownChunkingValidationError extends Error {
  readonly code = 'MARKDOWN_CHUNKING_INVALID_INPUT';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Markdown chunking input is invalid: ${summary}`);
    this.name = 'MarkdownChunkingValidationError';
    this.issues = issues;
  }
}

/** Machine-readable categories of a chunking failure that is not an input problem. */
export type MarkdownChunkingErrorCode =
  'MARKDOWN_CHUNKING_TOKENIZER_FAILED' | 'MARKDOWN_CHUNKING_INVALID_BLOCK';

/** Half-open source range that a chunking failure refers to. */
export interface MarkdownChunkingRange {
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
export class MarkdownChunkingError extends Error {
  readonly code: MarkdownChunkingErrorCode;
  /** The block range being processed, when the failure is attributable to one. */
  readonly range: MarkdownChunkingRange | null;
  /** Structured detail for `MARKDOWN_CHUNKING_INVALID_BLOCK`, empty otherwise. */
  readonly issues: readonly ValidationIssue[];

  constructor(
    code: MarkdownChunkingErrorCode,
    message: string,
    range: MarkdownChunkingRange | null,
    issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'MarkdownChunkingError';
    this.code = code;
    this.range = range;
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Option and dependency validation                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Markdown token policy is validated by the shared chunking schema, so the
 * two chunkers cannot disagree about what a usable target and maximum are
 * (INV-DEP-003). The rules and messages are unchanged.
 */
const MarkdownChunkingOptionsSchema = ChunkingOptionsSchema;

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
 * Phase 5 already produced a validated record, but the chunker is still a runtime
 * boundary: an `IngestedSource` can be persisted, transported, or rebuilt by
 * hand, and every guarantee used below is re-established here rather than assumed
 * (INV-BLOCK-005).
 */
function validateSource(source: IngestedSource): {
  readonly document: IngestedSource['document'];
  readonly content: string;
} {
  const parsed = safeParse(IngestedSourceSchema, source);
  if (!parsed.ok) {
    throw new MarkdownChunkingValidationError(parsed.issues);
  }

  const { document, content } = parsed.value;
  const issues: ValidationIssue[] = [];

  if (document.sourceType !== 'markdown') {
    issues.push(
      issue(
        ['document', 'sourceType'],
        `must be "markdown", received "${document.sourceType}"`,
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
    throw new MarkdownChunkingValidationError(issues);
  }

  return { document, content };
}

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                 */
/* -------------------------------------------------------------------------- */

const BOM = '﻿';

function isFrontmatterOpeningLine(text: string): boolean {
  return text === '---' || text === `${BOM}---`;
}

function isFrontmatterClosingLine(text: string): boolean {
  return text === '---';
}

/**
 * Strict source-only frontmatter detection.
 *
 * The opener is accepted only as the very first line and only as exactly `---`,
 * optionally preceded by a BOM. Leading whitespace before the opener and an
 * indented closing delimiter both disqualify the block, and an unclosed opener
 * stays ordinary Markdown content. A `---` later in the document is a thematic
 * break, never frontmatter.
 *
 * The frontmatter text is excluded from block content. It is never parsed as
 * YAML and never injected into metadata: source data must not become compiler
 * input (INV-SEC-001).
 */
function bodyStartAfterFrontmatter(lines: readonly SourceLine[]): number {
  const first = lines[0];
  if (first === undefined || !isFrontmatterOpeningLine(first.text)) return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && isFrontmatterClosingLine(line.text)) {
      return line.fullEndOffset;
    }
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Headings and sections                                                       */
/* -------------------------------------------------------------------------- */

interface HeadingInfo {
  readonly level: number;
  readonly text: string;
  readonly startOffset: number;
  readonly bodyStartOffset: number;
}

interface Fence {
  readonly marker: '`' | '~';
  readonly length: number;
}

/**
 * Heading text is the parsed ATX title, with surrounding and repeated inner
 * whitespace collapsed. This value is provenance metadata, not block content: the
 * heading line itself never enters `ContextBlock.content`, so normalizing it here
 * cannot alter source text.
 */
function normalizeHeadingText(value: string): string {
  return value.trim().replace(/[ \t]+/g, ' ');
}

function parseAtxHeading(line: string): { readonly level: number; readonly text: string } | null {
  const match = /^ {0,3}(#{1,6})(.*)$/.exec(line);
  if (match === null) return null;
  const rest = match[2] ?? '';
  const marker = match[1] ?? '';
  // `#Heading` is not a heading; `#` alone is an empty one.
  if (rest.length > 0 && !/^[ \t]/.test(rest)) return null;
  return {
    level: marker.length,
    text: normalizeHeadingText(rest.trim().replace(/[ \t]+#+[ \t]*$/, '')),
  };
}

function parseFenceOpen(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null) return null;
  const run = match[1] ?? '';
  const marker: '`' | '~' = run.startsWith('`') ? '`' : '~';
  // A backtick info string may not contain a backtick, so `` ```a` `` is not a fence.
  if (marker === '`' && (match[2] ?? '').includes('`')) return null;
  return { marker, length: run.length };
}

function isFenceClose(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  const run = match?.[1];
  return run !== undefined && run.startsWith(fence.marker) && run.length >= fence.length;
}

interface Section {
  /** Empty when the section has no heading path at all. */
  readonly headingPath: readonly string[];
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Builds one section per heading plus a root section for content before the first
 * heading.
 *
 * The heading stack pops on an equal or shallower level, skipped levels are
 * allowed, and duplicate heading text is allowed. A section body starts after its
 * heading line, so heading markers never enter block content and a parent never
 * repeats a child's body.
 */
function buildSections(
  rootHeadingPath: readonly string[],
  contentLength: number,
  contentStart: number,
  headings: readonly HeadingInfo[],
): readonly Section[] {
  const sections: Section[] = [
    {
      headingPath: rootHeadingPath,
      startOffset: contentStart,
      endOffset: headings[0]?.startOffset ?? contentLength,
    },
  ];

  const stack: { level: number; text: string }[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading === undefined) continue;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= heading.level) {
      stack.pop();
    }
    stack.push({ level: heading.level, text: heading.text });
    // An empty ATX heading (`#`) contributes no path segment.
    const headingPath = stack.map((entry) => entry.text).filter((text) => text.length > 0);
    sections.push({
      headingPath: headingPath.length > 0 ? headingPath : rootHeadingPath,
      startOffset: heading.bodyStartOffset,
      endOffset: headings[index + 1]?.startOffset ?? contentLength,
    });
  }

  return sections;
}

/* -------------------------------------------------------------------------- */
/* Logical blocks                                                              */
/* -------------------------------------------------------------------------- */

type LogicalBlockKind = 'paragraph' | 'code' | 'list' | 'quote' | 'table' | 'html';

/**
 * One structural unit inside a section, addressed by source offsets only.
 *
 * Atomic kinds are never split: a fenced code block, list, blockquote or callout,
 * table, and HTML block lose their meaning when cut in half.
 */
interface LogicalBlock {
  readonly kind: LogicalBlockKind;
  readonly atomic: boolean;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface ListMarker {
  readonly indent: number;
  /** Column where the item's own content begins, after the marker and its spacing. */
  readonly contentIndent: number;
  readonly ordered: boolean;
}

function parseListMarker(text: string): ListMarker | null {
  const match = /^( *)([-+*]|\d+[.)])[ \t]+/.exec(text);
  if (match === null) return null;
  return {
    indent: (match[1] ?? '').length,
    // Column where the item's own content begins, used to decide whether an
    // indented line belongs to the item or ends the list.
    contentIndent: match[0].length,
    ordered: /^\d/.test(match[2] ?? ''),
  };
}

function isListStart(text: string): boolean {
  const marker = parseListMarker(text);
  return marker !== null && marker.indent <= 3;
}

function leadingSpaces(text: string): number {
  return /^ */.exec(text)?.[0].length ?? 0;
}

/**
 * True when an ATX-heading-looking line ends a list whose items start their content
 * at `contentIndent`.
 *
 * A heading indented to at least the item's content column is list content, so it
 * stays inside the atomic block and never becomes a document section. A heading
 * indented less than that column is ordinary document structure and closes the
 * list.
 */
function endsListWithHeading(text: string, contentIndent: number): boolean {
  return parseAtxHeading(text) !== null && leadingSpaces(text) < contentIndent;
}

/**
 * Finds the end of a list, keeping loose and nested lists in one atomic block.
 *
 * A blank line ends the list only when the following non-blank line is not a
 * deeper marker, and not a marker of the same kind at the same indent.
 */
function listBlockEnd(lines: readonly SourceLine[], start: number): number {
  const rootLine = lines[start];
  const rootMarker = rootLine === undefined ? null : parseListMarker(rootLine.text);
  if (rootMarker === null) return start + 1;

  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (!isBlank(line)) {
      if (endsListWithHeading(line.text, rootMarker.contentIndent)) return index;
      index += 1;
      continue;
    }

    const blankStart = index;
    while (index < lines.length) {
      const blank = lines[index];
      if (blank === undefined || !isBlank(blank)) break;
      index += 1;
    }
    const next = lines[index];
    if (next === undefined) return blankStart;

    const nextMarker = parseListMarker(next.text);
    const continues =
      nextMarker !== null &&
      (nextMarker.indent > rootMarker.indent ||
        (nextMarker.indent === rootMarker.indent && nextMarker.ordered === rootMarker.ordered));
    if (!continues) return blankStart;
    index += 1;
  }
  return index;
}

function isQuoteStart(text: string): boolean {
  return /^ {0,3}>/.test(text);
}

function isHtmlStart(text: string): boolean {
  return /^ {0,3}<(?:!--|\/?[A-Za-z][\w-]*(?:\s|>|\/))/.test(text);
}

function isTableDelimiter(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes('|')) return false;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function isTableStart(lines: readonly SourceLine[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return (
    header !== undefined &&
    header.text.includes('|') &&
    delimiter !== undefined &&
    isTableDelimiter(delimiter.text)
  );
}

/** Headings and logical blocks as understood by one single interpretation of the source. */
interface StructuralScan {
  readonly headings: readonly HeadingInfo[];
  readonly blocks: readonly LogicalBlock[];
}

/**
 * Interprets the whole document body once, producing both the section headings and
 * the logical blocks.
 *
 * Section discovery and block parsing deliberately share this one pass. When they
 * were two passes, the heading scan only protected fenced code, so an
 * ATX-looking line inside another atomic structure — an HTML block or comment, or
 * indented list content — was recognized as a heading and cut that atomic block in
 * half, with the inner text leaking into `headingPath`. Because a single walk
 * consumes each atomic span before its interior can be examined, the two views can
 * no longer disagree about what is protected.
 *
 * A line becomes a heading only when it is reached at document level. Fenced code
 * is consumed first, so heading-like, list-like, and HTML-like text inside code is
 * never reinterpreted, and an unclosed fence runs to the end of the document.
 *
 * Setext headings (`Title` followed by `===` or `---`) are deliberately not
 * recognized. Deciding whether an underline belongs to a preceding paragraph
 * requires full block-context tracking — lazy continuation, list items, and
 * blockquotes all change the answer — and the reference implementation resolved
 * it by trusting the Obsidian metadata cache, which does not exist here. A
 * source-only approximation would misplace section boundaries and therefore
 * misplace block offsets, so the limitation is documented instead of guessed
 * (DEC-029): a Setext-underlined title stays ordinary paragraph content.
 */
function scanStructure(
  content: string,
  lines: readonly SourceLine[],
  contentStart: number,
): StructuralScan {
  const headings: HeadingInfo[] = [];
  const blocks: LogicalBlock[] = [];
  let index = 0;
  while (index < lines.length && (lines[index]?.startOffset ?? contentStart) < contentStart) {
    index += 1;
  }

  const push = (start: number, end: number, kind: LogicalBlockKind, atomic: boolean): void => {
    const first = lines[start];
    const last = lines[end - 1];
    if (first === undefined || last === undefined) return;
    // A whitespace-only range is not an ordinary candidate (INV-BLOCK-004).
    if (content.slice(first.startOffset, last.contentEndOffset).trim().length === 0) return;
    blocks.push({
      kind,
      atomic,
      startOffset: first.startOffset,
      endOffset: last.contentEndOffset,
    });
  };

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = parseFenceOpen(line.text);
    if (fence !== null) {
      const start = index;
      index += 1;
      while (index < lines.length) {
        const current = lines[index];
        index += 1;
        if (current !== undefined && isFenceClose(current.text, fence)) break;
      }
      push(start, index, 'code', true);
      continue;
    }

    // Reached at document level only: every atomic span above and below consumes
    // its own interior, so a heading-like line inside one never arrives here.
    const heading = parseAtxHeading(line.text);
    if (heading !== null) {
      headings.push({
        level: heading.level,
        text: heading.text,
        startOffset: line.startOffset,
        bodyStartOffset: line.fullEndOffset,
      });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const start = index;
      index += 2;
      while (index < lines.length) {
        const current = lines[index];
        if (current === undefined || isBlank(current) || !current.text.includes('|')) break;
        index += 1;
      }
      push(start, index, 'table', true);
      continue;
    }

    if (isListStart(line.text)) {
      const start = index;
      index = listBlockEnd(lines, start);
      push(start, index, 'list', true);
      continue;
    }

    // A blockquote, callout, or basic HTML block or comment spans consecutive
    // non-blank lines. Its interior is never re-examined, so an ATX-looking line
    // inside it stays part of the atomic block. A blank line still closes the
    // span, which is the documented extent of basic HTML support.
    const groupedKind: LogicalBlockKind | null = isQuoteStart(line.text)
      ? 'quote'
      : isHtmlStart(line.text)
        ? 'html'
        : null;
    if (groupedKind !== null) {
      const start = index;
      index += 1;
      while (index < lines.length) {
        const current = lines[index];
        if (current === undefined || isBlank(current)) break;
        index += 1;
      }
      push(start, index, groupedKind, true);
      continue;
    }

    const start = index;
    index += 1;
    while (index < lines.length) {
      const current = lines[index];
      if (
        current === undefined ||
        isBlank(current) ||
        parseAtxHeading(current.text) !== null ||
        parseFenceOpen(current.text) !== null ||
        isTableStart(lines, index) ||
        isListStart(current.text) ||
        isQuoteStart(current.text) ||
        isHtmlStart(current.text)
      ) {
        break;
      }
      index += 1;
    }
    push(start, index, 'paragraph', false);
  }

  return { headings, blocks };
}

/* -------------------------------------------------------------------------- */
/* Paragraph splitting and grouping                                            */
/* -------------------------------------------------------------------------- */

/**
 * Splits one paragraph that exceeds `maxTokens` into ordered non-overlapping
 * pieces, and re-labels them as Markdown paragraphs.
 *
 * The boundary rules — sentence, then whitespace, then a Unicode-safe hard
 * boundary, each candidate measured with the exact tokenizer — are the shared
 * ones (DEC-029). Only the label is added here, because grouping needs to know
 * that a piece of a paragraph is still divisible.
 */
function splitParagraph(
  content: string,
  block: LogicalBlock,
  options: MarkdownChunkingOptions,
  countSlice: CountSlice,
): readonly LogicalBlock[] {
  return splitRange(content, block, options, countSlice).map((piece: SourceRange) => ({
    kind: 'paragraph' as const,
    atomic: false,
    startOffset: piece.startOffset,
    endOffset: piece.endOffset,
  }));
}

/* -------------------------------------------------------------------------- */
/* Chunker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic structural Markdown chunker.
 *
 * One instance holds one tokenizer and one token policy. `chunk` is pure with
 * respect to its input: it mutates nothing it is given and returns blocks in
 * source order.
 */
export class MarkdownChunker {
  readonly #tokenizer: Tokenizer;
  readonly #options: MarkdownChunkingOptions;

  /**
   * @throws {MarkdownChunkingValidationError} when the tokenizer or the options are invalid.
   */
  constructor(tokenizer: Tokenizer, options: MarkdownChunkingOptions) {
    const tokenizerIssues = validateTokenizer(tokenizer);
    const parsed = safeParse(MarkdownChunkingOptionsSchema, options);
    const optionIssues = parsed.ok
      ? []
      : parsed.issues.map((detail) => ({
          ...detail,
          path: ['options', ...detail.path],
          pointer: ['options', ...detail.path].join('.'),
        }));

    const issues = [...tokenizerIssues, ...optionIssues];
    if (issues.length > 0) {
      throw new MarkdownChunkingValidationError(issues);
    }

    this.#tokenizer = tokenizer;
    // A copy, so a later mutation of the caller's object cannot change policy.
    this.#options = {
      targetTokens: parsed.ok ? parsed.value.targetTokens : options.targetTokens,
      maxTokens: parsed.ok ? parsed.value.maxTokens : options.maxTokens,
    };
  }

  /**
   * Splits one ingested Markdown source into `ContextBlock` records.
   *
   * The parameter is validated at runtime even though it is typed: an
   * `IngestedSource` can be persisted and rebuilt, and every property relied on
   * below is re-established rather than assumed (INV-BLOCK-005).
   *
   * @throws {MarkdownChunkingValidationError} when the source is not a valid Markdown ingestion result.
   * @throws {MarkdownChunkingError} when the tokenizer fails or a derived block is not a valid domain record.
   */
  chunk(source: IngestedSource): readonly ContextBlock[] {
    const { document, content } = validateSource(source);
    if (content.length === 0) return [];

    const countSlice = this.#sliceCounter(content);
    const lines = scanLines(content);
    const contentStart = bodyStartAfterFrontmatter(lines);

    // A blank title is treated as absent. The value is used exactly as supplied:
    // it is never trimmed, rewritten, or derived from a path or filename.
    const title = document.title;
    const rootHeadingPath =
      title !== undefined && title.trim().length > 0 ? Object.freeze([title]) : [];

    // One interpretation of the source produces both the headings and the logical
    // blocks, so a section boundary can never fall inside an atomic block.
    const structure = scanStructure(content, lines, contentStart);
    const sections = buildSections(
      rootHeadingPath,
      content.length,
      contentStart,
      structure.headings,
    );

    const blocks: ContextBlock[] = [];
    const occurrences = new Map<string, number>();
    // Both sections and blocks are in source order, so one cursor assigns every
    // block to its section without rescanning.
    let blockCursor = 0;

    for (const section of sections) {
      const sectionBlocks: LogicalBlock[] = [];
      while (blockCursor < structure.blocks.length) {
        const block = structure.blocks[blockCursor];
        if (block === undefined || block.startOffset >= section.endOffset) break;
        sectionBlocks.push(block);
        blockCursor += 1;
      }

      const logical = sectionBlocks.flatMap((block) =>
        block.atomic ? [block] : splitParagraph(content, block, this.#options, countSlice),
      );
      if (logical.length === 0) continue;

      for (const group of groupRanges(logical, this.#options, countSlice)) {
        blocks.push(this.#buildBlock(document, content, lines, section, group, occurrences));
      }
    }

    return blocks;
  }

  /**
   * Wraps the tokenizer so no external error type and no unusable count escapes.
   *
   * The shared helper builds the message; the raised error stays this module's
   * own, so a Markdown tokenizer failure keeps its `MARKDOWN_CHUNKING_*` code and
   * its source range (INV-ADAPTER-003).
   */
  #sliceCounter(content: string): CountSlice {
    return sliceCounter(this.#tokenizer, content, (message, start, end) => {
      throw new MarkdownChunkingError('MARKDOWN_CHUNKING_TOKENIZER_FAILED', message, {
        startOffset: start,
        endOffset: end,
      });
    });
  }

  #buildBlock(
    document: IngestedSource['document'],
    content: string,
    lines: readonly SourceLine[],
    section: Section,
    group: RangeGroup,
    occurrences: Map<string, number>,
  ): ContextBlock {
    const blockContent = content.slice(group.startOffset, group.endOffset);
    // The canonical rule DEC-029 fixed for Markdown is now owned by the domain
    // and shared with `CandidateValidator`, so a written hash and a rechecked
    // hash cannot drift apart (DEC-030). The computed value is unchanged.
    // `validateSource` has already rejected malformed UTF-16 in the whole
    // source, and block boundaries never split a code point, so this call
    // cannot throw here.
    const normalizedContentHash = calculateNormalizedContentHash(blockContent);
    const headingPath = section.headingPath.length > 0 ? [...section.headingPath] : null;

    const basePayload = contextBlockIdPayload(document.id, headingPath, normalizedContentHash);
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
      ...(headingPath !== null ? { headingPath } : {}),
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
      throw new MarkdownChunkingError(
        'MARKDOWN_CHUNKING_INVALID_BLOCK',
        `Derived block for source range [${String(group.startOffset)}, ${String(group.endOffset)}) is not a valid ContextBlock`,
        { startOffset: group.startOffset, endOffset: group.endOffset },
        parsed.issues,
      );
    }
    return parsed.value;
  }
}

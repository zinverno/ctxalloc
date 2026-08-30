import { createHash } from 'node:crypto';
import {
  CONTEXT_BLOCK_SCHEMA_VERSION,
  ContextBlockSchema,
  SourceDocumentSchema,
  calculateNormalizedContentHash,
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type JsonObject,
  type JsonValue,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
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
 * Token limits are correctness data, so a numeric string, a fraction, `NaN`,
 * `Infinity`, zero, a negative value, and a value above `Number.MAX_SAFE_INTEGER`
 * are all rejected rather than coerced (INV-BUDGET-005).
 */
const positiveSafeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value > 0, {
  message: 'must be a positive safe integer',
});

const MarkdownChunkingOptionsSchema = z
  .strictObject({
    targetTokens: positiveSafeInteger,
    maxTokens: positiveSafeInteger,
  })
  .refine((options) => options.targetTokens <= options.maxTokens, {
    message: 'must not be greater than maxTokens',
    path: ['targetTokens'],
  });

function issue(path: readonly string[], message: string, code = 'invalid_value'): ValidationIssue {
  return { code, path, pointer: path.join('.'), message };
}

/**
 * The tokenizer arrives as an injected dependency, and its identity is copied
 * into block metadata, so its port shape is checked once at construction rather
 * than trusted from the compile-time type alone.
 */
function validateTokenizer(tokenizer: Tokenizer): readonly ValidationIssue[] {
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
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

const IngestedSourceSchema = z.strictObject({
  document: SourceDocumentSchema,
  content: z.string(),
});

/** SHA-256 over the UTF-8 encoding of `text`, rendered as `sha256:<64 lowercase hex>`. */
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

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
/* Source line scanning                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One physical source line.
 *
 * `contentEndOffset` excludes the line terminator and its `\r`, so a block range
 * built from line offsets is exact for both LF and CRLF sources.
 */
interface SourceLine {
  /** Zero-based scan index. Public line numbers are one-based. */
  readonly index: number;
  readonly startOffset: number;
  readonly contentEndOffset: number;
  readonly fullEndOffset: number;
  readonly text: string;
}

const CARRIAGE_RETURN = 13;

function scanLines(content: string): readonly SourceLine[] {
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
function lineNumberAtOffset(lines: readonly SourceLine[], offset: number): number {
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

function isBlank(line: SourceLine): boolean {
  return line.text.trim().length === 0;
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
/* Paragraph splitting                                                         */
/* -------------------------------------------------------------------------- */

function isWhitespaceAt(content: string, offset: number): boolean {
  return /\s/.test(content.charAt(offset));
}

/** Largest offset `<= end` such that the slice does not end with whitespace. */
function trimmedEnd(content: string, start: number, end: number): number {
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

/** Counts tokens of the exact candidate substring; `null` when it is empty after trimming. */
type CountSlice = (start: number, end: number) => number;

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
  options: MarkdownChunkingOptions,
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
  options: MarkdownChunkingOptions,
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
 * Splits one paragraph that exceeds `maxTokens`.
 *
 * Pieces stay in source order, never overlap, and drop only the whitespace that
 * separates them. Boundaries are preferred in the documented order: sentence,
 * then whitespace, then a Unicode-safe hard boundary.
 */
function splitParagraph(
  content: string,
  block: LogicalBlock,
  options: MarkdownChunkingOptions,
  countSlice: CountSlice,
): readonly LogicalBlock[] {
  if (countSlice(block.startOffset, block.endOffset) <= options.maxTokens) return [block];

  const pieces: LogicalBlock[] = [];
  let cursor = block.startOffset;

  while (cursor < block.endOffset) {
    while (cursor < block.endOffset && isWhitespaceAt(content, cursor)) cursor += 1;
    if (cursor >= block.endOffset) break;

    const remainderEnd = trimmedEnd(content, cursor, block.endOffset);
    let boundary: PieceBoundary;
    if (remainderEnd > cursor && countSlice(cursor, remainderEnd) <= options.maxTokens) {
      boundary = { endOffset: remainderEnd, nextCursor: block.endOffset };
    } else {
      boundary =
        bestFittingBoundary(
          content,
          cursor,
          sentenceBoundaries(content, cursor, block.endOffset),
          options,
          countSlice,
        ) ??
        bestFittingBoundary(
          content,
          cursor,
          whitespaceBoundaries(content, cursor, block.endOffset),
          options,
          countSlice,
        ) ??
        hardBoundary(content, cursor, block.endOffset, options, countSlice);
    }

    if (boundary.endOffset > cursor) {
      pieces.push({
        kind: 'paragraph',
        atomic: false,
        startOffset: cursor,
        endOffset: boundary.endOffset,
      });
    }
    // Guaranteed forward progress: every boundary producer returns a cursor
    // strictly greater than the current one.
    cursor = Math.max(boundary.nextCursor, cursor + 1);
  }

  return pieces.length > 0 ? pieces : [block];
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

interface BlockGroup {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly tokens: number;
}

/**
 * Groups adjacent logical blocks inside one heading section.
 *
 * A group is always the exact contiguous source slice from the first block's
 * start to the last block's end, so the whitespace that separated them stays in
 * the content. Grouping never crosses a heading section, never reorders, never
 * duplicates, and never splits an atomic block.
 */
function groupBlocks(
  blocks: readonly LogicalBlock[],
  options: MarkdownChunkingOptions,
  countSlice: CountSlice,
): readonly BlockGroup[] {
  const groups: BlockGroup[] = [];
  let start: number | null = null;
  let end = 0;
  let tokens = 0;

  const flush = (): void => {
    if (start === null) return;
    groups.push({ startOffset: start, endOffset: end, tokens });
    start = null;
  };

  for (const block of blocks) {
    const standalone = countSlice(block.startOffset, block.endOffset);

    if (block.atomic && standalone > options.maxTokens) {
      flush();
      groups.push({
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        tokens: standalone,
      });
      continue;
    }

    if (start === null) {
      start = block.startOffset;
      end = block.endOffset;
      tokens = standalone;
      continue;
    }

    const combined = countSlice(start, block.endOffset);
    const closerToTarget =
      Math.abs(combined - options.targetTokens) <= Math.abs(tokens - options.targetTokens);
    if (combined <= options.maxTokens && closerToTarget) {
      end = block.endOffset;
      tokens = combined;
      continue;
    }

    flush();
    start = block.startOffset;
    end = block.endOffset;
    tokens = standalone;
  }

  flush();
  return groups;
}

/* -------------------------------------------------------------------------- */
/* Block construction                                                          */
/* -------------------------------------------------------------------------- */

/** Deep copy of validated JSON data, so no caller-owned object is shared or mutated. */
function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJsonValue(entry);
    return result;
  }
  return value;
}

/**
 * Derives the deterministic block identity (DEC-029).
 *
 * The payload carries the source document, the heading path, and the normalized
 * content hash only. Offsets, line numbers, token counts, tokenizer identity,
 * titles, timestamps, metadata, the clock, and randomness are all absent, so a
 * block whose normalized content and heading path are unchanged keeps its
 * identity even when unrelated earlier text shifted its offsets (INV-BLOCK-001,
 * INV-DET-003).
 *
 * `occurrence` distinguishes blocks whose whole base payload is identical inside
 * one source, counted in source order, so duplicates stay unique
 * (INV-BLOCK-002).
 */
function contextBlockIdPayload(
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

function contextBlockId(basePayload: string, occurrence: number): string {
  const base: unknown = JSON.parse(basePayload);
  const payload = JSON.stringify([...(base as unknown[]), occurrence]);
  return `context-block:${sha256(payload)}`;
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

      for (const group of groupBlocks(logical, this.#options, countSlice)) {
        blocks.push(this.#buildBlock(document, content, lines, section, group, occurrences));
      }
    }

    return blocks;
  }

  /** Wraps the tokenizer so no external error type and no unusable count escapes. */
  #sliceCounter(content: string): CountSlice {
    return (start: number, end: number): number => {
      const text = content.slice(start, end);
      let count: number;
      try {
        count = this.#tokenizer.countTokens(text);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new MarkdownChunkingError(
          'MARKDOWN_CHUNKING_TOKENIZER_FAILED',
          `Tokenizer "${this.#tokenizer.id}" failed for source range [${String(start)}, ${String(end)}): ${detail}`,
          { startOffset: start, endOffset: end },
        );
      }
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new MarkdownChunkingError(
          'MARKDOWN_CHUNKING_TOKENIZER_FAILED',
          `Tokenizer "${this.#tokenizer.id}" returned ${String(count)} for source range [${String(start)}, ${String(end)}): expected a non-negative safe integer`,
          { startOffset: start, endOffset: end },
        );
      }
      return count;
    };
  }

  #buildBlock(
    document: IngestedSource['document'],
    content: string,
    lines: readonly SourceLine[],
    section: Section,
    group: BlockGroup,
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

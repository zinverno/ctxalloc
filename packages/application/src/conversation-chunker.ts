import {
  CONTEXT_BLOCK_SCHEMA_VERSION,
  ContextBlockSchema,
  SourceDocumentSchema,
  calculateNormalizedContentHash,
  safeParse,
  type ContextBlock,
  type JsonObject,
  type SourceDocument,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
import { cloneJsonValue, issue, sha256, validateTokenizer } from './chunking-primitives.js';
import {
  CONVERSATION_SOURCE_SCHEMA_VERSION,
  ConversationSourceValidationError,
  canonicalConversationContent,
  validateConversationSourcePayload,
  type ConversationSourceMessage,
  type IngestedConversationSource,
} from './conversation-source.js';

/**
 * Deterministic conversation chunking (DEC-039).
 *
 * The rule of version 1 is one line long:
 *
 * ```text
 * one validated message = one ContextBlock
 * ```
 *
 * A message is never split, and that is a provenance constraint rather than a
 * simplification. `SourceLocation` can name a message — `kind:
 * "conversation-message"` with a message identifier — but it has no way to name a
 * *range inside* one. Splitting a long message would therefore emit two blocks
 * whose locations are indistinguishable, so neither could be traced back to the
 * text it actually came from (INV-PROV-002, INV-BLOCK-006).
 *
 * Nothing is rewritten, summarized, merged, reordered, or normalized, and no
 * message is dropped. The chunker reads no file, calls no model, reads no clock,
 * and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/** Stable identity of this chunker, recorded on every block it produces. */
const CHUNKER_ID = 'ctxalloc-conversation-message';
const CHUNKER_VERSION = '1';

/** Payload kind, hashed with the identity data so no other payload can collide with it. */
const CONVERSATION_BLOCK_ID_PAYLOAD_KIND = 'ctxalloc-conversation-context-block-id';

/**
 * Version of the conversation block identity algorithm, hashed with the payload.
 *
 * A change to the canonical tuple must raise this number, which makes the change
 * a visible new identity rather than a silent reinterpretation of stored blocks.
 */
const CONVERSATION_BLOCK_ID_ALGORITHM_VERSION = 1;

/**
 * Invalid chunker construction or chunking input.
 *
 * The issues are project-owned, serializable, and ordered deterministically.
 * Validation-library errors never escape this boundary (INV-ADAPTER-001).
 */
export class ConversationChunkingValidationError extends Error {
  readonly code = 'CONVERSATION_CHUNKING_INVALID_INPUT';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Conversation chunking input is invalid: ${summary}`);
    this.name = 'ConversationChunkingValidationError';
    this.issues = issues;
  }
}

/** Machine-readable categories of a chunking failure that is not an input problem. */
export type ConversationChunkingErrorCode =
  'CONVERSATION_CHUNKING_TOKENIZER_FAILED' | 'CONVERSATION_CHUNKING_INVALID_BLOCK';

/**
 * A chunking failure that is not caused by the caller's input.
 *
 * The failure names the message it was processing, because a conversation has no
 * offsets to point at. A tokenizer-library error or a `DomainValidationError`
 * never escapes (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class ConversationChunkingError extends Error {
  readonly code: ConversationChunkingErrorCode;
  /** Identifier of the message being processed, when the failure is attributable to one. */
  readonly messageId: string | null;
  /** Structured detail for `CONVERSATION_CHUNKING_INVALID_BLOCK`, empty otherwise. */
  readonly issues: readonly ValidationIssue[];

  constructor(
    code: ConversationChunkingErrorCode,
    message: string,
    messageId: string | null,
    issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ConversationChunkingError';
    this.code = code;
    this.messageId = messageId;
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Input validation                                                            */
/* -------------------------------------------------------------------------- */

const IngestedConversationShapeSchema = z.strictObject({
  document: SourceDocumentSchema,
  content: z.string(),
  messages: z.array(z.unknown()),
});

/**
 * Validates the properties this use case relies on.
 *
 * Ingestion already produced a validated record, but the chunker is a runtime
 * boundary: the record can be persisted, transported, or rebuilt by hand
 * (INV-BLOCK-005). The messages are re-validated by the schema that owns the
 * format, and the canonical content is rebuilt from them and compared against
 * both the supplied content and the document hash. That comparison is the
 * provenance proof: it establishes that these exact messages, in this exact
 * order, are the ones the document describes (INV-PROV-005).
 */
function validateSource(source: IngestedConversationSource): {
  readonly document: SourceDocument;
  readonly messages: readonly ConversationSourceMessage[];
} {
  const shape = safeParse(IngestedConversationShapeSchema, source);
  if (!shape.ok) {
    throw new ConversationChunkingValidationError(shape.issues);
  }

  const { document, content } = shape.value;
  const issues: ValidationIssue[] = [];

  if (document.sourceType !== 'conversation') {
    issues.push(
      issue(
        ['document', 'sourceType'],
        `must be "conversation", received "${document.sourceType}"`,
        'invalid_source_type',
      ),
    );
  }

  let messages: readonly ConversationSourceMessage[];
  try {
    messages = validateConversationSourcePayload({
      schemaVersion: CONVERSATION_SOURCE_SCHEMA_VERSION,
      messages: shape.value.messages,
    }).messages;
  } catch (cause) {
    // The format's own validator owns these rules, and its issues are already
    // project-owned and deterministically ordered, so they are carried through
    // rather than restated in a second vocabulary (INV-DEP-003).
    const nested =
      cause instanceof ConversationSourceValidationError
        ? cause.issues
        : [issue(['messages'], 'must be valid conversation messages', 'invalid_value')];
    throw new ConversationChunkingValidationError([...issues, ...nested]);
  }

  const canonical = canonicalConversationContent(messages);
  if (canonical !== content) {
    issues.push(
      issue(
        ['content'],
        'must equal the canonical logical content of the supplied messages',
        'content_mismatch',
      ),
    );
  }
  if (sha256(canonical) !== document.contentHash) {
    issues.push(
      issue(
        ['messages'],
        'must match document.contentHash: the supplied messages hash to a different value',
        'content_hash_mismatch',
      ),
    );
  }

  if (issues.length > 0) {
    throw new ConversationChunkingValidationError(issues);
  }

  return { document, messages };
}

/* -------------------------------------------------------------------------- */
/* Block identity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Derives the deterministic conversation block identity (DEC-039).
 *
 * ```text
 * ["ctxalloc-conversation-context-block-id", 1, sourceDocumentId, messageId, normalizedContentHash]
 * ```
 *
 * The **message identifier** takes part; the message *index* does not. A
 * conversation grows by insertion, so identifying a block by position would give
 * every later message a new identity the moment an earlier one arrived — and a
 * changed block identity invalidates candidate caches, deduplication groups, and
 * every trace that referred to it (INV-BLOCK-001).
 *
 * There is no occurrence counter. Message identifiers are already unique within
 * a conversation, which the payload validation enforces, so two blocks of one
 * conversation can never collide (INV-BLOCK-002).
 */
function conversationBlockId(
  sourceDocumentId: string,
  messageId: string,
  normalizedContentHash: string,
): string {
  const payload = JSON.stringify([
    CONVERSATION_BLOCK_ID_PAYLOAD_KIND,
    CONVERSATION_BLOCK_ID_ALGORITHM_VERSION,
    sourceDocumentId,
    messageId,
    normalizedContentHash,
  ]);
  return `context-block:${sha256(payload)}`;
}

/* -------------------------------------------------------------------------- */
/* Chunker                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic one-message-per-block conversation chunker.
 *
 * The chunker takes no token policy. It has no size decision to make: the
 * message boundary is the block boundary, and a message above any configured
 * maximum is still emitted whole because splitting it would destroy its
 * provenance. Accepting a target and a maximum it could not honor would be a
 * policy the component does not implement.
 */
export class ConversationChunker {
  readonly #tokenizer: Tokenizer;

  /**
   * @throws {ConversationChunkingValidationError} when the tokenizer is invalid.
   */
  constructor(tokenizer: Tokenizer) {
    const issues = validateTokenizer(tokenizer);
    if (issues.length > 0) {
      throw new ConversationChunkingValidationError(issues);
    }
    this.#tokenizer = tokenizer;
  }

  /**
   * Turns one ingested conversation into `ContextBlock` records, in message order.
   *
   * A conversation with no messages yields no blocks. Timestamps fall back from
   * the message to the document and are otherwise absent: no current time is ever
   * substituted, because a compiled result must not depend on when it was
   * compiled (INV-DET-004).
   *
   * @throws {ConversationChunkingValidationError} when the source is not a valid conversation ingestion result.
   * @throws {ConversationChunkingError} when the tokenizer fails or a derived block is not a valid domain record.
   */
  chunk(source: IngestedConversationSource): readonly ContextBlock[] {
    const { document, messages } = validateSource(source);
    return messages.map((message, index) => this.#buildBlock(document, message, index));
  }

  /** Wraps the tokenizer so no external error type and no unusable count escapes. */
  #countTokens(message: ConversationSourceMessage): number {
    let count: number;
    try {
      count = this.#tokenizer.countTokens(message.content);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new ConversationChunkingError(
        'CONVERSATION_CHUNKING_TOKENIZER_FAILED',
        `Tokenizer "${this.#tokenizer.id}" failed for message "${message.id}": ${detail}`,
        message.id,
      );
    }
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new ConversationChunkingError(
        'CONVERSATION_CHUNKING_TOKENIZER_FAILED',
        `Tokenizer "${this.#tokenizer.id}" returned ${String(count)} for message "${message.id}": expected a non-negative safe integer`,
        message.id,
      );
    }
    return count;
  }

  #buildBlock(
    document: SourceDocument,
    message: ConversationSourceMessage,
    messageIndex: number,
  ): ContextBlock {
    // Payload validation has already rejected malformed UTF-16 in message
    // content, so this call cannot throw here.
    const normalizedContentHash = calculateNormalizedContentHash(message.content);
    const tokenCount = this.#countTokens(message);

    // A message timestamp is more specific than the document's, so it wins when
    // present. Neither is invented: when both are absent the field stays absent.
    const createdAt = message.createdAt ?? document.createdAt;
    const updatedAt = message.updatedAt ?? document.updatedAt;

    const metadata: JsonObject = {
      source: cloneJsonValue(document.metadata),
      ...(message.metadata !== undefined ? { message: cloneJsonValue(message.metadata) } : {}),
      chunking: {
        chunkerId: CHUNKER_ID,
        chunkerVersion: CHUNKER_VERSION,
      },
      tokenization: {
        tokenizerId: this.#tokenizer.id,
        tokenizerVersion: this.#tokenizer.version,
      },
    };

    const fields: Record<string, unknown> = {
      id: conversationBlockId(document.id, message.id, normalizedContentHash),
      schemaVersion: CONTEXT_BLOCK_SCHEMA_VERSION,
      scope: document.scope,
      sourceDocumentId: document.id,
      sourceType: document.sourceType,
      // `messageIndex` is recorded as the message's position for a reader, and it
      // is deliberately absent from the identity above.
      sourceLocation: {
        kind: 'conversation-message',
        messageId: message.id,
        messageIndex,
      },
      content: message.content,
      normalizedContentHash,
      tokenCount,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      attributes: {},
      metadata,
    };

    const parsed = safeParse(ContextBlockSchema, fields);
    if (!parsed.ok) {
      throw new ConversationChunkingError(
        'CONVERSATION_CHUNKING_INVALID_BLOCK',
        `Derived block for message "${message.id}" is not a valid ContextBlock`,
        message.id,
        parsed.issues,
      );
    }
    return parsed.value;
  }
}

import {
  JsonObjectSchema,
  ScopeSchema,
  TimestampSchema,
  findLoneSurrogate,
  safeParse,
  type JsonObject,
  type Scope,
  type SourceDocument,
  type Timestamp,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import { issue } from './chunking-primitives.js';
import { ingestSource, type IngestedSource, type SourceIdentity } from './source-ingestion.js';

/**
 * The strict local conversation source format and its ingestion (DEC-039).
 *
 * A conversation arrives as JSON, but JSON *formatting* is a storage
 * representation, not conversation content. Indentation, key order, and
 * whitespace between tokens are all free variables of a serializer, and hashing
 * the raw file would make a reformatted export look like an edited conversation.
 * Ingestion therefore builds one canonical logical representation and hashes
 * that instead (INV-PROV-005).
 *
 * The v1 message shape is deliberately minimal: an identifier, exact content,
 * optional timestamps, optional metadata. There is no role, no tool call, no
 * attachment, no multimodal part, no thread, and no provider-specific envelope.
 * The renderer serializes block content and nothing else, so declaring a `role`
 * field would publish a promise the pipeline does not keep; a speaker label that
 * matters belongs inside the exact message content, where it is rendered
 * (DEC-035, DEC-039).
 */

/** Current schema version of {@link ConversationSourcePayload} (INV-STORE-004). */
export const CONVERSATION_SOURCE_SCHEMA_VERSION = 1;

/** One message of a conversation source. */
export interface ConversationSourceMessage {
  readonly id: string;
  readonly content: string;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly metadata?: JsonObject;
}

/** One complete conversation source document. */
export interface ConversationSourcePayload {
  readonly schemaVersion: typeof CONVERSATION_SOURCE_SCHEMA_VERSION;
  readonly messages: readonly ConversationSourceMessage[];
}

/** Complete input of one conversation ingestion. Every value is explicit. */
export interface ConversationIngestionInput {
  readonly scope: Scope;
  readonly identity: SourceIdentity;
  /** The already-parsed conversation payload, validated here at runtime. */
  readonly payload: unknown;
  readonly title?: string;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly metadata: JsonObject;
}

/**
 * Result of one conversation ingestion.
 *
 * `document` and `content` are exactly what an `IngestedSource` carries, so the
 * record is usable anywhere one is — `content` being the canonical logical
 * representation rather than the raw file. `messages` are the exact validated
 * records the chunker needs, in exact source order.
 */
export interface IngestedConversationSource {
  readonly document: SourceDocument;
  readonly content: string;
  readonly messages: readonly ConversationSourceMessage[];
}

/**
 * Invalid conversation source input.
 *
 * The issues are project-owned, serializable, and deterministically ordered. No
 * `SyntaxError` from `JSON.parse` and no validation-library error escapes this
 * boundary: a malformed file is a structured rejection, not a stack trace from a
 * parser the caller never chose (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class ConversationSourceValidationError extends Error {
  readonly code = 'CONVERSATION_SOURCE_INVALID_INPUT';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Conversation source is invalid: ${summary}`);
    this.name = 'ConversationSourceValidationError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Payload schema                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A message identifier: non-blank, well-formed UTF-16, preserved exactly.
 *
 * Blankness is checked with `trim` and the supplied value is never trimmed,
 * lowercased, or canonicalized: the identifier is bound into the block identity,
 * so rewriting it would silently produce a different block (INV-BLOCK-001).
 */
const messageId = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * Message content: non-blank and well-formed UTF-16, carried verbatim.
 *
 * A whitespace-only message is rejected rather than dropped. Silently discarding
 * it would make the conversation's message count depend on content the caller
 * still believes is there, and an empty block is not an ordinary candidate
 * anyway (INV-BLOCK-004). Rejection makes the problem visible at its source.
 */
const messageContent = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const ConversationSourceMessageSchema = z.strictObject({
  id: messageId,
  content: messageContent,
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema.optional(),
});

/**
 * The runtime boundary of the payload.
 *
 * Unknown fields are rejected rather than stripped, nothing is coerced, and no
 * default is injected. An empty `messages` array is valid: a conversation with
 * no messages is a real state, and it simply produces no blocks.
 */
const ConversationSourcePayloadSchema = z.strictObject({
  schemaVersion: z.literal(CONVERSATION_SOURCE_SCHEMA_VERSION),
  messages: z.array(ConversationSourceMessageSchema),
});

/* -------------------------------------------------------------------------- */
/* Canonical logical content                                                   */
/* -------------------------------------------------------------------------- */

/** Payload kind, hashed with the data so no other payload can collide with it. */
const CONVERSATION_CONTENT_PAYLOAD_KIND = 'ctxalloc-conversation-content';

/**
 * Version of the canonical logical representation, serialized with the payload.
 *
 * A change to the tuple shape must raise this number, which makes the change a
 * visible new content hash rather than a silent reinterpretation of stored
 * conversations.
 */
const CONVERSATION_CONTENT_VERSION = 1;

/**
 * Builds the canonical logical content of one conversation.
 *
 * ```text
 * ["ctxalloc-conversation-content", 1, [[messageId, exactContent], ...]]
 * ```
 *
 * A fixed-order array is serialized rather than an object, so no property
 * insertion order can affect the result (INV-DET-002). Message order
 * participates: reordering a conversation changes what it says, and the hash
 * must reflect that.
 *
 * Message timestamps and metadata deliberately do **not** participate. They
 * describe when a message was recorded and what a provider annotated it with,
 * not what the conversation contains, and letting a re-exported timestamp change
 * the content hash would report an edit that never happened.
 *
 * Message content is never normalized. Line endings, indentation, and Unicode
 * composition are all significant, exactly as they are for a text block.
 */
export function canonicalConversationContent(
  messages: readonly ConversationSourceMessage[],
): string {
  return JSON.stringify([
    CONVERSATION_CONTENT_PAYLOAD_KIND,
    CONVERSATION_CONTENT_VERSION,
    messages.map((message) => [message.id, message.content]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Parsing and validation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parses one conversation source file into a validated payload.
 *
 * `JSON.parse` throws a `SyntaxError`, which is a runtime type of the parser
 * rather than a project failure category, so it is caught and re-reported as a
 * structured issue. The parser message is included because it names the offending
 * position, and it is the parser's own description of the *syntax*, not of the
 * conversation's content.
 *
 * @throws {ConversationSourceValidationError} when the text is not a valid conversation source.
 */
export function parseConversationSourceJson(text: unknown): ConversationSourcePayload {
  if (typeof text !== 'string') {
    throw new ConversationSourceValidationError([
      issue([], 'must be a JSON string', 'invalid_type'),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConversationSourceValidationError([
      issue([], `must be valid JSON: ${detail}`, 'invalid_json'),
    ]);
  }

  return validateConversationSourcePayload(parsed);
}

/**
 * Rebuilds one validated message with absent optional fields left absent.
 *
 * The validated value carries an explicit `undefined` for every omitted optional
 * field. Writing that through would produce a record claiming *there is a
 * timestamp, and it is nothing* — the opposite of the contract — and it would
 * also change what `JSON.stringify` emits for the record. Exact values are
 * copied unchanged (INV-PROV-005).
 */
function toMessage(message: {
  readonly id: string;
  readonly content: string;
  readonly createdAt?: Timestamp | undefined;
  readonly updatedAt?: Timestamp | undefined;
  readonly metadata?: JsonObject | undefined;
}): ConversationSourceMessage {
  return {
    id: message.id,
    content: message.content,
    ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
    ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
  };
}

/** Rejects a repeated message identifier, which would make one block ambiguous. */
function findDuplicateMessageIds(
  messages: readonly ConversationSourceMessage[],
): readonly ValidationIssue[] {
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  messages.forEach((message, index) => {
    if (seen.has(message.id)) {
      issues.push(
        issue(
          ['messages', String(index), 'id'],
          `must be unique within the conversation: "${message.id}" is already used`,
          'duplicate_message_id',
        ),
      );
      return;
    }
    seen.add(message.id);
  });
  return issues;
}

/**
 * Validates one conversation payload strictly, all or nothing.
 *
 * Message identity must be unique because a conversation block is identified by
 * its message identifier rather than its position (DEC-039). Two messages
 * sharing an identifier would produce two blocks claiming one identity, and
 * resolving that by position would reintroduce exactly the fragility the
 * identifier exists to avoid (INV-BLOCK-002).
 *
 * @throws {ConversationSourceValidationError} when the payload is not valid.
 */
export function validateConversationSourcePayload(payload: unknown): ConversationSourcePayload {
  const parsed = safeParse(ConversationSourcePayloadSchema, payload);
  if (!parsed.ok) {
    throw new ConversationSourceValidationError(parsed.issues);
  }

  const messages = parsed.value.messages.map(toMessage);

  const duplicates = findDuplicateMessageIds(messages);
  if (duplicates.length > 0) {
    throw new ConversationSourceValidationError(duplicates);
  }

  return { schemaVersion: parsed.value.schemaVersion, messages };
}

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                   */
/* -------------------------------------------------------------------------- */

const ConversationIngestionInputSchema = z.strictObject({
  scope: ScopeSchema,
  identity: z.strictObject({
    namespace: z.string().refine((value) => value.trim().length > 0, {
      message: 'must not be empty or whitespace-only',
    }),
    key: z.string().refine((value) => value.trim().length > 0, {
      message: 'must not be empty or whitespace-only',
    }),
  }),
  payload: z.unknown(),
  title: z.string().optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema,
});

/**
 * Ingests one conversation source.
 *
 * The payload is validated, the canonical logical content is built from the
 * validated messages, and `ingestSource` derives the document identity and
 * hashes that canonical string with `sourceType: "conversation"`. Existing
 * Markdown and plain-text ingestion semantics are untouched: this use case adds
 * a canonical representation step in front of `ingestSource`, it does not change
 * what `ingestSource` does (DEC-028).
 *
 * The consequences are exactly the two the format needs:
 *
 * * reformatting the JSON file — indentation, key order, trailing newline —
 *   changes neither `SourceDocument.id` nor `contentHash`;
 * * changing a message identifier, a message's content, or the order of the
 *   messages changes `contentHash`, because all three change what the
 *   conversation says.
 *
 * @throws {ConversationSourceValidationError} when the input or the payload is invalid.
 */
export function ingestConversationSource(input: unknown): IngestedConversationSource {
  const parsed = safeParse(ConversationIngestionInputSchema, input);
  if (!parsed.ok) {
    throw new ConversationSourceValidationError(parsed.issues);
  }

  const payload = validateConversationSourcePayload(parsed.value.payload);
  const content = canonicalConversationContent(payload.messages);

  const ingested: IngestedSource = ingestSource({
    scope: parsed.value.scope,
    sourceType: 'conversation',
    identity: parsed.value.identity,
    content,
    ...(parsed.value.title !== undefined ? { title: parsed.value.title } : {}),
    ...(parsed.value.createdAt !== undefined ? { createdAt: parsed.value.createdAt } : {}),
    ...(parsed.value.updatedAt !== undefined ? { updatedAt: parsed.value.updatedAt } : {}),
    metadata: parsed.value.metadata,
  });

  return {
    document: ingested.document,
    content: ingested.content,
    messages: payload.messages,
  };
}

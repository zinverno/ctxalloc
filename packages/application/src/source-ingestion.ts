import { createHash } from 'node:crypto';
import {
  JsonObjectSchema,
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  ScopeSchema,
  SourceDocumentSchema,
  SourceTypeSchema,
  TimestampSchema,
  parseOrThrow,
  safeParse,
  type JsonObject,
  type Scope,
  type SourceDocument,
  type SourceType,
  type Timestamp,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';

/**
 * Pure source ingestion (DEC-028).
 *
 * The use case receives source content that the caller has already read, an
 * explicit logical identity, and an explicit scope. It validates that input,
 * derives a stable `SourceDocument` identity, hashes the exact source content,
 * and returns the record together with the unchanged content.
 *
 * It deliberately does not: read a file, walk a directory, fetch a URL, infer a
 * scope or a path, read the clock, generate a random value, normalize text, parse
 * Markdown or frontmatter, split content, create `ContextBlock` records, count
 * tokens, call a model, or persist anything. Reading bytes belongs to a future
 * SourceReader adapter, and chunking belongs to a later phase; neither exists yet
 * (ARCHITECTURE section 9).
 */

/**
 * Caller-controlled logical identity of one source.
 *
 * `namespace` names the identity namespace the caller owns, `key` names one
 * logical source inside it. Both are exact strings: they are never trimmed,
 * lowercased, or otherwise rewritten, because the derived document identity must
 * stay stable and reproducible (INV-BLOCK-001, INV-PROV-005).
 *
 * Neither component is a machine-specific absolute path by definition. A future
 * file reader can build them from a stable vault identifier plus a relative path,
 * and a future conversation reader from a provider namespace plus a stable
 * conversation identifier. Provider identifiers and paths may additionally travel
 * in `metadata`, where they remain untrusted source metadata (INV-SEC-001).
 */
export interface SourceIdentity {
  readonly namespace: string;
  readonly key: string;
}

/** Complete input of one ingestion. Every value is explicit; nothing is inferred. */
export interface SourceIngestionInput {
  readonly scope: Scope;
  readonly sourceType: SourceType;
  readonly identity: SourceIdentity;
  /** Exact source content, already in memory. */
  readonly content: string;
  readonly title?: string;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly metadata: JsonObject;
}

/** Result of one ingestion: the validated record and the unchanged content. */
export interface IngestedSource {
  readonly document: SourceDocument;
  /** The exact string the caller supplied, ready for a future chunker. */
  readonly content: string;
}

/**
 * Invalid ingestion input.
 *
 * The issues are project-owned, serializable, and ordered deterministically, so a
 * future CLI, HTTP API, or trace can report them without re-deriving meaning from
 * a free-text message. Validation-library errors never escape this boundary
 * (INV-ADAPTER-001).
 */
export class SourceIngestionValidationError extends Error {
  readonly code = 'SOURCE_INGESTION_INVALID_INPUT';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Source ingestion input is invalid: ${summary}`);
    this.name = 'SourceIngestionValidationError';
    this.issues = issues;
  }
}

/**
 * Identity components are validated for emptiness but never rewritten, matching
 * how the domain validates its own identifiers.
 */
const exactNonBlankString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

const SourceIdentitySchema = z.strictObject({
  namespace: exactNonBlankString,
  key: exactNonBlankString,
});

/**
 * Strict input schema: unknown fields are rejected rather than stripped, no value
 * is coerced, and no default is injected. Optional fields that are absent stay
 * absent.
 */
const SourceIngestionInputSchema = z.strictObject({
  scope: ScopeSchema,
  sourceType: SourceTypeSchema,
  identity: SourceIdentitySchema,
  content: z.string(),
  title: z.string().optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema,
});

type ValidatedInput = z.infer<typeof SourceIngestionInputSchema>;

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

function malformedUnicodeIssue(path: readonly string[], index: number): ValidationIssue {
  return {
    code: 'invalid_unicode',
    path,
    pointer: path.join('.'),
    message: `must be well-formed UTF-16: lone surrogate at code unit ${String(index)}`,
  };
}

/**
 * Collects malformed-UTF-16 failures for the values that are hashed.
 *
 * A lone surrogate has no UTF-8 encoding. Encoders substitute U+FFFD, which would
 * produce a hash of text the caller never supplied, so ingestion fails before any
 * hashing happens (INV-BLOCK-007, INV-PROV-005).
 *
 * The checked values are the ones this phase encodes as UTF-8 itself: the identity
 * components and the source content. Scope values reach the identity payload
 * through `JSON.stringify`, which escapes a lone surrogate as `\uXXXX` instead of
 * losing it, so the payload stays exactly recoverable either way.
 *
 * The order of the checks is fixed, so identical invalid input always reports
 * identical issues (INV-DET-001).
 */
function findMalformedUnicode(input: ValidatedInput): readonly ValidationIssue[] {
  const checked: readonly (readonly [readonly string[], string])[] = [
    [['identity', 'namespace'], input.identity.namespace],
    [['identity', 'key'], input.identity.key],
    [['content'], input.content],
  ];

  return checked.flatMap(([path, value]) => {
    const index = findLoneSurrogate(value);
    return index === null ? [] : [malformedUnicodeIssue(path, index)];
  });
}

/** SHA-256 over the UTF-8 encoding of `text`, rendered as `sha256:<64 lowercase hex>`. */
function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Payload kind, kept inside the hashed data so another payload cannot collide with it. */
const SOURCE_DOCUMENT_ID_PAYLOAD_KIND = 'ctxalloc-source-document-id';

/**
 * Version of the identity algorithm, hashed with the payload.
 *
 * A future change to the canonical tuple must raise this number, which makes the
 * change a visible new identity rather than a silent reinterpretation of the
 * existing one.
 */
const SOURCE_DOCUMENT_ID_ALGORITHM_VERSION = 1;

/**
 * Derives the stable document identity from logical identity only (DEC-028).
 *
 * Content is deliberately absent from the payload: editing one logical source must
 * change its `contentHash` without creating a second document identity
 * (INV-BLOCK-001). Scope participates so the same key in another tenant,
 * workspace, or project never reuses one project-owned document ID
 * (INV-SCOPE-002), and the source type participates so one key cannot silently
 * change meaning between source kinds.
 *
 * A fixed-order array is serialized rather than an object, so no property
 * insertion order can affect the result (INV-DET-002).
 */
function deriveSourceDocumentId(
  scope: Scope,
  sourceType: SourceType,
  identity: SourceIdentity,
): string {
  const payload = JSON.stringify([
    SOURCE_DOCUMENT_ID_PAYLOAD_KIND,
    SOURCE_DOCUMENT_ID_ALGORITHM_VERSION,
    scope.tenantId,
    scope.workspaceId,
    scope.projectId ?? null,
    sourceType,
    identity.namespace,
    identity.key,
  ]);
  return `source-document:${sha256(payload)}`;
}

/**
 * Builds the record fields.
 *
 * Optional fields are written only when the caller supplied them, so an absent
 * value stays absent instead of becoming a present `undefined`. No field is
 * injected: the logical identity itself is not a `SourceDocument` field and is
 * never silently copied into `metadata`.
 */
function buildDocumentFields(input: ValidatedInput): Record<string, unknown> {
  return {
    id: deriveSourceDocumentId(input.scope, input.sourceType, input.identity),
    schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
    scope: input.scope,
    sourceType: input.sourceType,
    ...(input.title !== undefined ? { title: input.title } : {}),
    contentHash: sha256(input.content),
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
    metadata: input.metadata,
  };
}

/**
 * Ingests one source that the caller has already read.
 *
 * The parameter is `unknown` because this function is a runtime boundary:
 * compile-time types are not sufficient for data arriving from a file, a request,
 * or a provider (INV-BLOCK-005).
 *
 * The returned `content` is the exact string that was supplied. No trimming, no
 * Unicode normalization, no line-ending rewriting, no BOM removal, and no
 * trailing-newline adjustment happens anywhere in this module, so the hash always
 * describes the bytes the caller actually holds.
 *
 * @throws {SourceIngestionValidationError} when the input is not a valid ingestion request.
 */
export function ingestSource(input: unknown): IngestedSource {
  const parsed = safeParse(SourceIngestionInputSchema, input);
  if (!parsed.ok) {
    throw new SourceIngestionValidationError(parsed.issues);
  }

  const malformed = findMalformedUnicode(parsed.value);
  if (malformed.length > 0) {
    throw new SourceIngestionValidationError(malformed);
  }

  // The fields are derived from already validated values, so this parse cannot
  // fail. It is kept as the final guarantee that what leaves this function really
  // satisfies the persisted domain schema (INV-STORE-004).
  const document = parseOrThrow(SourceDocumentSchema, buildDocumentFields(parsed.value));

  return { document, content: parsed.value.content };
}

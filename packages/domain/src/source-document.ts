import { z } from 'zod';
import { ContentHashSchema } from './content-hash.js';
import { SourceDocumentIdSchema } from './ids.js';
import { JsonObjectSchema } from './json-value.js';
import { ScopeSchema } from './scope.js';
import { SourceTypeSchema } from './source-type.js';
import { TimestampSchema } from './timestamp.js';

/** Current persisted schema version for `SourceDocument` (INV-STORE-004). */
export const SOURCE_DOCUMENT_SCHEMA_VERSION = 1;

/**
 * Source-level record (ARCHITECTURE section 5.2).
 *
 * The record describes the source object, not its full content: blocks carry the
 * content once they have been created.
 *
 * `id` is the project-owned stable identity. An absolute local filesystem path is
 * never the identity field; a path may travel in `metadata` as ordinary source
 * metadata, which the compiler treats as untrusted data (INV-SEC-001).
 *
 * The object is strict, so unknown fields are rejected rather than silently
 * stripped. That keeps an unsupported or future record shape a visible failure.
 */
export const SourceDocumentSchema = z.strictObject({
  id: SourceDocumentIdSchema,
  schemaVersion: z.literal(SOURCE_DOCUMENT_SCHEMA_VERSION),
  scope: ScopeSchema,
  sourceType: SourceTypeSchema,
  title: z.string().optional(),
  contentHash: ContentHashSchema,
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema,
});

export type SourceDocument = Readonly<z.infer<typeof SourceDocumentSchema>>;

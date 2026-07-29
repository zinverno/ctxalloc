import { z } from 'zod';
import { ContentHashSchema } from './content-hash.js';
import { ContextBlockIdSchema, SourceDocumentIdSchema } from './ids.js';
import { JsonObjectSchema } from './json-value.js';
import { ScopeSchema } from './scope.js';
import { SourceLocationSchema } from './source-location.js';
import { SourceTypeSchema } from './source-type.js';
import { TimestampSchema } from './timestamp.js';

/** Current persisted schema version for `ContextBlock` (INV-STORE-004). */
export const CONTEXT_BLOCK_SCHEMA_VERSION = 1;

/**
 * Query-independent authored attributes of a block (DEC-026).
 *
 * These values describe the block itself and stay identical no matter which
 * query is being compiled. Query-dependent retrieval scores do not belong here:
 * a provider's relevance or recency score is a property of one retrieval for one
 * query, so storing it on the canonical entity would make the record's meaning
 * depend on the last query that touched it. Those values will travel on a future
 * candidate wrapper, and calculated scores on a future scoring result.
 *
 * `required` is a declaration only. Required blocks form a separate allocation
 * class and must never be modelled as a large score (INV-SCORE-003); that logic
 * belongs to the allocator, not to this record.
 */
const ContextBlockAttributesSchema = z.strictObject({
  required: z.boolean().optional(),
  priority: z.number().int().optional(),
  category: z.string().optional(),
});

export type ContextBlockAttributes = Readonly<z.infer<typeof ContextBlockAttributesSchema>>;

/**
 * The smallest independently selectable unit of context (ARCHITECTURE 5.3).
 *
 * Provenance is mandatory: every block references a source document
 * (INV-PROV-001) and carries a content hash derived from its canonical content
 * (INV-PROV-005). Content is validated but never trimmed or rewritten, so the
 * extractive guarantee holds byte-for-byte (DEC-014).
 *
 * The record is query-independent (DEC-026): it contains only source-derived or
 * explicitly authored data. It deliberately contains no retrieval score, scoring
 * result, allocation decision, trace decision, rendered output, or generated
 * summary. Those are produced by later stages and must not be stored here.
 */
export const ContextBlockSchema = z.strictObject({
  id: ContextBlockIdSchema,
  schemaVersion: z.literal(CONTEXT_BLOCK_SCHEMA_VERSION),
  scope: ScopeSchema,

  sourceDocumentId: SourceDocumentIdSchema,
  sourceType: SourceTypeSchema,
  sourceLocation: SourceLocationSchema.optional(),

  // A block with empty or whitespace-only content is not an ordinary candidate
  // (INV-BLOCK-004). The check never mutates the value.
  content: z.string().refine((value) => value.trim().length > 0, {
    message: 'must not be empty or whitespace-only',
  }),
  normalizedContentHash: ContentHashSchema,

  // Supplied measurement data, not a trusted final rendered count. The compiler
  // must validate or recompute it before allocation (INV-BLOCK-003), and the
  // rendered context remains the source of truth for the budget (INV-BUDGET-002).
  tokenCount: z.number().int().min(0),

  headingPath: z.array(z.string()).optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),

  attributes: ContextBlockAttributesSchema,
  metadata: JsonObjectSchema,
});

export type ContextBlock = Readonly<z.infer<typeof ContextBlockSchema>>;

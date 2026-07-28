import { z } from 'zod';

/**
 * Project-owned identifier values.
 *
 * Identifiers are opaque strings supplied by ingestion. The domain validates
 * them but never generates them: block identifiers must be derived from stable
 * source identity and location (INV-BLOCK-001), so random or time-based
 * generation is forbidden here and in every later phase of the kernel
 * (INV-DET-003).
 *
 * Validation checks trimmed emptiness but never rewrites the value. No
 * canonicalization is applied, because the documents do not define one and
 * silently changing an identifier would break stability guarantees.
 */
const identifier = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

export const SourceDocumentIdSchema = identifier.brand<'SourceDocumentId'>();
export type SourceDocumentId = z.infer<typeof SourceDocumentIdSchema>;

export const ContextBlockIdSchema = identifier.brand<'ContextBlockId'>();
export type ContextBlockId = z.infer<typeof ContextBlockIdSchema>;

import { z } from 'zod';

/**
 * Source kinds supported by the current MVP (MVP_SCOPE section 3.10):
 * Markdown documents, plain text documents, and conversation messages.
 *
 * The architecture sketch types this field as `string`, but the MVP scope
 * defines a closed set, so the domain encodes the closed set. Adding a kind is a
 * deliberate scope change, not an incidental string value.
 *
 * Obsidian is a Markdown source carrying extra metadata, not a separate kind.
 */
export const SOURCE_TYPES = ['markdown', 'text', 'conversation'] as const;

export const SourceTypeSchema = z.enum(SOURCE_TYPES);

export type SourceType = z.infer<typeof SourceTypeSchema>;

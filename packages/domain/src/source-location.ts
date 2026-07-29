import { z } from 'zod';

/**
 * Where a block came from inside its source document (INV-PROV-002).
 *
 * Only the two location kinds required by the current MVP sources are modelled.
 * Page, PDF, binary-document, DOM, database-row, and provider-specific variants
 * are intentionally absent until a document requires them.
 */

const nonNegativeInteger = z.number().int().min(0);
const positiveInteger = z.number().int().min(1);

/**
 * A character range inside a text or Markdown document.
 *
 * INV-BLOCK-006 requires `0 <= startOffset <= endOffset <= sourceLength`. The
 * first two relations are checked here. The comparison against `sourceLength`
 * cannot be checked by the domain, which never reads source files; it belongs to
 * the ingestion adapter that produced the range. Invalid boundaries are rejected
 * rather than silently corrected.
 */
const TextRangeLocationSchema = z
  .strictObject({
    kind: z.literal('text-range'),
    startOffset: nonNegativeInteger,
    endOffset: nonNegativeInteger,
    startLine: positiveInteger.optional(),
    endLine: positiveInteger.optional(),
  })
  .refine((location) => location.endOffset >= location.startOffset, {
    message: 'endOffset must not be less than startOffset',
    path: ['endOffset'],
  })
  .refine(
    (location) =>
      location.startLine === undefined ||
      location.endLine === undefined ||
      location.endLine >= location.startLine,
    { message: 'endLine must not be less than startLine', path: ['endLine'] },
  );

/**
 * A single message inside a conversation source. Conversation messages are an
 * explicit MVP source type (MVP_SCOPE section 3.9), and a message identifier is
 * documented lineage (INV-PROV-002).
 */
const ConversationMessageLocationSchema = z.strictObject({
  kind: z.literal('conversation-message'),
  messageId: z.string().refine((value) => value.trim().length > 0, {
    message: 'must not be empty or whitespace-only',
  }),
  messageIndex: nonNegativeInteger.optional(),
});

export const SourceLocationSchema = z.discriminatedUnion('kind', [
  TextRangeLocationSchema,
  ConversationMessageLocationSchema,
]);

export type SourceLocation = Readonly<z.infer<typeof SourceLocationSchema>>;
export type TextRangeLocation = Readonly<z.infer<typeof TextRangeLocationSchema>>;
export type ConversationMessageLocation = Readonly<
  z.infer<typeof ConversationMessageLocationSchema>
>;

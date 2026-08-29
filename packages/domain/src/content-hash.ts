import { z } from 'zod';

/**
 * Serialized content hash value.
 *
 * The invariants require content hashes to be derived from canonical content
 * using a documented algorithm (INV-PROV-005), but they do not fix a wire
 * format. The domain therefore defines the accepted *representation* and
 * validates it strictly:
 *
 *     sha256:<64 lowercase hexadecimal characters>
 *
 * Labelling the algorithm inside the value keeps the record self-describing and
 * makes a future algorithm change an explicit, detectable migration rather than
 * a silent reinterpretation of existing data.
 *
 * This module defines and validates the *representation* only. The canonical
 * `ContextBlock.normalizedContentHash` computation lives in
 * `block-content-hash.ts` (DEC-030); the exact `SourceDocument.contentHash` over
 * complete source content stays an ingestion concern.
 */
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const ContentHashSchema = z
  .string()
  .regex(CONTENT_HASH_PATTERN, {
    message: 'must be a content hash of the form "sha256:<64 lowercase hex characters>"',
  })
  .brand<'ContentHash'>();

export type ContentHash = z.infer<typeof ContentHashSchema>;

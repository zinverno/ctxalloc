import { z } from 'zod';
import { ContextBlockSchema } from './context-block.js';
import { JsonObjectSchema } from './json-value.js';
import { findLoneSurrogate } from './unicode.js';

/** Current schema version for `CandidateBlock` (INV-STORE-004). */
export const CANDIDATE_BLOCK_SCHEMA_VERSION = 1;

/**
 * Provider-supplied strings are untrusted input that later travels into a
 * compilation trace, so they are validated but never rewritten.
 *
 * Blankness is checked with `trim`; the exact supplied value is preserved. No
 * lowercasing, trimming, or canonicalization is applied, because a provider
 * identity is an opaque value the provider owns, and silently rewriting it would
 * make two traces disagree about which counts and scores are comparable.
 *
 * Malformed UTF-16 is rejected here even though the existing identifier and
 * scope schemas check blankness only. Retrieval strings arrive from an external
 * system, which is exactly where a lone surrogate is likely to appear, and
 * rejecting it costs nothing for a value that has never been persisted. The
 * older identifier schemas are deliberately left unchanged: tightening them
 * could reject already-stored records and belongs to its own migration.
 */
const providerString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, {
    message: 'must be well-formed UTF-16',
  });

/**
 * One provider-defined relevance value for one retrieval of one block.
 *
 * The value is carried, never interpreted. Providers disagree on scale and even
 * on direction — a cosine similarity rises with relevance while a distance falls
 * — so `semantics` names the provider's metric and `higherIsBetter` states the
 * direction explicitly rather than letting a consumer assume one (INV-SCORE-002).
 *
 * Negative values are accepted because the provider scale is not normalized at
 * this stage. `NaN` and `Infinity` are rejected: neither is a usable measurement
 * and neither survives a JSON round trip (INV-SCORE-004).
 */
export const CandidateRetrievalScoreSchema = z.strictObject({
  value: z.number().refine((value) => Number.isFinite(value), {
    message: 'must be a finite number',
  }),
  semantics: providerString,
  higherIsBetter: z.boolean(),
});

export type CandidateRetrievalScore = Readonly<z.infer<typeof CandidateRetrievalScoreSchema>>;

/**
 * What one retrieval provider reported about one block for one request.
 *
 * `rank` is the provider's own position, not canonical ordering: providers
 * disagree on whether the first result is rank 0 or rank 1, so zero is valid and
 * the compiler never treats the value as an ordering instruction
 * (INV-ALLOC-002). A negative, fractional, or unsafe rank is rejected.
 *
 * `metadata` carries provider-specific data such as a provider-side identifier.
 * It is ordinary untrusted source metadata: it never replaces a project-owned
 * identifier (INV-ADAPTER-002) and never becomes compiler policy (INV-SEC-001).
 */
export const CandidateRetrievalSchema = z.strictObject({
  providerId: providerString,
  providerVersion: providerString,
  rank: z
    .number()
    .refine((value) => Number.isSafeInteger(value) && value >= 0, {
      message: 'must be a non-negative safe integer',
    })
    .optional(),
  score: CandidateRetrievalScoreSchema.optional(),
  metadata: JsonObjectSchema.optional(),
});

export type CandidateRetrieval = Readonly<z.infer<typeof CandidateRetrievalSchema>>;

/**
 * An ephemeral request-specific wrapper around one canonical `ContextBlock`
 * (DEC-026, DEC-030).
 *
 * `ContextBlock` stays query-independent: the same record is valid for every
 * query in its scope. Retrieval-supplied values describe one retrieval for one
 * query, so they live here and are never written back into the block.
 *
 * The wrapper has no identity of its own. `block.id` remains the project-owned
 * stable block identifier, so two wrappers may legitimately carry the same block
 * with different retrieval data, and deciding what to do with that pair belongs
 * to deduplication, not to this record.
 *
 * `retrieval` is optional so a direct or statically authored candidate needs no
 * fabricated provider. The record deliberately contains no normalized relevance,
 * recency, redundancy, or utility score, no allocation decision, no trace
 * decision, and no rendered text: those are produced by later compiler stages.
 */
export const CandidateBlockSchema = z.strictObject({
  schemaVersion: z.literal(CANDIDATE_BLOCK_SCHEMA_VERSION),
  block: ContextBlockSchema,
  retrieval: CandidateRetrievalSchema.optional(),
});

export type CandidateBlock = Readonly<z.infer<typeof CandidateBlockSchema>>;

import {
  TimestampSchema,
  calculateNormalizedContentHash,
  type ContextBlock,
  type Scope,
  type SourceDocument,
  type Timestamp,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

/**
 * Deterministic construction helpers for the v1 retrieval dataset (DEC-041).
 *
 * Blocks are built here rather than written out as literal JSON for the same
 * reason the evaluation dataset builds its own: a block carries a
 * `normalizedContentHash` and a `tokenCount` that `CandidateValidator`
 * recomputes and rejects if they disagree, so both are derived — the hash by the
 * domain's canonical helper, the count by the tokenizer the run will actually
 * use. That also lets this corpus feed a real compilation, not only a retrieval
 * measurement.
 *
 * Nothing here reads a clock, a random value, the filesystem, the network, or
 * the environment: two builds over one tokenizer are byte-identical
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/** The one scope every in-scope retrieval record belongs to. */
export const RETRIEVAL_SCOPE: Scope = { tenantId: 'bench', workspaceId: 'retrieval-v1' };

/** A second scope, used only to prove that one corpus cannot reach another. */
export const RETRIEVAL_FOREIGN_SCOPE: Scope = { tenantId: 'bench', workspaceId: 'retrieval-other' };

/** Stable dataset identity, reported by every run over this suite. */
export const RETRIEVAL_DATASET_ID = 'ctxalloc-retrieval-v1';

/** Stable dataset version. Bumped when a case is added, removed, or changed. */
export const RETRIEVAL_DATASET_VERSION = '1';

/**
 * The explicit instant every retrieval request carries.
 *
 * Retrieval v1 does **not** rank on it. It is supplied because the port requires
 * it, and a fixture that omitted it could not be handed to a provider at all
 * (INV-DET-004).
 */
export const RETRIEVAL_REFERENCE_TIME: Timestamp = TimestampSchema.parse(
  '2026-06-01T12:00:00.000Z',
);

/** One source document, hashed over the exact text it stands for. */
export function retrievalDocument(
  id: string,
  content: string,
  scope: Scope = RETRIEVAL_SCOPE,
): SourceDocument {
  return {
    id,
    schemaVersion: 1,
    scope,
    sourceType: 'markdown',
    contentHash: calculateNormalizedContentHash(content),
    metadata: {},
  } as SourceDocument;
}

/** Optional per-block annotations a fixture may set. */
export interface RetrievalBlockOptions {
  readonly scope?: Scope;
  readonly headingPath?: readonly string[];
  readonly required?: boolean;
  readonly priority?: number;
  readonly category?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * One canonical block whose hash and token count are derived, never asserted.
 *
 * Some fixtures deliberately carry a heading path, an authored priority, a
 * category, a required flag, and timestamps. Retrieval v1 must ignore every one
 * of them: they exist here precisely so a test can prove that ranking did not
 * move when they changed (DEC-041).
 */
export function retrievalBlock(
  id: string,
  sourceDocumentId: string,
  content: string,
  tokenizer: Tokenizer,
  options: RetrievalBlockOptions = {},
): ContextBlock {
  return {
    id,
    schemaVersion: 1,
    scope: options.scope ?? RETRIEVAL_SCOPE,
    sourceDocumentId,
    sourceType: 'markdown',
    sourceLocation: {
      kind: 'text-range',
      startOffset: 0,
      endOffset: content.length,
      startLine: 1,
    },
    content,
    normalizedContentHash: calculateNormalizedContentHash(content),
    tokenCount: tokenizer.countTokens(content),
    ...(options.headingPath === undefined ? {} : { headingPath: options.headingPath }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    attributes: {
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.category === undefined ? {} : { category: options.category }),
    },
    metadata: {},
  } as ContextBlock;
}

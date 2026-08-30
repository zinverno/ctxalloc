/**
 * Public domain contract for CtxAlloc.
 *
 * This package owns the canonical vocabulary used by every later layer
 * (DEC-006). It contains data definitions and validation only: no retrieval, no
 * tokenization, no allocation, no rendering, and no infrastructure dependency
 * (INV-DEP-001).
 *
 * The one exception is the canonical block content hash, which uses the Node
 * standard library. Hashing is a pure function of the supplied string, not an
 * infrastructure dependency: it reaches no database, framework, filesystem, or
 * SDK, and it is owned here so that the chunker which writes a hash and the
 * validator which rechecks it cannot drift apart (DEC-030, INV-DEP-003).
 */

export {
  calculateNormalizedContentHash,
  normalizeContextBlockContentForHash,
} from './block-content-hash.js';
export {
  CANDIDATE_BLOCK_SCHEMA_VERSION,
  CandidateBlockSchema,
  CandidateRetrievalSchema,
  CandidateRetrievalScoreSchema,
  type CandidateBlock,
  type CandidateRetrieval,
  type CandidateRetrievalScore,
} from './candidate-block.js';
export { ContentHashSchema, type ContentHash } from './content-hash.js';
export {
  CONTEXT_BLOCK_SCHEMA_VERSION,
  ContextBlockSchema,
  type ContextBlock,
  type ContextBlockAttributes,
} from './context-block.js';
export {
  ContextBlockIdSchema,
  SourceDocumentIdSchema,
  type ContextBlockId,
  type SourceDocumentId,
} from './ids.js';
export {
  JsonObjectSchema,
  JsonValueSchema,
  type JsonObject,
  type JsonValue,
} from './json-value.js';
export { ScopeSchema, scopesEqual, type Scope } from './scope.js';
export {
  SourceLocationSchema,
  type ConversationMessageLocation,
  type SourceLocation,
  type TextRangeLocation,
} from './source-location.js';
export {
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  SourceDocumentSchema,
  type SourceDocument,
} from './source-document.js';
export { SOURCE_TYPES, SourceTypeSchema, type SourceType } from './source-type.js';
export { TimestampSchema, type Timestamp } from './timestamp.js';
export {
  TokenBudgetSchema,
  availableInputTokens,
  configuredReservedTokens,
  type TokenBudget,
} from './token-budget.js';
export { findLoneSurrogate } from './unicode.js';
export {
  DomainValidationError,
  parseOrThrow,
  safeParse,
  type ValidationIssue,
  type ValidationResult,
} from './validation.js';

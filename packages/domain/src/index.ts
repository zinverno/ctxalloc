/**
 * Public domain contract for CtxAlloc.
 *
 * This package owns the canonical vocabulary used by every later layer
 * (DEC-006). It contains data definitions and validation only: no retrieval, no
 * tokenization, no allocation, no rendering, and no infrastructure dependency
 * (INV-DEP-001).
 */

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
  DomainValidationError,
  parseOrThrow,
  safeParse,
  type ValidationIssue,
  type ValidationResult,
} from './validation.js';

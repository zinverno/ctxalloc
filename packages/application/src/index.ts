/**
 * Application use cases for CtxAlloc.
 *
 * This layer coordinates use cases over the domain model (ARCHITECTURE section
 * 3.2). It owns no budget or selection logic, calls no model, and reaches no
 * external system.
 *
 * Two use cases exist in this phase, and both are synchronous, deterministic, and
 * offline:
 *
 * - deterministic source ingestion (DEC-028) turns explicit, already-read source
 *   content into a validated `SourceDocument` plus the unchanged content;
 * - deterministic Markdown chunking (DEC-029) turns one ingested Markdown source
 *   into runtime-validated `ContextBlock` records whose content is exact source
 *   text.
 *
 * Reading sources from disk remains a future SourceReader adapter, and retrieval,
 * scoring, allocation, rendering, and traces remain later phases.
 */

export {
  MarkdownChunker,
  MarkdownChunkingError,
  MarkdownChunkingValidationError,
  type MarkdownChunkingErrorCode,
  type MarkdownChunkingOptions,
  type MarkdownChunkingRange,
} from './markdown-chunker.js';
export {
  SourceIngestionValidationError,
  ingestSource,
  type IngestedSource,
  type SourceIdentity,
  type SourceIngestionInput,
} from './source-ingestion.js';

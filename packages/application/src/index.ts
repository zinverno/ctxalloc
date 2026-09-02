/**
 * Application use cases for CtxAlloc.
 *
 * This layer coordinates use cases over the domain model and the compiler kernel
 * (ARCHITECTURE section 3.2). It owns no budget or selection logic, calls no
 * model, and reaches no external system directly: filesystem access, the control
 * plane, and retrieval all arrive through project-owned ports, so every use case
 * here runs offline in a test (INV-DEP-002).
 *
 * The implemented use cases are:
 *
 * - deterministic source ingestion (DEC-028) — explicit already-read content
 *   becomes a validated `SourceDocument` plus the unchanged content;
 * - deterministic Markdown chunking (DEC-029) — one ingested Markdown source
 *   becomes `ContextBlock` records whose content is exact source text;
 * - deterministic plain-text chunking (DEC-039) — the same, over maximal
 *   non-blank line runs;
 * - conversation source ingestion and chunking (DEC-039) — one strict local JSON
 *   conversation becomes a document hashed over its canonical logical content,
 *   and one block per message;
 * - the local source-to-compilation slice (DEC-039) —
 *   `CompileLocalContextService` joins the control store, the source reader,
 *   ingestion, chunking, the candidate provider, and `ContextCompiler` into one
 *   path from registered local sources to a `CompilationResult`.
 *
 * Real retrieval, model execution, the evaluation harness, persistence, the CLI,
 * and the HTTP API remain later phases.
 */

export {
  CompileLocalContextService,
  LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION,
  LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION,
  LocalSourcePipelineError,
  type LocalCompilationRequest,
  type LocalCompilationResult,
  type LocalCompileServiceConfig,
  type LocalSourcePipelineStage,
} from './compile-local-context-service.js';
export {
  ConversationChunker,
  ConversationChunkingError,
  ConversationChunkingValidationError,
  type ConversationChunkingErrorCode,
} from './conversation-chunker.js';
export {
  CONVERSATION_SOURCE_SCHEMA_VERSION,
  ConversationSourceValidationError,
  ingestConversationSource,
  parseConversationSourceJson,
  validateConversationSourcePayload,
  type ConversationIngestionInput,
  type ConversationSourceMessage,
  type ConversationSourcePayload,
  type IngestedConversationSource,
} from './conversation-source.js';
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
export {
  TextChunker,
  TextChunkingError,
  TextChunkingValidationError,
  type TextChunkingErrorCode,
  type TextChunkingOptions,
  type TextChunkingRange,
} from './text-chunker.js';

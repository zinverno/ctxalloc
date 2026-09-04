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
 * - deterministic local corpus preparation (DEC-042) —
 *   `PrepareLocalCorpusService` turns the registrations of one scope into the
 *   canonical `SourceDocument` and `ContextBlock` corpus, retrieving nothing and
 *   compiling nothing;
 * - the local source-to-compilation slice (DEC-039) —
 *   `CompileLocalContextService` joins that preparation with the candidate
 *   provider and `ContextCompiler` into one path from registered local sources
 *   to a `CompilationResult`;
 * - control-plane registration validation (DEC-042) — `source-registration.ts`
 *   owns the one runtime boundary and the one canonical order every reader and
 *   writer of a `SourceRegistration` uses;
 * - control-plane writing (DEC-042) — `LocalSourceRegistryService` registers,
 *   updates, removes, and lists sources over a `ControlStore` and a
 *   `ControlStoreWriter`;
 * - trace persistence (DEC-042) — `CompilationTracePersistenceService` owns the
 *   conversion between the compiler's `SettledCompilationTrace` and the
 *   JSON-safe envelope a `TraceStore` persists.
 *
 * The last two are the reusable seam both the CLI and a future HTTP API compose
 * against. This layer still opens no database: SQLite lives behind the ports, in
 * `@ctxalloc/adapters` (INV-DEP-001, INV-ADAPTER-001).
 *
 * The HTTP API, model routing, and a persistent retrieval index remain later
 * phases.
 */

export {
  CompileLocalContextService,
  LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION,
  LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION,
  type LocalCompilationRequest,
  type LocalCompilationResult,
  type LocalCompileServiceConfig,
} from './compile-local-context-service.js';
export {
  CompilationTracePersistenceError,
  CompilationTracePersistenceService,
  STORED_COMPILATION_TRACE_RECORD_SCHEMA_VERSION,
  type CompilationTracePersistenceIssueCode,
} from './compilation-trace-persistence-service.js';
export {
  LocalSourcePipelineError,
  type LocalSourcePipelineStage,
} from './local-source-pipeline.js';
export {
  LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION,
  LocalSourceRegistryError,
  LocalSourceRegistryService,
  type LocalSourceRegistryIssueCode,
  type LocalSourceRegistryRequest,
  type LocalSourceRegistryResult,
} from './local-source-registry-service.js';
export {
  PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION,
  PREPARE_LOCAL_CORPUS_REQUEST_SCHEMA_VERSION,
  PrepareLocalCorpusService,
  compareContextBlocks,
  type PrepareLocalCorpusConfig,
  type PrepareLocalCorpusRequest,
  type PreparedLocalCorpus,
} from './prepare-local-corpus-service.js';
export {
  SOURCE_REGISTRATION_KEY_SCHEMA_VERSION,
  SOURCE_REGISTRATION_SCHEMA_VERSION,
  SourceRegistrationValidationError,
  compareSourceRegistrations,
  parseSourceRegistration,
  parseSourceRegistrationKey,
  sourceRegistrationLogicalKey,
  validateSourceRegistration,
  validateSourceRegistrationKey,
} from './source-registration.js';
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

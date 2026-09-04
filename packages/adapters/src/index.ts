/**
 * Infrastructure adapters for CtxAlloc.
 *
 * An adapter implements one project-owned port against one real external system.
 * This package is the only place in the product where filesystem IO, network IO,
 * or a platform clock is allowed: neither `@ctxalloc/domain`,
 * `@ctxalloc/compiler`, `@ctxalloc/application`, nor `@ctxalloc/evaluation` may
 * open a file, make a request, or read a timer (INV-DEP-001, INV-DEP-002).
 *
 * `AnthropicModelProvider` and `SystemMonotonicClock` serve evaluation only. The
 * compiler kernel calls no model and reads no clock, and shipping an adapter for
 * each capability does not change that (DEC-040).
 *
 * `MiniSearchCandidateProvider` is the first real retrieval implementation
 * (DEC-041). It proposes candidates and decides nothing: the compiler still owns
 * scoring, filtering, allocation, ordering, and rendering, and it still cannot
 * tell which provider produced a candidate.
 *
 * It depends on `@ctxalloc/ports` and, for the candidate wrapper's schema
 * version and the shared UTF-16 check, on `@ctxalloc/domain` — the same
 * project-owned vocabulary the ports already speak, which is why an adapter
 * naming it introduces no second spelling of one concept. It deliberately does
 * **not** depend on `@ctxalloc/compiler`: an adapter that could see the kernel
 * would be able to make a selection decision, and the whole point of the seam is
 * that it cannot (INV-DEP-003).
 *
 * `SQLiteControlStore` and `SQLiteTraceStore` are the local persistence
 * implementations (DEC-042). The first implements `ControlStore` and
 * `ControlStoreWriter`; the second implements `TraceStore` and stores opaque
 * JSON envelopes. Neither depends on `@ctxalloc/compiler`: the kernel already
 * depends inward on the ports, so an adapter naming it would close a dependency
 * cycle, and a store that could see the kernel could interpret an audit record
 * it is only meant to keep (INV-DEP-003).
 *
 * Their shared database, migration, and canonical-JSON mechanics are
 * package-internal and are deliberately not exported: they are how these two
 * adapters happen to work, not a contract anything may build on.
 *
 * No Node type reaches a public declaration. `DatabaseSync`, `StatementSync`,
 * and every other driver type stop inside this package. Every failure is a
 * project-owned error carrying a stable machine-readable code (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 */

export {
  ANTHROPIC_MODEL_PROVIDER_ID,
  ANTHROPIC_MODEL_PROVIDER_VERSION,
  AnthropicModelProvider,
  AnthropicModelProviderError,
  type AnthropicModelProviderConfig,
  type AnthropicModelProviderErrorCode,
} from './anthropic-model-provider.js';
export {
  MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION,
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_LIBRARY_NAME,
  MINISEARCH_LIBRARY_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_HIGHER_IS_BETTER,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  MiniSearchCandidateProvider,
  MiniSearchCandidateProviderError,
  type MiniSearchCandidateProviderConfig,
  type MiniSearchCandidateProviderErrorCode,
} from './minisearch-candidate-provider.js';
export {
  NODE_FILE_SOURCE_READER_ID,
  NODE_FILE_SOURCE_READER_VERSION,
  NodeFileSourceReader,
  NodeFileSourceReaderError,
  type NodeFileSourceReaderConfig,
  type NodeFileSourceReaderErrorCode,
} from './node-file-source-reader.js';
export {
  SQLITE_CONTROL_STORE_ID,
  SQLITE_CONTROL_STORE_VERSION,
  SQLiteControlStore,
  SQLiteControlStoreError,
  type SQLiteControlStoreErrorCode,
} from './sqlite-control-store.js';
export {
  SQLITE_LOCAL_STORE_SCHEMA_VERSION,
  type SQLiteLocalStoreConfig,
} from './sqlite-store-config.js';
export {
  SQLITE_TRACE_STORE_ID,
  SQLITE_TRACE_STORE_VERSION,
  SQLiteTraceStore,
  SQLiteTraceStoreError,
  type SQLiteTraceStoreErrorCode,
} from './sqlite-trace-store.js';
export {
  SYSTEM_MONOTONIC_CLOCK_ID,
  SYSTEM_MONOTONIC_CLOCK_VERSION,
  SystemMonotonicClock,
} from './system-monotonic-clock.js';

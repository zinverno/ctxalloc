/**
 * Public port contracts for CtxAlloc.
 *
 * A port describes an external capability the kernel needs, using project-owned
 * types only (INV-ADAPTER-001). The package has no external dependency and no
 * runtime export: every contract here is a type, so importing a port can never
 * pull infrastructure into a layer.
 *
 * It may reference `@ctxalloc/domain` with type-only imports. A port that
 * described a scope, a source document, or a candidate in its own private
 * vocabulary would force every adapter to translate between two spellings of one
 * concept, which is how a second source of truth starts (INV-DEP-003).
 *
 * Six capabilities have real consumers:
 *
 * * `Tokenizer` — exact token counts for the compiler kernel;
 * * `SourceReader` — exact source text for one adapter locator;
 * * `ControlStore` — the read-only registry of logical sources in a scope;
 * * `CandidateProvider` — candidate wrappers proposed for one request;
 * * `ModelProvider` — one configured model, for evaluation only;
 * * `MonotonicClock` — elapsed durations, for evaluation only.
 *
 * The last two are consumed by `@ctxalloc/evaluation` and by nothing else. The
 * compiler kernel calls no model and reads no clock, and neither port changes
 * that: a port is a capability offered, not a capability every layer may reach
 * for (INV-DEP-002, INV-DET-004).
 *
 * `TraceStore` and a general wall-clock port are still absent. They are added by
 * the phase that consumes them, not before.
 */

export type { CandidateProvider, CandidateProviderRequest } from './candidate-provider.js';
export type { ControlStore, SourceRegistration } from './control-store.js';
export type {
  ModelProvider,
  ModelProviderRequest,
  ModelProviderResult,
  ModelProviderUsage,
} from './model-provider.js';
export type { MonotonicClock } from './monotonic-clock.js';
export type { SourceReadRequest, SourceReadResult, SourceReader } from './source-reader.js';
export type { Tokenizer } from './tokenizer.js';

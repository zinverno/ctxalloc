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
 * Four capabilities have real consumers:
 *
 * * `Tokenizer` — exact token counts for the compiler kernel;
 * * `SourceReader` — exact source text for one adapter locator;
 * * `ControlStore` — the read-only registry of logical sources in a scope;
 * * `CandidateProvider` — candidate wrappers proposed for one request.
 *
 * `TraceStore`, `ModelProvider`, and a `Clock` port are still absent. They are
 * added by the phase that consumes them, not before.
 */

export type { CandidateProvider, CandidateProviderRequest } from './candidate-provider.js';
export type { ControlStore, SourceRegistration } from './control-store.js';
export type { SourceReadRequest, SourceReadResult, SourceReader } from './source-reader.js';
export type { Tokenizer } from './tokenizer.js';

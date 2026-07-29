/**
 * Public port contracts for CtxAlloc.
 *
 * A port describes an external capability the kernel needs, using project-owned
 * types only (INV-ADAPTER-001). This package has no runtime dependency, internal
 * or external: it must stay importable from every layer without pulling in
 * infrastructure.
 *
 * Only the capability with a real current consumer is defined. Further ports
 * (candidate provider, source reader, trace store, control store, model provider,
 * clock) are added when the phase that consumes them is implemented.
 */

export type { Tokenizer } from './tokenizer.js';

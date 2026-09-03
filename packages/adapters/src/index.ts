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
 * It depends on `@ctxalloc/ports` alone. It deliberately does **not** depend on
 * `@ctxalloc/compiler`: an adapter that could see the kernel would be able to
 * make a selection decision, and the whole point of the seam is that it cannot
 * (INV-DEP-003).
 *
 * No Node type reaches a public declaration. Every failure is a project-owned
 * error carrying a stable machine-readable code (INV-ADAPTER-001,
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
  NODE_FILE_SOURCE_READER_ID,
  NODE_FILE_SOURCE_READER_VERSION,
  NodeFileSourceReader,
  NodeFileSourceReaderError,
  type NodeFileSourceReaderConfig,
  type NodeFileSourceReaderErrorCode,
} from './node-file-source-reader.js';
export {
  SYSTEM_MONOTONIC_CLOCK_ID,
  SYSTEM_MONOTONIC_CLOCK_VERSION,
  SystemMonotonicClock,
} from './system-monotonic-clock.js';

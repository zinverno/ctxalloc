/**
 * Infrastructure adapters for CtxAlloc.
 *
 * An adapter implements one project-owned port against one real external system.
 * This package is the only place in the local vertical slice where filesystem IO
 * is allowed: neither `@ctxalloc/domain`, `@ctxalloc/compiler`, nor
 * `@ctxalloc/application` may open a file (INV-DEP-001, INV-DEP-002).
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
  NODE_FILE_SOURCE_READER_ID,
  NODE_FILE_SOURCE_READER_VERSION,
  NodeFileSourceReader,
  NodeFileSourceReaderError,
  type NodeFileSourceReaderConfig,
  type NodeFileSourceReaderErrorCode,
} from './node-file-source-reader.js';

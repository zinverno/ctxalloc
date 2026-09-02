/**
 * Source reader port.
 *
 * Reading bytes from a machine is the one capability the application layer
 * cannot own: a filesystem, a vault, or a remote store is infrastructure, and
 * the layer that ingests sources must stay testable without any of it
 * (INV-DEP-001, INV-DEP-002). The capability is therefore expressed as a
 * project-owned interface so that no `node:fs` type, path type, stream, buffer,
 * or SDK handle reaches a consumer (INV-ADAPTER-001).
 *
 * The port is deliberately narrow. It answers one question — *what exact text
 * does this locator hold?* — and nothing else.
 */

/**
 * One read of one adapter-addressable source.
 *
 * `locator` is an **adapter locator only**: the string one specific adapter uses
 * to find bytes. It is not a `SourceDocument.id`, not a `SourceIdentity`, not a
 * scope, and not provenance authority. Logical source identity is owned by the
 * control plane and by ingestion (DEC-028), so moving a file, renaming a
 * directory, or mounting a vault at another path changes a locator without
 * changing what the source *is* (INV-ADAPTER-002).
 */
export interface SourceReadRequest {
  readonly locator: string;
}

/**
 * The exact decoded text the locator holds.
 *
 * The value is byte-exact with respect to the stored source: line endings,
 * indentation, trailing whitespace, a trailing newline, an initial U+FEFF, and
 * Unicode composition all survive unchanged. A reader that normalized any of
 * them would produce a `contentHash` describing text the source never contained
 * (INV-PROV-005, INV-BLOCK-007).
 */
export interface SourceReadResult {
  readonly content: string;
}

/**
 * Reads exact source text for one locator.
 *
 * An implementation must not infer a source type, ingest, chunk, count tokens,
 * normalize whitespace or line endings, strip a byte-order mark, read a clock,
 * or derive timestamps from filesystem metadata. Every one of those is a
 * decision an explicit registration or a later stage owns, and a reader that
 * guessed one would make source meaning depend on where the bytes happened to
 * live (INV-DEP-003).
 *
 * A failure must be explicit. Returning empty text for a missing, unreadable, or
 * malformed source is forbidden: "no content" and "the read failed" are
 * different answers and must stay distinguishable (INV-ADAPTER-003). The error
 * must be project-owned; a raw filesystem or SDK error may not escape the
 * adapter (INV-ADAPTER-001).
 *
 * `id` and `version` identify the reader implementation for a future trace or
 * report, exactly as `Tokenizer` identity does (INV-TRACE-005).
 */
export interface SourceReader {
  /** Stable identifier of the reader implementation. */
  readonly id: string;

  /** Stable version of the reader implementation and its read semantics. */
  readonly version: string;

  read(request: SourceReadRequest): Promise<SourceReadResult>;
}

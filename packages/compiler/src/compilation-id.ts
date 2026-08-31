import { domainSeparatedDigest } from './digest.js';
import type { CompilationRequestFingerprint } from './request-fingerprint.js';

/**
 * The deterministic identity of one complete compiler invocation (DEC-038).
 *
 * `fingerprintCompilationRequest` answers *which exact validated caller request
 * value was this?* This module answers the different, larger question:
 *
 * ```text
 * Which complete deterministic compiler invocation was this?
 * ```
 *
 * INV-DET-001 defines determinism over more than the request. The configured
 * tokenizer implementation and version, the compiler identity and version, the
 * renderer identity and version, and every other explicit compiler configuration
 * are inputs too, and one byte-identical request compiled under two different
 * tokenizers can legitimately reach a different selection and a different
 * measurement (DEC-035, DEC-036, DEC-037). A request-only identifier would
 * collide across those runs, so this identifier binds the request fingerprint
 * **plus** the composition inputs that can change what is compiled.
 *
 * It is not random and not discovered. No git revision, hostname, process
 * identifier, wall clock, or CI build number takes part: every one of them would
 * make the identity depend on where the code happened to run rather than on what
 * was compiled (INV-DET-003, INV-DET-004).
 *
 * It identifies the **invocation**, not only a successful output. A compilation
 * that fails after request validation has the same identifier it would have had
 * on success, which is what lets a structured failure be correlated with the run
 * that produced it. An invalid raw request has no identifier at all, because no
 * validated request fingerprint exists to bind.
 *
 * The module is internal to the compiler kernel apart from the two values the
 * entry point publishes; the digest helper it uses is never re-exported
 * (INV-ADAPTER-001).
 */

/**
 * Current version of the compilation-identifier preimage (INV-STORE-004).
 *
 * The version is part of the hashed preimage, so a future change to what is
 * bound produces visibly different values rather than silently reinterpreting
 * stored ones.
 */
export const COMPILATION_ID_VERSION = 1;

/**
 * A published compilation identity, spelled `sha256:<64 lowercase hex characters>`.
 *
 * The alias is a string rather than a branded domain type on purpose: it is an
 * audit identity of one invocation, not a content hash of block content, and
 * borrowing `ContentHash` would claim it is one.
 */
export type CompilationId = string;

/** The label that separates this digest from every other digest in the kernel. */
const COMPILATION_ID_LABEL = 'ctxalloc-compilation-id';

/**
 * The explicit composition inputs bound alongside the request fingerprint.
 *
 * Every member is a value the composition root configured, and the set is
 * closed: adding a hidden input later would silently change stored identities,
 * so a new input arrives with a new {@link COMPILATION_ID_VERSION}.
 *
 * `maxCorrectionSelections` participates because it is a decision input, not a
 * performance knob. It can change whether the bounded fallback search proves a
 * result or stops with a structured search-limit failure, so two runs that
 * differ only in that bound are genuinely different deterministic invocations
 * (DEC-038).
 */
export interface CompilationIdComposition {
  readonly compilerId: string;
  readonly compilerVersion: string;
  readonly tokenizerId: string;
  readonly tokenizerVersion: string;
  readonly rendererId: string;
  readonly rendererVersion: string;
  readonly correctionStrategy: string;
  readonly correctionVersion: number;
  readonly maxCorrectionSelections: number;
}

/**
 * Calculates the identifier of one deterministic invocation.
 *
 * The preimage is the canonical serialization of:
 *
 * ```text
 * ["ctxalloc-compilation-id", 1, [requestFingerprint, composition]]
 * ```
 *
 * hashed as exact UTF-8 bytes with SHA-256 and published as
 * `sha256:<64 lowercase hex characters>`.
 *
 * The whole request is deliberately **not** duplicated into the preimage. The
 * fingerprint already binds the request identifier, scope, query, reference
 * time, candidates, source documents, the `TokenBudget`, and the complete
 * `CompilationPolicy` value, and restating them would create two places for one
 * fact (INV-DEP-003, DEC-037).
 *
 * Identical composition inputs over an identical request produce an identical
 * identifier; changing any one of them produces a different one.
 */
export function calculateCompilationId(
  requestFingerprint: CompilationRequestFingerprint,
  composition: CompilationIdComposition,
): CompilationId {
  return domainSeparatedDigest(COMPILATION_ID_LABEL, COMPILATION_ID_VERSION, [
    requestFingerprint,
    composition,
  ]);
}

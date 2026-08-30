import type { CompilationRequest } from './compilation-request.js';
import { domainSeparatedDigest } from './digest.js';

/**
 * Deterministic fingerprint of one validated `CompilationRequest` (DEC-037).
 *
 * The fingerprint answers exactly one question:
 *
 * ```text
 * Which exact validated caller request value was this?
 * ```
 *
 * It does **not** answer *which complete deterministic compiler invocation was
 * this?* INV-DET-001 defines determinism over more than the request — the
 * configured tokenizer implementation and version, the compiler version, and
 * any other explicit compiler configuration count too — and DEC-035 records
 * that no stage contract carries a tokenizer identity. One byte-identical
 * request compiled under two different tokenizers can legitimately produce
 * different measurements and a different selection, and both runs carry this
 * same fingerprint. That is correct: the fingerprint identifies the request
 * value, and the composition inputs are recorded separately in the trace
 * (DEC-036).
 *
 * So it is **not a compilation identifier**, and it must not be named or used as
 * one. It is also not a semantic-equivalence hash, not a cache key promising
 * equivalent outputs, and not a normalized candidate-set fingerprint. A future
 * deterministic compilation identifier must bind the compiler identity and
 * version, the tokenizer identity and version, the renderer identity and version,
 * the policy identities and configuration, and every other explicit composition
 * input alongside the request evidence. That identifier is not implemented here.
 *
 * Because it identifies the exact request value, **array order participates**:
 * two requests whose candidate arrays are permutations of each other have
 * different fingerprints, even though the compiler deliberately compiles them to
 * the same result (INV-ALLOC-005). INV-DET-002 governs compiler *processing*,
 * not the identity of the caller's payload, so normalizing candidate order
 * inside this fingerprint would make two genuinely different caller payloads
 * indistinguishable in an audit record.
 *
 * The function is synchronous, pure, and offline. It reads no clock, no random
 * value, no file, no environment variable, no database, and no network resource,
 * consults no `package.json` and no git revision, and calls no model, no
 * retrieval provider, and no tokenizer (INV-DET-001, INV-DET-003, INV-DET-004,
 * INV-DEP-002). It mutates nothing.
 */

/**
 * Current version of the fingerprint preimage (INV-STORE-004).
 *
 * The version is part of the hashed preimage, so a future change to what is
 * fingerprinted produces visibly different values rather than silently
 * reinterpreting stored ones.
 */
export const COMPILATION_REQUEST_FINGERPRINT_VERSION = 1;

/**
 * A published fingerprint value, spelled `sha256:<64 lowercase hex characters>`.
 *
 * The alias is a string rather than a branded domain type on purpose: it is an
 * audit identity of a caller payload, not a content hash of block content, and
 * borrowing `ContentHash` would claim it is one.
 */
export type CompilationRequestFingerprint = string;

/** The label that separates this digest from every other digest in the kernel. */
const FINGERPRINT_LABEL = 'ctxalloc-compilation-request-fingerprint';

/**
 * Fingerprints one **validated** compilation request.
 *
 * The preimage is the canonical serialization of:
 *
 * ```text
 * ["ctxalloc-compilation-request-fingerprint", 1, request]
 * ```
 *
 * hashed as exact UTF-8 bytes with SHA-256 and published as
 * `sha256:<64 lowercase hex characters>`.
 *
 * Every field of the request participates, including `id` and `query`, and every
 * array keeps its exact order. Object property insertion order does not, because
 * canonical serialization sorts keys by UTF-16 code unit — a request rebuilt
 * from JSON with its keys in a different order is the same request value
 * (INV-DET-002).
 *
 * Nothing outside the request participates: no compiler version, tokenizer
 * identity, renderer identity, clock, random value, or environment state
 * (DEC-036).
 *
 * Exact strings are preserved. No Unicode normalization, trimming, collapsing,
 * or lowercasing is applied, so an NFC query and its NFD spelling are different
 * requests and fingerprint differently.
 *
 * The parameter is a validated `CompilationRequest`, not `unknown`: this is not a
 * runtime boundary, and re-validating here would put one rule under two owners
 * (INV-DEP-003). `CompilationRequestValidator` is the boundary that produces the
 * value.
 */
export function fingerprintCompilationRequest(
  request: CompilationRequest,
): CompilationRequestFingerprint {
  return domainSeparatedDigest(FINGERPRINT_LABEL, COMPILATION_REQUEST_FINGERPRINT_VERSION, request);
}

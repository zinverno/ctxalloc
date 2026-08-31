import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

/**
 * Deterministic domain-separated SHA-256 digests for compiler audit identities.
 *
 * Two different values must never produce the same published digest merely
 * because they happen to serialize alike. A raw query string and a rendered
 * context string are both strings, and hashing each one bare would let a query
 * that happens to equal a rendered context report the same digest as that
 * rendered context, so an audit consumer comparing digests would conclude the
 * two are the same artefact. Every digest is therefore taken over a labelled,
 * versioned preimage: the label names what is being identified and the version
 * lets the preimage change without silently reinterpreting stored digests
 * (INV-PROV-005, INV-STORE-004).
 *
 * Serialization goes through the project-owned canonical JSON rule, so key order
 * is fixed by UTF-16 code unit, array order is preserved, exact strings survive
 * with no Unicode normalization and no trimming, an absent optional property
 * stays absent, and nothing depends on the machine's locale or on JavaScript
 * property insertion order (INV-DET-002).
 *
 * Hashing uses the Node standard library. No hashing dependency is added, no
 * `node:crypto` type reaches the public surface, and the module reads no clock,
 * no random value, no file, no environment variable, and no network resource
 * (INV-DET-001, INV-DET-003, INV-DET-004, INV-ADAPTER-001).
 *
 * The digest is **audit identity, not authorization**. Nothing in the compiler
 * grants access, skips a check, reuses a result, or decides inclusion because
 * two digests match, so no correctness rule of this kernel depends on collision
 * resistance.
 *
 * The module is internal to the compiler kernel: it is never re-exported from
 * the package entry point, and no public declaration names it
 * (INV-ADAPTER-001).
 */

/**
 * `sha256:<64 lowercase hex characters>` over the canonical preimage
 * `[label, version, value]`, encoded as UTF-8.
 *
 * The published representation is the one the domain already defines for a
 * content hash, so an audit consumer reads one spelling of a digest everywhere
 * (`ContentHashSchema`). The value is deliberately not branded as a
 * `ContentHash`: that brand means "the canonical hash of block content", and a
 * request fingerprint is not that.
 *
 * The caller must supply a JSON-safe value the domain schemas have already
 * parsed, which is what makes `canonicalJson` total here.
 */
export function domainSeparatedDigest(label: string, version: number, value: unknown): string {
  const preimage = canonicalJson([label, version, value]);
  return `sha256:${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

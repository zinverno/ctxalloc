import { createHash } from 'node:crypto';
import { ContentHashSchema, type ContentHash } from './content-hash.js';
import { findLoneSurrogate } from './unicode.js';
import { DomainValidationError, type ValidationIssue } from './validation.js';

/**
 * Canonical `ContextBlock.normalizedContentHash` computation (DEC-030).
 *
 * DEC-029 fixed this rule for Markdown blocks. Phase 7 generalizes it to every
 * extractive schema-version-1 text `ContextBlock`, because two components now
 * depend on producing the same value from the same content: the Markdown chunker
 * writes the hash, and `CandidateValidator` recomputes it to detect a stale or
 * forged record. Two implementations of one correctness rule would be free to
 * drift, so the rule is owned once, here (INV-DEP-003).
 *
 * Normalization unifies line endings and nothing else, so an LF copy and a CRLF
 * copy of the same text compare equal while indentation, trailing spaces,
 * blank-line runs, and Unicode composition all stay significant — each of them
 * can carry meaning in Markdown, in code, and in natural language.
 *
 * Hashing uses the Node standard library. No hashing dependency is added, no
 * `node:crypto` type reaches the public surface, and the module reads no clock,
 * no random value, no file, no environment variable, and no network resource
 * (INV-DET-001, INV-DET-003, INV-DET-004, INV-ADAPTER-001).
 */

/**
 * Canonical normalization applied before hashing block content.
 *
 * CRLF becomes LF, then any remaining lone CR becomes LF. Nothing is trimmed,
 * collapsed, or Unicode-normalized.
 */
export function normalizeContextBlockContentForHash(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function loneSurrogateIssue(index: number): ValidationIssue {
  return {
    code: 'invalid_unicode',
    path: ['content'],
    pointer: 'content',
    message: `must be well-formed UTF-16: lone surrogate at code unit ${String(index)}`,
  };
}

/**
 * Computes `sha256:<64 lowercase hex characters>` over the normalized content
 * encoded as UTF-8.
 *
 * Malformed UTF-16 fails explicitly instead of hashing U+FFFD replacement text,
 * which would silently describe content the caller never held (INV-BLOCK-007,
 * INV-PROV-005). Normalization only rewrites CR and LF, so it can neither create
 * nor repair a lone surrogate; checking the supplied content is therefore
 * equivalent to checking the normalized form.
 *
 * @throws {DomainValidationError} when `content` is not well-formed UTF-16.
 */
export function calculateNormalizedContentHash(content: string): ContentHash {
  const loneSurrogate = findLoneSurrogate(content);
  if (loneSurrogate !== null) {
    throw new DomainValidationError([loneSurrogateIssue(loneSurrogate)]);
  }

  const normalized = normalizeContextBlockContentForHash(content);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  // The literal is re-validated rather than cast, so the branded representation
  // contract stays enforced by the schema that defines it.
  return ContentHashSchema.parse(`sha256:${digest}`);
}

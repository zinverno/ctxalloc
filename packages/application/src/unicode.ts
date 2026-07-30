/**
 * UTF-16 well-formedness checks shared by the application use cases.
 *
 * Both ingestion and chunking encode strings as UTF-8 before hashing, and
 * chunking additionally hands substrings to a tokenizer. A lone surrogate has no
 * UTF-8 encoding: encoders substitute U+FFFD, which would hash or count text the
 * caller never supplied. The check therefore lives in one place so the two use
 * cases cannot drift apart on a correctness rule (INV-BLOCK-007).
 *
 * This module is internal to `@ctxalloc/application` and is not exported from the
 * package entry point.
 */

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/**
 * Returns the index of the first lone UTF-16 surrogate, or `null` when the string
 * is well-formed.
 *
 * The scan walks code units rather than code points: iterating code points would
 * already have hidden the defect being looked for.
 */
export function findLoneSurrogate(text: string): number | null {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < HIGH_SURROGATE_FIRST || unit > LOW_SURROGATE_LAST) continue;

    // A low surrogate reached here was not consumed as the tail of a valid pair.
    if (unit > HIGH_SURROGATE_LAST) return index;

    const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
    if (next >= LOW_SURROGATE_FIRST && next <= LOW_SURROGATE_LAST) {
      index += 1;
      continue;
    }
    return index;
  }
  return null;
}

/**
 * UTF-16 well-formedness check shared by every layer that encodes a domain
 * string as UTF-8.
 *
 * A lone surrogate has no UTF-8 encoding: encoders substitute U+FFFD, so hashing
 * or counting such a string describes text the caller never supplied
 * (INV-BLOCK-007). Source ingestion, Markdown chunking, block content hashing,
 * and candidate validation all depend on that rule, so it is owned once by the
 * domain rather than copied into each consumer.
 *
 * The check is pure string arithmetic. It reads no clock, no environment, and no
 * external system, so it does not weaken the domain's freedom from
 * infrastructure (INV-DEP-001).
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

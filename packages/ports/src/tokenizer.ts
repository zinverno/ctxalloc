/**
 * Tokenizer port.
 *
 * Token counts are correctness data, not an estimate: the budget allocator and
 * the final rendered-context check in later phases depend on them. The capability
 * is therefore expressed as a project-owned interface so that the kernel never
 * imports a tokenizer library type (INV-ADAPTER-001), and so that core tests run
 * offline against a deterministic fake.
 */

/**
 * Counts tokens for exact text using one specific tokenizer.
 *
 * Implementations must be pure with respect to the supplied text: identical text
 * counted by the same tokenizer identity always yields the same number
 * (INV-DET-001), with no randomness (INV-DET-003) and no dependency on the
 * current time (INV-DET-004). An implementation must not read the network, the
 * filesystem, a database, or a model API while counting.
 *
 * `id` and `version` identify the tokenizer in a compilation trace
 * (INV-TRACE-005) and make counts from different tokenizers comparable only when
 * both values match.
 */
export interface Tokenizer {
  /** Stable identifier of the tokenizer implementation, for example `fake`. */
  readonly id: string;

  /** Stable version of the tokenizer implementation and its token vocabulary. */
  readonly version: string;

  /**
   * Counts the tokens of the exact supplied text.
   *
   * The result is a finite non-negative integer (INV-BUDGET-005) describing the
   * supplied string only. It does not include rendering overhead, message
   * wrappers, system prompt text, tool schemas, reserved output tokens, or any
   * other part of a compiled context; the final compiled total is measured by
   * tokenizing the rendered context itself (INV-BUDGET-002).
   *
   * The text must not be normalized, trimmed, or otherwise modified before
   * counting, and the call must be synchronous. An implementation that cannot
   * count the supplied text must fail explicitly instead of returning an
   * approximation or substituting another tokenizer (INV-ADAPTER-003).
   */
  countTokens(text: string): number;
}

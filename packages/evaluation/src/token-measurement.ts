import type { Tokenizer } from '@ctxalloc/ports';

/**
 * The one place the evaluation layer measures tokens (DEC-040).
 *
 * A baseline's token count is published as a benchmark measurement and decides
 * whether a prefix fits. The `Tokenizer` port is an external boundary, so an
 * implementation may throw, or return a value that is not a token count at all.
 * The compiler already refuses such a value; the evaluation layer must not
 * publish a weaker number than the compiler does (INV-BUDGET-005, INV-DEP-003).
 *
 * Four concrete failures this closes:
 *
 * * a tokenizer that throws — a raw dependency error would escape baseline
 *   construction, carrying whatever message the implementation chose;
 * * `NaN` for the full-context render — `baselineInputTokens`, `tokenReduction`,
 *   and every aggregate built on them become invalid numeric data;
 * * a negative count for a prefix — that prefix then "fits" any non-negative
 *   budget, and the baseline silently over-fills;
 * * a fractional count — a benchmark publishes a fraction of a token.
 *
 * Nothing is coerced, rounded, or clamped: a value that is not a non-negative
 * safe integer is a failure, not something to repair. The tokenizer is called
 * **exactly once** per requested measurement, so a tokenizer with side effects
 * cannot be invoked a different number of times depending on the outcome.
 *
 * The module is package-internal.
 */

/** Machine-readable reasons a measurement could not be made. */
export type EvaluationTokenMeasurementReason = 'tokenizer_threw' | 'invalid_token_count';

/**
 * The single error a rejected measurement raises inside this package.
 *
 * It is mapped by `EvaluationHarness` onto an `EvaluationHarnessError` with
 * issue code `tokenizer_failed`, so a caller sees one project-owned failure
 * surface. It carries **no** tokenizer message and no measured text: the first
 * is a dependency's wording and the second is source content (INV-SEC-001).
 */
export class EvaluationTokenMeasurementError extends Error {
  readonly code = 'EVALUATION_TOKEN_MEASUREMENT_FAILED';
  readonly reason: EvaluationTokenMeasurementReason;

  constructor(reason: EvaluationTokenMeasurementReason, message: string) {
    super(message);
    this.name = 'EvaluationTokenMeasurementError';
    this.reason = reason;
  }
}

/**
 * The exact token count of one string, or a project-owned failure.
 *
 * @throws {EvaluationTokenMeasurementError} when the tokenizer throws, or
 * returns anything other than a non-negative safe integer.
 */
export function countEvaluationTokens(tokenizer: Tokenizer, text: string): number {
  let counted: unknown;
  try {
    counted = tokenizer.countTokens(text);
  } catch {
    // The thrown value is discarded: a tokenizer implementation chooses its own
    // wording, and some quote the text they were counting.
    throw new EvaluationTokenMeasurementError(
      'tokenizer_threw',
      'The tokenizer failed while measuring an evaluation context.',
    );
  }

  if (typeof counted !== 'number' || !Number.isSafeInteger(counted) || counted < 0) {
    // The value is not quoted either: a tokenizer that returned an object would
    // put its content into the message.
    throw new EvaluationTokenMeasurementError(
      'invalid_token_count',
      'The tokenizer returned a value that is not a non-negative safe integer.',
    );
  }

  return counted;
}

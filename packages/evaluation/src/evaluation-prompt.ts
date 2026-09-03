/**
 * The versioned downstream prompt the harness owns (DEC-040).
 *
 * The prompt belongs here, not to an adapter. If `AnthropicModelProvider` chose
 * the framing, changing the adapter would change every historical benchmark
 * number without any record of it, and a second adapter would produce numbers
 * that are not comparable with the first's. Publishing an id and a version means
 * a report can say exactly what was asked.
 *
 * The user prompt is one deterministic JSON object with exactly two keys,
 * serialized in the fixed order `context`, then `query`:
 *
 * ```text
 * {"context":<exact context>,"query":<exact query>}
 * ```
 *
 * There is no instruction text, no delimiter, no heading, and no commentary. Any
 * of those would be prompt engineering baked into the measurement apparatus, and
 * a fairer or better-worded template would then change results that were
 * supposed to be about the context. The system prompt is where framing belongs,
 * and it comes from `EvaluationRunConfig` so a run states it explicitly.
 *
 * Both values are embedded exactly: `JSON.stringify` escapes them, and nothing
 * is trimmed, normalized, or truncated.
 *
 * The builder is pure. It reads no clock, no random value, and no environment
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/** Stable identity of the prompt shape, recorded in every evaluation report. */
export const EVALUATION_PROMPT_ID = 'ctxalloc-eval-prompt';

/** Stable version of the behavior published under {@link EVALUATION_PROMPT_ID}. */
export const EVALUATION_PROMPT_VERSION = '1';

/**
 * Builds the exact user prompt for one context and one query.
 *
 * The key order is fixed by this function rather than by a generic canonical
 * serializer, because it is a wire format a model sees, not an internal
 * comparison: `context` precedes `query` so the question is the last thing in
 * the prompt.
 */
export function buildEvaluationUserPrompt(context: string, query: string): string {
  return `{"context":${JSON.stringify(context)},"query":${JSON.stringify(query)}}`;
}

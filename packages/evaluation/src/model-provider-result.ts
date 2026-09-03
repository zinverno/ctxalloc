import { findLoneSurrogate } from '@ctxalloc/domain';
import type { ModelProviderResult, ModelProviderUsage } from '@ctxalloc/ports';

/**
 * Runtime validation of what a `ModelProvider` resolved with (DEC-040).
 *
 * `ModelProvider` is an injected runtime port, so its result is data from
 * outside this package no matter how carefully the shipped adapter behaves. A
 * TypeScript interface is erased at run time and proves nothing about an
 * implementation the harness did not write, and the harness immediately hashes,
 * scores, counts, and publishes the fields it gets back — so an unchecked result
 * turns malformed provider data into benchmark measurements
 * (INV-ADAPTER-003, INV-DEP-003).
 *
 * Concrete values this rejects, each of which would otherwise be published:
 *
 * * `schemaVersion: 2` — a result written against a contract this code does not
 *   implement, read as though it were v1;
 * * a non-string `outputText` — `evaluateAnswer` and the answer hash would
 *   describe something that is not the model's answer;
 * * an `outputText` carrying a lone surrogate — it has no UTF-8 encoding, so the
 *   answer hash would describe text with U+FFFD substituted in
 *   (INV-BLOCK-007);
 * * `usage.inputTokens: NaN`, `Infinity`, `-1`, `12.5`, or a value beyond the
 *   safe integer range — each becomes `providerInputTokens` in a report, and the
 *   first two poison every aggregate computed from it;
 * * an empty or malformed `actualModelId` — model identity decides whether
 *   `qualityLoss` may be published at all (METRICS 11.6);
 * * an unknown field — a provider disagreeing with this contract must fail
 *   loudly rather than have the part this code recognizes quietly used.
 *
 * Nothing is coerced, defaulted, trimmed, or repaired: the result is either a
 * valid v1 result or a call failure. The reading itself is total — a hostile
 * implementation may return a `Proxy` whose traps throw — and the validator
 * returns a **fresh plain object**, so nothing downstream ever reads a
 * provider-controlled property a second time and no getter can return a
 * different value on the second read.
 *
 * The error carries no field value and no validator detail: a malformed result
 * is provider-controlled content, and a report is not a place for it
 * (INV-SEC-001).
 *
 * The module is package-internal.
 */

/** Fields a v1 result may carry. Anything else is a contract disagreement. */
const RESULT_KEYS: readonly string[] = [
  'schemaVersion',
  'outputText',
  'usage',
  'providerRequestId',
  'stopReason',
  'actualModelId',
];

/** Fields `ModelProviderUsage` may carry. */
const USAGE_KEYS: readonly string[] = ['inputTokens', 'outputTokens'];

/** Public failure code for a resolved-but-invalid provider result. */
export const MODEL_PROVIDER_INVALID_RESULT = 'MODEL_PROVIDER_INVALID_RESULT';

/**
 * The single error an invalid provider result raises inside this package.
 *
 * `EvaluationHarness` maps it onto the ordinary provider-call-failure path, so a
 * result that cannot be trusted is reported exactly like a call that did not
 * return: no score, no answer hash, no usage, and no quality comparison.
 */
export class ModelProviderResultValidationError extends Error {
  readonly code = MODEL_PROVIDER_INVALID_RESULT;

  constructor() {
    super('The model provider resolved with a value that is not a valid ModelProviderResult.');
    this.name = 'ModelProviderResultValidationError';
  }
}

function reject(): never {
  throw new ModelProviderResultValidationError();
}

/** Own enumerable keys, or a rejection when the value refuses to be inspected. */
function ownKeys(value: object): readonly string[] {
  try {
    return Object.keys(value);
  } catch {
    return reject();
  }
}

/** One property read, at most once, with a throwing accessor treated as invalid. */
function read(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return reject();
  }
}

function requireKnownKeys(value: object, allowed: readonly string[]): void {
  for (const key of ownKeys(value)) {
    if (!allowed.includes(key)) reject();
  }
}

/** A present provider-native identifier: non-empty and well-formed UTF-16. */
function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || findLoneSurrogate(value) !== null) {
    reject();
  }
  return value;
}

/** A present provider-native token count: a non-negative safe integer, exactly. */
function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) reject();
  return value;
}

function validateUsage(value: unknown): ModelProviderUsage | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject();

  requireKnownKeys(value, USAGE_KEYS);
  const inputTokens = optionalCount(read(value, 'inputTokens'));
  const outputTokens = optionalCount(read(value, 'outputTokens'));

  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/**
 * The provider's result as validated v1 data, or a project-owned failure.
 *
 * @throws {ModelProviderResultValidationError} for anything that is not a
 * schema-v1 result.
 */
export function validateModelProviderResult(value: unknown): ModelProviderResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject();

  requireKnownKeys(value, RESULT_KEYS);

  if (read(value, 'schemaVersion') !== 1) reject();

  const outputText = read(value, 'outputText');
  // An empty answer is legitimate — a model may decline — and is preserved
  // exactly, including its whitespace.
  if (typeof outputText !== 'string' || findLoneSurrogate(outputText) !== null) reject();

  const usage = validateUsage(read(value, 'usage'));
  const providerRequestId = optionalText(read(value, 'providerRequestId'));
  const stopReason = optionalText(read(value, 'stopReason'));
  const actualModelId = optionalText(read(value, 'actualModelId'));

  return {
    schemaVersion: 1,
    outputText,
    ...(usage === undefined ? {} : { usage }),
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(actualModelId === undefined ? {} : { actualModelId }),
  };
}

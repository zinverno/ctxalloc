import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link ModelProvider} port (DEC-040).
 *
 * The fake **answers nothing**. It reads no query, inspects no context, computes
 * no similarity, generates no text, and invents no token usage. Every byte it
 * returns was written by the test that configured it.
 *
 * That restraint is the whole value. A fake that derived an answer from the
 * query — even a plausible one — would be an unshipped language model living in
 * the test package, and every evaluation test built on it would be measuring
 * that instead of the harness (INV-DEP-003). A fake that invented `usage` counts
 * would let a test assert a provider-native number nothing produced.
 *
 * Two scripting modes, exactly one of which is configured:
 *
 * * **in call order** — the next entry per call, exhaustion is an error;
 * * **by exact user prompt** — the entry whose `userPrompt` matches byte for
 *   byte, an unmatched prompt is an error.
 *
 * Matching is exact string equality. Nothing is trimmed, normalized, lowercased,
 * or fuzzy-matched: a test that expects a particular prompt should fail when the
 * prompt changes, because that is usually the bug.
 *
 * Every call is recorded as an application-owned snapshot, so a test can assert
 * that two calls differed only by their context — the fairness property the
 * evaluation harness exists to preserve — and a later mutation of the request by
 * the caller cannot rewrite what was recorded.
 *
 * It makes no network call, reads no clock, and uses no random value
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'fake-model-provider';
const DEFAULT_VERSION = '1';
const DEFAULT_MODEL_ID = 'fake-model';

/**
 * One scripted outcome: a result the provider returns, or a failure it raises.
 *
 * A failure is scripted explicitly rather than signalled by a missing entry,
 * because "the provider failed" and "the test forgot a fixture" are different
 * facts and the harness treats them differently.
 */
export type FakeModelProviderOutcome =
  | { readonly kind: 'result'; readonly result: ModelProviderResult }
  | { readonly kind: 'failure'; readonly code: string; readonly message: string };

/** One outcome bound to one exact user prompt. */
export interface FakeModelProviderPromptOutcome {
  readonly userPrompt: string;
  readonly outcome: FakeModelProviderOutcome;
}

/** Explicit provider behavior for one test. */
export interface FakeModelProviderOptions {
  readonly id?: string;
  readonly version?: string;

  /** Configured model identity, reported on the instance and never per request. */
  readonly modelId?: string;

  /** Outcomes returned in exactly this order, one per call. */
  readonly outcomes?: readonly FakeModelProviderOutcome[];

  /** Outcomes selected by exact `userPrompt` equality. */
  readonly outcomesByUserPrompt?: readonly FakeModelProviderPromptOutcome[];
}

/** Rejected {@link FakeModelProvider} configuration. */
export class FakeModelProviderConfigurationError extends Error {
  readonly code = 'FAKE_MODEL_PROVIDER_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'FakeModelProviderConfigurationError';
  }
}

/** A {@link FakeModelProvider} call that no configured outcome covers. */
export class FakeModelProviderUnscriptedCallError extends Error {
  readonly code = 'FAKE_MODEL_PROVIDER_UNSCRIPTED_CALL';
  /** How many calls the provider had already answered. */
  readonly callIndex: number;

  constructor(message: string, callIndex: number) {
    super(message);
    this.name = 'FakeModelProviderUnscriptedCallError';
    this.callIndex = callIndex;
  }
}

/** The failure a test scripted, raised exactly as configured. */
export class FakeModelProviderScriptedFailureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FakeModelProviderScriptedFailureError';
    this.code = code;
  }
}

/**
 * A structural copy, so a recorded call cannot be rewritten by its caller.
 *
 * The port's request and result records are flat JSON data, so a recursive copy
 * over arrays and plain objects reproduces them exactly.
 */
function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry: unknown) => snapshot(entry)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(result, key, {
        value: snapshot(entry),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return result as T;
  }
  return value;
}

function validateOutcome(outcome: FakeModelProviderOutcome, where: string): void {
  if (typeof outcome !== 'object' || outcome === null) {
    throw new FakeModelProviderConfigurationError(
      `FakeModelProvider outcome ${where} must be an object.`,
    );
  }
  if (outcome.kind === 'failure') {
    if (outcome.code.trim().length === 0) {
      throw new FakeModelProviderConfigurationError(
        `FakeModelProvider failure outcome ${where} must carry a non-blank code.`,
      );
    }
    return;
  }
  if (outcome.kind !== 'result') {
    throw new FakeModelProviderConfigurationError(
      `FakeModelProvider outcome ${where} must be a result or a failure.`,
    );
  }
  const { result } = outcome;
  if (typeof result !== 'object' || result === null) {
    throw new FakeModelProviderConfigurationError(
      `FakeModelProvider result ${where} must be an object.`,
    );
  }
  if (result.schemaVersion !== 1) {
    throw new FakeModelProviderConfigurationError(
      `FakeModelProvider result ${where} must carry schemaVersion 1.`,
    );
  }
  if (typeof result.outputText !== 'string') {
    throw new FakeModelProviderConfigurationError(
      `FakeModelProvider result ${where} must carry an outputText string.`,
    );
  }
}

export class FakeModelProvider implements ModelProvider {
  readonly id: string;
  readonly version: string;
  readonly modelId: string;

  readonly #ordered: readonly FakeModelProviderOutcome[] | null;
  readonly #byPrompt: ReadonlyMap<string, FakeModelProviderOutcome> | null;
  readonly #calls: ModelProviderRequest[] = [];
  #next = 0;

  /**
   * @throws {FakeModelProviderConfigurationError} when neither or both scripting
   * modes are configured, when an outcome is malformed, or when one user prompt
   * is bound twice.
   */
  constructor(options: FakeModelProviderOptions = {}) {
    const ordered = options.outcomes ?? null;
    const byPrompt = options.outcomesByUserPrompt ?? null;

    if (ordered === null && byPrompt === null) {
      throw new FakeModelProviderConfigurationError(
        'FakeModelProvider requires either outcomes or outcomesByUserPrompt.',
      );
    }
    if (ordered !== null && byPrompt !== null) {
      // Two selection rules would need a precedence order, and a test reading a
      // failure would have to know which rule answered.
      throw new FakeModelProviderConfigurationError(
        'FakeModelProvider accepts outcomes or outcomesByUserPrompt, not both.',
      );
    }

    if (ordered !== null) {
      if (ordered.length === 0) {
        throw new FakeModelProviderConfigurationError(
          'FakeModelProvider outcomes must not be empty.',
        );
      }
      ordered.forEach((outcome, index) => {
        validateOutcome(outcome, `at index ${String(index)}`);
      });
      this.#ordered = ordered.map((outcome) => snapshot(outcome));
      this.#byPrompt = null;
    } else {
      const entries = byPrompt ?? [];
      if (entries.length === 0) {
        throw new FakeModelProviderConfigurationError(
          'FakeModelProvider outcomesByUserPrompt must not be empty.',
        );
      }
      const map = new Map<string, FakeModelProviderOutcome>();
      entries.forEach((entry, index) => {
        if (typeof entry.userPrompt !== 'string') {
          throw new FakeModelProviderConfigurationError(
            `FakeModelProvider outcomesByUserPrompt at index ${String(index)} must carry a userPrompt string.`,
          );
        }
        if (map.has(entry.userPrompt)) {
          throw new FakeModelProviderConfigurationError(
            `FakeModelProvider outcomesByUserPrompt binds one user prompt twice at index ${String(index)}.`,
          );
        }
        validateOutcome(entry.outcome, `at index ${String(index)}`);
        map.set(entry.userPrompt, snapshot(entry.outcome));
      });
      this.#byPrompt = map;
      this.#ordered = null;
    }

    this.id = options.id ?? DEFAULT_ID;
    this.version = options.version ?? DEFAULT_VERSION;
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
  }

  /** Every request this provider was given, in call order, as owned snapshots. */
  get calls(): readonly ModelProviderRequest[] {
    return this.#calls;
  }

  /**
   * Returns the configured outcome for this call.
   *
   * @throws {FakeModelProviderUnscriptedCallError} when no outcome covers it.
   * @throws {FakeModelProviderScriptedFailureError} when the outcome is a
   * scripted failure.
   */
  // `async` so an unscripted call rejects rather than throwing synchronously: a
  // caller awaiting a provider expects a rejected promise, and a synchronous
  // throw would escape a `try` that only guards the `await`.
  async generate(request: ModelProviderRequest): Promise<ModelProviderResult> {
    const callIndex = this.#calls.length;
    this.#calls.push(snapshot(request));

    const outcome = this.#outcomeFor(request, callIndex);
    if (outcome.kind === 'failure') {
      throw new FakeModelProviderScriptedFailureError(outcome.code, outcome.message);
    }
    // A fresh snapshot per call, so two calls answered by one scripted result
    // cannot share an object a test then mutates.
    return snapshot(outcome.result);
  }

  #outcomeFor(request: ModelProviderRequest, callIndex: number): FakeModelProviderOutcome {
    if (this.#byPrompt !== null) {
      const matched = this.#byPrompt.get(request.userPrompt);
      if (matched === undefined) {
        // The prompt itself is not quoted: it carries the evaluation context,
        // and a test failure message is not a place to print source content
        // (INV-SEC-001).
        throw new FakeModelProviderUnscriptedCallError(
          `FakeModelProvider has no outcome configured for the user prompt of call ${String(callIndex)}.`,
          callIndex,
        );
      }
      return matched;
    }

    const ordered = this.#ordered ?? [];
    const outcome = ordered[this.#next];
    if (outcome === undefined) {
      throw new FakeModelProviderUnscriptedCallError(
        `FakeModelProvider was configured with ${String(ordered.length)} outcome(s) and has none left for call ${String(callIndex)}.`,
        callIndex,
      );
    }
    this.#next += 1;
    return outcome;
  }
}

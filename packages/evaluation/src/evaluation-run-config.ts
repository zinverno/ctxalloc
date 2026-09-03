import { TimestampSchema, findLoneSurrogate, safeParse, type Timestamp } from '@ctxalloc/domain';
import { z } from 'zod';

/**
 * Configuration of one evaluation run (DEC-040).
 *
 * Everything that could change a measured number is explicit and has no default.
 * A system prompt, a sampling temperature, an output limit, or a determinism
 * repeat count chosen silently would be an unrecorded experiment variable, and
 * two runs of one benchmark could then differ for a reason the report never
 * mentions.
 *
 * `executedAt` is **reporting metadata only**. Nothing in the harness reads it to
 * make a decision, and no component reads a clock to produce it: the run's date
 * arrives from the caller exactly as `CompilationRequest.referenceTime` does
 * (INV-DET-004).
 */

/** Current schema version of {@link EvaluationRunConfig} (INV-STORE-004). */
export const EVALUATION_RUN_CONFIG_SCHEMA_VERSION = 1;

/**
 * Whether the run calls a model at all.
 *
 * `disabled` is the CI mode: context-preservation and token metrics are measured
 * with no provider present, so the suite needs no credential and makes no paid
 * call. `full-baseline-and-compiled` runs both halves of one comparison.
 *
 * There is no "compiled only" mode. A compiled answer with nothing to compare it
 * against cannot produce a quality loss, which is the measurement the model
 * execution exists for.
 */
export type EvaluationModelExecution = 'disabled' | 'full-baseline-and-compiled';

export interface EvaluationRunConfig {
  readonly schemaVersion: typeof EVALUATION_RUN_CONFIG_SCHEMA_VERSION;
  readonly runId: string;

  /** Explicit reporting metadata. Never read to make a decision. */
  readonly executedAt: Timestamp;

  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly referenceEnvironment: string;

  /** Sent unchanged as the system prompt of both model calls. May be empty. */
  readonly systemPrompt: string;
  readonly maxOutputTokens: number;
  readonly temperature: number;

  readonly modelExecution: EvaluationModelExecution;

  /** Total compilations per case, including the primary one. At least 1. */
  readonly determinismRepeats: number;

  /** Quality loss strictly greater than this is severe (METRICS 11.6). */
  readonly severeQualityLossThreshold: number;
}

/** Machine-readable categories of a rejected run configuration. */
export type EvaluationRunConfigIssueCode = 'invalid_run_config';

/**
 * The single error run-configuration validation raises.
 *
 * Its issues are project-owned and serializable. The system prompt is never
 * quoted back in a message: it is caller-authored text, and an error is not a
 * place to reprint it (INV-SEC-001).
 */
export class EvaluationRunConfigValidationError extends Error {
  readonly code = 'EVALUATION_RUN_CONFIG_INVALID';
  readonly issues: readonly {
    readonly code: string;
    readonly pointer: string;
    readonly message: string;
  }[];

  constructor(
    issues: readonly {
      readonly code: string;
      readonly pointer: string;
      readonly message: string;
    }[],
  ) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Evaluation run configuration is invalid: ${summary}`);
    this.name = 'EvaluationRunConfigValidationError';
    this.issues = issues;
  }
}

const identity = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const unitInterval = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
    message: 'must be a finite number in [0, 1]',
  });

const positiveSafeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 1, {
    message: 'must be a safe integer greater than or equal to 1',
  });

/**
 * The runtime boundary of the configuration.
 *
 * Unknown fields are rejected rather than stripped: a misspelled
 * `determinismRepeat` would otherwise leave a run with a repeat count the caller
 * believes they set and does not have (INV-BLOCK-005).
 *
 * `systemPrompt` is the one string that may be empty. An empty system prompt is
 * a deliberate configuration — it is exactly how a run measures the model with
 * no framing at all — while every identity field names something and a blank
 * name identifies nothing.
 */
const EvaluationRunConfigSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_RUN_CONFIG_SCHEMA_VERSION),
  runId: identity,
  executedAt: TimestampSchema,
  datasetId: identity,
  datasetVersion: identity,
  referenceEnvironment: identity,
  systemPrompt: z.string().refine((value) => findLoneSurrogate(value) === null, {
    message: 'must be well-formed UTF-16',
  }),
  maxOutputTokens: positiveSafeInteger,
  temperature: unitInterval,
  modelExecution: z.enum(['disabled', 'full-baseline-and-compiled']),
  determinismRepeats: positiveSafeInteger,
  severeQualityLossThreshold: unitInterval,
});

/**
 * Validates one run configuration strictly, all or nothing.
 *
 * @throws {EvaluationRunConfigValidationError} when the configuration is not
 * usable.
 */
export function validateEvaluationRunConfig(input: unknown): EvaluationRunConfig {
  const parsed = safeParse(EvaluationRunConfigSchema, input);
  if (!parsed.ok) {
    throw new EvaluationRunConfigValidationError(
      parsed.issues.map((issue) => ({
        code: 'invalid_run_config' satisfies EvaluationRunConfigIssueCode,
        pointer: issue.pointer,
        message: issue.message,
      })),
    );
  }
  return parsed.value;
}

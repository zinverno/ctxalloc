import type { AnswerCriterionResult } from './answer-evaluator.js';
import { canonicalJson, domainSeparatedHash } from './canonical-json.js';
import type { EvaluationBaselineResult } from './evaluation-baselines.js';
import type { EvaluationDatasetSplit, ExpectedCompilationFailure } from './evaluation-case.js';
import type { EvaluationModelExecution } from './evaluation-run-config.js';

/**
 * Serializable evaluation results and the suite report (DEC-040).
 *
 * **The privacy boundary lives here.** A case result and a report carry
 * measurements, identities, hashes, and issue codes — never a raw query, source
 * document, candidate content, compiled context, baseline context, model prompt,
 * model answer, or credential. A benchmark report is the artefact most likely to
 * be pasted into a chat, attached to a ticket, or committed, and a type that
 * *could* carry source content is a type that eventually does (INV-SEC-001).
 *
 * Raw text is available for a single case through {@link EvaluationCaseDetails},
 * which is deliberately a separate in-memory result the suite report never
 * embeds. Nothing here is persisted in Phase 17.
 *
 * An absent metric is absent. Nothing substitutes zero for a measurement whose
 * denominator does not exist: a case with no required blocks has no recall, and
 * printing `0` would make it look like a failure and drag every aggregate with
 * it (METRICS 9.1).
 */

/** Current schema version of {@link EvaluationCaseResult} (INV-STORE-004). */
export const EVALUATION_CASE_RESULT_SCHEMA_VERSION = 1;

/** Current schema version of {@link EvaluationReport} (INV-STORE-004). */
export const EVALUATION_REPORT_SCHEMA_VERSION = 1;

/** Domain separator for an answer hash. */
export const EVALUATION_ANSWER_HASH_DOMAIN = 'ctxalloc-eval-answer:1';

/** Domain separator for a report identity hash. */
export const EVALUATION_REPORT_HASH_DOMAIN = 'ctxalloc-eval-report:1';

/** Whether the compiler produced a result for one case. */
export type EvaluationCompilationOutcome = 'succeeded' | 'failed';

/**
 * A privacy-safe projection of one compilation failure.
 *
 * The stage and the issue codes are what a report needs to route a failure. The
 * issue *messages* are not carried: they legitimately quote request values, and
 * a report is not a place for those. `ContextCompilationError` itself is never
 * weakened into a string — the caller of `runCase` still receives the structured
 * error where one is thrown (INV-ADAPTER-003).
 */
export interface EvaluationCompilationFailure {
  readonly stage: string;
  readonly issueCodes: readonly string[];
  readonly compilationId?: string;
}

/** The three baselines of one case, as far as each was built. */
export interface EvaluationBaselineResults {
  readonly fullContext: EvaluationBaselineResult;
  readonly truncation: EvaluationBaselineResult;
  readonly topK: EvaluationBaselineResult;
}

/**
 * Token metrics of one successful case (METRICS 8.7, 8.8).
 *
 * ```text
 * tokenReduction      = baselineInputTokens - compiledTokens
 * tokenReductionRatio = tokenReduction / baselineInputTokens
 * ```
 *
 * `baselineInputTokens` is the **full-context** baseline's exact token count and
 * nothing else: not `candidateTokens`, not `canonicalContentTokens`, not
 * `availableInputTokens`, and not `totalTokens`. Each of those is a different
 * quantity, and publishing one under this name would be a reporting error rather
 * than an approximation (METRICS 8.7).
 *
 * The reduction may be negative and is never clamped: a compilation that renders
 * more than the whole candidate set is a real and reportable outcome. The ratio
 * is absent when the baseline is empty, because dividing by zero would publish
 * `NaN` or `Infinity` under a percentage's name.
 *
 * The other two baselines are reported beside it, always named, never as "the"
 * token reduction.
 */
export interface EvaluationTokenMetrics {
  readonly baselineInputTokens: number;
  readonly compiledTokens: number;
  readonly tokenReduction: number;
  readonly tokenReductionRatio?: number;
  readonly truncationBaselineTokens?: number;
  readonly truncationTokenReduction?: number;
  readonly topKBaselineTokens?: number;
  readonly topKTokenReduction?: number;
}

/**
 * Compiler correctness observations of one successful case (METRICS 8, 13).
 *
 * `budgetViolation` is expected to be `false` for every case. It is recorded
 * rather than asserted so a violation appears as a counted, reported fact
 * instead of an exception that stops the run (INV-BUDGET-001).
 */
export interface EvaluationCompilerUsage {
  readonly compiledTokens: number;
  readonly availableInputTokens: number;
  readonly unusedTokens: number;
  readonly renderingTokenDelta: number;
  readonly budgetViolation: boolean;
}

/**
 * Context-preservation metrics of one successful case (METRICS 9).
 *
 * Every one is computed from the **final** `CompilationResult.includedBlocks`,
 * and every one is absent when the case states no annotation for it.
 */
export interface EvaluationPreservationMetrics {
  readonly requiredBlockRecall?: number;
  readonly weightedFactCoverage?: number;
  readonly criticalFactCoverage?: number;
  readonly relevantBlockRecall?: number;
  readonly irrelevantExclusionRate?: number;
  readonly preservedFactIds: readonly string[];
  readonly missingFactIds: readonly string[];
}

/** The compiler determinism check of one case. */
export interface EvaluationDeterminismResult {
  /** Total compilations executed, including the primary one. */
  readonly executions: number;
  /** True when every repeat produced the identical outcome. */
  readonly matched: boolean;
  /** How the first divergent repeat differed, when one did. */
  readonly divergence?: 'result-differs' | 'succeeded-then-failed' | 'failed-then-succeeded';
}

/** Whether and how a model ran for one case. */
export type EvaluationModelState =
  | 'disabled'
  | 'skipped-expected-failure'
  | 'skipped-compilation-failed'
  | 'executed'
  | 'baseline-call-failed'
  | 'compiled-call-failed';

/** Which of the two calls a report entry describes. */
export type EvaluationModelCall = 'full-baseline' | 'compiled';

/**
 * One model call's measurements.
 *
 * `answerHash` stands in for the answer. Provider token counts keep their own
 * names and are never combined with CtxAlloc tokenizer counts: the two use
 * different vocabularies, and the provider's input count also includes the
 * system prompt and message framing (METRICS 8.6).
 */
export interface EvaluationModelCallResult {
  readonly call: EvaluationModelCall;
  readonly latencyMilliseconds: number;
  readonly answerHash: string;
  readonly criteria: readonly AnswerCriterionResult[];
  readonly answerQualityScore?: number;
  readonly providerInputTokens?: number;
  readonly providerOutputTokens?: number;
  readonly providerRequestId?: string;
  readonly stopReason?: string;
  readonly actualModelId?: string;
}

/** Why a quality comparison could not be made from two otherwise valid answers. */
export type EvaluationQualityComparisonIssue = 'actual-model-mismatch';

/**
 * The model half of one case result.
 *
 * `qualityLoss = baselineScore - compiledScore`, signed and never clamped: a
 * compiled context that answers *better* than the full one is a real result, and
 * clamping it to zero would hide it (METRICS 11.6). Both values must exist for a
 * loss to exist — a failed provider call never becomes a zero score.
 *
 * `qualityComparisonIssue` records why a loss is absent even though both calls
 * succeeded and both were scored. Today there is one reason: the two calls
 * reported **different** `actualModelId` values, so context was not the only
 * variable that changed and the difference is not a context effect. Both scores
 * are still published; only the comparison is withheld.
 */
export interface EvaluationModelResult {
  readonly state: EvaluationModelState;
  /**
   * The calls actually **attempted**, in order.
   *
   * Empty when no model ran; `['full-baseline']` when the baseline call failed
   * and the compiled call therefore never happened; both entries otherwise.
   * Publishing a planned order would be a false audit record.
   */
  readonly callOrder: readonly EvaluationModelCall[];
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly modelId?: string;
  readonly baseline?: EvaluationModelCallResult;
  readonly compiled?: EvaluationModelCallResult;
  readonly failedCall?: EvaluationModelCall;
  readonly failureCode?: string;
  readonly qualityComparisonIssue?: EvaluationQualityComparisonIssue;
  readonly qualityLoss?: number;
  readonly severeQualityLoss?: boolean;
}

/** The expected-failure verdict of one case (METRICS 13.2). */
export interface EvaluationExpectedFailureResult {
  readonly expected: ExpectedCompilationFailure;
  readonly passed: boolean;
}

/** One case's suite-safe result. */
export interface EvaluationCaseResult {
  readonly schemaVersion: typeof EVALUATION_CASE_RESULT_SCHEMA_VERSION;
  readonly caseId: string;
  readonly datasetSplit: EvaluationDatasetSplit;
  readonly tags: readonly string[];

  readonly compilation: EvaluationCompilationOutcome;
  readonly compilationId?: string;
  readonly requestFingerprint?: string;
  readonly compilationFailure?: EvaluationCompilationFailure;

  readonly compilationLatencyMilliseconds: number;

  readonly baselines?: EvaluationBaselineResults;
  readonly tokens?: EvaluationTokenMetrics;
  readonly usage?: EvaluationCompilerUsage;
  readonly preservation?: EvaluationPreservationMetrics;
  readonly determinism?: EvaluationDeterminismResult;

  readonly model: EvaluationModelResult;

  readonly expectedFailure?: EvaluationExpectedFailureResult;

  /** `compilationLatency + compiledModelLatency`, when a compiled call ran. */
  readonly compiledRequestLatencyMilliseconds?: number;
}

/**
 * One case's result together with the raw text it produced.
 *
 * This exists only in memory, only for a single `runCaseDetailed` call, and is
 * never embedded in an {@link EvaluationReport}. It is the one place a caller can
 * see what was actually sent and answered — for debugging one case, not for
 * reporting a suite.
 */
export interface EvaluationCaseDetails {
  readonly result: EvaluationCaseResult;
  readonly fullContextBaselineContext?: string;
  readonly truncationBaselineContext?: string;
  readonly topKBaselineContext?: string;
  readonly compiledContext?: string;
  readonly baselineUserPrompt?: string;
  readonly compiledUserPrompt?: string;
  readonly baselineAnswer?: string;
  readonly compiledAnswer?: string;
}

/**
 * A distribution of one measurement over the cases that produced it.
 *
 * Percentiles use **nearest-rank** over ascending values, fixed by DEC-040 and
 * used everywhere:
 *
 * ```text
 * rank  = clamp(ceil(p * n), 1, n)
 * value = sorted[rank - 1]
 * ```
 *
 * One method, defined once, because two percentile conventions in one report
 * would make two numbers that look comparable disagree by construction. Under
 * this definition `median` is exactly `p50`, so both names describe one value
 * rather than two nearly-equal ones.
 */
export interface EvaluationDistribution {
  readonly count: number;
  readonly mean: number;
  readonly median: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly minimum: number;
  readonly maximum: number;
}

/** Aggregate counts over one suite. */
export interface EvaluationReportCounts {
  readonly cases: number;
  readonly successfulCompilations: number;
  readonly expectedFailureCases: number;
  readonly expectedFailuresMatched: number;
  readonly unexpectedFailures: number;
  readonly providerFailures: number;
  readonly determinismFailures: number;
  readonly budgetViolations: number;
  readonly severeQualityLosses: number;
  /** Cases where the two calls reported different concrete models. */
  readonly modelIdentityMismatches: number;
}

/** Distributions of the measured metrics, each absent when nothing produced it. */
export interface EvaluationReportAggregates {
  readonly requiredBlockRecall?: EvaluationDistribution;
  readonly weightedFactCoverage?: EvaluationDistribution;
  readonly criticalFactCoverage?: EvaluationDistribution;
  readonly relevantBlockRecall?: EvaluationDistribution;
  readonly irrelevantExclusionRate?: EvaluationDistribution;
  readonly tokenReduction?: EvaluationDistribution;
  readonly tokenReductionRatio?: EvaluationDistribution;
  readonly qualityLoss?: EvaluationDistribution;
}

/** Latency distributions, kept apart from the quality metrics (METRICS 17). */
export interface EvaluationReportLatency {
  readonly compilation?: EvaluationDistribution;
  readonly baselineModel?: EvaluationDistribution;
  readonly compiledModel?: EvaluationDistribution;
  readonly compiledRequest?: EvaluationDistribution;
}

/** Identities of everything that produced the numbers in a report. */
export interface EvaluationReportComposition {
  readonly tokenizerId: string;
  readonly tokenizerVersion: string;
  readonly compilerId: string;
  readonly compilerVersion: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly baselineRendererId: string;
  readonly baselineRendererVersion: string;
  readonly clockId: string;
  readonly clockVersion: string;
  readonly modelProviderId?: string;
  readonly modelProviderVersion?: string;
  readonly modelId?: string;
}

/** One suite report. */
export interface EvaluationReport {
  readonly schemaVersion: typeof EVALUATION_REPORT_SCHEMA_VERSION;
  readonly runId: string;
  readonly executedAt: string;
  readonly datasetId: string;
  readonly datasetVersion: string;
  readonly referenceEnvironment: string;
  readonly modelExecution: EvaluationModelExecution;

  readonly composition: EvaluationReportComposition;
  readonly counts: EvaluationReportCounts;
  readonly aggregates: EvaluationReportAggregates;
  readonly latency: EvaluationReportLatency;

  /** Case results in canonical case-id order. */
  readonly cases: readonly EvaluationCaseResult[];

  /** Domain-separated hash of the canonical report, excluding this field. */
  readonly reportHash: string;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The nearest-rank percentile of an ascending array.
 *
 * `p` is in `(0, 1]`. The rank is clamped into the array, so `p50` of a
 * single-observation distribution is that observation rather than an
 * interpolation between it and nothing. The minimum is reported separately
 * because nearest-rank has no `p0`.
 */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.min(Math.max(Math.ceil(p * sorted.length), 1), sorted.length);
  // `sorted` is non-empty and the rank is clamped into it, so the index is
  // always present; the fallback exists only to satisfy the index check.
  return sorted[rank - 1] ?? 0;
}

/**
 * Summarizes observations, or reports that there were none.
 *
 * An empty set produces `undefined` rather than a distribution of zeros. A
 * report that printed `mean: 0` for a metric nothing measured would be stating a
 * result nobody obtained.
 */
export function summarize(values: readonly number[]): EvaluationDistribution | undefined {
  if (values.length === 0) return undefined;

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const p50 = percentile(sorted, 0.5);

  return {
    count: sorted.length,
    mean: sum / sorted.length,
    // One definition, two names: `median` is `p50` under the nearest-rank rule,
    // not an averaged middle pair.
    median: p50,
    p10: percentile(sorted, 0.1),
    p50,
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    minimum: sorted[0] ?? 0,
    maximum: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * The report's identity hash, over everything in it except the hash itself.
 *
 * It identifies one report's exact content, so two runs can be compared without
 * either disclosing what they measured.
 */
export function hashReport(report: Omit<EvaluationReport, 'reportHash'>): string {
  return domainSeparatedHash(EVALUATION_REPORT_HASH_DOMAIN, canonicalJson(report));
}

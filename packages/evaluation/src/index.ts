/**
 * Public contract of the CtxAlloc evaluation harness (DEC-040).
 *
 * The package answers one product question: *does CtxAlloc preserve what matters
 * while spending fewer tokens than the obvious alternatives?* It compiles real
 * `CompilationRequest`s through the real kernel, builds explicit baselines
 * beside them, and reports token reduction, context preservation, answer quality
 * loss, and latency as separate numbers.
 *
 * ```text
 * EvaluationCase
 *   -> case validation
 *   -> CandidateValidator (baseline batch)
 *   -> full-context / truncation / top-k baselines
 *   -> ContextCompiler.compile(request)
 *   -> determinism repeats
 *   -> context-preservation and token metrics
 *   -> two ModelProvider calls differing only by context
 *   -> rule-based answer scoring
 *   -> EvaluationCaseResult / EvaluationReport
 * ```
 *
 * It depends on `@ctxalloc/domain`, `@ctxalloc/ports`, and `@ctxalloc/compiler`,
 * and deliberately **not** on `@ctxalloc/application`: a benchmark case is static
 * data, so nothing here needs a source reader, a chunker, or a candidate
 * provider, and depending on the application layer to compile static cases would
 * couple the measurement to the pipeline that produces the thing measured
 * (INV-DEP-003).
 *
 * The compiler stays model-free. Token reduction, baselines, prompts, and answer
 * scoring exist only here, and nothing in this package is reachable from the
 * kernel (METRICS 8.7, INV-DEP-002).
 *
 * Several things are deliberately internal: the canonical serializer, the
 * percentile helper, the hash preimage helpers, and the baseline record
 * construction. Each is a mechanism rather than a contract, and exporting one
 * would freeze an implementation detail that a later version has to be free to
 * change (INV-ADAPTER-001).
 */

export {
  evaluateAnswer,
  type AnswerCriterionResult,
  type AnswerEvaluation,
} from './answer-evaluator.js';
export {
  EVALUATION_BASELINE_RENDERER_ID,
  EVALUATION_BASELINE_RENDERER_VERSION,
  type EvaluationBaselineInapplicableReason,
  type EvaluationBaselineName,
  type EvaluationBaselineResult,
} from './evaluation-baselines.js';
export {
  EVALUATION_CASE_SCHEMA_VERSION,
  EVALUATION_FACT_WEIGHTS,
  EvaluationCaseValidationError,
  validateEvaluationCase,
  type AnswerCriterion,
  type EvaluationCase,
  type EvaluationCaseIssueCode,
  type EvaluationDatasetSplit,
  type EvaluationFactImportance,
  type EvaluationRequiredFact,
  type ExpectedCompilationFailure,
} from './evaluation-case.js';
export {
  EvaluationHarness,
  EvaluationHarnessError,
  type EvaluationHarnessIssueCode,
} from './evaluation-harness.js';
export {
  EVALUATION_PROMPT_ID,
  EVALUATION_PROMPT_VERSION,
  buildEvaluationUserPrompt,
} from './evaluation-prompt.js';
export {
  EVALUATION_ANSWER_HASH_DOMAIN,
  EVALUATION_CASE_RESULT_SCHEMA_VERSION,
  EVALUATION_REPORT_HASH_DOMAIN,
  EVALUATION_REPORT_SCHEMA_VERSION,
  type EvaluationBaselineResults,
  type EvaluationCaseDetails,
  type EvaluationCaseResult,
  type EvaluationCompilationFailure,
  type EvaluationCompilationOutcome,
  type EvaluationCompilerUsage,
  type EvaluationDeterminismResult,
  type EvaluationDistribution,
  type EvaluationExpectedFailureResult,
  type EvaluationModelCall,
  type EvaluationModelCallResult,
  type EvaluationModelResult,
  type EvaluationModelState,
  type EvaluationPreservationMetrics,
  type EvaluationReport,
  type EvaluationReportAggregates,
  type EvaluationReportComposition,
  type EvaluationReportCounts,
  type EvaluationReportLatency,
  type EvaluationTokenMetrics,
} from './evaluation-report.js';
export {
  EVALUATION_RUN_CONFIG_SCHEMA_VERSION,
  EvaluationRunConfigValidationError,
  validateEvaluationRunConfig,
  type EvaluationModelExecution,
  type EvaluationRunConfig,
  type EvaluationRunConfigIssueCode,
} from './evaluation-run-config.js';

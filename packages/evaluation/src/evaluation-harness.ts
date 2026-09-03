import {
  CandidateValidationError,
  CandidateValidator,
  ContextCompilationError,
  ContextCompiler,
  type CompilationRequest,
  type CompilationResult,
} from '@ctxalloc/compiler';
import { availableInputTokens, type CandidateBlock } from '@ctxalloc/domain';
import type {
  ModelProvider,
  ModelProviderResult,
  MonotonicClock,
  Tokenizer,
} from '@ctxalloc/ports';
import { evaluateAnswer, type AnswerEvaluation } from './answer-evaluator.js';
import { canonicalJson, compareCodeUnits, domainSeparatedHash } from './canonical-json.js';
import {
  EVALUATION_BASELINE_RENDERER_ID,
  EVALUATION_BASELINE_RENDERER_VERSION,
  buildFullContextBaseline,
  buildTopKBaseline,
  buildTruncationBaseline,
  type EvaluationBaselineBuild,
} from './evaluation-baselines.js';
import {
  EVALUATION_FACT_WEIGHTS,
  validateEvaluationCase,
  type EvaluationCase,
  type EvaluationRequiredFact,
} from './evaluation-case.js';
import {
  EVALUATION_PROMPT_ID,
  EVALUATION_PROMPT_VERSION,
  buildEvaluationUserPrompt,
} from './evaluation-prompt.js';
import {
  EVALUATION_ANSWER_HASH_DOMAIN,
  EVALUATION_CASE_RESULT_SCHEMA_VERSION,
  EVALUATION_REPORT_SCHEMA_VERSION,
  hashReport,
  summarize,
  type EvaluationCaseDetails,
  type EvaluationCaseResult,
  type EvaluationCompilationFailure,
  type EvaluationDeterminismResult,
  type EvaluationModelCall,
  type EvaluationModelCallResult,
  type EvaluationModelResult,
  type EvaluationPreservationMetrics,
  type EvaluationReport,
  type EvaluationTokenMetrics,
} from './evaluation-report.js';
import { validateEvaluationRunConfig, type EvaluationRunConfig } from './evaluation-run-config.js';
import { EvaluationTokenMeasurementError } from './token-measurement.js';

/**
 * The evaluation harness (DEC-040).
 *
 * It answers the product question Phase 17 exists for: *does CtxAlloc preserve
 * what matters while spending fewer tokens than the obvious alternatives?* For
 * one case it builds explicit baselines, compiles the real request, measures
 * what survived, optionally asks one model the same question twice, and reports
 * token reduction, quality loss, and latency **separately**.
 *
 * Three properties keep the answer honest.
 *
 * **One tokenizer.** The harness owns a single `Tokenizer` object and gives it to
 * `CandidateValidator`, to every baseline measurement, and to `ContextCompiler`.
 * It does not accept a pre-built validator or compiler, because a compiler
 * configured with a different tokenizer would make `baselineInputTokens` and
 * `compiledTokens` counts of two different vocabularies, and their difference
 * would be arithmetic on incomparable numbers (METRICS 8.6).
 *
 * **One prompt.** Both model calls use the same provider instance, system
 * prompt, query, output limit, temperature, and prompt builder version. Only the
 * context differs. Any other difference would make the measured quality gap
 * partly about something else.
 *
 * **Two token vocabularies stay apart.** Provider-native usage is reported under
 * its own names and never subtracted from a CtxAlloc count.
 *
 * The compiler is untouched. No model is called from inside it, nothing is added
 * to `CompilationResult`, and token reduction exists only here (METRICS 8.7).
 */

/** Machine-readable categories of a harness failure (INV-TRACE-002). */
export type EvaluationHarnessIssueCode =
  | 'invalid_harness_configuration'
  | 'model_provider_required'
  | 'clock_failed'
  | 'duplicate_case_id'
  | 'tokenizer_failed';

/**
 * The single error the harness raises in its own right.
 *
 * Case validation raises `EvaluationCaseValidationError`, run-config validation
 * raises `EvaluationRunConfigValidationError`, and a compilation failure remains
 * a `ContextCompilationError` — none of them is weakened into a string here
 * (INV-ADAPTER-003).
 *
 * No message carries a query, a context, a prompt, or a model answer.
 */
export class EvaluationHarnessError extends Error {
  readonly code = 'EVALUATION_HARNESS_FAILED';
  readonly issueCode: EvaluationHarnessIssueCode;

  constructor(issueCode: EvaluationHarnessIssueCode, message: string) {
    super(message);
    this.name = 'EvaluationHarnessError';
    this.issueCode = issueCode;
  }
}

/** A conservative shape for a provider-supplied failure code. */
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Used when a provider's own code is absent or not obviously a code. */
const OPAQUE_FAILURE_CODE = 'provider_call_failed';

/**
 * A provider failure's code, when it is plainly a code and not prose.
 *
 * A provider is external, and its `message` may quote the prompt, the context,
 * or a credential — so no message is ever copied. A `code` is usually
 * project-owned and safe, but "usually" is not a guarantee, so only a value
 * shaped like a machine-readable constant is carried and anything else becomes
 * one fixed opaque code (INV-SEC-001).
 */
function failureCodeOf(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) return OPAQUE_FAILURE_CODE;
  const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');
  const code: unknown = descriptor === undefined ? undefined : descriptor.value;
  if (typeof code !== 'string' || !SAFE_FAILURE_CODE.test(code)) return OPAQUE_FAILURE_CODE;
  return code;
}

/** A measured operation and the elapsed milliseconds around it. */
interface Measured<T> {
  readonly value: T;
  readonly durationMilliseconds: number;
}

/** One compilation attempt: the compiler's result, or its structured failure. */
type CompileOutcome =
  | { readonly ok: true; readonly result: CompilationResult }
  | { readonly ok: false; readonly error: ContextCompilationError };

export class EvaluationHarness {
  readonly #tokenizer: Tokenizer;
  readonly #clock: MonotonicClock;
  readonly #modelProvider: ModelProvider | null;
  readonly #compiler: ContextCompiler;
  readonly #candidateValidator: CandidateValidator;
  readonly #compilerId: string;
  readonly #compilerVersion: string;

  /**
   * @param compilerConfig Validated by `ContextCompiler`; this class adds no
   * rules of its own and reads the compiler identity back only after the
   * compiler has accepted it.
   * @throws {ContextCompilationError} when the compiler configuration or the
   * tokenizer is unusable.
   * @throws {EvaluationHarnessError} when the clock is unusable.
   */
  constructor(
    compilerConfig: unknown,
    tokenizer: Tokenizer,
    clock: MonotonicClock,
    modelProvider?: ModelProvider,
  ) {
    // Constructed first: it owns configuration and tokenizer validation, and a
    // harness must not publish its own competing verdict on either.
    this.#compiler = new ContextCompiler(compilerConfig, tokenizer);
    this.#candidateValidator = new CandidateValidator(tokenizer);

    if (
      typeof clock !== 'object' ||
      clock === null ||
      typeof clock.nowMilliseconds !== 'function' ||
      typeof clock.id !== 'string' ||
      typeof clock.version !== 'string'
    ) {
      throw new EvaluationHarnessError(
        'invalid_harness_configuration',
        'EvaluationHarness requires a MonotonicClock with an id, a version, and nowMilliseconds().',
      );
    }

    const identity = compilerConfig as { compilerId?: unknown; compilerVersion?: unknown };
    this.#compilerId = typeof identity.compilerId === 'string' ? identity.compilerId : '';
    this.#compilerVersion =
      typeof identity.compilerVersion === 'string' ? identity.compilerVersion : '';

    this.#tokenizer = tokenizer;
    this.#clock = clock;
    this.#modelProvider = modelProvider ?? null;
  }

  /** The suite-safe result of one case. */
  async runCase(runConfig: unknown, evaluationCase: unknown): Promise<EvaluationCaseResult> {
    return (await this.runCaseDetailed(runConfig, evaluationCase)).result;
  }

  /**
   * One case's result together with the raw text it produced.
   *
   * The raw strings exist here and nowhere else. `runSuite` never collects them,
   * so a suite report cannot carry source content or a model answer even by
   * accident (INV-SEC-001).
   */
  async runCaseDetailed(
    runConfig: unknown,
    evaluationCase: unknown,
  ): Promise<EvaluationCaseDetails> {
    const config = validateEvaluationRunConfig(runConfig);
    const validatedCase = validateEvaluationCase(evaluationCase);
    this.#requireProviderFor(config);
    return this.#execute(config, validatedCase);
  }

  /**
   * Runs a whole suite and aggregates it into one report.
   *
   * Cases are validated first, then ordered by case identifier over UTF-16 code
   * units, so a report's row order does not depend on the order an array
   * literal happened to be written in (INV-DET-002). A repeated case identifier
   * is rejected rather than silently overwritten: two rows with one name make
   * every aggregate ambiguous.
   */
  async runSuite(runConfig: unknown, cases: readonly unknown[]): Promise<EvaluationReport> {
    const config = validateEvaluationRunConfig(runConfig);
    this.#requireProviderFor(config);

    const validated = cases.map((entry) => validateEvaluationCase(entry));
    const seen = new Set<string>();
    for (const entry of validated) {
      if (seen.has(entry.id)) {
        throw new EvaluationHarnessError(
          'duplicate_case_id',
          `EvaluationHarness received the case identifier ${JSON.stringify(entry.id)} more than once.`,
        );
      }
      seen.add(entry.id);
    }

    const ordered = [...validated].sort((a, b) => compareCodeUnits(a.id, b.id));
    const results: EvaluationCaseResult[] = [];
    for (const entry of ordered) {
      // Sequential on purpose: concurrent cases would interleave model calls and
      // make every measured latency a measurement of contention.
      results.push((await this.#execute(config, entry)).result);
    }

    return this.#report(config, results);
  }

  #requireProviderFor(config: EvaluationRunConfig): void {
    if (config.modelExecution !== 'disabled' && this.#modelProvider === null) {
      throw new EvaluationHarnessError(
        'model_provider_required',
        'EvaluationHarness requires a ModelProvider when model execution is enabled.',
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* One case                                                                  */
  /* ------------------------------------------------------------------------ */

  async #execute(
    config: EvaluationRunConfig,
    evaluationCase: EvaluationCase,
  ): Promise<EvaluationCaseDetails> {
    const request = evaluationCase.compilationRequest;
    const available = availableInputTokens(request.budget);

    // Candidate validation establishes the batch every baseline is built from.
    // When it fails there is no valid batch to render, so no baseline is built
    // and the compiler is left to produce its own structured failure — which is
    // also the failure an expected-failure case is checked against.
    let validCandidates: readonly CandidateBlock[] | null = null;
    try {
      validCandidates = this.#candidateValidator.validate({
        scope: request.scope,
        sourceDocuments: request.sourceDocuments,
        candidates: request.candidates,
      }).candidates;
    } catch (cause) {
      if (!(cause instanceof CandidateValidationError)) throw cause;
    }

    // Every baseline token count is validated. A tokenizer that throws, or that
    // returns anything but a non-negative safe integer, becomes one project-owned
    // harness failure rather than a raw dependency error or an invalid published
    // measurement (INV-BUDGET-005, INV-ADAPTER-003).
    const baselines =
      validCandidates === null ? null : this.#measureBaselines(validCandidates, available);

    const primary = this.#measure(() => this.#compile(request));
    const determinism = this.#checkDeterminism(config, request, primary.value);
    const outcome = primary.value;

    return outcome.ok
      ? this.#successfulCase(
          config,
          evaluationCase,
          outcome.result,
          primary.durationMilliseconds,
          determinism,
          baselines,
        )
      : this.#failedCase(
          evaluationCase,
          outcome.error,
          primary.durationMilliseconds,
          determinism,
          baselines,
        );
  }

  #measureBaselines(
    validCandidates: readonly CandidateBlock[],
    availableInputTokens: number,
  ): BaselineBuilds {
    try {
      return {
        fullContext: buildFullContextBaseline(validCandidates, this.#tokenizer),
        truncation: buildTruncationBaseline(validCandidates, availableInputTokens, this.#tokenizer),
        topK: buildTopKBaseline(validCandidates, availableInputTokens, this.#tokenizer),
      };
    } catch (cause) {
      if (!(cause instanceof EvaluationTokenMeasurementError)) throw cause;
      // The tokenizer's own wording and the measured text both stay inside: the
      // first is a dependency's, the second is source content (INV-SEC-001).
      throw new EvaluationHarnessError(
        'tokenizer_failed',
        'EvaluationHarness could not measure a baseline context with the configured tokenizer.',
      );
    }
  }

  #compile(request: CompilationRequest): CompileOutcome {
    try {
      return { ok: true, result: this.#compiler.compile(request) };
    } catch (cause) {
      if (cause instanceof ContextCompilationError) return { ok: false, error: cause };
      throw cause;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Determinism                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Repeats the exact same compilation and requires the exact same outcome.
   *
   * The comparison is a canonical projection of the **whole** compiler result —
   * identifier, compiled context, included blocks, usage, and settled trace —
   * with nothing excluded. Latency is not part of `CompilationResult`, so it
   * cannot make two identical compilations look different (INV-DET-001).
   *
   * A structured failure is compared the same way, so a deterministic failure
   * repeats cleanly and a case that succeeds once and fails once is recorded as
   * a determinism failure rather than as one of the two outcomes.
   *
   * The model is never called for a repeat: a compiler determinism check that
   * spent model calls would be paying to measure something the model has no part
   * in.
   */
  #checkDeterminism(
    config: EvaluationRunConfig,
    request: CompilationRequest,
    first: CompileOutcome,
  ): EvaluationDeterminismResult {
    const expected = projectOutcome(first);
    for (let execution = 2; execution <= config.determinismRepeats; execution += 1) {
      const repeat = this.#compile(request);
      if (repeat.ok !== first.ok) {
        return {
          executions: execution,
          matched: false,
          divergence: first.ok ? 'succeeded-then-failed' : 'failed-then-succeeded',
        };
      }
      if (projectOutcome(repeat) !== expected) {
        return { executions: execution, matched: false, divergence: 'result-differs' };
      }
    }
    return { executions: config.determinismRepeats, matched: true };
  }

  /* ------------------------------------------------------------------------ */
  /* Latency                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Measures one operation with the injected monotonic clock.
   *
   * Both readings are validated and the interval is required to be
   * non-decreasing. A clock that moved backwards would produce a negative
   * duration, and publishing one would be reporting a measurement that cannot
   * have happened — so it is a harness failure instead.
   */
  #measure<T>(operation: () => T): Measured<T> {
    const start = this.#reading();
    const value = operation();
    const end = this.#reading();
    if (end < start) {
      throw new EvaluationHarnessError(
        'clock_failed',
        'EvaluationHarness observed a MonotonicClock reading that moved backwards.',
      );
    }
    return { value, durationMilliseconds: end - start };
  }

  async #measureAsync<T>(operation: () => Promise<T>): Promise<Measured<T>> {
    const start = this.#reading();
    const value = await operation();
    const end = this.#reading();
    if (end < start) {
      throw new EvaluationHarnessError(
        'clock_failed',
        'EvaluationHarness observed a MonotonicClock reading that moved backwards.',
      );
    }
    return { value, durationMilliseconds: end - start };
  }

  #reading(): number {
    let reading: unknown;
    try {
      reading = this.#clock.nowMilliseconds();
    } catch {
      // The port is an external boundary: an adapter exception, or a test
      // double's exhaustion, must not escape carrying its own message
      // (INV-ADAPTER-003, INV-SEC-001).
      throw new EvaluationHarnessError(
        'clock_failed',
        'EvaluationHarness could not read the configured MonotonicClock.',
      );
    }
    if (typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0) {
      throw new EvaluationHarnessError(
        'clock_failed',
        'EvaluationHarness requires every MonotonicClock reading to be a finite non-negative number.',
      );
    }
    return reading;
  }

  /* ------------------------------------------------------------------------ */
  /* Successful compilation                                                    */
  /* ------------------------------------------------------------------------ */

  async #successfulCase(
    config: EvaluationRunConfig,
    evaluationCase: EvaluationCase,
    result: CompilationResult,
    compilationLatencyMilliseconds: number,
    determinism: EvaluationDeterminismResult,
    baselines: BaselineBuilds | null,
  ): Promise<EvaluationCaseDetails> {
    const expectsFailure = evaluationCase.expectedCompilationFailure !== undefined;

    const base = {
      schemaVersion:
        EVALUATION_CASE_RESULT_SCHEMA_VERSION as typeof EVALUATION_CASE_RESULT_SCHEMA_VERSION,
      caseId: evaluationCase.id,
      datasetSplit: evaluationCase.datasetSplit,
      tags: [...evaluationCase.tags].sort(compareCodeUnits),
      compilation: 'succeeded' as const,
      compilationId: String(result.compilationId),
      requestFingerprint: String(result.trace.request.fingerprint),
      compilationLatencyMilliseconds,
      ...(baselines === null ? {} : { baselines: publishedBaselines(baselines) }),
      determinism,
    };

    if (expectsFailure) {
      // The case predicted a failure and got a success. Its metrics are not
      // reported: they would enter aggregates a failure case is excluded from,
      // under a case whose stated expectation was not met (METRICS 13.2).
      return {
        result: {
          ...base,
          model: { state: 'skipped-expected-failure', callOrder: [] },
          expectedFailure: {
            expected: evaluationCase.expectedCompilationFailure as {
              stage: string;
              issueCode: string;
            },
            passed: false,
          },
        },
        ...rawBaselineContexts(baselines),
        compiledContext: result.compiledContext,
      };
    }

    const preservation = measurePreservation(evaluationCase, result);
    const tokens = baselines === null ? undefined : measureTokens(baselines, result);
    const usage = {
      compiledTokens: result.usage.compiledTokens,
      availableInputTokens: result.usage.availableTokens,
      unusedTokens: result.usage.unusedTokens,
      renderingTokenDelta: result.usage.renderingTokenDelta,
      budgetViolation: result.usage.compiledTokens > result.usage.availableTokens,
    };

    const model = await this.#runModel(config, evaluationCase, baselines, result);

    return {
      result: {
        ...base,
        ...(tokens === undefined ? {} : { tokens }),
        usage,
        preservation,
        model: model.report,
        ...(model.report.compiled === undefined
          ? {}
          : {
              compiledRequestLatencyMilliseconds:
                compilationLatencyMilliseconds + model.report.compiled.latencyMilliseconds,
            }),
      },
      ...rawBaselineContexts(baselines),
      compiledContext: result.compiledContext,
      ...model.raw,
    };
  }

  #failedCase(
    evaluationCase: EvaluationCase,
    error: ContextCompilationError,
    compilationLatencyMilliseconds: number,
    determinism: EvaluationDeterminismResult,
    baselines: BaselineBuilds | null,
  ): EvaluationCaseDetails {
    const failure: EvaluationCompilationFailure = {
      stage: error.stage,
      // Codes only: an issue message legitimately quotes request values, and a
      // report is not a place for them (INV-SEC-001).
      issueCodes: [...new Set(error.issues.map((issue) => issue.code))].sort(compareCodeUnits),
      ...(error.compilationId === undefined ? {} : { compilationId: String(error.compilationId) }),
    };

    const expected = evaluationCase.expectedCompilationFailure;

    return {
      result: {
        schemaVersion:
          EVALUATION_CASE_RESULT_SCHEMA_VERSION as typeof EVALUATION_CASE_RESULT_SCHEMA_VERSION,
        caseId: evaluationCase.id,
        datasetSplit: evaluationCase.datasetSplit,
        tags: [...evaluationCase.tags].sort(compareCodeUnits),
        compilation: 'failed',
        ...(failure.compilationId === undefined ? {} : { compilationId: failure.compilationId }),
        compilationFailure: failure,
        compilationLatencyMilliseconds,
        ...(baselines === null ? {} : { baselines: publishedBaselines(baselines) }),
        determinism,
        model: {
          state: expected === undefined ? 'skipped-compilation-failed' : 'skipped-expected-failure',
          callOrder: [],
        },
        ...(expected === undefined
          ? {}
          : {
              expectedFailure: {
                expected,
                passed:
                  error.stage === expected.stage &&
                  error.issues.some((issue) => issue.code === expected.issueCode),
              },
            }),
      },
      ...rawBaselineContexts(baselines),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Model execution                                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Asks the same model the same question twice, changing only the context.
   *
   * The full-context baseline is called first and the compiled context second,
   * and the order is recorded: a provider whose behavior depends on call order
   * would otherwise bias one side invisibly.
   *
   * A provider failure is recorded as a failure. It never becomes an answer
   * score of zero — a model that could not be reached said nothing about the
   * context, and scoring silence as a wrong answer would blame the compiler for
   * an outage.
   */
  async #runModel(
    config: EvaluationRunConfig,
    evaluationCase: EvaluationCase,
    baselines: BaselineBuilds | null,
    result: CompilationResult,
  ): Promise<{
    readonly report: EvaluationModelResult;
    readonly raw: Partial<EvaluationCaseDetails>;
  }> {
    const provider = this.#modelProvider;
    if (config.modelExecution === 'disabled' || provider === null || baselines === null) {
      return { report: { state: 'disabled', callOrder: [] }, raw: {} };
    }

    const query = evaluationCase.compilationRequest.query;
    const baselinePrompt = buildEvaluationUserPrompt(baselines.fullContext.context, query);
    const compiledPrompt = buildEvaluationUserPrompt(result.compiledContext, query);
    const identity = {
      providerId: provider.id,
      providerVersion: provider.version,
      modelId: provider.modelId,
    };
    // Attempted, not planned. A two-entry order published after the baseline
    // call failed would be a false audit record of a call that never happened.
    const baselineOnly: readonly EvaluationModelCall[] = ['full-baseline'];
    const bothCalls: readonly EvaluationModelCall[] = ['full-baseline', 'compiled'];

    let baselineCall: Measured<ModelProviderResult>;
    try {
      baselineCall = await this.#measureAsync(() =>
        provider.generate(this.#requestFor(config, baselinePrompt)),
      );
    } catch (cause) {
      if (cause instanceof EvaluationHarnessError) throw cause;
      return {
        report: {
          state: 'baseline-call-failed',
          callOrder: baselineOnly,
          ...identity,
          failedCall: 'full-baseline',
          failureCode: failureCodeOf(cause),
        },
        raw: { baselineUserPrompt: baselinePrompt },
      };
    }

    let compiledCall: Measured<ModelProviderResult>;
    try {
      compiledCall = await this.#measureAsync(() =>
        provider.generate(this.#requestFor(config, compiledPrompt)),
      );
    } catch (cause) {
      if (cause instanceof EvaluationHarnessError) throw cause;
      return {
        report: {
          state: 'compiled-call-failed',
          callOrder: bothCalls,
          ...identity,
          baseline: callResult('full-baseline', baselineCall, evaluationCase),
          failedCall: 'compiled',
          failureCode: failureCodeOf(cause),
        },
        raw: {
          baselineUserPrompt: baselinePrompt,
          compiledUserPrompt: compiledPrompt,
          baselineAnswer: baselineCall.value.outputText,
        },
      };
    }

    const baseline = callResult('full-baseline', baselineCall, evaluationCase);
    const compiled = callResult('compiled', compiledCall, evaluationCase);

    // A provider may resolve one configured alias to a concrete version, which is
    // legitimate — but if the two calls report *different* concrete models, two
    // experimental variables changed and the difference in the answers is no
    // longer a context effect. Both scores stay published; the comparison does
    // not (METRICS 11.6).
    const mismatched =
      baseline.actualModelId !== undefined &&
      compiled.actualModelId !== undefined &&
      baseline.actualModelId !== compiled.actualModelId;

    const loss =
      mismatched ||
      baseline.answerQualityScore === undefined ||
      compiled.answerQualityScore === undefined
        ? undefined
        : baseline.answerQualityScore - compiled.answerQualityScore;

    return {
      report: {
        state: 'executed',
        callOrder: bothCalls,
        ...identity,
        baseline,
        compiled,
        ...(mismatched ? { qualityComparisonIssue: 'actual-model-mismatch' as const } : {}),
        ...(loss === undefined
          ? {}
          : {
              qualityLoss: loss,
              // Strictly greater than: a loss exactly at the configured
              // threshold is the boundary the run declared acceptable.
              severeQualityLoss: loss > config.severeQualityLossThreshold,
            }),
      },
      raw: {
        baselineUserPrompt: baselinePrompt,
        compiledUserPrompt: compiledPrompt,
        baselineAnswer: baselineCall.value.outputText,
        compiledAnswer: compiledCall.value.outputText,
      },
    };
  }

  #requestFor(
    config: EvaluationRunConfig,
    userPrompt: string,
  ): {
    schemaVersion: 1;
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
    temperature: number;
  } {
    return {
      schemaVersion: 1,
      systemPrompt: config.systemPrompt,
      userPrompt,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Suite report                                                              */
  /* ------------------------------------------------------------------------ */

  #report(config: EvaluationRunConfig, cases: readonly EvaluationCaseResult[]): EvaluationReport {
    const provider = this.#modelProvider;
    const expectedFailureCases = cases.filter((entry) => entry.expectedFailure !== undefined);

    const counts = {
      cases: cases.length,
      successfulCompilations: cases.filter((entry) => entry.compilation === 'succeeded').length,
      expectedFailureCases: expectedFailureCases.length,
      expectedFailuresMatched: expectedFailureCases.filter(
        (entry) => entry.expectedFailure?.passed === true,
      ).length,
      unexpectedFailures: cases.filter(
        (entry) => entry.compilation === 'failed' && entry.expectedFailure === undefined,
      ).length,
      providerFailures: cases.filter(
        (entry) =>
          entry.model.state === 'baseline-call-failed' ||
          entry.model.state === 'compiled-call-failed',
      ).length,
      determinismFailures: cases.filter((entry) => entry.determinism?.matched === false).length,
      budgetViolations: cases.filter((entry) => entry.usage?.budgetViolation === true).length,
      severeQualityLosses: cases.filter((entry) => entry.model.severeQualityLoss === true).length,
      // Visible at suite level so a blocked comparison cannot disappear into an
      // absent `qualityLoss` that looks like an unscored case.
      modelIdentityMismatches: cases.filter(
        (entry) => entry.model.qualityComparisonIssue === 'actual-model-mismatch',
      ).length,
    };

    const collect = (pick: (entry: EvaluationCaseResult) => number | undefined): number[] =>
      cases.map(pick).filter((value): value is number => value !== undefined);

    const draft = {
      schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION as typeof EVALUATION_REPORT_SCHEMA_VERSION,
      runId: config.runId,
      executedAt: config.executedAt,
      datasetId: config.datasetId,
      datasetVersion: config.datasetVersion,
      referenceEnvironment: config.referenceEnvironment,
      modelExecution: config.modelExecution,
      composition: {
        tokenizerId: this.#tokenizer.id,
        tokenizerVersion: this.#tokenizer.version,
        compilerId: this.#compilerId,
        compilerVersion: this.#compilerVersion,
        promptId: EVALUATION_PROMPT_ID,
        promptVersion: EVALUATION_PROMPT_VERSION,
        baselineRendererId: EVALUATION_BASELINE_RENDERER_ID,
        baselineRendererVersion: EVALUATION_BASELINE_RENDERER_VERSION,
        clockId: this.#clock.id,
        clockVersion: this.#clock.version,
        ...(provider === null || config.modelExecution === 'disabled'
          ? {}
          : {
              modelProviderId: provider.id,
              modelProviderVersion: provider.version,
              modelId: provider.modelId,
            }),
      },
      counts,
      aggregates: withoutAbsent({
        requiredBlockRecall: summarize(collect((e) => e.preservation?.requiredBlockRecall)),
        weightedFactCoverage: summarize(collect((e) => e.preservation?.weightedFactCoverage)),
        criticalFactCoverage: summarize(collect((e) => e.preservation?.criticalFactCoverage)),
        relevantBlockRecall: summarize(collect((e) => e.preservation?.relevantBlockRecall)),
        irrelevantExclusionRate: summarize(collect((e) => e.preservation?.irrelevantExclusionRate)),
        tokenReduction: summarize(collect((e) => e.tokens?.tokenReduction)),
        tokenReductionRatio: summarize(collect((e) => e.tokens?.tokenReductionRatio)),
        qualityLoss: summarize(collect((e) => e.model.qualityLoss)),
      }),
      latency: withoutAbsent({
        compilation: summarize(cases.map((entry) => entry.compilationLatencyMilliseconds)),
        baselineModel: summarize(collect((e) => e.model.baseline?.latencyMilliseconds)),
        compiledModel: summarize(collect((e) => e.model.compiled?.latencyMilliseconds)),
        compiledRequest: summarize(collect((e) => e.compiledRequestLatencyMilliseconds)),
      }),
      cases,
    };

    return { ...draft, reportHash: hashReport(draft) };
  }
}

/* -------------------------------------------------------------------------- */
/* Case helpers                                                                */
/* -------------------------------------------------------------------------- */

interface BaselineBuilds {
  readonly fullContext: EvaluationBaselineBuild;
  readonly truncation: EvaluationBaselineBuild;
  readonly topK: EvaluationBaselineBuild;
}

function publishedBaselines(builds: BaselineBuilds): {
  readonly fullContext: EvaluationBaselineBuild['result'];
  readonly truncation: EvaluationBaselineBuild['result'];
  readonly topK: EvaluationBaselineBuild['result'];
} {
  return {
    fullContext: builds.fullContext.result,
    truncation: builds.truncation.result,
    topK: builds.topK.result,
  };
}

function rawBaselineContexts(builds: BaselineBuilds | null): Partial<EvaluationCaseDetails> {
  if (builds === null) return {};
  return {
    fullContextBaselineContext: builds.fullContext.context,
    truncationBaselineContext: builds.truncation.context,
    ...(builds.topK.result.applicable ? { topKBaselineContext: builds.topK.context } : {}),
  };
}

/**
 * Drops absent entries, so an omitted distribution is a missing key rather than
 * a present key holding `undefined`.
 *
 * Under `exactOptionalPropertyTypes` those are different records, and the second
 * one serializes an aggregate that says "measured: nothing" instead of not
 * appearing at all.
 */
function withoutAbsent<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry;
  }
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * The canonical projection two compilations are compared by.
 *
 * Nothing is excluded from a successful result. A failure is projected onto its
 * stage, its exact issues, and its identifier, which is everything a caller
 * could observe about it.
 */
function projectOutcome(outcome: CompileOutcome): string {
  if (outcome.ok) return canonicalJson(outcome.result);
  return canonicalJson({
    stage: outcome.error.stage,
    issues: outcome.error.issues,
    compilationId: outcome.error.compilationId ?? null,
  });
}

/**
 * Context-preservation metrics from the final included blocks (METRICS 9).
 *
 * A fact is preserved when **every** block of at least **one** of its evidence
 * groups is included: OR across groups, AND inside a group.
 *
 * Every ratio is absent when its denominator is zero. A case that annotates no
 * irrelevant blocks has no exclusion rate to report, and reporting `1` would
 * credit the compiler for excluding nothing.
 */
function measurePreservation(
  evaluationCase: EvaluationCase,
  result: CompilationResult,
): EvaluationPreservationMetrics {
  // Compared as plain strings: the domain brands its block identifier type, and
  // a case annotation is caller text that has not been through that brand.
  const included = new Set<string>(result.includedBlocks.map((block) => String(block.id)));

  const ratio = (matched: number, total: number): number | undefined =>
    total === 0 ? undefined : matched / total;

  const preserved = (fact: EvaluationRequiredFact): boolean =>
    fact.evidenceBlockGroups.some((group) => group.every((blockId) => included.has(blockId)));

  const facts = evaluationCase.requiredFacts;
  const preservedFacts = facts.filter(preserved);
  const totalWeight = facts.reduce(
    (sum, fact) => sum + EVALUATION_FACT_WEIGHTS[fact.importance],
    0,
  );
  const preservedWeight = preservedFacts.reduce(
    (sum, fact) => sum + EVALUATION_FACT_WEIGHTS[fact.importance],
    0,
  );
  const critical = facts.filter((fact) => fact.importance === 'critical');

  const requiredMatched = evaluationCase.requiredBlockIds.filter((id) => included.has(id)).length;
  const relevantMatched = evaluationCase.relevantBlockIds.filter((id) => included.has(id)).length;
  const irrelevantExcluded = evaluationCase.irrelevantBlockIds.filter(
    (id) => !included.has(id),
  ).length;

  return {
    ...maybe('requiredBlockRecall', ratio(requiredMatched, evaluationCase.requiredBlockIds.length)),
    ...maybe('weightedFactCoverage', ratio(preservedWeight, totalWeight)),
    ...maybe('criticalFactCoverage', ratio(critical.filter(preserved).length, critical.length)),
    ...maybe('relevantBlockRecall', ratio(relevantMatched, evaluationCase.relevantBlockIds.length)),
    ...maybe(
      'irrelevantExclusionRate',
      ratio(irrelevantExcluded, evaluationCase.irrelevantBlockIds.length),
    ),
    preservedFactIds: preservedFacts.map((fact) => fact.id),
    missingFactIds: facts.filter((fact) => !preserved(fact)).map((fact) => fact.id),
  };
}

function maybe(key: string, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

/** Token metrics against the full-context baseline (METRICS 8.7, 8.8). */
function measureTokens(builds: BaselineBuilds, result: CompilationResult): EvaluationTokenMetrics {
  const full = builds.fullContext.result;
  const baselineInputTokens = full.applicable ? full.contextTokens : 0;
  const compiledTokens = result.usage.compiledTokens;
  const truncation = builds.truncation.result;
  const topK = builds.topK.result;

  return {
    baselineInputTokens,
    compiledTokens,
    // Never clamped: a compiled context larger than the whole candidate set is a
    // real outcome, and hiding it would hide the case worth looking at.
    tokenReduction: baselineInputTokens - compiledTokens,
    // Absent rather than NaN or Infinity when there was nothing to reduce.
    ...(baselineInputTokens === 0
      ? {}
      : { tokenReductionRatio: (baselineInputTokens - compiledTokens) / baselineInputTokens }),
    ...(truncation.applicable
      ? {
          truncationBaselineTokens: truncation.contextTokens,
          truncationTokenReduction: truncation.contextTokens - compiledTokens,
        }
      : {}),
    ...(topK.applicable
      ? {
          topKBaselineTokens: topK.contextTokens,
          topKTokenReduction: topK.contextTokens - compiledTokens,
        }
      : {}),
  };
}

/** One model call's suite-safe measurements. */
function callResult(
  call: EvaluationModelCall,
  measured: Measured<ModelProviderResult>,
  evaluationCase: EvaluationCase,
): EvaluationModelCallResult {
  const answer = measured.value.outputText;
  const evaluation: AnswerEvaluation = evaluateAnswer(answer, evaluationCase.answerCriteria);
  const usage = measured.value.usage;

  return {
    call,
    latencyMilliseconds: measured.durationMilliseconds,
    answerHash: domainSeparatedHash(EVALUATION_ANSWER_HASH_DOMAIN, answer),
    criteria: evaluation.criteria,
    ...(evaluation.score === undefined ? {} : { answerQualityScore: evaluation.score }),
    ...(usage?.inputTokens === undefined ? {} : { providerInputTokens: usage.inputTokens }),
    ...(usage?.outputTokens === undefined ? {} : { providerOutputTokens: usage.outputTokens }),
    ...(measured.value.providerRequestId === undefined
      ? {}
      : { providerRequestId: measured.value.providerRequestId }),
    ...(measured.value.stopReason === undefined ? {} : { stopReason: measured.value.stopReason }),
    ...(measured.value.actualModelId === undefined
      ? {}
      : { actualModelId: measured.value.actualModelId }),
  };
}

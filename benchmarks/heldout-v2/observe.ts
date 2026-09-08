import {
  CompilationRequestValidator,
  ContextCompilationError,
  ContextCompiler,
  type CompilationRequest,
  type CompilationResult,
} from '@ctxalloc/compiler';
import { TimestampSchema } from '@ctxalloc/domain';
import {
  EvaluationHarness,
  validateEvaluationCase,
  type EvaluationRunConfig,
} from '@ctxalloc/evaluation';
import type { Tokenizer } from '@ctxalloc/ports';
import { measureCorrectness } from '../acceptance/correctness.js';
import { array, object, hashJson } from './data.js';
import { COMPILER, DATASET, METRICS, REFERENCE_TIME } from './protocol.js';
import { reduction, selectionMetrics } from './metrics.js';
import type { HeldoutCase } from './types.js';

/** Observational assertions over actual numeric stage evidence; no evaluator truth is consulted. */
export function contractChecks(request: CompilationRequest, result: CompilationResult) {
  const scoring = request.policy.scoring;
  const filtering = request.policy.filtering;
  if (scoring.schemaVersion !== 2 || filtering.schemaVersion !== 3)
    throw new Error('Frozen evidence schemas required.');
  const exclusions = filtering.applicability?.exclusions ?? [];
  const ignoredKey = (v: {
    providerId: string;
    providerVersion: string;
    semantics: string;
    higherIsBetter: boolean;
  }) => hashJson([v.providerId, v.providerVersion, v.semantics, v.higherIsBetter]);
  const ignored = new Set(scoring.compatibility.ignoredRetrievalContracts.map(ignoredKey));
  const checks = result.trace.groups.map((g) => {
    const ids = g.members.map((m) => String(m.blockId));
    const applicability = exclusions.find((e) => ids.includes(e.blockId));
    const incomplete =
      g.score.evidence?.components
        .filter((c) => c.completeness === 'incomplete' && (g.score[c.component]?.weight ?? 0) > 0)
        .map((c) => c.component) ?? [];
    const below =
      filtering.minimumTotalScore !== undefined && g.score.total < filtering.minimumTotalScore;
    const expectedReason =
      applicability !== undefined
        ? applicability.reason === 'inapplicable'
          ? 'FILTERED_INAPPLICABLE'
          : 'FILTERED_SUPERSEDED'
        : g.canonical.required
          ? 'ELIGIBLE_REQUIRED'
          : !below
            ? 'ELIGIBLE_POLICY'
            : incomplete.length > 0
              ? 'ELIGIBLE_INCOMPLETE_EVIDENCE'
              : 'FILTERED_SCORE_BELOW_MINIMUM';
    const rawIgnored = g.members
      .flatMap((m) => {
        const r = m.retrieval;
        if (r?.score === undefined) return [];
        const v = {
          blockId: m.blockId,
          providerId: r.providerId,
          providerVersion: r.providerVersion,
          semantics: r.score.semantics,
          higherIsBetter: r.score.higherIsBetter,
          rawValue: r.score.value,
        };
        return ignored.has(ignoredKey(v)) ? [hashJson(v)] : [];
      })
      .sort();
    const observedIgnored = (g.score.evidence?.ignoredRetrieval ?? []).map(hashJson).sort();
    const scoreEvidence = g.score.retrieval?.evidence ?? [];
    return {
      blockId: g.canonical.id,
      admission:
        g.filtering.reason === expectedReason &&
        !(
          below &&
          incomplete.length > 0 &&
          !g.canonical.required &&
          applicability === undefined &&
          filtering.onIncompleteEvidence === 'reject'
        ),
      applicability:
        applicability === undefined ||
        result.trace.settlement.decisions.find((d) => d.blockId === g.canonical.id)?.reason ===
          expectedReason,
      compatibility:
        scoreEvidence.every((e) => !ignored.has(ignoredKey(e))) &&
        hashJson(rawIgnored) === hashJson(observedIgnored),
      completeness:
        g.score.evidence !== undefined &&
        hashJson(g.score.evidence.scope) === hashJson(request.scope) &&
        g.score.evidence.components.every(
          (c) =>
            c.configured === (scoring[c.component] !== undefined) &&
            c.completeness ===
              (scoring.evidence.completeness.find((d) => d.component === c.component)?.state ??
                null),
        ),
      traceVersion: result.trace.schemaVersion === 4,
    };
  });
  return {
    groups: checks,
    passed: checks.every(
      (c) => c.admission && c.applicability && c.compatibility && c.completeness && c.traceVersion,
    ),
  };
}
function execute(compiler: ContextCompiler, input: unknown) {
  try {
    return { result: compiler.compile(input), failure: null };
  } catch (e) {
    return {
      result: null,
      failure:
        e instanceof ContextCompilationError
          ? {
              stage: e.stage,
              issueCodes: [...new Set(e.issues.map((i) => i.code))].sort(),
              compilationId: e.compilationId ?? null,
            }
          : {
              stage: 'unexpected-implementation',
              issueCodes: ['unexpected_implementation_failure'],
              compilationId: null,
            },
    };
  }
}
export async function observeCases(entries: readonly HeldoutCase[], tokenizer: Tokenizer) {
  const compiler = new ContextCompiler(COMPILER, tokenizer);
  const harness = new EvaluationHarness(COMPILER, tokenizer, {
    id: 'heldout-v2-timing-disabled',
    version: '1',
    nowMilliseconds: () => 0,
  });
  const config: EvaluationRunConfig = {
    schemaVersion: 1,
    runId: DATASET.id,
    executedAt: TimestampSchema.parse(REFERENCE_TIME),
    datasetId: DATASET.id,
    datasetVersion: DATASET.version,
    referenceEnvironment: 'offline-reference-tokenizer',
    systemPrompt: 'Model execution is disabled.',
    maxOutputTokens: 100,
    temperature: 0,
    modelExecution: 'disabled',
    determinismRepeats: 1,
    severeQualityLossThreshold: 0.2,
  };
  const observations = [];
  for (const entry of entries) {
    const first = execute(compiler, entry.input);
    const repeats = Array.from({ length: METRICS.repeats - 1 }, () =>
      execute(compiler, entry.input),
    );
    const fingerprint = (v: ReturnType<typeof execute>) => hashJson(v.result ?? v.failure);
    const repeatAgreement = repeats.every((r) => fingerprint(r) === fingerprint(first));
    const expected = entry.expectedFailure;
    const matchesFailure =
      first.failure !== null &&
      expected !== null &&
      first.failure.stage === expected.stage &&
      hashJson(first.failure.issueCodes) === hashJson([expected.issueCode]);
    let status: 'success' | 'expected-failure' | 'unexpected-failure' | 'unexpected-success' =
      first.result === null
        ? matchesFailure
          ? 'expected-failure'
          : 'unexpected-failure'
        : expected === null
          ? 'success'
          : 'unexpected-success';
    let selection = null;
    let correctness = null;
    let contracts = null;
    let tokens = null;
    let baseline = null;
    let evaluatorFailure = false;
    let additionalCompilationAgrees = true;
    if (first.result !== null) {
      try {
        const request = new CompilationRequestValidator().validate(entry.input);
        const result = first.result;
        selection = selectionMetrics(entry.annotations, request, result);
        correctness = measureCorrectness(request, result, tokenizer);
        contracts = contractChecks(request, result);
        const annotated = validateEvaluationCase({
          schemaVersion: 1,
          id: entry.id,
          datasetSplit: 'validation',
          compilationRequest: request,
          requiredBlockIds: entry.annotations.requiredBlockIds,
          requiredFacts: entry.annotations.facts
            .filter((f) => f.required)
            .map((f) => ({
              id: f.id,
              description: f.description,
              importance: f.importance,
              evidenceBlockGroups: f.evidenceBlockGroups,
              acceptableEvidence: [],
            })),
          relevantBlockIds: entry.annotations.units
            .filter((u) => u.useful)
            .flatMap((u) => u.blockIds),
          irrelevantBlockIds: entry.annotations.units
            .filter((u) => !u.useful)
            .flatMap((u) => u.blockIds),
          answerCriteria: [],
          tags: [entry.profile, entry.stratum, entry.evidenceCondition, entry.budgetRegime],
        });
        const measured = await harness.runCaseDetailed(config, annotated);
        baseline = measured.result.baselines?.fullContext ?? null;
        if (baseline === null || !baseline.applicable)
          throw new Error('Full rendered baseline is required.');
        tokens = reduction(baseline.contextTokens, result.usage.compiledTokens);
        additionalCompilationAgrees =
          measured.result.compilationId === result.compilationId &&
          measured.compiledContext === result.compiledContext;
      } catch {
        evaluatorFailure = true;
        status = 'unexpected-failure';
      }
    }
    observations.push({
      caseId: entry.id,
      profile: entry.profile,
      stratum: entry.stratum,
      replica: entry.replica,
      budgetRegime: entry.budgetRegime,
      evidenceCondition: entry.evidenceCondition,
      reductionExpected: entry.reductionExpected,
      candidateWrappers: objectCandidateCount(entry.input),
      expectedFailure: expected,
      status,
      failure: first.failure,
      evaluatorFailure,
      repeatComparisons: repeats.length,
      repeatAgreement,
      additionalCompilationAgrees,
      selection,
      correctness,
      contracts,
      tokens,
      baseline,
      usage: first.result?.usage ?? null,
      trace: first.result?.trace ?? null,
      inputHash: hashJson(entry.input),
      annotationHash: hashJson(entry.annotations),
    });
  }
  return observations;
}
function objectCandidateCount(input: unknown) {
  return array(object(input).candidates).length;
}
export type CaseObservation = Awaited<ReturnType<typeof observeCases>>[number];

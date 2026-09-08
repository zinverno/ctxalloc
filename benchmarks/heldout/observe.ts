import { ContextCompiler } from '@ctxalloc/compiler';
import {
  EvaluationHarness,
  validateEvaluationCase,
  type EvaluationCaseResult,
  type EvaluationRunConfig,
} from '@ctxalloc/evaluation';
import { TimestampSchema } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import {
  measureCorrectness,
  scopeDetections,
  type CorrectnessCounts,
} from '../acceptance/correctness.js';
import { measureSelection } from './metrics.js';
import { COMPILER, DATASET, REFERENCE_TIME, type HeldoutCase } from './types.js';

export interface CaseObservation {
  readonly caseId: string;
  readonly profile: HeldoutCase['profile'];
  readonly stratum: HeldoutCase['stratum'];
  readonly replica: HeldoutCase['replica'];
  readonly budgetRegime: HeldoutCase['budgetRegime'];
  readonly evidenceCondition: HeldoutCase['annotations']['evidenceCondition'];
  readonly expectedFailure: boolean;
  readonly status: 'success' | 'expected-failure' | 'unexpected-failure' | 'unexpected-success';
  readonly candidateWrappers: number;
  readonly candidateContentTokens: number;
  readonly harness: Omit<
    EvaluationCaseResult,
    'compilationLatencyMilliseconds' | 'compiledRequestLatencyMilliseconds'
  >;
  readonly selection: ReturnType<typeof measureSelection> | null;
  readonly correctness: CorrectnessCounts | null;
  readonly scopeDetections: { readonly numerator: number; readonly denominator: number };
  readonly additionalCompilationAgrees: boolean;
  readonly trace: {
    readonly schemaVersion: number;
    readonly groups: readonly {
      readonly canonicalId: string;
      readonly memberIds: readonly string[];
      readonly scoreTotal: number;
      readonly filterReason: string;
      readonly finalReason: string;
    }[];
  } | null;
}

/** Only the verified runner may supply frozen cases; pre-freeze tests use unrelated toy inputs. */
export async function observeCases(
  entries: readonly HeldoutCase[],
  tokenizer: Tokenizer,
): Promise<readonly CaseObservation[]> {
  // The harness requires a clock; constant readings are explicitly NOT_MEASURED,
  // and no duration is published as performance evidence.
  const clock = { id: 'heldout-timing-disabled', version: '1', nowMilliseconds: () => 0 };
  const harness = new EvaluationHarness(COMPILER, tokenizer, clock);
  const compiler = new ContextCompiler(COMPILER, tokenizer);
  const config: EvaluationRunConfig = {
    schemaVersion: 1,
    runId: 'ctxalloc-heldout-v1',
    executedAt: TimestampSchema.parse(REFERENCE_TIME),
    datasetId: DATASET.id,
    datasetVersion: DATASET.version,
    referenceEnvironment: 'offline-reference-tokenizer',
    systemPrompt: 'Model execution is disabled.',
    maxOutputTokens: 100,
    temperature: 0,
    modelExecution: 'disabled',
    determinismRepeats: 3,
    severeQualityLossThreshold: 0.2,
  };
  const observations: CaseObservation[] = [];
  for (const entry of entries) {
    const annotated = validateEvaluationCase({
      schemaVersion: 1,
      id: entry.id,
      datasetSplit: 'validation',
      compilationRequest: entry.input,
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
      relevantBlockIds: entry.annotations.units.filter((u) => u.useful).flatMap((u) => u.blockIds),
      irrelevantBlockIds: entry.annotations.units
        .filter((u) => !u.useful)
        .flatMap((u) => u.blockIds),
      ...(entry.annotations.expectedFailure === null
        ? {}
        : { expectedCompilationFailure: entry.annotations.expectedFailure }),
      answerCriteria: [],
      tags: [entry.profile, entry.stratum, entry.budgetRegime],
    });
    const detailed = await harness.runCaseDetailed(config, annotated);
    // Remove only runtime timing fields; the existing privacy-safe evidence stays intact.
    const {
      compilationLatencyMilliseconds: ignoredLatency,
      compiledRequestLatencyMilliseconds: ignoredRequestLatency,
      ...evidence
    } = detailed.result;
    void ignoredLatency;
    void ignoredRequestLatency;
    const expectedFailure = entry.annotations.expectedFailure !== null;
    const succeeded = evidence.compilation === 'succeeded';
    const result = succeeded ? compiler.compile(entry.input) : null;
    const selection = result === null ? null : measureSelection(entry, result);
    const agrees =
      result === null ||
      (evidence.compilationId === result.compilationId &&
        detailed.compiledContext === result.compiledContext &&
        evidence.tokens?.compiledTokens === result.usage.compiledTokens &&
        evidence.usage?.availableInputTokens === result.usage.availableTokens &&
        (evidence.preservation?.requiredBlockRecall ?? null) ===
          (selection!.ratios.requiredBlockRecall.denominator === 0
            ? null
            : selection!.ratios.requiredBlockRecall.numerator /
              selection!.ratios.requiredBlockRecall.denominator) &&
        (evidence.preservation?.weightedFactCoverage ?? null) ===
          (selection!.ratios.weightedRequiredFactCoverage.denominator === 0
            ? null
            : selection!.ratios.weightedRequiredFactCoverage.numerator /
              selection!.ratios.weightedRequiredFactCoverage.denominator) &&
        (evidence.preservation?.criticalFactCoverage ?? null) ===
          (selection!.ratios.criticalFactCoverage.denominator === 0
            ? null
            : selection!.ratios.criticalFactCoverage.numerator /
              selection!.ratios.criticalFactCoverage.denominator));
    observations.push({
      caseId: entry.id,
      profile: entry.profile,
      stratum: entry.stratum,
      replica: entry.replica,
      budgetRegime: entry.budgetRegime,
      evidenceCondition: entry.annotations.evidenceCondition,
      expectedFailure,
      status: succeeded
        ? expectedFailure
          ? 'unexpected-success'
          : 'success'
        : expectedFailure && evidence.expectedFailure?.passed
          ? 'expected-failure'
          : 'unexpected-failure',
      candidateWrappers: entry.input.candidates.length,
      candidateContentTokens: entry.input.candidates.reduce((n, c) => n + c.block.tokenCount, 0),
      harness: evidence,
      selection,
      correctness: result === null ? null : measureCorrectness(entry.input, result, tokenizer),
      scopeDetections: scopeDetections(entry.input, tokenizer),
      additionalCompilationAgrees: agrees,
      trace:
        result === null
          ? null
          : {
              schemaVersion: result.trace.schemaVersion,
              groups: result.trace.groups.map((g) => ({
                canonicalId: g.canonical.id,
                memberIds: g.members.map((m) => m.blockId),
                scoreTotal: g.score.total,
                filterReason: g.filtering.reason,
                finalReason: result.trace.settlement.decisions.find(
                  (d) => d.blockId === g.canonical.id,
                )!.reason,
              })),
            },
    });
  }
  return observations;
}

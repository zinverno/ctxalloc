import type { aggregateCases } from './aggregate.js';
import { ratioValue } from './metrics.js';
import type { CaseObservation } from './observe.js';
import type { RatioName } from './types.js';

export const GATE_DEFINITIONS = {
  id: 'ctxalloc-heldout-gates',
  version: '1',
  expectedFailures: 4,
  expectedSuccesses: 44,
  requiredPreservation: 1,
  criticalPreservation: 1,
  usefulProfileMinimum: 0.95,
  usefulCaseMinimum: 0.8,
  admissionPrecisionMinimum: 0.8,
  admissionRecallMinimum: 0.95,
  overallMedianReductionMinimum: 0.2,
  profileMedianReductionMinimum: 0.15,
  allowedBudgetViolations: 0,
  expectedScopeDetections: 4,
  allowedCrossScopeInclusions: 0,
  accountingRequired: 1,
  expectedRepeatComparisons: 96,
  allowedRepeatMismatches: 0,
  allowedAdditionalDisagreements: 0,
  allowedApplicabilityMismatches: 0,
  runtimeRequiredPreservation: 1,
} as const;
export interface GateObservation {
  readonly subject: string;
  readonly metric: string;
  readonly value: number | null;
  readonly operator: '=' | '>=';
  readonly target: number;
}
export interface HeldoutGate {
  readonly id: string;
  readonly required: true;
  readonly state: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  readonly observations: readonly GateObservation[];
  readonly failures: readonly GateObservation[];
}
function gate(id: string, observations: readonly GateObservation[]): HeldoutGate {
  const failures = observations.filter(
    (o) => o.value !== null && (o.operator === '=' ? o.value !== o.target : o.value < o.target),
  );
  return {
    id,
    required: true,
    state:
      failures.length > 0
        ? 'FAIL'
        : observations.length === 0 || observations.some((o) => o.value === null)
          ? 'NOT_EVALUATED'
          : 'PASS',
    observations,
    failures,
  };
}
const equal = (
  subject: string,
  metric: string,
  value: number | null,
  target: number,
): GateObservation => ({ subject, metric, value, operator: '=', target });
const minimum = (
  subject: string,
  metric: string,
  value: number | null,
  target: number,
): GateObservation => ({ subject, metric, value, operator: '>=', target });
export function evaluateGates(
  cases: readonly CaseObservation[],
  aggregates: ReturnType<typeof aggregateCases>,
): readonly HeldoutGate[] {
  const defs = GATE_DEFINITIONS;
  const success = cases.filter((c) => c.status === 'success');
  const ratioChecks = (name: RatioName, target: number, op: '=' | '>=') =>
    success.flatMap((c) => {
      const r = c.selection?.ratios[name];
      if (r === undefined || r.denominator === 0) return [];
      return [(op === '=' ? equal : minimum)(c.caseId, name, ratioValue(r), target)];
    });
  const profileChecks = (names: readonly RatioName[], target: number) =>
    aggregates.byProfile.flatMap((p) =>
      names.flatMap((name) =>
        (['micro', 'macro'] as const).map((aggregation) =>
          minimum(p.id, `${name}.${aggregation}`, p.ratios[name][aggregation], target),
        ),
      ),
    );
  const correctness = cases.filter((c) => c.correctness !== null);
  const accounting = correctness.flatMap((c) =>
    (
      [
        'provenanceCoverage',
        'wrapperAccountingCompleteness',
        'groupDecisionCompleteness',
        'decisionReasonCoverage',
        'traceReconciliationRate',
      ] as const
    ).flatMap((name) => {
      const r = c.correctness![name];
      return r.denominator === 0 ? [] : [equal(c.caseId, name, r.numerator / r.denominator, 1)];
    }),
  );
  const comparisons = cases.reduce(
    (n, c) => n + (c.harness.determinism === undefined ? 0 : c.harness.determinism.executions - 1),
    0,
  );
  return [
    gate('failures', [
      equal(
        'overall',
        'matchedExpectedFailures',
        cases.filter((c) => c.status === 'expected-failure').length,
        defs.expectedFailures,
      ),
      equal(
        'overall',
        'unexpectedFailures',
        cases.filter((c) => c.status === 'unexpected-failure' || c.status === 'unexpected-success')
          .length,
        0,
      ),
      equal('overall', 'successfulCompilations', success.length, defs.expectedSuccesses),
    ]),
    gate('required-blocks', ratioChecks('requiredBlockRecall', defs.requiredPreservation, '=')),
    gate(
      'required-facts',
      ratioChecks('weightedRequiredFactCoverage', defs.requiredPreservation, '='),
    ),
    gate('critical-facts', ratioChecks('criticalFactCoverage', defs.criticalPreservation, '=')),
    gate('useful-preservation', [
      ...profileChecks(['usefulBlockRecall', 'usefulFactCoverage'], defs.usefulProfileMinimum),
      ...ratioChecks('usefulBlockRecall', defs.usefulCaseMinimum, '>='),
      ...ratioChecks('usefulFactCoverage', defs.usefulCaseMinimum, '>='),
    ]),
    gate('admission-quality', [
      ...profileChecks(['optionalAdmissionPrecision'], defs.admissionPrecisionMinimum),
      ...profileChecks(['optionalAdmissionRecall'], defs.admissionRecallMinimum),
    ]),
    gate('reduction', [
      minimum(
        'overall',
        'medianReduction',
        aggregates.overall.reduction.distribution?.median ?? null,
        defs.overallMedianReductionMinimum,
      ),
      ...aggregates.byProfile.map((p) =>
        minimum(
          p.id,
          'medianReduction',
          p.reduction.distribution?.median ?? null,
          defs.profileMedianReductionMinimum,
        ),
      ),
    ]),
    gate('budget', [
      equal(
        'overall',
        'budgetViolations',
        cases.filter((c) => c.harness.usage?.budgetViolation === true).length,
        defs.allowedBudgetViolations,
      ),
    ]),
    gate('scope', [
      equal(
        'overall',
        'detectedForeignCandidates',
        cases.reduce((n, c) => n + c.scopeDetections.numerator, 0),
        defs.expectedScopeDetections,
      ),
      equal(
        'overall',
        'foreignCandidateDenominator',
        cases.reduce((n, c) => n + c.scopeDetections.denominator, 0),
        defs.expectedScopeDetections,
      ),
      equal(
        'overall',
        'crossScopeInclusions',
        correctness.reduce((n, c) => n + c.correctness!.crossScopeInclusionCount, 0),
        defs.allowedCrossScopeInclusions,
      ),
      equal(
        'overall',
        'successfulForeignScopeRequests',
        cases.filter(
          (c) => c.scopeDetections.denominator > 0 && c.harness.compilation === 'succeeded',
        ).length,
        0,
      ),
    ]),
    gate('accounting', accounting),
    gate('determinism', [
      equal('overall', 'comparisons', comparisons, defs.expectedRepeatComparisons),
      equal(
        'overall',
        'mismatchedRepeats',
        cases.filter((c) => c.harness.determinism?.matched !== true).length,
        defs.allowedRepeatMismatches,
      ),
      equal(
        'overall',
        'additionalDisagreements',
        cases.filter((c) => !c.additionalCompilationAgrees).length,
        defs.allowedAdditionalDisagreements,
      ),
    ]),
    gate('applicability', [
      equal(
        'overall',
        'contradictoryDispositions',
        success.reduce((n, c) => n + (c.selection?.incorrectApplicabilityUnitIds.length ?? 0), 0),
        defs.allowedApplicabilityMismatches,
      ),
    ]),
    gate(
      'runtime-required',
      ratioChecks('runtimeRequiredGroupRecall', defs.runtimeRequiredPreservation, '='),
    ),
  ];
}

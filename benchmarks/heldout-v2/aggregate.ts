import { aggregateRatio, aggregateRatios, aggregateReduction } from './metrics.js';
import { CONDITIONS, PROFILES, STRATA } from './protocol.js';
import type { CaseObservation } from './observe.js';
export const CORRECTNESS_NAMES = [
  'provenanceCoverage',
  'wrapperAccountingCompleteness',
  'groupDecisionCompleteness',
  'decisionReasonCoverage',
  'traceReconciliationRate',
] as const;
export function summarizeCases(cases: readonly CaseObservation[]) {
  const success = cases.filter((c) => c.status === 'success');
  return {
    counts: {
      cases: cases.length,
      successes: success.length,
      expectedFailures: cases.filter((c) => c.expectedFailure !== null).length,
      matchedExpectedFailures: cases.filter((c) => c.status === 'expected-failure').length,
      unexpectedFailures: cases.filter((c) => c.status === 'unexpected-failure').length,
      unexpectedSuccesses: cases.filter((c) => c.status === 'unexpected-success').length,
      wrappers: cases.reduce((n, c) => n + c.candidateWrappers, 0),
      successfulWrappers: success.reduce((n, c) => n + c.candidateWrappers, 0),
      groups: success.reduce((n, c) => n + (c.trace?.groups.length ?? 0), 0),
      admitted: success.reduce(
        (n, c) =>
          n + (c.trace?.groups.filter((g) => g.filtering.decision === 'eligible').length ?? 0),
        0,
      ),
      admittedUnderUncertainty: success.reduce(
        (n, c) =>
          n +
          (c.trace?.groups.filter((g) => g.filtering.reason === 'ELIGIBLE_INCOMPLETE_EVIDENCE')
            .length ?? 0),
        0,
      ),
      included: success.reduce(
        (n, c) =>
          n +
          (c.trace?.settlement.decisions.filter((d) => d.disposition === 'included').length ?? 0),
        0,
      ),
      filtered: success.reduce(
        (n, c) =>
          n +
          (c.trace?.settlement.decisions.filter((d) => d.disposition === 'filtered').length ?? 0),
        0,
      ),
      budgetExcluded: success.reduce(
        (n, c) =>
          n +
          (c.trace?.settlement.decisions.filter((d) => d.disposition === 'excluded').length ?? 0),
        0,
      ),
    },
    ratios: aggregateRatios(
      success.flatMap((c) => (c.selection === null ? [] : [c.selection.ratios])),
    ),
    reduction: aggregateReduction(success.flatMap((c) => (c.tokens === null ? [] : [c.tokens]))),
    correctness: {
      ratios: Object.fromEntries(
        CORRECTNESS_NAMES.map((name) => [
          name,
          aggregateRatio(
            success.flatMap((c) => (c.correctness === null ? [] : [c.correctness[name]])),
          ),
        ]),
      ),
      budgetViolations: cases.filter(
        (c) => c.usage !== null && c.usage.compiledTokens > c.usage.availableTokens,
      ).length,
      crossScopeInclusions: cases.reduce(
        (n, c) => n + (c.correctness?.crossScopeInclusionCount ?? 0),
        0,
      ),
      contractMismatches: success.filter((c) => c.contracts?.passed !== true).length,
      repeatComparisons: cases.reduce((n, c) => n + c.repeatComparisons, 0),
      repeatMismatches: cases.filter((c) => !c.repeatAgreement).length,
      additionalCompilationDisagreements: cases.filter((c) => !c.additionalCompilationAgrees)
        .length,
    },
  };
}
export function segments(cases: readonly CaseObservation[]) {
  return {
    overall: summarizeCases(cases),
    byProfile: PROFILES.map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.profile === id)),
    })),
    byCondition: CONDITIONS.map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.evidenceCondition === id)),
    })),
    byStratum: STRATA.map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.stratum === id)),
    })),
    byBudget: (['tight', 'generous'] as const).map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.budgetRegime === id)),
    })),
    byProfileAndCondition: PROFILES.flatMap((profile) =>
      CONDITIONS.map((condition) => ({
        profile,
        condition,
        ...summarizeCases(
          cases.filter((c) => c.profile === profile && c.evidenceCondition === condition),
        ),
      })),
    ),
  };
}
export function aggregateCases(cases: readonly CaseObservation[]) {
  return {
    ...segments(cases),
    primary: segments(
      cases.filter(
        (c) =>
          c.evidenceCondition !== 'misleading-complete' &&
          c.evidenceCondition !== 'negative-contract',
      ),
    ),
    reductionEligible: segments(cases.filter((c) => c.reductionExpected)),
    misleadingRisk: summarizeCases(
      cases.filter((c) => c.evidenceCondition === 'misleading-complete'),
    ),
  };
}

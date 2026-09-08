import { aggregateRatio, aggregateRatios, distribution } from './metrics.js';
import { PROFILES, STRATA } from './types.js';
import type { CaseObservation } from './observe.js';

export function summarizeCases(cases: readonly CaseObservation[]) {
  const successful = cases.filter((c) => c.status === 'success');
  const ratios = aggregateRatios(
    successful.flatMap((c) => (c.selection === null ? [] : [c.selection.ratios])),
  );
  const tokens = successful.flatMap((c) =>
    c.harness.tokens === undefined ? [] : [c.harness.tokens],
  );
  const reductions = tokens.flatMap((t) =>
    t.tokenReductionRatio === undefined ? [] : [t.tokenReductionRatio],
  );
  const baselineTokens = tokens.reduce((n, t) => n + t.baselineInputTokens, 0);
  const compiledTokens = tokens.reduce((n, t) => n + t.compiledTokens, 0);
  const loo =
    reductions.length < 2
      ? []
      : reductions.flatMap((_, i) => {
          const v = distribution(reductions.filter((_, j) => i !== j))?.median;
          return v === undefined ? [] : [v];
        });
  return {
    counts: {
      cases: cases.length,
      successes: successful.length,
      expectedFailures: cases.filter((c) => c.expectedFailure).length,
      matchedExpectedFailures: cases.filter((c) => c.status === 'expected-failure').length,
      unexpectedFailures: cases.filter(
        (c) => c.status === 'unexpected-failure' || c.status === 'unexpected-success',
      ).length,
      wrappers: cases.reduce((n, c) => n + c.candidateWrappers, 0),
    },
    ratios,
    correctness: {
      ratios: Object.fromEntries(
        (
          [
            'provenanceCoverage',
            'wrapperAccountingCompleteness',
            'groupDecisionCompleteness',
            'decisionReasonCoverage',
            'traceReconciliationRate',
          ] as const
        ).map((name) => [
          name,
          aggregateRatio(
            successful.flatMap((c) => (c.correctness === null ? [] : [c.correctness[name]])),
          ),
        ]),
      ),
      budgetViolations: cases.filter((c) => c.harness.usage?.budgetViolation === true).length,
      crossScopeInclusions: cases.reduce(
        (n, c) => n + (c.correctness?.crossScopeInclusionCount ?? 0),
        0,
      ),
      scopeDetections: aggregateRatio(cases.map((c) => c.scopeDetections)),
      repeatComparisons: cases.reduce(
        (n, c) =>
          n + (c.harness.determinism === undefined ? 0 : c.harness.determinism.executions - 1),
        0,
      ),
      casesWithRepeatMismatch: cases.filter((c) => c.harness.determinism?.matched !== true).length,
      additionalCompilationDisagreements: cases.filter((c) => !c.additionalCompilationAgrees)
        .length,
    },
    falseAdmissionCount: successful.reduce(
      (n, c) => n + (c.selection?.falseAdmissionCount ?? 0),
      0,
    ),
    falseExclusionCount: successful.reduce(
      (n, c) => n + (c.selection?.falseExclusionCount ?? 0),
      0,
    ),
    reduction: {
      candidateContentTokens: successful.reduce((n, c) => n + c.candidateContentTokens, 0),
      baselineTokens,
      compiledTokens,
      tokensSaved: baselineTokens - compiledTokens,
      micro: baselineTokens === 0 ? null : (baselineTokens - compiledTokens) / baselineTokens,
      macro: distribution(reductions)?.mean ?? null,
      distribution: distribution(reductions),
      leaveOneRequestOutMedianRange:
        loo.length === 0 ? null : { minimum: Math.min(...loo), maximum: Math.max(...loo) },
    },
  };
}
export function aggregateCases(cases: readonly CaseObservation[]) {
  return {
    overall: summarizeCases(cases),
    byProfile: PROFILES.map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.profile === id)),
    })),
    byStratum: STRATA.map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.stratum === id)),
    })),
    byBudget: (['tight', 'generous'] as const).map((id) => ({
      id,
      ...summarizeCases(cases.filter((c) => c.budgetRegime === id)),
    })),
    byProfileAndStratum: PROFILES.flatMap((profile) =>
      STRATA.map((stratum) => ({
        profile,
        stratum,
        ...summarizeCases(cases.filter((c) => c.profile === profile && c.stratum === stratum)),
      })),
    ),
  };
}

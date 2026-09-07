import type { Tokenizer } from '@ctxalloc/ports';
import { diagnoseCompilation } from '../diagnostics/compilation-decisions.js';
import { ADMISSION_COMPILER, ADMISSION_DATASET, buildAdmissionDevelopment } from './cases.js';
import { ADMISSION_PROFILE_IDS, admissionProfile } from './profiles.js';

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** Development contract checks, not a held-out product gate or an answer-quality metric. */
export function evaluateAdmissionDevelopment(tokenizer: Tokenizer) {
  const cases = buildAdmissionDevelopment(tokenizer).map((entry) => {
    const diagnostic = diagnoseCompilation(entry.compilationRequest, ADMISSION_COMPILER, tokenizer);
    const admittedIds = diagnostic.groups
      .filter((g) => g.filtering.decision === 'eligible')
      .map((g) => g.canonical.id);
    const includedIds = diagnostic.settlement.ordering.orderedBlockIds;
    const required = diagnostic.groups.filter((g) => g.canonical.required);
    const checks = {
      admissionMatches: sameIds(admittedIds, entry.expectedAdmittedIds),
      finalSelectionMatches: sameIds(includedIds, entry.expectedIncludedIds),
      wrappersAccounted:
        diagnostic.groups.flatMap((g) => g.members).length ===
        entry.compilationRequest.candidates.length,
      requiredGroupsPreserved: required.every((g) => g.finalDecision.disposition === 'included'),
      withinBudget: diagnostic.usage.compiledTokens <= diagnostic.usage.availableTokens,
    };
    return {
      caseId: entry.id,
      profileId: entry.profile,
      coverage: entry.coverage,
      limitation: entry.limitation,
      expectedAdmittedIds: entry.expectedAdmittedIds,
      expectedIncludedIds: entry.expectedIncludedIds,
      admittedIds,
      includedIds,
      checks,
      status: Object.values(checks).every(Boolean) ? ('PASS' as const) : ('FAIL' as const),
      diagnostic,
    };
  });
  const groups = cases.flatMap((c) => c.diagnostic.groups);
  return {
    schemaVersion: 1 as const,
    dataset: ADMISSION_DATASET,
    purpose: 'development-only admission and applicability contract checks',
    productValidation: 'NOT_EVALUATED' as const,
    modelExecution: 'disabled' as const,
    timing: 'NOT_MEASURED' as const,
    profiles: ADMISSION_PROFILE_IDS.map(admissionProfile),
    counts: {
      cases: cases.length,
      passed: cases.filter((c) => c.status === 'PASS').length,
      failed: cases.filter((c) => c.status === 'FAIL').length,
      candidateWrappers: groups.flatMap((g) => g.members).length,
      groups: groups.length,
      admittedGroups: groups.filter((g) => g.filtering.decision === 'eligible').length,
      scoreFilteredGroups: groups.filter(
        (g) => g.filtering.reason === 'FILTERED_SCORE_BELOW_MINIMUM',
      ).length,
      inapplicableGroups: groups.filter((g) => g.filtering.reason === 'FILTERED_INAPPLICABLE')
        .length,
      supersededGroups: groups.filter((g) => g.filtering.reason === 'FILTERED_SUPERSEDED').length,
      finalIncludedGroups: groups.filter((g) => g.finalDecision.disposition === 'included').length,
      finalBudgetExcludedGroups: groups.filter((g) => g.finalDecision.disposition === 'excluded')
        .length,
      requiredGroups: groups.filter((g) => g.canonical.required).length,
      requiredGroupsIncluded: groups.filter(
        (g) => g.canonical.required && g.finalDecision.disposition === 'included',
      ).length,
      budgetViolations: cases.filter((c) => !c.checks.withinBudget).length,
    },
    developmentStatus: cases.every((c) => c.status === 'PASS')
      ? ('PASS' as const)
      : ('FAIL' as const),
    cases,
  };
}

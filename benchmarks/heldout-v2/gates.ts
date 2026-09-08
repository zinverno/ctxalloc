import { CORRECTNESS_NAMES, type aggregateCases } from './aggregate.js';
import { GATE_LIMITS as L, MATRIX, PROFILES } from './protocol.js';
import type { CaseObservation } from './observe.js';
import type { Ratios } from './metrics.js';
export interface Check {
  subject: string;
  metric: string;
  value: number | null;
  operator: '=' | '>=';
  target: number;
}
export interface Gate {
  id: string;
  category: 'contract' | 'effectiveness' | 'risk-disclosure';
  required: true;
  state: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  observations: readonly Check[];
  failures: readonly Check[];
}
const check = (
  subject: string,
  metric: string,
  value: number | null,
  target: number,
  operator: '=' | '>=' = '=',
): Check => ({ subject, metric, value, target, operator });
function gate(id: string, category: Gate['category'], observations: readonly Check[]): Gate {
  const failures = observations.filter(
    (c) => c.value !== null && (c.operator === '=' ? c.value !== c.target : c.value < c.target),
  );
  return {
    id,
    category,
    required: true,
    state:
      failures.length > 0
        ? 'FAIL'
        : observations.length === 0 || observations.some((c) => c.value === null)
          ? 'NOT_EVALUATED'
          : 'PASS',
    observations,
    failures,
  };
}
export function evaluateGates(
  cases: readonly CaseObservation[],
  a: ReturnType<typeof aggregateCases>,
): readonly Gate[] {
  const success = cases.filter((c) => c.status === 'success');
  const primary = success.filter((c) => c.evidenceCondition !== 'misleading-complete');
  const perCase = (
    rows: typeof success,
    name: keyof Ratios,
    target: number,
    operator: '=' | '>=' = '=',
  ) =>
    rows.flatMap((c) => {
      const r = c.selection?.ratios[name];
      return r === undefined || r.denominator === 0
        ? []
        : [check(c.caseId, name, r.numerator / r.denominator, target, operator)];
    });
  // Every planned primary profile/condition is checked independently. Null required denominators never pass.
  const primarySegments = [
    ...a.primary.byProfile,
    ...a.primary.byCondition.filter(
      (c) => c.id !== 'negative-contract' && c.id !== 'misleading-complete',
    ),
  ];
  const quality = (name: keyof Ratios, threshold: number) =>
    primarySegments.flatMap((s) =>
      (['micro', 'macro'] as const).map((k) =>
        check(s.id, `${name}.${k}`, s.ratios[name][k], threshold, '>='),
      ),
    );
  const accounting = success.flatMap((c) =>
    CORRECTNESS_NAMES.flatMap((name) => {
      const r = c.correctness?.[name];
      return r?.denominator === 0
        ? []
        : [check(c.caseId, name, r === undefined ? null : r.numerator / r.denominator, 1)];
    }),
  );
  const risk = cases.filter((c) => c.evidenceCondition === 'misleading-complete');
  const coverage = MATRIX.map((p) =>
    check(
      p.id,
      'exactPreregisteredOutcome',
      cases.filter(
        (c) =>
          c.caseId === p.id &&
          c.status === (p.expectedFailure === null ? 'success' : 'expected-failure'),
      ).length,
      1,
    ),
  );
  return [
    gate('outcomes', 'contract', [
      check('overall', 'cases', cases.length, L.cases),
      check('overall', 'successes', success.length, L.expectedSuccesses),
      check(
        'overall',
        'matchedFailures',
        cases.filter((c) => c.status === 'expected-failure').length,
        L.expectedFailures,
      ),
      ...coverage,
    ]),
    gate(
      'runtime-required',
      'contract',
      perCase(success, 'runtimeRequiredGroupRecall', L.runtimeRequired),
    ),
    gate('budget', 'contract', [
      check('overall', 'violations', a.overall.correctness.budgetViolations, 0),
    ]),
    gate('scope', 'contract', [
      check('overall', 'crossScopeInclusions', a.overall.correctness.crossScopeInclusions, 0),
      check(
        'overall',
        'candidateScopeFailures',
        cases.filter(
          (c) =>
            c.status === 'expected-failure' && c.failure?.issueCodes.includes('scope_mismatch'),
        ).length,
        2,
      ),
      check(
        'overall',
        'evidenceScopeFailures',
        cases.filter(
          (c) =>
            c.status === 'expected-failure' &&
            c.failure?.issueCodes.includes('evidence_scope_mismatch'),
        ).length,
        1,
      ),
    ]),
    gate('accounting', 'contract', accounting),
    gate('determinism', 'contract', [
      check('overall', 'comparisons', a.overall.correctness.repeatComparisons, L.comparisons),
      check('overall', 'mismatches', a.overall.correctness.repeatMismatches, 0),
      check(
        'overall',
        'additionalDisagreements',
        a.overall.correctness.additionalCompilationDisagreements,
        0,
      ),
    ]),
    ...(
      ['admission', 'applicability', 'compatibility', 'completeness', 'traceVersion'] as const
    ).map((name) =>
      gate(
        name,
        'contract',
        success.map((c) =>
          check(
            c.caseId,
            name,
            c.contracts === null ? null : Number(c.contracts.groups.every((g) => g[name])),
            1,
          ),
        ),
      ),
    ),
    gate('useful-blocks', 'effectiveness', [
      ...quality('usefulBlockRecall', L.usefulBlockRecall),
      ...perCase(primary, 'usefulBlockRecall', L.caseUsefulMinimum, '>='),
    ]),
    gate('useful-facts', 'effectiveness', [
      ...quality('usefulFactCoverage', L.usefulFactCoverage),
      ...perCase(primary, 'usefulFactCoverage', L.caseUsefulMinimum, '>='),
    ]),
    gate('critical-facts', 'effectiveness', [
      ...quality('criticalFactCoverage', L.criticalFactCoverage),
      ...perCase(primary, 'criticalFactCoverage', 1),
    ]),
    gate('required-facts', 'effectiveness', [
      ...quality('weightedRequiredFactCoverage', L.weightedRequiredFactCoverage),
      ...perCase(primary, 'weightedRequiredFactCoverage', 1),
    ]),
    gate(
      'admission-recall',
      'effectiveness',
      quality('optionalAdmissionRecall', L.optionalAdmissionRecall),
    ),
    gate(
      'admission-precision',
      'effectiveness',
      a.primary.byProfile.flatMap((p) =>
        (['micro', 'macro'] as const).map((k) =>
          check(
            p.id,
            `precision.${k}`,
            p.ratios.optionalAdmissionPrecision[k],
            L.precisionByProfile[p.id],
            '>=',
          ),
        ),
      ),
    ),
    gate('reduction', 'effectiveness', [
      check(
        'eligible',
        'median',
        a.reductionEligible.overall.reduction.distribution?.median ?? null,
        L.reductionOverallMedian,
        '>=',
      ),
      ...PROFILES.map((id) =>
        check(
          id,
          'eligibleMedian',
          a.reductionEligible.byProfile.find((p) => p.id === id)?.reduction.distribution?.median ??
            null,
          L.reductionProfileMedian,
          '>=',
        ),
      ),
      ...a.reductionEligible.byCondition
        .filter((c) => MATRIX.some((p) => p.reductionExpected && p.evidenceCondition === c.id))
        .map((c) =>
          check(
            c.id,
            'eligibleMedian',
            c.reduction.distribution?.median ?? null,
            L.reductionConditionMedian,
            '>=',
          ),
        ),
    ]),
    gate('misleading-risk-disclosure', 'risk-disclosure', [
      check('misleading-complete', 'cases', risk.length, L.misleadingCases),
      ...risk.map((c) =>
        check(
          c.caseId,
          'allRiskMeasurementsPresent',
          Number(
            c.status === 'success' &&
              c.contracts !== null &&
              c.tokens?.ratio !== null &&
              c.tokens !== null &&
              c.selection !== null &&
              [
                'usefulBlockRecall',
                'usefulFactCoverage',
                'irrelevantRejection',
                'optionalAdmissionPrecision',
                'optionalAdmissionRecall',
              ].every((name) => c.selection!.ratios[name as keyof Ratios].denominator > 0),
          ),
          1,
        ),
      ),
    ]),
  ];
}
export const verdict = (gates: readonly Gate[]) =>
  gates.length > 0 && gates.every((g) => g.state === 'PASS') ? 'PASS' : 'FAIL';

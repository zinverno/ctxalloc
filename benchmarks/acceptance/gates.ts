import type { EvaluationReport } from '@ctxalloc/evaluation';

export type GateState = 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'NOT_APPLICABLE';
export type AcceptanceState = 'PASS' | 'FAIL' | 'INCOMPLETE';
export interface Gate {
  readonly id: string;
  readonly state: GateState;
  readonly value: number | null;
  readonly target: string;
  readonly evidence: string;
  readonly category: 'engineering' | 'product';
  readonly required: boolean;
}
export function overall(gates: readonly Gate[]): AcceptanceState {
  const required = gates.filter((gate) => gate.required);
  if (required.some((gate) => gate.state === 'FAIL')) return 'FAIL';
  if (required.length === 0 || required.some((gate) => gate.state === 'NOT_EVALUATED'))
    return 'INCOMPLETE';
  return 'PASS';
}
export function metric(
  id: string,
  value: number | undefined,
  target: string,
  passes: (value: number) => boolean,
  category: Gate['category'],
  evidence: string,
  required = true,
): Gate {
  return {
    id,
    state: value === undefined ? 'NOT_EVALUATED' : passes(value) ? 'PASS' : 'FAIL',
    value: value ?? null,
    target,
    category,
    evidence,
    required,
  };
}

/** Threshold existing harness measurements; never recalculate preservation or reduction. */
export function contextGates(validation: EvaluationReport, longContext: EvaluationReport): Gate[] {
  if (
    validation.cases.some((entry) => entry.datasetSplit !== 'validation') ||
    longContext.cases.some(
      (entry) => entry.datasetSplit !== 'validation' || !entry.tags.includes('long-context'),
    )
  )
    throw new Error('Release metrics require the validation split.');
  const a = validation.aggregates;
  return [
    metric(
      'medianContextReduction',
      a.tokenReductionRatio?.median,
      '>= 0.35',
      (v) => v >= 0.35,
      'product',
      'EvaluationHarness validation aggregates',
    ),
    metric(
      'longContextReduction',
      longContext.aggregates.tokenReductionRatio?.median,
      '>= 0.50',
      (v) => v >= 0.5,
      'product',
      'EvaluationHarness long-context validation aggregates',
    ),
    metric(
      'requiredBlockRecall',
      a.requiredBlockRecall?.minimum,
      '>= 0.95 in every measured case',
      (v) => v >= 0.95,
      'product',
      'EvaluationHarness validation preservation',
    ),
    metric(
      'requiredBlockRecallValidBudget',
      a.requiredBlockRecall?.minimum,
      '= 1.00 in valid measured cases (METRICS 9.1 / 22.2)',
      (v) => v === 1,
      'product',
      'EvaluationHarness validation preservation; stronger final checklist',
    ),
    metric(
      'weightedFactCoverage',
      a.weightedFactCoverage?.minimum,
      '>= 0.95 in every measured case',
      (v) => v >= 0.95,
      'product',
      'EvaluationHarness validation preservation',
    ),
    metric(
      'criticalFactCoverage',
      a.criticalFactCoverage?.minimum,
      '= 1.00 when annotated',
      (v) => v === 1,
      'product',
      'EvaluationHarness validation preservation',
    ),
  ];
}

/** A fake/disabled report cannot become live answer-quality evidence. */
export function qualityGate(report: EvaluationReport, liveProvider: boolean): Gate {
  const comparable =
    liveProvider &&
    report.modelExecution === 'full-baseline-and-compiled' &&
    report.composition.modelProviderId === 'ctxalloc-anthropic-messages' &&
    report.counts.providerFailures === 0 &&
    report.counts.modelIdentityMismatches === 0 &&
    report.cases.every(
      (entry) =>
        entry.datasetSplit === 'validation' &&
        (entry.expectedFailure !== undefined ||
          (entry.model.state === 'executed' && entry.model.qualityLoss !== undefined)),
    );
  return metric(
    'medianAnswerQualityLoss',
    comparable ? report.aggregates.qualityLoss?.median : undefined,
    '<= 0.05',
    (v) => v <= 0.05,
    'product',
    comparable
      ? 'Explicit manual same-model live validation'
      : 'No complete live answer-quality evidence; disabled and fake runs do not qualify',
  );
}

/** The harness stops at the first differing repeat; executions includes the original. */
export function repeatedComparisons(
  report: EvaluationReport,
): { identical: number; total: number } | undefined {
  let identical = 0;
  let total = 0;
  for (const entry of report.cases) {
    const evidence = entry.determinism;
    if (evidence === undefined || evidence.executions < 2) return undefined;
    const comparisons = evidence.executions - 1;
    total += comparisons;
    identical += comparisons - (evidence.matched ? 0 : 1);
  }
  return total === 0 ? undefined : { identical, total };
}

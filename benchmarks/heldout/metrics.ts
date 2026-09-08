import { EVALUATION_FACT_WEIGHTS } from '@ctxalloc/evaluation';
import type { CompilationResult } from '@ctxalloc/compiler';
import { RATIO_NAMES, type Fact, type HeldoutCase, type Ratio, type Ratios } from './types.js';

export const METRIC_DEFINITIONS = {
  id: 'ctxalloc-heldout-metrics',
  version: '1',
  blockUnit:
    'useful-block recall and admission use annotated exact-content units; required-block recall uses exact ids',
  facts: 'OR across evidence groups, AND within each group; weights critical=3 major=2 minor=1',
  micro: 'sum numerators / sum denominators; null if denominator zero',
  macro: 'mean of case ratios with positive denominator; null if none',
  median: 'nearest-rank p50: sorted[ceil(0.5*n)-1]',
  uncertainty:
    'leave-one-request-out micro and median ranges; descriptive, not confidence intervals',
  reduction:
    'existing EvaluationHarness full-wrapper rendered baseline minus compiled rendered tokens; ratio unclamped',
  successDenominators: 'expected failures excluded; unexpected failures fail the failure gate',
  correctness: 'reuse benchmarks/acceptance/correctness.ts without changes',
  repeatComparisons: 2,
} as const;
export const ratioValue = (r: Ratio): number | null =>
  r.denominator === 0 ? null : r.numerator / r.denominator;
const count = (matched: number, total: number): Ratio => ({
  numerator: matched,
  denominator: total,
});
export function factPreserved(fact: Fact, included: ReadonlySet<string>): boolean {
  return fact.evidenceBlockGroups.some((g) => g.every((id) => included.has(id)));
}
export function measureSelection(entry: HeldoutCase, result: CompilationResult) {
  const included = new Set<string>(result.includedBlocks.map((b) => b.id));
  const admitted = new Set<string>(
    result.trace.groups
      .filter((g) => g.filtering.decision === 'eligible')
      .flatMap((g) => g.members.map((m) => m.blockId)),
  );
  const runtimeIds = new Set<string>(
    entry.input.candidates
      .filter((c) => c.block.attributes.required === true)
      .map((c) => c.block.id),
  );
  const units = entry.annotations.units;
  const retained = (u: (typeof units)[number]) => u.blockIds.some((id) => included.has(id));
  const eligible = (u: (typeof units)[number]) => u.blockIds.some((id) => admitted.has(id));
  const useful = units.filter((u) => u.useful);
  const runtime = units.filter((u) => u.blockIds.some((id) => runtimeIds.has(id)));
  const optional = units.filter((u) => !runtime.includes(u));
  const usefulOptional = optional.filter((u) => u.useful && u.applicability === 'applicable');
  const admittedOptional = optional.filter(eligible);
  const usefulAdmitted = usefulOptional.filter(eligible);
  const facts = entry.annotations.facts;
  const usefulFacts = facts.filter((f) => f.useful);
  const requiredFacts = facts.filter((f) => f.required);
  const critical = facts.filter((f) => f.importance === 'critical');
  const preserved = (f: Fact) => factPreserved(f, included);
  const weight = (fs: readonly Fact[]) =>
    fs.reduce((n, f) => n + EVALUATION_FACT_WEIGHTS[f.importance], 0);
  const requiredIds = entry.annotations.requiredBlockIds;
  const ratios: Ratios = {
    requiredBlockRecall: count(
      requiredIds.filter((id) => included.has(id)).length,
      requiredIds.length,
    ),
    usefulBlockRecall: count(useful.filter(retained).length, useful.length),
    usefulFactCoverage: count(usefulFacts.filter(preserved).length, usefulFacts.length),
    weightedRequiredFactCoverage: count(
      weight(requiredFacts.filter(preserved)),
      weight(requiredFacts),
    ),
    criticalFactCoverage: count(critical.filter(preserved).length, critical.length),
    optionalAdmissionPrecision: count(usefulAdmitted.length, admittedOptional.length),
    optionalAdmissionRecall: count(usefulAdmitted.length, usefulOptional.length),
    runtimeRequiredGroupRecall: count(runtime.filter(retained).length, runtime.length),
  };
  const incorrectApplicabilityUnits = units.filter((u) => {
    const g = result.trace.groups.find((g) =>
      g.members.some((m) => u.blockIds.includes(m.blockId)),
    );
    if (g === undefined) return true;
    if (u.applicability === 'applicable')
      return (
        g.filtering.reason === 'FILTERED_INAPPLICABLE' ||
        g.filtering.reason === 'FILTERED_SUPERSEDED'
      );
    const expected =
      u.applicability === 'inapplicable' ? 'FILTERED_INAPPLICABLE' : 'FILTERED_SUPERSEDED';
    return (
      g.filtering.reason !== expected ||
      result.trace.settlement.decisions.find((d) => d.blockId === g.canonical.id)?.reason !==
        expected
    );
  });
  return {
    ratios,
    falseAdmissionCount: admittedOptional.length - usefulAdmitted.length,
    falseExclusionCount: usefulOptional.length - usefulAdmitted.length,
    falseAdmissionUnitIds: admittedOptional
      .filter((u) => !usefulAdmitted.includes(u))
      .map((u) => u.id),
    falseExclusionUnitIds: usefulOptional.filter((u) => !eligible(u)).map((u) => u.id),
    missingUsefulUnitIds: useful.filter((u) => !retained(u)).map((u) => u.id),
    missingUsefulFactIds: usefulFacts.filter((f) => !preserved(f)).map((f) => f.id),
    missingRequiredFactIds: requiredFacts.filter((f) => !preserved(f)).map((f) => f.id),
    missingCriticalFactIds: critical.filter((f) => !preserved(f)).map((f) => f.id),
    incorrectApplicabilityUnitIds: incorrectApplicabilityUnits.map((u) => u.id),
  };
}
export function distribution(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    minimum: sorted[0]!,
    maximum: sorted[sorted.length - 1]!,
  };
}
export function aggregateRatio(ratios: readonly Ratio[]) {
  const numerator = ratios.reduce((a, r) => a + r.numerator, 0);
  const denominator = ratios.reduce((a, r) => a + r.denominator, 0);
  const values = ratios.flatMap((r) => {
    const v = ratioValue(r);
    return v === null ? [] : [v];
  });
  const summary = distribution(values);
  const loo =
    ratios.length < 2
      ? []
      : ratios.flatMap((r) => {
          const d = denominator - r.denominator;
          return d === 0 ? [] : [(numerator - r.numerator) / d];
        });
  return {
    numerator,
    denominator,
    micro: ratioValue({ numerator, denominator }),
    macro: summary?.mean ?? null,
    measuredCases: values.length,
    distribution: summary,
    leaveOneRequestOutMicroRange:
      loo.length === 0 ? null : { minimum: Math.min(...loo), maximum: Math.max(...loo) },
  };
}
export function aggregateRatios(rows: readonly Ratios[]) {
  return Object.fromEntries(
    RATIO_NAMES.map((name) => [name, aggregateRatio(rows.map((r) => r[name]))]),
  ) as Record<(typeof RATIO_NAMES)[number], ReturnType<typeof aggregateRatio>>;
}

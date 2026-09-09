import type { CompilationRequest, CompilationResult } from '@ctxalloc/compiler';
import { EVALUATION_FACT_WEIGHTS } from '@ctxalloc/evaluation';
import { aggregateRatio, distribution, factPreserved } from '../heldout/metrics.js';
import type { Ratio } from '../heldout/types.js';
import type { Annotations } from './types.js';
export { aggregateRatio, distribution } from '../heldout/metrics.js';
export const RATIO_NAMES = [
  'usefulBlockRecall',
  'usefulFactCoverage',
  'criticalFactCoverage',
  'weightedRequiredFactCoverage',
  'optionalAdmissionPrecision',
  'optionalAdmissionRecall',
  'runtimeRequiredGroupRecall',
  'irrelevantRejection',
] as const;
export type Ratios = Readonly<Record<(typeof RATIO_NAMES)[number], Ratio>>;
const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator });
export function selectionMetrics(
  annotations: Annotations,
  input: CompilationRequest,
  result: CompilationResult,
) {
  const included = new Set<string>(result.includedBlocks.map((b) => b.id));
  const admitted = new Set<string>(
    result.trace.groups
      .filter((g) => g.filtering.decision === 'eligible')
      .flatMap((g) => g.members.map((m) => m.blockId)),
  );
  const runtime = new Set(
    input.candidates
      .filter((c) => c.block.attributes.required === true)
      .map((c) => String(c.block.id)),
  );
  const retained = (u: Annotations['units'][number]) => u.blockIds.some((id) => included.has(id));
  const eligible = (u: Annotations['units'][number]) => u.blockIds.some((id) => admitted.has(id));
  const useful = annotations.units.filter((u) => u.useful);
  const irrelevant = annotations.units.filter((u) => !u.useful);
  const required = annotations.units.filter((u) => u.blockIds.some((id) => runtime.has(id)));
  const optional = annotations.units.filter((u) => !required.includes(u));
  const usefulOptional = optional.filter((u) => u.useful && u.applicability === 'applicable');
  const admittedOptional = optional.filter(eligible);
  const facts = annotations.facts;
  const usefulFacts = facts.filter((f) => f.useful);
  const critical = facts.filter((f) => f.importance === 'critical');
  const requiredFacts = facts.filter((f) => f.required);
  const preserved = (f: (typeof facts)[number]) => factPreserved(f, included);
  const weight = (fs: typeof facts) =>
    fs.reduce((n, f) => n + EVALUATION_FACT_WEIGHTS[f.importance], 0);
  const ratios: Ratios = {
    usefulBlockRecall: ratio(useful.filter(retained).length, useful.length),
    usefulFactCoverage: ratio(usefulFacts.filter(preserved).length, usefulFacts.length),
    criticalFactCoverage: ratio(critical.filter(preserved).length, critical.length),
    weightedRequiredFactCoverage: ratio(
      weight(requiredFacts.filter(preserved)),
      weight(requiredFacts),
    ),
    optionalAdmissionPrecision: ratio(
      usefulOptional.filter(eligible).length,
      admittedOptional.length,
    ),
    optionalAdmissionRecall: ratio(usefulOptional.filter(eligible).length, usefulOptional.length),
    runtimeRequiredGroupRecall: ratio(required.filter(retained).length, required.length),
    irrelevantRejection: ratio(irrelevant.filter((u) => !retained(u)).length, irrelevant.length),
  };
  return {
    ratios,
    missingUsefulUnitIds: useful.filter((u) => !retained(u)).map((u) => u.id),
    missingUsefulFactIds: usefulFacts.filter((f) => !preserved(f)).map((f) => f.id),
    missingCriticalFactIds: critical.filter((f) => !preserved(f)).map((f) => f.id),
    missingRequiredFactIds: requiredFacts.filter((f) => !preserved(f)).map((f) => f.id),
    falseAdmissionUnitIds: admittedOptional
      .filter((u) => !usefulOptional.includes(u))
      .map((u) => u.id),
    falseExclusionUnitIds: usefulOptional.filter((u) => !eligible(u)).map((u) => u.id),
  };
}
export function aggregateRatios(rows: readonly Ratios[]) {
  return Object.fromEntries(
    RATIO_NAMES.map((name) => [name, aggregateRatio(rows.map((r) => r[name]))]),
  ) as Record<(typeof RATIO_NAMES)[number], ReturnType<typeof aggregateRatio>>;
}
export function reduction(full: number, compiled: number) {
  return {
    fullRenderedTokens: full,
    compiledRenderedTokens: compiled,
    tokensSaved: full - compiled,
    ratio: full === 0 ? null : (full - compiled) / full,
  };
}
export function aggregateReduction(rows: readonly ReturnType<typeof reduction>[]) {
  const full = rows.reduce((n, r) => n + r.fullRenderedTokens, 0);
  const compiled = rows.reduce((n, r) => n + r.compiledRenderedTokens, 0);
  return {
    ...reduction(full, compiled),
    distribution: distribution(rows.flatMap((r) => (r.ratio === null ? [] : [r.ratio]))),
  };
}

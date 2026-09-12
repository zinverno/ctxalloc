export const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});
export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lo = Math.floor(position);
    return sorted[lo]! + (sorted[Math.ceil(position)]! - sorted[lo]!) * (position - lo);
  };
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p10: quantile(0.1),
    p25: quantile(0.25),
    median: quantile(0.5),
    p75: quantile(0.75),
    p90: quantile(0.9),
    max: sorted.at(-1) ?? null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
  };
}
export function correlation(pairs: readonly (readonly [number, number])[]): number | null {
  if (pairs.length < 2) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  const cov = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const xx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const yy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  return xx === 0 || yy === 0 ? null : cov / Math.sqrt(xx * yy);
}
export function effectiveness(
  ids: ReadonlySet<string>,
  useful: readonly string[],
  irrelevant: readonly string[],
) {
  const positive = useful.filter((id) => ids.has(id)).length;
  const negative = irrelevant.filter((id) => ids.has(id)).length;
  const unjudged = ids.size - positive - negative;
  return {
    positive,
    negative,
    unjudged,
    precision: { lower: ratio(positive, ids.size), upper: ratio(positive + unjudged, ids.size) },
    judgedPrecision: ratio(positive, positive + negative),
    recall: ratio(positive, useful.length),
    falseAdmissions: { lower: negative, upper: negative + unjudged },
  };
}
/** Disjoint, exhaustive stage ownership; missing source evidence belongs to retrieval/preparation. */
export function losses(
  units: readonly { blockIds: readonly string[] }[],
  retrieved: ReadonlySet<string>,
  admitted: ReadonlySet<string>,
  included: ReadonlySet<string>,
) {
  const result = {
    total: units.length,
    preserved: 0,
    retrieval: 0,
    admission: 0,
    allocation: 0,
    sourceUnavailable: 0,
  };
  for (const u of units) {
    if (!u.blockIds.length) result.sourceUnavailable++;
    if (!u.blockIds.some((id) => retrieved.has(id))) result.retrieval++;
    else if (!u.blockIds.some((id) => admitted.has(id))) result.admission++;
    else if (!u.blockIds.some((id) => included.has(id))) result.allocation++;
    else result.preserved++;
  }
  return result;
}

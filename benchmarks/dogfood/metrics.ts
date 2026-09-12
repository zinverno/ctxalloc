import { ratio, effectiveness } from '../retrieval-calibration/metrics.js';
import type { Annotation } from './schema.js';
import type { MappedEvidence } from './prepare.js';

export type Stages = {
  prepared: ReadonlySet<string>;
  matching: ReadonlySet<string>;
  capped: ReadonlySet<string>;
  admitted: ReadonlySet<string>;
  final: ReadonlySet<string>;
};
export function stageCounts(units: readonly boolean[][]) {
  const at = (stage: number) => units.filter((u) => u[stage]).length;
  const counts = {
    total: units.length,
    source: at(0),
    prepared: at(1),
    matching: at(2),
    capped: at(3),
    admitted: at(4),
    final: at(5),
  };
  if (units.some((u) => u.some((present, i) => i > 0 && present && !u[i - 1])))
    throw new Error('nonmonotone_evidence');
  return {
    ...counts,
    losses: {
      retrieval: counts.total - counts.capped,
      sourceUnavailable: counts.total - counts.source,
      preparation: counts.source - counts.prepared,
      noMatch: counts.prepared - counts.matching,
      retrievalCap: counts.matching - counts.capped,
      admission: counts.capped - counts.admitted,
      allocation: counts.admitted - counts.final,
    },
  };
}
export function evidenceMetrics(a: Annotation, mapped: MappedEvidence, stages: Stages) {
  const sets = [stages.prepared, stages.matching, stages.capped, stages.admitted, stages.final];
  const evidence = mapped.map((e) => [
    e.sourceAvailable,
    ...sets.map(
      (set) =>
        e.preparationComplete !== false &&
        e.blockIds.length > 0 &&
        e.blockIds.every((id) => set.has(id)),
    ),
  ]);
  const facts = a.facts.map((f) =>
    Array.from({ length: 6 }, (_, stage) =>
      f.alternatives.some((alternative) =>
        alternative.every((id) => evidence[mapped.findIndex((e) => e.id === id)]?.[stage] === true),
      ),
    ),
  );
  return {
    evidence: stageCounts(evidence),
    facts: stageCounts(facts),
    critical: stageCounts(facts.filter((_, i) => a.facts[i]!.critical === true)),
    criticalityComplete: a.facts.every((f) => f.critical !== null),
    admission: effectiveness(
      stages.admitted,
      [...new Set(mapped.flatMap((e) => e.blockIds))],
      a.irrelevantBlockIds,
    ),
    judgmentCoverage: ratio(
      new Set([...mapped.flatMap((e) => e.blockIds), ...a.irrelevantBlockIds]).size,
      stages.prepared.size,
    ),
  };
}
export type EvidenceMetrics = ReturnType<typeof evidenceMetrics>;
export type Gate = 'PASS' | 'FAIL' | 'NOT_EVALUATED' | 'NOT_APPLICABLE';
export function target(numerator: number, denominator: number, floor: number): Gate {
  return denominator === 0 ? 'NOT_EVALUATED' : numerator / denominator >= floor ? 'PASS' : 'FAIL';
}
export interface Outcome {
  status: 'SUCCESS' | 'COMPILATION_FAILED';
  failureStage: string | null;
  metrics: EvidenceMetrics;
  runtimePreserved: number;
  runtimeTotal: number;
  tokens: { prepared: number; retrieved: number; compiled: number | null };
  budgetCompliant: boolean | null;
  scopeCompliant: boolean | null;
  deterministic: boolean;
}
export interface QueryResult {
  id: string;
  language: string;
  strata: readonly string[];
  answerability: Annotation['answerability'];
  scopeReviewed: boolean;
  totalEvidence: number;
  totalFacts: number;
  totalCritical: number;
  runtimeTotal: number;
  primary: Outcome | null;
  generous: Outcome | null;
}
export function summarize(
  rows: readonly QueryResult[],
  control: 'primary' | 'generous' = 'primary',
) {
  const sum = (f: (r: QueryResult) => number) => rows.reduce((n, r) => n + f(r), 0);
  const outcomes = rows.flatMap((r) => (r[control] ? [r[control]!] : []));
  const add = (f: (r: Outcome) => number) => outcomes.reduce((n, r) => n + f(r), 0);
  const evidence = sum((r) => r.totalEvidence),
    facts = sum((r) => r.totalFacts),
    critical = sum((r) => r.totalCritical),
    runtime = sum((r) => r.runtimeTotal);
  const allObserved = outcomes.length === rows.length;
  const failed = rows.length - outcomes.filter((o) => o.status === 'SUCCESS').length;
  const retrieved = add((o) => o.metrics.evidence.capped),
    admitted = add((o) => o.metrics.evidence.admitted);
  const criticalComplete = allObserved && outcomes.every((o) => o.metrics.criticalityComplete);
  const runtimeKept = add((o) => o.runtimePreserved),
    factsKept = add((o) => o.metrics.facts.final),
    criticalKept = add((o) => o.metrics.critical.final);
  const prepared = add((o) => o.tokens.prepared),
    retrievedTokens = add((o) => o.tokens.retrieved),
    compiled = add((o) => o.tokens.compiled ?? 0);
  const tokenComplete = allObserved && failed === 0;
  const positives = add((o) => o.metrics.admission.positive),
    negatives = add((o) => o.metrics.admission.negative),
    unjudged = add((o) => o.metrics.admission.unjudged);
  const reduction = (before: number, after: number) =>
    tokenComplete ? ratio(before - after, before) : null;
  const losses = (kind: 'evidence' | 'facts') => ({
    retrieval: add((o) => o.metrics[kind].losses.retrieval),
    sourceUnavailable: add((o) => o.metrics[kind].losses.sourceUnavailable),
    preparation: add((o) => o.metrics[kind].losses.preparation),
    noMatch: add((o) => o.metrics[kind].losses.noMatch),
    retrievalCap: add((o) => o.metrics[kind].losses.retrievalCap),
    admission: add((o) => o.metrics[kind].losses.admission),
    allocation: add((o) => o.metrics[kind].losses.allocation),
    observedQueries: outcomes.length,
  });
  const gates: Record<string, Gate> = {
    retrieval: allObserved ? target(retrieved, evidence, 0.95) : 'NOT_EVALUATED',
    admission: allObserved ? target(admitted, retrieved, 1) : 'NOT_EVALUATED',
    finalFacts: target(factsKept, facts, 0.95),
    critical: criticalComplete ? target(criticalKept, critical, 1) : 'NOT_EVALUATED',
    runtime: runtime === 0 && allObserved ? 'NOT_APPLICABLE' : target(runtimeKept, runtime, 1),
    compilation: failed === 0 && rows.length > 0 ? 'PASS' : 'FAIL',
    budget: outcomes.some((o) => o.budgetCompliant === false)
      ? 'FAIL'
      : allObserved && outcomes.every((o) => o.budgetCompliant === true)
        ? 'PASS'
        : 'NOT_EVALUATED',
    scope: outcomes.some((o) => o.scopeCompliant === false)
      ? 'FAIL'
      : allObserved && outcomes.every((o) => o.scopeCompliant === true)
        ? 'PASS'
        : 'NOT_EVALUATED',
    determinism: allObserved && outcomes.every((o) => o.deterministic) ? 'PASS' : 'FAIL',
    annotationCoverage:
      allObserved &&
      outcomes.every(
        (o) =>
          o.metrics.criticalityComplete &&
          o.metrics.judgmentCoverage.value !== null &&
          o.metrics.judgmentCoverage.value >= 0.8,
      ) &&
      rows.every((r) => r.scopeReviewed)
        ? 'PASS'
        : 'NOT_EVALUATED',
  };
  return {
    queryCount: rows.length,
    observedStageQueries: outcomes.length,
    successfulCompilations: rows.length - failed,
    failures: failed,
    sourceAvailability: allObserved
      ? ratio(
          add((o) => o.metrics.evidence.source),
          evidence,
        )
      : null,
    preparationCoverage: allObserved
      ? ratio(
          add((o) => o.metrics.evidence.prepared),
          add((o) => o.metrics.evidence.source),
        )
      : null,
    retrievalRecall: allObserved ? ratio(retrieved, evidence) : null,
    retrievalGivenPrepared: allObserved
      ? ratio(
          retrieved,
          add((o) => o.metrics.evidence.prepared),
        )
      : null,
    admissionRecall: allObserved ? ratio(admitted, retrieved) : null,
    finalFactPreservation: ratio(factsKept, facts),
    knownCriticalFactPreservation: ratio(criticalKept, critical),
    criticalityStatus: criticalComplete && critical > 0 ? 'EVALUATED' : 'NOT_EVALUATED',
    runtimePreservation: ratio(runtimeKept, runtime),
    admissionPrecision: {
      lower: ratio(positives, positives + negatives + unjudged),
      upper: ratio(positives + unjudged, positives + negatives + unjudged),
      judgedOnly: ratio(positives, positives + negatives),
      judgmentCoverage: ratio(positives + negatives, positives + negatives + unjudged),
    },
    falseAdmissions: { lower: negatives, upper: negatives + unjudged },
    evidenceLosses: losses('evidence'),
    factLosses: losses('facts'),
    completeEvidenceLossQueries: rows
      .filter((r) => r.totalEvidence > 0 && (r[control]?.metrics.evidence.final ?? 0) === 0)
      .map((r) => r.id),
    tokenComparisons: {
      completeWorkload: tokenComplete,
      preparedToRetrieved: allObserved ? ratio(prepared - retrievedTokens, prepared) : null,
      retrievedToCompiled: reduction(retrievedTokens, compiled),
      endToEnd: reduction(prepared, compiled),
      measuredQueryCount: outcomes.filter((o) => o.tokens.compiled !== null).length,
    },
    budgetViolations: add((o) => Number(o.budgetCompliant === false)),
    crossScopeViolations: add((o) => Number(o.scopeCompliant === false)),
    gates,
  };
}

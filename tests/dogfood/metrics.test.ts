import { describe, expect, it } from 'vitest';
import {
  evidenceMetrics,
  stageCounts,
  summarize,
  target,
  type QueryResult,
} from '../../benchmarks/dogfood/metrics.js';
import type { Annotation } from '../../benchmarks/dogfood/schema.js';
import { feasibility } from '../../benchmarks/dogfood/evaluate.js';

const annotation: Annotation = {
  taskId: 'toy',
  answerability: 'answerable',
  scopeReviewed: true,
  useful: [],
  irrelevantBlockIds: [],
  facts: [
    {
      id: 'complementary',
      statement: 'Toy conjunction',
      required: true,
      critical: true,
      alternatives: [['a', 'b']],
    },
    {
      id: 'alternative',
      statement: 'Toy alternative',
      required: false,
      critical: false,
      alternatives: [['a'], ['c']],
    },
  ],
};
const mapped = [
  { id: 'a', sourceAvailable: true, blockIds: ['a1', 'a2'] },
  { id: 'b', sourceAvailable: true, blockIds: ['b'] },
  { id: 'c', sourceAvailable: false, blockIds: [] },
];
const set = (...ids: string[]) => new Set(ids);

describe('Dogfood metric definitions (toy arithmetic only)', () => {
  it('requires every carrier in a fact alternative, including all span chunks', () => {
    const m = evidenceMetrics(annotation, mapped, {
      prepared: set('a1', 'a2', 'b'),
      matching: set('a1', 'a2', 'b'),
      capped: set('a1', 'a2', 'b'),
      admitted: set('a1', 'a2', 'b'),
      final: set('a1', 'a2'),
    });
    expect(m.facts).toMatchObject({ total: 2, final: 1, losses: { allocation: 1 } });
    expect(m.critical.final).toBe(0);
    const partial = evidenceMetrics(annotation, mapped, {
      prepared: set('a1', 'a2', 'b'),
      matching: set('a1', 'a2', 'b'),
      capped: set('a1', 'a2', 'b'),
      admitted: set('a1', 'a2', 'b'),
      final: set('a1', 'b'),
    });
    expect(partial.facts.final).toBe(0);
  });
  it('separates unavailable source, preparation, matching, cap, admission and allocation losses', () => {
    const vectors = Array.from({ length: 7 }, (_, n) => Array.from({ length: 6 }, (_, i) => i < n));
    const counts = stageCounts(vectors);
    expect(counts.losses).toEqual({
      retrieval: 4,
      sourceUnavailable: 1,
      preparation: 1,
      noMatch: 1,
      retrievalCap: 1,
      admission: 1,
      allocation: 1,
    });
    expect(counts.final).toBe(1);
    expect(() => stageCounts([[false, true]])).toThrow('nonmonotone_evidence');
  });
  it('keeps unjudged candidate bounds and zero denominators explicit', () => {
    const m = evidenceMetrics({ ...annotation, facts: [], irrelevantBlockIds: ['negative'] }, [], {
      prepared: set('negative', 'unknown'),
      matching: set('negative', 'unknown'),
      capped: set('negative', 'unknown'),
      admitted: set('negative', 'unknown'),
      final: set(),
    });
    expect(m.admission.falseAdmissions).toEqual({ lower: 1, upper: 2 });
    expect(m.admission.precision.lower.value).toBe(0);
    expect(m.admission.precision.upper.value).toBe(0.5);
    expect(m.admission.recall.value).toBeNull();
    expect(target(0, 0, 1)).toBe('NOT_EVALUATED');
  });
  it('keeps failed/unobserved queries in final denominators and marks retrieval unobserved', () => {
    const row: QueryResult = {
      id: 'q001',
      language: 'en',
      strata: ['developer-reference'],
      answerability: 'answerable',
      scopeReviewed: true,
      totalEvidence: 3,
      totalFacts: 2,
      totalCritical: 1,
      runtimeTotal: 1,
      primary: null,
      generous: null,
    };
    const result = summarize([row]);
    expect(result.failures).toBe(1);
    expect(result.finalFactPreservation).toEqual({ numerator: 0, denominator: 2, value: 0 });
    expect(result.retrievalRecall).toBeNull();
    expect(result.factLosses.observedQueries).toBe(0);
    expect(result.completeEvidenceLossQueries).toEqual(['q001']);
    expect(result.tokenComparisons.endToEnd).toBeNull();
    expect(result.criticalityStatus).toBe('NOT_EVALUATED');
  });
  it('accepts an exact fitting witness without changing compilation, and never infers impossibility from failure', () => {
    const fit = feasibility(annotation, mapped, (ids) => ({ tokens: 10, included: ids }), 10);
    expect(fit.status).toBe('FEASIBLE');
    expect(
      feasibility(annotation, mapped, (ids) => ({ tokens: 11, included: ids }), 10).status,
    ).toBe('UNKNOWN');
    expect(
      feasibility(
        annotation,
        mapped,
        () => {
          throw new Error('toy failure');
        },
        10,
      ).status,
    ).toBe('UNKNOWN');
    expect(
      feasibility(
        { ...annotation, facts: [{ ...annotation.facts[0]!, critical: null }] },
        mapped,
        () => ({ tokens: 1, included: set() }),
        10,
      ).status,
    ).toBe('NOT_EVALUATED');
  });
});

it('records partially prepared evidence as preparation loss while keeping its surviving chunks positively judged', () => {
  const partial = [
    { id: 'a', sourceAvailable: true, blockIds: ['a1'], preparationComplete: false },
  ];
  const a = { ...annotation, facts: [{ ...annotation.facts[0]!, alternatives: [['a']] }] };
  const m = evidenceMetrics(a, partial, {
    prepared: set('a1'),
    matching: set('a1'),
    capped: set('a1'),
    admitted: set('a1'),
    final: set('a1'),
  });
  expect(m.evidence.losses.preparation).toBe(1);
  expect(m.evidence.final).toBe(0);
  expect(m.admission.positive).toBe(1);
  expect(m.facts.final).toBe(0);
  expect(feasibility(a, partial, (ids) => ({ tokens: 1, included: ids }), 10).status).toBe(
    'UNKNOWN',
  );
});

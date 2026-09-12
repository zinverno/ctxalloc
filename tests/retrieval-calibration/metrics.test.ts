import { describe, expect, it } from 'vitest';
import {
  distribution,
  effectiveness,
  losses,
  ratio,
} from '../../benchmarks/retrieval-calibration/metrics.js';

// These arithmetic examples test the harness, not independent calibration ground truth.
describe('Phase 22A metric boundaries', () => {
  it('keeps empty denominators undefined rather than claiming perfect preservation', () => {
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(distribution([]).median).toBeNull();
  });
  it('does not treat unjudged candidates as false admissions or true positives', () => {
    const r = effectiveness(
      new Set(['positive', 'negative', 'unknown']),
      ['positive'],
      ['negative'],
    );
    expect(r.precision.lower.value).toBe(1 / 3);
    expect(r.precision.upper.value).toBe(2 / 3);
    expect(r.falseAdmissions).toEqual({ lower: 1, upper: 2 });
    expect(r.judgedPrecision.value).toBe(0.5);
  });
  it('exposes the uncertainty of positive-only judgments', () => {
    const r = effectiveness(new Set(['positive', 'unknown']), ['positive'], []);
    expect(r.judgedPrecision.value).toBe(1);
    expect(r.precision.lower.value).toBe(0.5);
    expect(r.precision.upper.value).toBe(1);
  });
  it('assigns every lost evidence unit to exactly one stage', () => {
    const units = ['retrieval', 'admission', 'allocation', 'included'].map((id) => ({
      blockIds: [id],
    }));
    expect(
      losses(
        units,
        new Set(['admission', 'allocation', 'included']),
        new Set(['allocation', 'included']),
        new Set(['included']),
      ),
    ).toEqual({
      total: 4,
      preserved: 1,
      retrieval: 1,
      admission: 1,
      allocation: 1,
      sourceUnavailable: 0,
    });
  });
  it('counts alternative carriers as one evidence unit and exposes unavailable source evidence', () => {
    expect(
      losses(
        [{ blockIds: ['a', 'b'] }, { blockIds: [] }],
        new Set(['b']),
        new Set(['b']),
        new Set(['b']),
      ),
    ).toEqual({
      total: 2,
      preserved: 1,
      retrieval: 1,
      admission: 0,
      allocation: 0,
      sourceUnavailable: 1,
    });
  });
  it('reports distribution tails and interpolated median', () => {
    expect(distribution([100, 0, 10, 20])).toMatchObject({
      count: 4,
      min: 0,
      median: 15,
      max: 100,
      mean: 32.5,
    });
  });
});

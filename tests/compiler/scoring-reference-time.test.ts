import { CandidateScorer } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  ONE_DAY,
  ONE_HOUR,
  REFERENCE_TIME,
  candidate,
  deduplicate,
  issueCodesOf,
  issuesOf,
  policy,
  score,
  secondsBeforeReference,
} from './scoring-fixtures.js';

const RECENCY_POLICY = policy({
  recency: { weight: 1, maxAgeSeconds: ONE_DAY, missingValue: 0 },
});

describe('CandidateScorer: explicit reference time', () => {
  it('INV-DET-004: copies the validated reference time into the result', () => {
    const result = score([candidate()], policy());
    expect(result.referenceTime).toBe(REFERENCE_TIME);
  });

  it('rejects an invalid reference time before scoring anything', () => {
    for (const value of [
      undefined,
      null,
      '',
      'yesterday',
      '2026-06-01',
      '2026-06-01T12:00:00',
      '2026-06-01T12:00:00+02:00',
      '2026-02-31T00:00:00.000Z',
      1_770_000_000_000,
      new Date(0),
    ]) {
      const codes = issueCodesOf(() => score([candidate()], policy(), { referenceTime: value }));
      expect(codes.length, String(value)).toBeGreaterThan(0);
      expect(new Set(codes), String(value)).toEqual(new Set(['invalid_reference_time']));
    }
  });

  it('addresses an invalid reference time by name', () => {
    const issues = issuesOf(() => score([candidate()], policy(), { referenceTime: 'nope' }));
    expect(issues[0]?.pointer).toBe('referenceTime');
  });

  it('INV-DET-004: reads no hidden clock, so scoring never changes between calls', () => {
    const batch = deduplicate({
      candidates: [candidate({ updatedAt: secondsBeforeReference(ONE_HOUR) })],
    });
    const scorer = new CandidateScorer(RECENCY_POLICY);

    const first = scorer.score(batch, REFERENCE_TIME);
    const second = scorer.score(batch, REFERENCE_TIME);

    expect(second).toEqual(first);
    expect(first.candidates[0]?.score.recency?.normalizedValue).toBeCloseTo(1 - 1 / 24, 12);
  });

  it('INV-DET-001: produces deep-equal results for the same input and reference time', () => {
    const candidates = [
      candidate({ id: 'block-1', createdAt: secondsBeforeReference(ONE_HOUR) }),
      candidate({ id: 'block-2', content: 'Second distinct block.' }),
    ];
    expect(score(candidates, RECENCY_POLICY)).toEqual(score(candidates, RECENCY_POLICY));
  });

  it('changes only the recency component when the reference time moves', () => {
    const candidates = [candidate({ updatedAt: secondsBeforeReference(ONE_HOUR) })];
    const full = policy({
      sourcePriority: { weight: 1, defaultValue: 0.5, bySourceDocumentId: [] },
      recency: { weight: 1, maxAgeSeconds: ONE_DAY, missingValue: 0 },
    });

    const atReference = score(candidates, full);
    const laterReference = score(candidates, full, {
      referenceTime: '2026-06-02T12:00:00.000Z',
    });

    expect(laterReference.candidates[0]?.score.sourcePriority).toEqual(
      atReference.candidates[0]?.score.sourcePriority,
    );
    expect(atReference.candidates[0]?.score.recency?.normalizedValue).toBeCloseTo(1 - 1 / 24, 12);
    expect(laterReference.candidates[0]?.score.recency?.normalizedValue).toBe(0);
  });

  it('ignores the reference time entirely when no recency component is configured', () => {
    const candidates = [candidate({ updatedAt: secondsBeforeReference(ONE_HOUR) })];
    const noRecency = policy({
      sourcePriority: { weight: 1, defaultValue: 0.5, bySourceDocumentId: [] },
    });

    const early = score(candidates, noRecency, { referenceTime: '2000-01-01T00:00:00.000Z' });
    const late = score(candidates, noRecency, { referenceTime: '2099-01-01T00:00:00.000Z' });

    expect(late.candidates.map((entry) => entry.score)).toEqual(
      early.candidates.map((entry) => entry.score),
    );
    // The reference time is still validated and still reported, because the
    // result states which instant produced it.
    expect(early.referenceTime).toBe('2000-01-01T00:00:00.000Z');
    expect(late.referenceTime).toBe('2099-01-01T00:00:00.000Z');
  });

  it('accepts sub-second precision without changing a whole-second result', () => {
    const candidates = [candidate({ updatedAt: '2026-06-01T11:00:00.000Z' })];
    const whole = score(candidates, RECENCY_POLICY);
    const fractional = score(candidates, RECENCY_POLICY, {
      referenceTime: '2026-06-01T12:00:00.500Z',
    });

    expect(whole.candidates[0]?.score.recency?.evidence[0]?.ageSeconds).toBe(ONE_HOUR);
    expect(fractional.candidates[0]?.score.recency?.evidence[0]?.ageSeconds).toBe(ONE_HOUR + 0.5);
  });

  it('exposes no Date instance anywhere in the result', () => {
    const result = score(
      [candidate({ updatedAt: secondsBeforeReference(ONE_HOUR) })],
      RECENCY_POLICY,
    );
    const seen: unknown[] = [];
    const walk = (value: unknown): void => {
      if (value instanceof Date) seen.push(value);
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk);
    };
    walk(result);

    expect(seen).toEqual([]);
    expect(typeof result.referenceTime).toBe('string');
  });
});

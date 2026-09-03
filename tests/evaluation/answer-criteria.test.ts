import { evaluateAnswer, type AnswerCriterion } from '@ctxalloc/evaluation';
import { describe, expect, it } from 'vitest';

/**
 * Deterministic rule-based answer evaluation, v1 (DEC-040, METRICS 11.5, 12.1).
 *
 * Every criterion is binary: it earns its whole weight or nothing. There is no
 * regular expression, no stemming, no fuzzy match, no trimming, and no Unicode
 * normalization — each of those would let a criterion match text the model did
 * not write, and would make the author's intent harder to read from the case
 * than from the implementation.
 */

const exact = (expected: string, caseSensitive = true, weight = 1): AnswerCriterion => ({
  kind: 'exact',
  id: `exact-${expected}-${String(caseSensitive)}`,
  weight,
  expected,
  caseSensitive,
});

describe('answer criteria: exact', () => {
  it('requires the whole answer to equal the expected string', () => {
    expect(evaluateAnswer('yes', [exact('yes')]).score).toBe(1);
    expect(evaluateAnswer('yes.', [exact('yes')]).score).toBe(0);
    expect(evaluateAnswer('it is yes', [exact('yes')]).score).toBe(0);
  });

  it('never trims the answer before comparing', () => {
    // A criterion that needed surrounding whitespace ignored can say so with
    // `contains-all`; silently trimming would pass text the model did not emit.
    expect(evaluateAnswer(' yes', [exact('yes')]).score).toBe(0);
    expect(evaluateAnswer('yes\n', [exact('yes')]).score).toBe(0);
  });

  it('honors case sensitivity in both directions', () => {
    expect(evaluateAnswer('YES', [exact('yes', true)]).score).toBe(0);
    expect(evaluateAnswer('YES', [exact('yes', false)]).score).toBe(1);
  });
});

describe('answer criteria: contains-all, contains-any, not-contains', () => {
  const all: AnswerCriterion = {
    kind: 'contains-all',
    id: 'all',
    weight: 1,
    expected: ['alpha', 'beta'],
    caseSensitive: true,
  };
  const any: AnswerCriterion = {
    kind: 'contains-any',
    id: 'any',
    weight: 1,
    expected: ['alpha', 'gamma'],
    caseSensitive: true,
  };
  const none: AnswerCriterion = {
    kind: 'not-contains',
    id: 'none',
    weight: 1,
    forbidden: ['secret', 'internal'],
    caseSensitive: true,
  };

  it('contains-all requires every value', () => {
    expect(evaluateAnswer('alpha and beta', [all]).score).toBe(1);
    expect(evaluateAnswer('alpha only', [all]).score).toBe(0);
  });

  it('contains-any requires at least one value', () => {
    expect(evaluateAnswer('gamma only', [any]).score).toBe(1);
    expect(evaluateAnswer('delta only', [any]).score).toBe(0);
  });

  it('not-contains requires none of the forbidden values', () => {
    expect(evaluateAnswer('a clean answer', [none]).score).toBe(1);
    expect(evaluateAnswer('this is internal', [none]).score).toBe(0);
  });

  it('applies case sensitivity per criterion', () => {
    const insensitive: AnswerCriterion = { ...all, id: 'all-ci', caseSensitive: false };
    expect(evaluateAnswer('ALPHA and BETA', [all]).score).toBe(0);
    expect(evaluateAnswer('ALPHA and BETA', [insensitive]).score).toBe(1);
  });

  it('uses locale-independent lowercasing', () => {
    // `toLocaleLowerCase` would fold `I` differently under a Turkish locale and
    // make one criterion pass on one machine and fail on another (INV-DET-002).
    const criterion: AnswerCriterion = {
      kind: 'contains-all',
      id: 'turkish',
      weight: 1,
      expected: ['istanbul'],
      caseSensitive: false,
    };
    expect(evaluateAnswer('We flew to ISTANBUL.', [criterion]).score).toBe(1);
  });
});

describe('answer criteria: scoring', () => {
  it('awards a criterion its whole weight or nothing', () => {
    const criteria: readonly AnswerCriterion[] = [
      exact('yes', true, 3),
      { kind: 'contains-all', id: 'c2', weight: 1, expected: ['no'], caseSensitive: true },
    ];
    const evaluation = evaluateAnswer('yes', criteria);
    expect(evaluation.earnedWeight).toBe(3);
    expect(evaluation.totalWeight).toBe(4);
    expect(evaluation.score).toBe(0.75);
    expect(evaluation.criteria.map((entry) => entry.passed)).toEqual([true, false]);
  });

  it('reports every criterion with its identifier, kind, and weight', () => {
    const evaluation = evaluateAnswer('yes', [exact('yes', true, 2)]);
    expect(evaluation.criteria).toEqual([
      { criterionId: 'exact-yes-true', kind: 'exact', weight: 2, passed: true },
    ]);
  });

  it('produces no score at all when a case states no criteria', () => {
    // An unscored answer is not a zero-scoring answer: emitting `0` would drag
    // every aggregate down with a measurement nobody made (METRICS 11.5).
    const evaluation = evaluateAnswer('anything', []);
    expect(evaluation.score).toBeUndefined();
    expect(evaluation.earnedWeight).toBe(0);
    expect(evaluation.totalWeight).toBe(0);
    expect(Object.keys(evaluation)).not.toContain('score');
  });

  it('is a pure function of the answer and the criteria', () => {
    const criteria = [exact('yes')];
    const first = evaluateAnswer('yes', criteria);
    const second = evaluateAnswer('yes', criteria);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('scores an empty answer without special-casing it', () => {
    // An empty answer is just a string: it fails a criterion that wants text and
    // passes one that forbids it.
    expect(evaluateAnswer('', [exact('yes')]).score).toBe(0);
    expect(
      evaluateAnswer('', [
        { kind: 'not-contains', id: 'n', weight: 1, forbidden: ['x'], caseSensitive: true },
      ]).score,
    ).toBe(1);
  });
});

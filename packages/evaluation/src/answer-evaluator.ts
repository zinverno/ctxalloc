import type { AnswerCriterion } from './evaluation-case.js';

/**
 * Deterministic rule-based answer evaluation, v1 (DEC-040, METRICS 11.5, 12.1).
 *
 * This is a pure function of the exact model output and the case's criteria. It
 * calls no model, reads no clock, uses no random value, and looks at neither the
 * context nor the query. Two runs over the same output and the same criteria
 * produce the same score, which is what makes a quality *loss* meaningful: a
 * judge that could change its mind would turn a stable regression into noise
 * (METRICS 12.3).
 *
 * Matching is exact substring or exact equality over the answer **as produced**.
 * Nothing is trimmed, Unicode-normalized, stemmed, or fuzzy-matched, and there
 * is no regular expression in v1. Every one of those would make a criterion
 * match text the model did not write, and would make an author's intent harder
 * to read from the case than from the implementation.
 *
 * Case-insensitive comparison uses `String.prototype.toLowerCase()`, which is
 * the locale-independent Unicode default case conversion. `toLocaleLowerCase`
 * is deliberately not used: it would fold `I` differently under a Turkish locale
 * and make a criterion pass on one machine and fail on another (INV-DET-002).
 *
 * Scoring is binary per criterion — a criterion earns its whole weight or
 * nothing — which is METRICS 11.5's awarded-points formula with each dimension
 * scored 0 or its maximum.
 */

/** The outcome of one criterion against one answer. */
export interface AnswerCriterionResult {
  readonly criterionId: string;
  readonly kind: AnswerCriterion['kind'];
  readonly weight: number;
  readonly passed: boolean;
}

/**
 * The complete scoring of one answer.
 *
 * `score` is absent when the case states no criteria. An unscored answer is not
 * a zero-scoring answer, and emitting `0` would drag every aggregate down with a
 * measurement nobody made (METRICS 11.5).
 */
export interface AnswerEvaluation {
  readonly criteria: readonly AnswerCriterionResult[];
  readonly earnedWeight: number;
  readonly totalWeight: number;
  readonly score?: number;
}

function fold(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function evaluateCriterion(criterion: AnswerCriterion, answer: string): boolean {
  const subject = fold(answer, criterion.caseSensitive);

  switch (criterion.kind) {
    case 'exact':
      return subject === fold(criterion.expected, criterion.caseSensitive);
    case 'contains-all':
      return criterion.expected.every((value) =>
        subject.includes(fold(value, criterion.caseSensitive)),
      );
    case 'contains-any':
      return criterion.expected.some((value) =>
        subject.includes(fold(value, criterion.caseSensitive)),
      );
    case 'not-contains':
      return criterion.forbidden.every(
        (value) => !subject.includes(fold(value, criterion.caseSensitive)),
      );
  }
}

/**
 * Scores one exact answer against one validated criterion set.
 *
 * The answer is used exactly as the provider returned it. Trimming it first
 * would let a criterion that requires an exact answer pass on text the model did
 * not produce, and the criteria are already free to be written as `contains-all`
 * when surrounding whitespace does not matter.
 */
export function evaluateAnswer(
  answer: string,
  criteria: readonly AnswerCriterion[],
): AnswerEvaluation {
  const results = criteria.map((criterion) => ({
    criterionId: criterion.id,
    kind: criterion.kind,
    weight: criterion.weight,
    passed: evaluateCriterion(criterion, answer),
  }));

  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  const earnedWeight = results.reduce(
    (sum, result) => (result.passed ? sum + result.weight : sum),
    0,
  );

  return {
    criteria: results,
    earnedWeight,
    totalWeight,
    ...(totalWeight === 0 ? {} : { score: earnedWeight / totalWeight }),
  };
}

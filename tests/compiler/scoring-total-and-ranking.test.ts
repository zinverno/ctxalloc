import { CandidateScorer } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  ONE_DAY,
  REFERENCE_TIME,
  candidate,
  deduplicateCandidates,
  issueCodesOf,
  permutations,
  policy,
  reversed,
  rule,
  score,
  scoredRetrieval,
  secondsBeforeReference,
} from './scoring-fixtures.js';

const FULL_POLICY = policy({
  retrieval: { weight: 4, aggregation: 'max', rules: [rule()] },
  authoredPriority: { weight: 2, min: 0, max: 10 },
  sourcePriority: { weight: 1, defaultValue: 0.5, bySourceDocumentId: [] },
  categoryPriority: { weight: 0.5, defaultValue: 0.2, byCategory: [{ category: 'a', value: 1 }] },
  recency: { weight: 0.25, maxAgeSeconds: ONE_DAY, missingValue: 0 },
});

describe('CandidateScorer: contributions and total', () => {
  it('multiplies each normalized value by its policy weight', () => {
    const result = score(
      [
        candidate(
          { attributes: { priority: 5, category: 'a' }, updatedAt: secondsBeforeReference(0) },
          scoredRetrieval(0.5),
        ),
      ],
      FULL_POLICY,
    );
    const candidateScore = result.candidates[0]?.score;

    expect(candidateScore?.retrieval).toMatchObject({
      normalizedValue: 0.5,
      weight: 4,
      contribution: 2,
    });
    expect(candidateScore?.authoredPriority).toMatchObject({
      normalizedValue: 0.5,
      weight: 2,
      contribution: 1,
    });
    expect(candidateScore?.sourcePriority).toMatchObject({
      normalizedValue: 0.5,
      weight: 1,
      contribution: 0.5,
    });
    expect(candidateScore?.categoryPriority).toMatchObject({
      normalizedValue: 1,
      weight: 0.5,
      contribution: 0.5,
    });
    expect(candidateScore?.recency).toMatchObject({
      normalizedValue: 1,
      weight: 0.25,
      contribution: 0.25,
    });
    expect(candidateScore?.total).toBe(2 + 1 + 0.5 + 0.5 + 0.25);
  });

  it('INV-DET-002: sums the components in one fixed order', () => {
    const result = score([candidate({}, scoredRetrieval(0.3))], FULL_POLICY);
    expect(Object.keys(result.candidates[0]?.score ?? {})).toEqual([
      'total',
      'retrieval',
      'authoredPriority',
      'sourcePriority',
      'categoryPriority',
      'recency',
    ]);
  });

  it('supports fractional weights that do not sum to one', () => {
    const result = score(
      [candidate({}, scoredRetrieval(1))],
      policy({
        retrieval: { weight: 3.5, aggregation: 'max', rules: [rule()] },
        sourcePriority: { weight: 0.25, defaultValue: 1, bySourceDocumentId: [] },
      }),
    );

    // A total is a policy-relative utility, not a probability, and is not
    // bounded by one.
    expect(result.candidates[0]?.score.total).toBe(3.75);
  });

  it('keeps a zero-weight component visible with a zero contribution', () => {
    const result = score(
      [candidate({}, scoredRetrieval(0.9))],
      policy({ retrieval: { weight: 0, aggregation: 'max', rules: [rule()] } }),
    );
    const component = result.candidates[0]?.score.retrieval;

    expect(component?.normalizedValue).toBe(0.9);
    expect(component?.contribution).toBe(0);
    expect(component?.evidence).toHaveLength(1);
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('totals zero when every component is absent', () => {
    expect(score([candidate()], policy()).candidates[0]?.score).toEqual({ total: 0 });
  });

  it('totals zero when every configured weight is zero', () => {
    const result = score(
      [candidate({ attributes: { priority: 10 } }, scoredRetrieval(1))],
      policy({
        retrieval: { weight: 0, aggregation: 'max', rules: [rule()] },
        authoredPriority: { weight: 0, min: 0, max: 10 },
        sourcePriority: { weight: 0, defaultValue: 1, bySourceDocumentId: [] },
        categoryPriority: { weight: 0, defaultValue: 1, byCategory: [] },
        recency: { weight: 0, maxAgeSeconds: ONE_DAY, missingValue: 1 },
      }),
    );

    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('publishes no negative zero anywhere in the result', () => {
    const result = score(
      [candidate({ attributes: { priority: 0 } }, scoredRetrieval(0))],
      policy({
        retrieval: { weight: 0, aggregation: 'max', rules: [rule()] },
        authoredPriority: { weight: 0, min: 0, max: 10 },
        recency: { weight: 0, maxAgeSeconds: ONE_DAY, missingValue: 0 },
      }),
    );

    const negativeZeros: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number' && Object.is(value, -0)) negativeZeros.push(path);
      else if (Array.isArray(value))
        value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      else if (typeof value === 'object' && value !== null) {
        for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
      }
    };
    walk(result, 'result');

    expect(negativeZeros).toEqual([]);
  });

  it('INV-SCORE-004: rejects a total that overflows to a non-finite value', () => {
    const codes = issueCodesOf(() =>
      score(
        [candidate({ attributes: { priority: 10 } }, scoredRetrieval(1))],
        policy({
          retrieval: { weight: Number.MAX_VALUE, aggregation: 'max', rules: [rule()] },
          authoredPriority: { weight: Number.MAX_VALUE, min: 0, max: 10 },
        }),
      ),
    );

    expect(codes).toEqual(['non_finite_score_result']);
  });
});

describe('CandidateScorer: output ranking', () => {
  const RANKING_POLICY = policy({
    retrieval: { weight: 1, aggregation: 'max', rules: [rule()] },
  });

  it('returns the highest total first', () => {
    const result = score(
      [
        candidate({ id: 'block-a', content: 'Alpha content.' }, scoredRetrieval(0.2)),
        candidate({ id: 'block-b', content: 'Bravo content.' }, scoredRetrieval(0.9)),
        candidate({ id: 'block-c', content: 'Charlie content.' }, scoredRetrieval(0.5)),
      ],
      RANKING_POLICY,
    );

    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id)).toEqual([
      'block-b',
      'block-c',
      'block-a',
    ]);
  });

  it('INV-DET-005: breaks a tie by the stable block identifier, compared by code unit', () => {
    const result = score(
      [
        candidate({ id: 'block-Z', content: 'Zulu content.' }, scoredRetrieval(0.5)),
        candidate({ id: 'block-a', content: 'Alpha content.' }, scoredRetrieval(0.5)),
        candidate({ id: 'block-A', content: 'Alpha uppercase content.' }, scoredRetrieval(0.5)),
      ],
      RANKING_POLICY,
    );

    // Uppercase precedes lowercase by UTF-16 code unit; a locale-aware
    // comparison would order these differently.
    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id)).toEqual([
      'block-A',
      'block-Z',
      'block-a',
    ]);
  });

  it('INV-ALLOC-005: returns the same ranking for every input permutation', () => {
    const candidates = [
      candidate({ id: 'block-1', content: 'One.' }, scoredRetrieval(0.4)),
      candidate({ id: 'block-2', content: 'Two.' }, scoredRetrieval(0.8)),
      candidate({ id: 'block-3', content: 'Three.' }, scoredRetrieval(0.4)),
    ];
    const scorer = new CandidateScorer(RANKING_POLICY);

    const expected = scorer
      .score(deduplicateCandidates(candidates), REFERENCE_TIME)
      .candidates.map((entry) => [entry.candidate.canonicalBlock.id, entry.score]);

    for (const permutation of permutations(candidates)) {
      const actual = scorer
        .score(deduplicateCandidates(permutation), REFERENCE_TIME)
        .candidates.map((entry) => [entry.candidate.canonicalBlock.id, entry.score]);
      expect(actual).toEqual(expected);
    }
  });

  it('INV-DET-002: is unaffected by reversed groups and reversed members', () => {
    const batch = deduplicateCandidates([
      candidate({ id: 'block-1', content: 'One.' }, scoredRetrieval(0.4)),
      candidate({ id: 'block-1', content: 'One.' }, scoredRetrieval(0.6)),
      candidate({ id: 'block-2', content: 'Two.' }, scoredRetrieval(0.8)),
    ]);
    const scorer = new CandidateScorer(RANKING_POLICY);

    const decisions = (set: ReturnType<typeof scorer.score>): unknown =>
      set.candidates.map((entry) => [entry.candidate.canonicalBlock.id, entry.score]);

    expect(decisions(scorer.score(reversed(batch), REFERENCE_TIME))).toEqual(
      decisions(scorer.score(batch, REFERENCE_TIME)),
    );
  });

  it('falls back to stable identifier order under a zero-signal policy', () => {
    const result = score(
      [
        candidate({ id: 'block-c', content: 'Charlie.' }),
        candidate({ id: 'block-a', content: 'Alpha.' }),
        candidate({ id: 'block-b', content: 'Bravo.' }),
      ],
      policy(),
    );

    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id)).toEqual([
      'block-a',
      'block-b',
      'block-c',
    ]);
  });

  it('INV-SCORE-003: does not let required status change the ranking', () => {
    const result = score(
      [
        candidate(
          { id: 'block-required', content: 'Required content.', attributes: { required: true } },
          scoredRetrieval(0.1),
        ),
        candidate({ id: 'block-optional', content: 'Optional content.' }, scoredRetrieval(0.9)),
      ],
      RANKING_POLICY,
    );

    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id)).toEqual([
      'block-optional',
      'block-required',
    ]);
    expect(result.candidates[1]?.candidate.canonicalBlock.attributes.required).toBe(true);
    expect(result.candidates[1]?.score.total).toBe(0.1);
  });

  it('returns the source registry in stable identifier order and the scope unchanged', () => {
    const result = score([candidate()], policy());

    expect(result.sourceDocuments.map((document) => document.id)).toEqual(['doc-1']);
    expect(result.scope).toEqual({ tenantId: 'local', workspaceId: 'default' });
  });
});

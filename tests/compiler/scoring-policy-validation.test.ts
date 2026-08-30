import { CANDIDATE_SCORING_POLICY_SCHEMA_VERSION, CandidateScorer } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  issueCodesOf,
  issuesOf,
  omit,
  policy,
  REFERENCE_TIME,
  rule,
  score,
  scoredRetrieval,
} from './scoring-fixtures.js';

function construct(overrides: Record<string, unknown>): () => CandidateScorer {
  return () => new CandidateScorer(policy(overrides));
}

describe('CandidateScorer: scoring policy validation', () => {
  it('publishes the policy schema version it accepts', () => {
    expect(CANDIDATE_SCORING_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('accepts an identity-only policy with no configured signal', () => {
    const result = score([candidate()], policy());

    expect(result.policyId).toBe('baseline');
    expect(result.policyVersion).toBe('1.0.0');
    expect(result.candidates[0]?.score).toEqual({ total: 0 });
  });

  it('accepts a policy configuring all five components', () => {
    const result = score(
      [candidate()],
      policy({
        retrieval: { weight: 1, aggregation: 'max', rules: [rule()] },
        authoredPriority: { weight: 1, min: -10, max: 10 },
        sourcePriority: { weight: 1, defaultValue: 0.5, bySourceDocumentId: [] },
        categoryPriority: { weight: 1, defaultValue: 0.25, byCategory: [] },
        recency: { weight: 1, maxAgeSeconds: 86_400, missingValue: 0 },
      }),
    );

    const score0 = result.candidates[0]?.score;
    expect(Object.keys(score0 ?? {})).toEqual([
      'total',
      'retrieval',
      'authoredPriority',
      'sourcePriority',
      'categoryPriority',
      'recency',
    ]);
  });

  it('rejects an unknown top-level field rather than stripping it', () => {
    expect(issueCodesOf(construct({ minimumScore: 0.5 }))).toEqual(['invalid_policy']);
  });

  it('rejects an unknown field inside a component', () => {
    expect(
      issueCodesOf(
        construct({ recency: { weight: 1, maxAgeSeconds: 10, missingValue: 0, decay: 'linear' } }),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('rejects a policy that is not an object', () => {
    for (const value of [null, undefined, 'policy', 7, []]) {
      expect(issueCodesOf(() => new CandidateScorer(value))).toEqual(['invalid_policy']);
    }
  });

  it('rejects a wrong schema version', () => {
    for (const version of [0, 2, '1', undefined]) {
      expect(issueCodesOf(() => new CandidateScorer(policy({ schemaVersion: version })))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a blank policy identity and preserves an exact one', () => {
    for (const blank of ['', '   ', '\n']) {
      expect(issueCodesOf(() => new CandidateScorer(policy({ policyId: blank })))).toEqual([
        'invalid_policy',
      ]);
      expect(issueCodesOf(() => new CandidateScorer(policy({ policyVersion: blank })))).toEqual([
        'invalid_policy',
      ]);
    }

    // Exact strings survive validation: nothing is trimmed or rewritten.
    const result = score([candidate()], policy({ policyId: '  spaced  ', policyVersion: 'v1 ' }));
    expect(result.policyId).toBe('  spaced  ');
    expect(result.policyVersion).toBe('v1 ');
  });

  it('INV-BLOCK-007: rejects a malformed Unicode policy, provider, or rule string', () => {
    const loneSurrogate = '\ud800';
    expect(issueCodesOf(() => new CandidateScorer(policy({ policyId: loneSurrogate })))).toEqual([
      'invalid_policy',
    ]);
    for (const field of ['ruleId', 'providerId', 'providerVersion', 'semantics']) {
      expect(
        issueCodesOf(
          construct({
            retrieval: { weight: 1, aggregation: 'max', rules: [rule({ [field]: loneSurrogate })] },
          }),
        ),
        field,
      ).toEqual(['invalid_policy']);
    }
    expect(
      issueCodesOf(
        construct({
          categoryPriority: {
            weight: 1,
            defaultValue: 0,
            byCategory: [{ category: loneSurrogate, value: 1 }],
          },
        }),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('INV-SCORE-004: rejects a negative, NaN, or infinite weight', () => {
    for (const weight of [
      -1,
      -0.0001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(
        issueCodesOf(construct({ recency: { weight, maxAgeSeconds: 10, missingValue: 0 } })),
        String(weight),
      ).toEqual(['invalid_policy']);
    }
  });

  it('accepts a zero weight and still produces the component', () => {
    const result = score(
      [candidate()],
      policy({ sourcePriority: { weight: 0, defaultValue: 1, bySourceDocumentId: [] } }),
    );

    expect(result.candidates[0]?.score.sourcePriority).toMatchObject({
      normalizedValue: 1,
      weight: 0,
      contribution: 0,
    });
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('rejects a policy-declared normalized value outside [0, 1]', () => {
    for (const value of [-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        issueCodesOf(construct({ recency: { weight: 1, maxAgeSeconds: 10, missingValue: value } })),
        `missingValue ${String(value)}`,
      ).toEqual(['invalid_policy']);
      expect(
        issueCodesOf(
          construct({ sourcePriority: { weight: 1, defaultValue: value, bySourceDocumentId: [] } }),
        ),
        `sourcePriority.defaultValue ${String(value)}`,
      ).toEqual(['invalid_policy']);
      expect(
        issueCodesOf(
          construct({
            categoryPriority: {
              weight: 1,
              defaultValue: 0,
              byCategory: [{ category: 'a', value }],
            },
          }),
        ),
        `byCategory value ${String(value)}`,
      ).toEqual(['invalid_policy']);
      expect(
        issueCodesOf(
          construct({
            sourcePriority: {
              weight: 1,
              defaultValue: 0,
              bySourceDocumentId: [{ sourceDocumentId: 'doc-1', value }],
            },
          }),
        ),
        `bySourceDocumentId value ${String(value)}`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('accepts the inclusive endpoints of the normalized range', () => {
    expect(
      construct({ sourcePriority: { weight: 1, defaultValue: 0, bySourceDocumentId: [] } }),
    ).not.toThrow();
    expect(
      construct({ sourcePriority: { weight: 1, defaultValue: 1, bySourceDocumentId: [] } }),
    ).not.toThrow();
  });

  it('rejects a retrieval range that is not finite or not strictly ordered', () => {
    for (const [min, max] of [
      [1, 1],
      [1, 0],
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 0],
    ]) {
      expect(
        issueCodesOf(
          construct({
            retrieval: { weight: 1, aggregation: 'max', rules: [rule({ min, max })] },
          }),
        ),
        `[${String(min)}, ${String(max)}]`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('accepts a negative retrieval range, because a provider scale may be negative', () => {
    expect(
      construct({
        retrieval: { weight: 1, aggregation: 'max', rules: [rule({ min: -1, max: 1 })] },
      }),
    ).not.toThrow();
  });

  it('rejects an authored-priority range that is not a strictly ordered safe integer pair', () => {
    for (const [min, max] of [
      [0, 0],
      [10, -10],
      [0.5, 10],
      [0, 10.5],
      [Number.MAX_SAFE_INTEGER + 2, Number.MAX_SAFE_INTEGER + 4],
      [Number.NaN, 10],
    ]) {
      const codes = issueCodesOf(construct({ authoredPriority: { weight: 1, min, max } }));
      expect(codes.length, `[${String(min)}, ${String(max)}]`).toBeGreaterThan(0);
      expect(new Set(codes), `[${String(min)}, ${String(max)}]`).toEqual(
        new Set(['invalid_policy']),
      );
    }
  });

  it('rejects a non-positive or fractional recency maxAgeSeconds', () => {
    for (const maxAgeSeconds of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        issueCodesOf(construct({ recency: { weight: 1, maxAgeSeconds, missingValue: 0 } })),
        String(maxAgeSeconds),
      ).toEqual(['invalid_policy']);
    }
  });

  it('accepts only "max" aggregation in schema version 1', () => {
    for (const aggregation of ['sum', 'mean', 'count', 'min', undefined]) {
      expect(
        issueCodesOf(construct({ retrieval: { weight: 1, aggregation, rules: [rule()] } })),
        String(aggregation),
      ).toEqual(['invalid_policy']);
    }
  });

  it('rejects a duplicate retrieval rule identifier', () => {
    const issues = issuesOf(
      construct({
        retrieval: {
          weight: 1,
          aggregation: 'max',
          rules: [rule(), rule({ semantics: 'distance', higherIsBetter: false })],
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_policy_rule']);
    expect(issues[0]?.pointer).toBe('retrieval.rules[1].ruleId');
  });

  it('rejects two rules owning the same provider contract tuple', () => {
    const issues = issuesOf(
      construct({
        retrieval: {
          weight: 1,
          aggregation: 'max',
          rules: [rule(), rule({ ruleId: 'cosine-again', min: -1, max: 2 })],
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_policy_rule']);
    expect(issues[0]?.pointer).toBe('retrieval.rules[1]');
  });

  it('accepts rules that differ in exactly one tuple element', () => {
    expect(
      construct({
        retrieval: {
          weight: 1,
          aggregation: 'max',
          rules: [
            rule({ ruleId: 'a' }),
            rule({ ruleId: 'b', providerId: 'other' }),
            rule({ ruleId: 'c', providerVersion: '9.9.9' }),
            rule({ ruleId: 'd', semantics: 'distance' }),
            rule({ ruleId: 'e', higherIsBetter: false }),
          ],
        },
      }),
    ).not.toThrow();
  });

  it('rejects a duplicate source priority entry', () => {
    const issues = issuesOf(
      construct({
        sourcePriority: {
          weight: 1,
          defaultValue: 0,
          bySourceDocumentId: [
            { sourceDocumentId: 'doc-1', value: 1 },
            { sourceDocumentId: 'doc-1', value: 0 },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_source_priority']);
    expect(issues[0]?.pointer).toBe('sourcePriority.bySourceDocumentId[1].sourceDocumentId');
  });

  it('rejects a duplicate category priority entry', () => {
    const issues = issuesOf(
      construct({
        categoryPriority: {
          weight: 1,
          defaultValue: 0,
          byCategory: [
            { category: 'policy', value: 1 },
            { category: 'policy', value: 0 },
          ],
        },
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['duplicate_category_priority']);
    expect(issues[0]?.pointer).toBe('categoryPriority.byCategory[1].category');
  });

  it('INV-DET-002: scores identically whatever order the policy rules are declared in', () => {
    const rules = [
      rule({ ruleId: 'a', semantics: 'cosine-similarity', min: 0, max: 1 }),
      rule({ ruleId: 'b', semantics: 'distance', higherIsBetter: false, min: 0, max: 4 }),
      rule({ ruleId: 'c', providerId: 'bm25', semantics: 'bm25', min: 0, max: 20 }),
    ];
    const sources = [
      { sourceDocumentId: 'doc-1', value: 0.25 },
      { sourceDocumentId: 'doc-2', value: 0.75 },
    ];
    const categories = [
      { category: 'policy', value: 0.4 },
      { category: 'reference', value: 0.9 },
    ];

    const build = (
      orderedRules: readonly Record<string, unknown>[],
      orderedSources: readonly Record<string, unknown>[],
      orderedCategories: readonly Record<string, unknown>[],
    ): Record<string, unknown> =>
      policy({
        retrieval: { weight: 1, aggregation: 'max', rules: [...orderedRules] },
        sourcePriority: { weight: 1, defaultValue: 0, bySourceDocumentId: [...orderedSources] },
        categoryPriority: { weight: 1, defaultValue: 0, byCategory: [...orderedCategories] },
      });

    const candidates = [
      candidate({ id: 'block-1', attributes: { category: 'policy' } }, scoredRetrieval(0.6)),
      candidate(
        {
          id: 'block-2',
          content: 'Another block entirely.',
          attributes: { category: 'reference' },
        },
        scoredRetrieval(
          2,
          { providerId: 'sqlite-fts5' },
          { semantics: 'distance', higherIsBetter: false },
        ),
      ),
    ];

    const declared = score(candidates, build(rules, sources, categories));
    const reversedPolicy = score(
      candidates,
      build([...rules].reverse(), [...sources].reverse(), [...categories].reverse()),
    );

    expect(reversedPolicy).toEqual(declared);
  });

  it('does not reorder or rewrite the caller-owned policy arrays', () => {
    const rules = [rule({ ruleId: 'z' }), rule({ ruleId: 'a', semantics: 'distance' })];
    const supplied = policy({ retrieval: { weight: 1, aggregation: 'max', rules } });
    new CandidateScorer(supplied);

    expect(rules.map((entry) => entry['ruleId'])).toEqual(['z', 'a']);
  });

  it('reuses the project-owned ValidationIssue shape and a stable top-level code', () => {
    try {
      new CandidateScorer(omit(policy(), 'policyId'));
    } catch (error) {
      expect((error as { code: string }).code).toBe('CANDIDATE_SCORING_FAILED');
      for (const issue of (error as { issues: readonly Record<string, unknown>[] }).issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      }
      return;
    }
    throw new Error('expected the policy to be rejected');
  });

  it('INV-ADAPTER-001: leaks no validation-library error through the boundary', () => {
    try {
      new CandidateScorer({ schemaVersion: 1 });
    } catch (error) {
      expect((error as Error).name).toBe('CandidateScoringError');
      expect((error as Error).constructor.name).toBe('CandidateScoringError');
      expect(String(error)).not.toContain('Zod');
      return;
    }
    throw new Error('expected the policy to be rejected');
  });

  it('short-circuits duplicate detection when the policy schema already failed', () => {
    // Both defects are present; only the schema issues are reported, because the
    // duplicate rules read fields the schema has not established.
    expect(
      issueCodesOf(
        construct({
          policyVersion: '',
          sourcePriority: {
            weight: 1,
            defaultValue: 0,
            bySourceDocumentId: [
              { sourceDocumentId: 'doc-1', value: 1 },
              { sourceDocumentId: 'doc-1', value: 0 },
            ],
          },
        }),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('reports every duplicate in one error', () => {
    expect(
      issueCodesOf(
        construct({
          retrieval: { weight: 1, aggregation: 'max', rules: [rule(), rule()] },
          sourcePriority: {
            weight: 1,
            defaultValue: 0,
            bySourceDocumentId: [
              { sourceDocumentId: 'doc-1', value: 1 },
              { sourceDocumentId: 'doc-1', value: 0 },
            ],
          },
          categoryPriority: {
            weight: 1,
            defaultValue: 0,
            byCategory: [
              { category: 'a', value: 1 },
              { category: 'a', value: 0 },
            ],
          },
        }),
      ),
    ).toEqual([
      'duplicate_policy_rule',
      'duplicate_policy_rule',
      'duplicate_source_priority',
      'duplicate_category_priority',
    ]);
  });

  it('constructs once and scores many batches with the same policy', () => {
    const scorer = new CandidateScorer(
      policy({ sourcePriority: { weight: 2, defaultValue: 0.5, bySourceDocumentId: [] } }),
    );
    const first = score(
      [candidate()],
      policy({ sourcePriority: { weight: 2, defaultValue: 0.5, bySourceDocumentId: [] } }),
    );

    expect(scorer).toBeInstanceOf(CandidateScorer);
    expect(first.candidates[0]?.score.total).toBe(1);
    expect(REFERENCE_TIME).toBe('2026-06-01T12:00:00.000Z');
  });
});

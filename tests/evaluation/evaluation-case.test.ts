import { EvaluationCaseValidationError, validateEvaluationCase } from '@ctxalloc/evaluation';
import { describe, expect, it } from 'vitest';
import {
  candidateBlock,
  compilationRequest,
  contextBlock,
  evaluationCase,
} from './evaluation-fixtures.js';

/**
 * Evaluation case validation, schema v1 (DEC-040, METRICS 4).
 *
 * A benchmark run against a broken answer key reports a number that means
 * nothing, so a case is proved all or nothing before anything is compiled: its
 * shape, its embedded `CompilationRequest` through the compiler's own validator,
 * and every cross-reference between its annotations and its candidate corpus.
 */

const BLOCK_A = contextBlock('blk:a', 'Alpha content.');
const BLOCK_B = contextBlock('blk:b', 'Beta content.', undefined, { startLine: 2 });

function baseCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...evaluationCase({
      request: compilationRequest({
        candidates: [candidateBlock(BLOCK_A), candidateBlock(BLOCK_B)],
      }),
    }),
    ...overrides,
  };
}

function codesOf(input: unknown): string[] {
  try {
    validateEvaluationCase(input);
  } catch (cause) {
    expect(cause).toBeInstanceOf(EvaluationCaseValidationError);
    return (cause as EvaluationCaseValidationError).issues.map((issue) => issue.code);
  }
  throw new Error('expected a rejection');
}

describe('evaluation case: strict schema', () => {
  it('accepts a well-formed case and preserves it exactly', () => {
    const validated = validateEvaluationCase(baseCase());
    expect(validated.schemaVersion).toBe(1);
    expect(validated.id).toBe('case-1');
    expect(validated.datasetSplit).toBe('development');
    expect(validated.compilationRequest.candidates).toHaveLength(2);
    expect(validated.expectedCompilationFailure).toBeUndefined();
  });

  it('rejects an unknown field rather than stripping it', () => {
    expect(codesOf(baseCase({ notes: 'extra' }))).toEqual(['invalid_case']);
  });

  it('rejects a missing field rather than defaulting it', () => {
    const partial = baseCase();
    delete partial.tags;
    expect(codesOf(partial)).toEqual(['invalid_case']);
  });

  it('rejects a wrong schema version and an unknown split', () => {
    expect(codesOf(baseCase({ schemaVersion: 2 }))).toEqual(['invalid_case']);
    expect(codesOf(baseCase({ datasetSplit: 'production' }))).toEqual(['invalid_case']);
  });

  it('coerces nothing: a numeric weight string stays invalid', () => {
    expect(
      codesOf(
        baseCase({
          answerCriteria: [
            { kind: 'exact', id: 'c1', weight: '2', expected: 'x', caseSensitive: true },
          ],
        }),
      ),
    ).toEqual(['invalid_case']);
  });
});

describe('evaluation case: the compilation request is embedded whole', () => {
  it('validates the request through the compiler and re-addresses its issues', () => {
    // The corrected METRICS 4 contract: no second, partial request schema exists,
    // so a request missing `referenceTime` fails the compiler's own rule.
    const request = compilationRequest({ candidates: [candidateBlock(BLOCK_A)] });
    delete request.referenceTime;
    const codes = codesOf(evaluationCase({ request }));
    expect(codes).toEqual(['invalid_compilation_request']);
  });

  it('keeps the case identifier and the request identifier independent', () => {
    const validated = validateEvaluationCase(
      baseCase({
        id: 'case-named-differently',
        compilationRequest: compilationRequest({
          id: 'request-named-differently',
          candidates: [candidateBlock(BLOCK_A)],
        }),
      }),
    );
    expect(validated.id).toBe('case-named-differently');
    expect(validated.compilationRequest.id).toBe('request-named-differently');
  });

  it('carries the whole request through: scope, query, time, budget, and policy', () => {
    const validated = validateEvaluationCase(baseCase());
    const request = validated.compilationRequest;
    expect(request.scope.tenantId).toBe('eval');
    expect(request.query).toBe('What does the note say?');
    expect(request.referenceTime).toBe('2026-06-01T12:00:00.000Z');
    expect(request.budget.totalTokens).toBe(400);
    expect(request.policy.policyId).toBe('eval-tests');
  });
});

describe('evaluation case: required facts', () => {
  const fact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'fact:1',
    description: 'Alpha is stated.',
    importance: 'critical',
    evidenceBlockGroups: [['blk:a']],
    acceptableEvidence: ['alpha'],
    ...overrides,
  });

  it('accepts OR-of-AND evidence groups', () => {
    const validated = validateEvaluationCase(
      baseCase({
        requiredFacts: [fact({ evidenceBlockGroups: [['blk:a', 'blk:b'], ['blk:b']] })],
      }),
    );
    expect(validated.requiredFacts[0]?.evidenceBlockGroups).toEqual([
      ['blk:a', 'blk:b'],
      ['blk:b'],
    ]);
  });

  it('rejects a duplicate fact identifier', () => {
    expect(codesOf(baseCase({ requiredFacts: [fact(), fact()] }))).toEqual(['duplicate_fact_id']);
  });

  it('rejects an empty group list and an empty group', () => {
    expect(codesOf(baseCase({ requiredFacts: [fact({ evidenceBlockGroups: [] })] }))).toEqual([
      'invalid_case',
    ]);
    expect(codesOf(baseCase({ requiredFacts: [fact({ evidenceBlockGroups: [[]] })] }))).toEqual([
      'invalid_case',
    ]);
  });

  it('rejects a repeated block inside one group', () => {
    expect(
      codesOf(baseCase({ requiredFacts: [fact({ evidenceBlockGroups: [['blk:a', 'blk:a']] })] })),
    ).toEqual(['duplicate_evidence_block']);
  });

  it('rejects two groups that are equal after canonical ordering', () => {
    // `[a, b]` and `[b, a]` name one conjunction; keeping both would count one
    // alternative twice.
    expect(
      codesOf(
        baseCase({
          requiredFacts: [
            fact({
              evidenceBlockGroups: [
                ['blk:a', 'blk:b'],
                ['blk:b', 'blk:a'],
              ],
            }),
          ],
        }),
      ),
    ).toEqual(['duplicate_evidence_group']);
  });

  it('rejects evidence naming a block the case does not contain', () => {
    expect(
      codesOf(baseCase({ requiredFacts: [fact({ evidenceBlockGroups: [['blk:absent']] })] })),
    ).toEqual(['unknown_block_id']);
  });

  it('rejects a blank description or a blank acceptable-evidence entry', () => {
    expect(codesOf(baseCase({ requiredFacts: [fact({ description: '  ' })] }))).toEqual([
      'invalid_case',
    ]);
    expect(codesOf(baseCase({ requiredFacts: [fact({ acceptableEvidence: [''] })] }))).toEqual([
      'invalid_case',
    ]);
  });
});

describe('evaluation case: answer criteria', () => {
  it('accepts all four kinds', () => {
    const validated = validateEvaluationCase(
      baseCase({
        answerCriteria: [
          { kind: 'exact', id: 'c1', weight: 1, expected: 'x', caseSensitive: true },
          { kind: 'contains-all', id: 'c2', weight: 2, expected: ['a', 'b'], caseSensitive: false },
          { kind: 'contains-any', id: 'c3', weight: 3, expected: ['a'], caseSensitive: true },
          { kind: 'not-contains', id: 'c4', weight: 1, forbidden: ['z'], caseSensitive: false },
        ],
      }),
    );
    expect(validated.answerCriteria.map((criterion) => criterion.kind)).toEqual([
      'exact',
      'contains-all',
      'contains-any',
      'not-contains',
    ]);
  });

  it('rejects a duplicate criterion identifier', () => {
    expect(
      codesOf(
        baseCase({
          answerCriteria: [
            { kind: 'exact', id: 'c1', weight: 1, expected: 'x', caseSensitive: true },
            { kind: 'contains-any', id: 'c1', weight: 1, expected: ['y'], caseSensitive: true },
          ],
        }),
      ),
    ).toEqual(['duplicate_criterion_id']);
  });

  it('rejects a repeated value inside one criterion', () => {
    expect(
      codesOf(
        baseCase({
          answerCriteria: [
            {
              kind: 'contains-all',
              id: 'c1',
              weight: 1,
              expected: ['a', 'a'],
              caseSensitive: true,
            },
          ],
        }),
      ),
    ).toEqual(['invalid_case']);
  });

  it('rejects a blank expected value, an empty list, and a non-positive weight', () => {
    for (const criteria of [
      [{ kind: 'exact', id: 'c1', weight: 1, expected: '   ', caseSensitive: true }],
      [{ kind: 'contains-all', id: 'c1', weight: 1, expected: [], caseSensitive: true }],
      [{ kind: 'exact', id: 'c1', weight: 0, expected: 'x', caseSensitive: true }],
      [{ kind: 'exact', id: 'c1', weight: 1.5, expected: 'x', caseSensitive: true }],
    ]) {
      expect(codesOf(baseCase({ answerCriteria: criteria }))).toEqual(['invalid_case']);
    }
  });

  it('rejects a regular expression kind, which v1 does not have', () => {
    expect(
      codesOf(
        baseCase({
          answerCriteria: [
            { kind: 'regex', id: 'c1', weight: 1, expected: '.*', caseSensitive: true },
          ],
        }),
      ),
    ).toEqual(['invalid_case']);
  });
});

describe('evaluation case: annotation cross-references', () => {
  it('rejects an annotation naming a block outside the candidate corpus', () => {
    expect(codesOf(baseCase({ requiredBlockIds: ['blk:absent'] }))).toEqual(['unknown_block_id']);
    expect(codesOf(baseCase({ relevantBlockIds: ['blk:absent'] }))).toEqual(['unknown_block_id']);
    expect(codesOf(baseCase({ irrelevantBlockIds: ['blk:absent'] }))).toEqual(['unknown_block_id']);
  });

  it('rejects a repeated annotation', () => {
    expect(codesOf(baseCase({ requiredBlockIds: ['blk:a', 'blk:a'] }))).toEqual([
      'duplicate_annotation_block_id',
    ]);
  });

  it('rejects a block annotated as both wanted and unwanted', () => {
    // Two metrics would otherwise disagree about the same block.
    expect(
      codesOf(baseCase({ requiredBlockIds: ['blk:a'], irrelevantBlockIds: ['blk:a'] })),
    ).toEqual(['conflicting_annotation']);
    expect(
      codesOf(baseCase({ relevantBlockIds: ['blk:b'], irrelevantBlockIds: ['blk:b'] })),
    ).toEqual(['conflicting_annotation']);
  });

  it('accepts an expected compilation failure with a stage and an issue code', () => {
    const validated = validateEvaluationCase(
      baseCase({
        expectedCompilationFailure: {
          stage: 'allocation',
          issueCode: 'required_content_exceeds_budget',
        },
      }),
    );
    expect(validated.expectedCompilationFailure).toEqual({
      stage: 'allocation',
      issueCode: 'required_content_exceeds_budget',
    });
  });

  it('rejects an expected failure with an unknown field or a blank code', () => {
    expect(
      codesOf(
        baseCase({
          expectedCompilationFailure: { stage: 'allocation', issueCode: 'x', message: 'why' },
        }),
      ),
    ).toEqual(['invalid_case']);
    expect(
      codesOf(baseCase({ expectedCompilationFailure: { stage: 'allocation', issueCode: '  ' } })),
    ).toEqual(['invalid_case']);
  });
});

describe('evaluation case: error privacy', () => {
  it('never quotes case content in a validation message', () => {
    const secret = 'TOP-SECRET-SOURCE-CONTENT';
    const block = contextBlock('blk:secret', secret);
    const codes = codesOf(
      evaluationCase({
        request: compilationRequest({ candidates: [candidateBlock(block)] }),
        requiredBlockIds: ['blk:absent'],
      }),
    );
    expect(codes).toEqual(['unknown_block_id']);

    try {
      validateEvaluationCase(
        evaluationCase({
          request: compilationRequest({ candidates: [candidateBlock(block)] }),
          requiredBlockIds: ['blk:absent'],
        }),
      );
    } catch (cause) {
      const error = cause as EvaluationCaseValidationError;
      const serialized = `${error.message} ${JSON.stringify(error.issues)}`;
      expect(serialized).not.toContain(secret);
    }
  });
});

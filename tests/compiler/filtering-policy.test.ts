import { CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION, CandidateFilter } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { filteringPolicy, issueCodesOf, issuesOf, omit, scoreSpecs } from './filtering-fixtures.js';

/**
 * Filtering policy validation (DEC-036).
 *
 * A policy is external configuration, so the constructor is a runtime boundary:
 * unknown fields are rejected rather than stripped, nothing is coerced, and no
 * default — least of all a default threshold — is injected.
 */
describe('CandidateFilter policy validation', () => {
  it('publishes the schema version of the policy it accepts', () => {
    expect(CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a no-op policy that configures no threshold', () => {
    expect(() => new CandidateFilter(filteringPolicy())).not.toThrow();
  });

  it('accepts a threshold of exactly zero', () => {
    expect(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: 0 }))).not.toThrow();
  });

  it('accepts a positive fractional threshold', () => {
    expect(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.125 }))).not.toThrow();
  });

  it('accepts a threshold above the range any normalized component can reach', () => {
    // The total is policy-relative: weights need not sum to one, so no upper
    // bound is knowable here and none is invented.
    expect(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: 1000 }))).not.toThrow();
  });

  it('rejects a schema version other than 1', () => {
    for (const schemaVersion of [0, 2, '1', 1.5]) {
      expect(issueCodesOf(() => new CandidateFilter(filteringPolicy({ schemaVersion })))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a missing schema version, identifier, or version', () => {
    for (const field of ['schemaVersion', 'policyId', 'policyVersion']) {
      expect(issueCodesOf(() => new CandidateFilter(omit(filteringPolicy(), field)))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a blank or whitespace-only identity', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(issuesOf(() => new CandidateFilter(filteringPolicy({ policyId: blank })))[0]).toEqual({
        code: 'invalid_policy',
        path: ['policyId'],
        pointer: 'policyId',
        message: 'must not be empty or whitespace-only',
      });
      expect(
        issuesOf(() => new CandidateFilter(filteringPolicy({ policyVersion: blank })))[0]?.pointer,
      ).toBe('policyVersion');
    }
  });

  it('INV-BLOCK-007: rejects a malformed UTF-16 identity', () => {
    const loneSurrogate = '\uD800';
    expect(
      issuesOf(() => new CandidateFilter(filteringPolicy({ policyId: loneSurrogate })))[0],
    ).toEqual({
      code: 'invalid_policy',
      path: ['policyId'],
      pointer: 'policyId',
      message: 'must be well-formed UTF-16',
    });
    expect(
      issuesOf(() => new CandidateFilter(filteringPolicy({ policyVersion: loneSurrogate })))[0]
        ?.message,
    ).toBe('must be well-formed UTF-16');
  });

  it('preserves an exact identity without trimming or rewriting it', () => {
    const policy = filteringPolicy({ policyId: ' Spaced Id ', policyVersion: '1.0.0-RC.1' });
    const result = new CandidateFilter(policy).filter(scoreSpecs([]));
    expect(result.filteringPolicyId).toBe(' Spaced Id ');
    expect(result.filteringPolicyVersion).toBe('1.0.0-RC.1');
  });

  it('rejects a negative threshold', () => {
    expect(
      issuesOf(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: -1 })))[0],
    ).toEqual({
      code: 'invalid_policy',
      path: ['minimumTotalScore'],
      pointer: 'minimumTotalScore',
      message: 'must be a finite number greater than or equal to 0',
    });
    expect(
      issueCodesOf(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: -0.0001 }))),
    ).toEqual(['invalid_policy']);
  });

  it('INV-SCORE-004: rejects a threshold that is not a usable number', () => {
    for (const unusable of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        issueCodesOf(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: unusable }))),
      ).toEqual(['invalid_policy']);
    }
  });

  it('coerces nothing: a numeric string threshold is rejected, not parsed', () => {
    for (const coercible of ['0', '0.5', true, null, [], {}]) {
      expect(
        issueCodesOf(() => new CandidateFilter(filteringPolicy({ minimumTotalScore: coercible }))),
      ).toEqual(['invalid_policy']);
    }
  });

  it('rejects an unknown field rather than stripping it', () => {
    for (const unknown of [
      { excludedBlockIds: [] },
      { deniedSourceDocumentIds: [] },
      { allowedCategories: [] },
      { maxAgeSeconds: 60 },
      { minimumRetrievalRank: 1 },
      { maxTokens: 100 },
      { pattern: '^a' },
      { minimumScore: 0.5 },
    ]) {
      expect(issueCodesOf(() => new CandidateFilter(filteringPolicy(unknown)))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a policy that is not an object at all', () => {
    for (const invalid of [null, undefined, 1, 'policy', [], true]) {
      expect(issueCodesOf(() => new CandidateFilter(invalid))).toEqual(['invalid_policy']);
    }
  });

  it('publishes a stable top-level error code', () => {
    try {
      new CandidateFilter({});
    } catch (error) {
      expect((error as { code: string }).code).toBe('CANDIDATE_FILTERING_FAILED');
      expect(error).toBeInstanceOf(Error);
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('INV-ADAPTER-001: reuses the project-owned ValidationIssue shape', () => {
    for (const issue of issuesOf(
      () => new CandidateFilter(filteringPolicy({ minimumTotalScore: -1 })),
    )) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });
});

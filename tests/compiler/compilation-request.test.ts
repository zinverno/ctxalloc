import {
  COMPILATION_REQUEST_SCHEMA_VERSION,
  CandidateValidator,
  CompilationRequestValidator,
  type CandidateValidationError,
  type CompilationRequest,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { compilationPolicy } from './compilation-fixtures.js';
import { candidateOf, issueCodesOf, issuesOf, omit } from './filtering-fixtures.js';
import { SCOPE, sourceDocument, wordTokenizer } from './fixtures.js';

/**
 * The compilation request (DEC-036).
 *
 * Validation is structural: it proves the record is a well-formed request of
 * well-formed domain values. `CandidateValidator` remains the semantic and
 * cross-record trust boundary.
 */

const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-1',
    schemaVersion: 1,
    scope: { ...SCOPE },
    query: 'how does allocation work?',
    referenceTime: REFERENCE_TIME,
    candidates: [candidateOf({ id: 'block-1', tokens: 4 })],
    sourceDocuments: [sourceDocument()],
    budget: { totalTokens: 100, reservedOutputTokens: 10 },
    policy: compilationPolicy(),
    ...overrides,
  };
}

const validator = new CompilationRequestValidator();

/** Every issue of a rejected request, proving all of them address the request. */
function requestIssueCodes(run: () => unknown): readonly string[] {
  const codes = issueCodesOf(run);
  expect(codes.length).toBeGreaterThan(0);
  return [...new Set(codes)];
}

describe('CompilationRequest shape', () => {
  it('publishes the schema version it accepts', () => {
    expect(COMPILATION_REQUEST_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a complete request and returns every field unchanged', () => {
    const input = request();
    const parsed: CompilationRequest = validator.validate(input);

    expect(parsed).toEqual(input);
    expect(Object.keys(parsed).sort()).toEqual([
      'budget',
      'candidates',
      'id',
      'policy',
      'query',
      'referenceTime',
      'schemaVersion',
      'scope',
      'sourceDocuments',
    ]);
  });

  it('accepts a minimal request with empty candidate and source arrays and an empty query', () => {
    const parsed = validator.validate(request({ query: '', candidates: [], sourceDocuments: [] }));

    expect(parsed.query).toBe('');
    expect(parsed.candidates).toEqual([]);
    expect(parsed.sourceDocuments).toEqual([]);
  });

  it('rejects a request that is not an object', () => {
    for (const invalid of [null, undefined, 1, 'request', [], true]) {
      expect(issueCodesOf(() => validator.validate(invalid))).toEqual(['invalid_request']);
    }
  });

  it('rejects a missing required field', () => {
    for (const field of [
      'id',
      'schemaVersion',
      'scope',
      'query',
      'referenceTime',
      'candidates',
      'sourceDocuments',
      'budget',
      'policy',
    ]) {
      expect(
        issueCodesOf(() => validator.validate(omit(request(), field))),
        `missing ${field}`,
      ).toEqual(['invalid_request']);
    }
  });

  it('rejects an unknown top-level field rather than stripping it', () => {
    for (const unknown of [
      { trace: {} },
      { fingerprint: 'abc' },
      { compilationId: 'x' },
      { warnings: [] },
      { tokenizer: {} },
      { result: {} },
    ]) {
      expect(issueCodesOf(() => validator.validate(request(unknown)))).toEqual(['invalid_request']);
    }
  });

  it('rejects a schema version other than 1', () => {
    for (const schemaVersion of [0, 2, '1', null]) {
      expect(issueCodesOf(() => validator.validate(request({ schemaVersion })))).toEqual([
        'invalid_request',
      ]);
    }
  });

  it('INV-SCOPE-001: rejects an absent or blank scope', () => {
    expect(requestIssueCodes(() => validator.validate(request({ scope: {} })))).toEqual([
      'invalid_request',
    ]);
    expect(
      issuesOf(() => validator.validate(request({ scope: { tenantId: ' ', workspaceId: 'w' } })))[0]
        ?.pointer,
    ).toBe('scope.tenantId');
  });

  it('publishes a stable top-level error code', () => {
    try {
      validator.validate({});
    } catch (error) {
      expect((error as { code: string }).code).toBe('COMPILATION_REQUEST_INVALID');
      return;
    }
    throw new Error('expected the empty request to be rejected');
  });

  it('INV-ALLOC-004: does not mutate the supplied input', () => {
    const input = request();
    const before = structuredClone(input);
    validator.validate(input);
    expect(input).toEqual(before);
  });

  it('INV-ADAPTER-001: reuses the project-owned ValidationIssue shape', () => {
    for (const issue of issuesOf(() => validator.validate(request({ id: '' })))) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });
});

describe('INV-DET-003: CompilationRequest identifiers are caller-supplied', () => {
  it('preserves the caller identifier exactly', () => {
    for (const id of ['req-1', ' padded ', 'ID with spaces', '🙂-request']) {
      expect(validator.validate(request({ id })).id).toBe(id);
    }
  });

  it('rejects a blank identifier rather than generating one', () => {
    for (const blank of ['', '   ', '\t']) {
      expect(issuesOf(() => validator.validate(request({ id: blank })))[0]).toEqual({
        code: 'invalid_request',
        path: ['id'],
        pointer: 'id',
        message: 'must not be empty or whitespace-only',
      });
    }
  });

  it('rejects an identifier that is not a string', () => {
    for (const invalid of [1, null, {}, []]) {
      expect(issueCodesOf(() => validator.validate(request({ id: invalid })))).toEqual([
        'invalid_request',
      ]);
    }
  });

  it('INV-BLOCK-007: rejects a malformed UTF-16 identifier', () => {
    expect(issuesOf(() => validator.validate(request({ id: 'req-\uD800' })))[0]?.message).toBe(
      'must be well-formed UTF-16',
    );
  });

  it('generates no identifier of its own: two identical requests stay identical', () => {
    expect(validator.validate(request())).toEqual(validator.validate(request()));
  });
});

describe('CompilationRequest query', () => {
  it('accepts and preserves an empty query', () => {
    expect(validator.validate(request({ query: '' })).query).toBe('');
  });

  it('accepts and preserves a whitespace-only query without trimming it', () => {
    for (const blank of [' ', '   ', '\t', '\n\n']) {
      expect(validator.validate(request({ query: blank })).query).toBe(blank);
    }
  });

  it('preserves a multi-line query exactly', () => {
    const query = 'first line\n  indented second\r\nthird\n';
    expect(validator.validate(request({ query })).query).toBe(query);
  });

  it('normalizes nothing: Unicode, emoji, and combining marks survive byte for byte', () => {
    for (const query of ['é', 'é', '🙂👨‍👩‍👧', 'ＦＵＬＬＷＩＤＴＨ']) {
      expect(validator.validate(request({ query })).query).toBe(query);
    }
  });

  it('INV-BLOCK-007: rejects a malformed UTF-16 query', () => {
    expect(issuesOf(() => validator.validate(request({ query: 'a\uDFFF' })))[0]).toEqual({
      code: 'invalid_request',
      path: ['query'],
      pointer: 'query',
      message: 'must be well-formed UTF-16',
    });
  });

  it('rejects a query that is not a string', () => {
    for (const invalid of [null, 1, [], {}]) {
      expect(issueCodesOf(() => validator.validate(request({ query: invalid })))).toEqual([
        'invalid_request',
      ]);
    }
  });
});

describe('INV-DET-004: CompilationRequest requires an explicit reference time', () => {
  it('requires referenceTime', () => {
    expect(issuesOf(() => validator.validate(omit(request(), 'referenceTime')))[0]?.pointer).toBe(
      'referenceTime',
    );
  });

  it('preserves the exact instant', () => {
    for (const referenceTime of [
      '2026-06-01T12:00:00.000Z',
      '2026-06-01T12:00:00Z',
      '1970-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999999999Z',
    ]) {
      expect(validator.validate(request({ referenceTime })).referenceTime).toBe(referenceTime);
    }
  });

  it('applies the existing Timestamp contract', () => {
    for (const invalid of [
      '2026-06-01T12:00:00',
      '2026-06-01 12:00:00Z',
      '2026-02-31T00:00:00.000Z',
      '2026-06-01T12:00:00+02:00',
      1_780_000_000_000,
      new Date('2026-06-01T12:00:00.000Z'),
      null,
    ]) {
      expect(
        requestIssueCodes(() => validator.validate(request({ referenceTime: invalid }))),
        `accepted ${String(invalid)}`,
      ).toEqual(['invalid_request']);
    }
  });

  it('reads no clock: it defaults no reference time and injects none', () => {
    const parsed = validator.validate(request({ referenceTime: '1999-01-01T00:00:00.000Z' }));
    expect(parsed.referenceTime).toBe('1999-01-01T00:00:00.000Z');
    // A validator that consulted the clock would disagree with itself over time.
    expect(validator.validate(request()).referenceTime).toBe(REFERENCE_TIME);
  });
});

describe('INV-BUDGET-005: CompilationRequest budget validation', () => {
  it('accepts the existing TokenBudget shape and keeps omitted reserves omitted', () => {
    const parsed = validator.validate(
      request({ budget: { totalTokens: 100, reservedOutputTokens: 10 } }),
    );

    expect(parsed.budget).toEqual({ totalTokens: 100, reservedOutputTokens: 10 });
    expect(Object.keys(parsed.budget)).not.toContain('reservedSystemTokens');
  });

  it('preserves every configured reserve exactly', () => {
    const budget = {
      totalTokens: 1000,
      reservedOutputTokens: 100,
      reservedSystemTokens: 50,
      reservedToolTokens: 25,
      reservedProtocolTokens: 5,
    };
    expect(validator.validate(request({ budget })).budget).toEqual(budget);
  });

  it('rejects an impossible budget, a fractional amount, and a coercible string', () => {
    for (const budget of [
      { totalTokens: 10, reservedOutputTokens: 20 },
      { totalTokens: 10.5, reservedOutputTokens: 1 },
      { totalTokens: '100', reservedOutputTokens: 10 },
      { totalTokens: 100 },
      { totalTokens: 100, reservedOutputTokens: -1 },
      { totalTokens: 100, reservedOutputTokens: 10, unknownReserve: 1 },
    ]) {
      expect(requestIssueCodes(() => validator.validate(request({ budget })))).toEqual([
        'invalid_request',
      ]);
    }
  });

  it('guesses no context window and adds no hidden reserve', () => {
    const parsed = validator.validate(
      request({ budget: { totalTokens: 100, reservedOutputTokens: 0 } }),
    );
    expect(parsed.budget).toEqual({ totalTokens: 100, reservedOutputTokens: 0 });
  });
});

describe('CompilationRequest policy composition', () => {
  it('reports a nested policy failure under the policy pointer', () => {
    const issues = issuesOf(() =>
      validator.validate(
        request({
          policy: compilationPolicy({
            filtering: {
              schemaVersion: 1,
              policyId: 'filtering',
              policyVersion: '1.0.0',
              minimumTotalScore: -1,
            },
          }),
        }),
      ),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('invalid_filtering_policy');
    expect(issues[0]?.pointer).toBe('policy.filtering.minimumTotalScore');
  });

  it('leaks no nested error object', () => {
    for (const issue of issuesOf(() => validator.validate(request({ policy: {} })))) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });

  it('rejects a policy that is not an object under the request pointer', () => {
    for (const invalid of [null, 1, 'policy', []]) {
      const issues = issuesOf(() => validator.validate(request({ policy: invalid })));
      expect(issues[0]?.code).toBe('invalid_request');
      expect(issues[0]?.pointer).toBe('policy');
    }
  });

  it('short-circuits policy validation when the request shape is malformed', () => {
    const issues = issuesOf(() =>
      validator.validate({ ...request({ id: '' }), policy: compilationPolicy({ ordering: {} }) }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['invalid_request']);
  });

  it('returns the validated policy with every slice intact', () => {
    const parsed = validator.validate(request());
    expect(parsed.policy.scoring.policyVersion).toBe('2.0.0');
    expect(parsed.policy.filtering.minimumTotalScore).toBe(0.25);
    expect(parsed.policy.allocation.optionalSelection).toBe('score-desc-greedy');
    expect(parsed.policy.ordering.strategy).toBe('source-document-then-location');
    expect(parsed.policy.rendering.format).toBe('jsonl-blocks');
  });
});

/**
 * INV-DEP-003: request validation is structural; `CandidateValidator` remains the
 * semantic and cross-record trust boundary (DEC-030, DEC-036).
 */
describe('CompilationRequest is not a CandidateValidator replacement', () => {
  function candidateValidationIssues(parsed: CompilationRequest): readonly string[] {
    try {
      new CandidateValidator(wordTokenizer).validate({
        scope: parsed.scope,
        sourceDocuments: parsed.sourceDocuments,
        candidates: parsed.candidates,
      });
    } catch (error) {
      return (error as CandidateValidationError).issues.map((issue) => issue.code);
    }
    return [];
  }

  it('accepts a stale token count that CandidateValidator then rejects', () => {
    const parsed = validator.validate(
      request({ candidates: [candidateOf({ id: 'block-1', tokens: 4 })] }),
    );
    const stale = validator.validate(
      request({
        candidates: [
          {
            ...(candidateOf({ id: 'block-1', tokens: 4 }) as Record<string, unknown>),
            block: {
              ...(candidateOf({ id: 'block-1', tokens: 4 }) as { block: Record<string, unknown> })
                .block,
              tokenCount: 999,
            },
          },
        ],
      }),
    );

    expect(candidateValidationIssues(parsed)).toEqual([]);
    expect(candidateValidationIssues(stale)).toEqual(['invalid_token_count']);
  });

  it('accepts a block whose source is not in the registry, which CandidateValidator rejects', () => {
    const parsed = validator.validate(
      request({ candidates: [candidateOf({ id: 'block-1', sourceDocumentId: 'missing-doc' })] }),
    );

    expect(parsed.candidates).toHaveLength(1);
    expect(candidateValidationIssues(parsed)).toEqual(['source_not_found']);
  });

  it('accepts a duplicated source identifier, which CandidateValidator rejects', () => {
    const parsed = validator.validate(
      request({ sourceDocuments: [sourceDocument(), sourceDocument()] }),
    );

    expect(parsed.sourceDocuments).toHaveLength(2);
    expect(candidateValidationIssues(parsed)).toContain('duplicate_source_document_id');
  });

  it('accepts a cross-scope candidate, which CandidateValidator rejects', () => {
    const parsed = validator.validate(
      request({
        candidates: [
          {
            ...(candidateOf({ id: 'block-1' }) as Record<string, unknown>),
            block: {
              ...(candidateOf({ id: 'block-1' }) as { block: Record<string, unknown> }).block,
              scope: { tenantId: 'other', workspaceId: 'other' },
            },
          },
        ],
      }),
    );

    expect(candidateValidationIssues(parsed)).toContain('scope_mismatch');
  });

  it('still rejects a structurally malformed candidate itself', () => {
    expect(
      requestIssueCodes(() => validator.validate(request({ candidates: [{ schemaVersion: 1 }] }))),
    ).toEqual(['invalid_request']);
    expect(
      requestIssueCodes(() => validator.validate(request({ sourceDocuments: [{ id: 'doc-1' }] }))),
    ).toEqual(['invalid_request']);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CandidateDeduplicator,
  CandidateEvidenceError,
  CandidateFilter,
  CandidateScorer,
  CompilationPolicyValidator,
  CompilationRequestValidator,
  ContextCompilationError,
  ContextCompiler,
  SettledCompilationTraceValidator,
} from '@ctxalloc/compiler';
import { measureCorrectness } from '../../benchmarks/acceptance/correctness.js';
import { candidate, SCOPE } from './fixtures.js';
import {
  compilerConfig,
  compilerPolicy,
  requestInput,
  wordTokenizer,
} from './compiler-fixtures.js';
import { deduplicateCandidates, REFERENCE_TIME, issuesOf } from './scoring-fixtures.js';
import { toApiError } from '../../apps/api/src/errors.js';

const provider = {
  providerId: 'evidence-test',
  providerVersion: '1',
  semantics: 'synthetic-grade',
  higherIsBetter: true,
};
const ignored = { ...provider, providerId: 'ignored-test' };
const signal = (value: number, contract = provider) => ({
  providerId: contract.providerId,
  providerVersion: contract.providerVersion,
  score: { value, semantics: contract.semantics, higherIsBetter: contract.higherIsBetter },
});
type State = 'complete' | 'incomplete';
interface Options {
  state?: State;
  retrieval?: boolean;
  retrievalState?: State;
  retrievalWeight?: number;
  ignore?: boolean;
  action?: 'admit' | 'reject';
  minimum?: number | null;
  scope?: typeof SCOPE | { tenantId: string; workspaceId: string };
  applicability?: unknown;
}
function scoring(o: Options = {}) {
  return {
    schemaVersion: 2,
    policyId: 'test-evidence:score',
    policyVersion: '1',
    authoredPriority: { weight: 1, min: 0, max: 4 },
    ...(o.retrieval
      ? {
          retrieval: {
            weight: o.retrievalWeight ?? 1,
            aggregation: 'max',
            rules: [{ ruleId: 'test-rule', ...provider, min: 0, max: 4 }],
          },
        }
      : {}),
    compatibility: { ignoredRetrievalContracts: o.ignore ? [ignored] : [] },
    evidence: {
      scope: o.scope ?? SCOPE,
      completeness: [
        { component: 'authoredPriority', state: o.state ?? 'complete' },
        ...(o.retrieval ? [{ component: 'retrieval', state: o.retrievalState ?? 'complete' }] : []),
      ],
    },
  };
}
function filtering(o: Options = {}) {
  return {
    schemaVersion: 3,
    policyId: 'test-evidence:admission',
    policyVersion: '1',
    onIncompleteEvidence: o.action ?? 'admit',
    ...(o.minimum === null ? {} : { minimumTotalScore: o.minimum ?? 0.5 }),
    ...(o.applicability === undefined ? {} : { applicability: o.applicability }),
  };
}
function request(
  candidates: readonly Record<string, unknown>[],
  o: Options = {},
  available = 1000,
) {
  return requestInput({
    candidates,
    available,
    policy: compilerPolicy({
      policyId: 'test-evidence',
      policyVersion: '1',
      scoring: scoring(o),
      filtering: filtering(o),
    }),
  });
}
const compiler = () => new ContextCompiler(compilerConfig(), wordTokenizer);
function failure(input: unknown): ContextCompilationError {
  try {
    compiler().compile(input);
  } catch (error) {
    if (error instanceof ContextCompilationError) return error;
    throw error;
  }
  throw new Error('Expected a structured compilation failure.');
}
const block = (id: string, priority?: number, required = false) =>
  candidate({
    id,
    content: `specimen ${id}`,
    attributes: {
      ...(priority === undefined ? {} : { priority }),
      ...(required ? { required } : {}),
    },
  });
afterEach(() => vi.restoreAllMocks());

describe('DEC-045 / INV-SCORE-002: exact compatibility and deterministic preflight', () => {
  it('rejects uncovered evidence before scoring or deduplication only for the opt-in contract', () => {
    const scored = vi.spyOn(CandidateScorer.prototype, 'score');
    const dedup = vi.spyOn(CandidateDeduplicator.prototype, 'deduplicate');
    const candidates = [candidate({ attributes: { priority: 4 } }, signal(2))];
    const error = failure(request(candidates));
    expect(error.stage).toBe('evidence-validation');
    expect(error.issues[0]?.code).toBe('retrieval_score_rule_not_found');
    expect(scored).not.toHaveBeenCalled();
    expect(dedup).not.toHaveBeenCalled();
    const old = requestInput({
      candidates,
      policy: compilerPolicy({
        scoring: {
          schemaVersion: 1,
          policyId: 'legacy',
          policyVersion: '1',
          authoredPriority: { weight: 1, min: 0, max: 4 },
        },
      }),
    });
    expect(failure(old).stage).toBe('scoring');
  });
  it('lets a caller run preflight without producing any scores', () => {
    const c = new CandidateScorer(scoring());
    const input = new CompilationRequestValidator().validate(request([candidate({}, signal(2))]));
    const before = JSON.stringify(input);
    expect(() => c.validateEvidence(input)).toThrow(CandidateEvidenceError);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('reports stable preflight issues for candidate permutations', () => {
    const candidates = [candidate({ id: 'b' }, signal(2)), candidate({ id: 'a' }, signal(1))];
    const left = failure(request(candidates));
    const right = failure(request([...candidates].reverse()));
    expect(left.issues).toEqual(right.issues);
  });
  it('ignores only an explicitly listed contract, regardless of its finite magnitude', () => {
    const totals = [-100000, 0, 100000].map((value) => {
      const result = compiler().compile(
        request([candidate({ attributes: { priority: 2 } }, signal(value, ignored))], {
          ignore: true,
        }),
      );
      const score = result.trace.groups[0]!.score;
      expect(score.retrieval).toBeUndefined();
      expect(score.evidence?.ignoredRetrieval[0]?.rawValue).toBe(value);
      return score.total;
    });
    expect(totals).toEqual([0.5, 0.5, 0.5]);
  });
  it.each(['providerId', 'providerVersion', 'semantics', 'higherIsBetter'] as const)(
    'never broadens an ignore to another %s',
    (field) => {
      const different = { ...ignored, [field]: field === 'higherIsBetter' ? false : 'other' };
      expect(
        failure(request([candidate({}, signal(2, different))], { ignore: true })).issues[0]?.code,
      ).toBe('retrieval_score_rule_not_found');
    },
  );
  it('separates supported and ignored measurements in one duplicate group', () => {
    const a = candidate(
      { id: 'a', content: 'shared specimen', attributes: { priority: 2 } },
      signal(3),
    );
    const b = candidate({ id: 'b', content: 'shared specimen' }, signal(1000, ignored));
    const result = compiler().compile(request([a, b, b, b], { retrieval: true, ignore: true }));
    expect(result.trace.groups).toHaveLength(1);
    const g = result.trace.groups[0]!;
    expect(g.score.total).toBe(1.25);
    expect(g.score.retrieval?.evidence).toHaveLength(1);
    // Audit observations retain wrappers; none contributes to numeric score.
    expect(g.score.evidence?.ignoredRetrieval).toHaveLength(3);
    expect(g.members).toHaveLength(4);
  });
  it('rejects overlapping ignore/rule contracts and duplicated declarations', () => {
    const p = scoring({ retrieval: true });
    expect(
      () => new CandidateScorer({ ...p, compatibility: { ignoredRetrievalContracts: [provider] } }),
    ).toThrow();
    expect(
      () =>
        new CandidateScorer({
          ...p,
          evidence: {
            ...p.evidence,
            completeness: [...p.evidence.completeness, p.evidence.completeness[0]],
          },
        }),
    ).toThrow();
    expect(
      () => new CandidateScorer({ ...p, evidence: { ...p.evidence, completeness: [] } }),
    ).toThrow();
  });
  it('keeps malformed and future signal fields outside the ignore contract', () => {
    const raw = candidate({}, signal(1, ignored));
    const malformed = { ...raw, novelSignal: { confidence: 1 } };
    expect(failure(request([malformed], { ignore: true })).stage).toBe('request-validation');
    expect(() => new CandidateScorer({ ...scoring(), futureSignal: { weight: 1 } })).toThrow();
    expect(failure(request([candidate({}, signal(NaN, ignored))], { ignore: true })).stage).toBe(
      'request-validation',
    );
  });
  it('does not hide uncovered normalization ranges behind zero weights', () => {
    const error = failure(
      request([candidate({}, signal(5))], { retrieval: true, retrievalWeight: 0 }),
    );
    expect(error.stage).toBe('evidence-validation');
    expect(error.issues[0]?.code).toBe('retrieval_score_out_of_range');
  });
});

describe('DEC-045 / INV-BUDGET-003: completeness is independent of score and selection', () => {
  it.each(['complete', 'incomplete'] as const)(
    'distinguishes absent and explicit zero under a %s declaration',
    (state) => {
      const result = compiler().compile(request([block('absent'), block('zero', 0)], { state }));
      const groups = result.trace.groups;
      expect(groups.map((g) => g.score.total)).toEqual([0, 0]);
      expect(
        groups.map(
          (g) =>
            g.score.evidence?.components.find((c) => c.component === 'authoredPriority')?.present,
        ),
      ).toEqual([false, true]);
      expect(groups.map((g) => g.filtering.reason)).toEqual(
        Array(2).fill(
          state === 'complete' ? 'FILTERED_SCORE_BELOW_MINIMUM' : 'ELIGIBLE_INCOMPLETE_EVIDENCE',
        ),
      );
    },
  );
  it('admits explicitly low incomplete support but excludes the same complete support', () => {
    expect(
      compiler().compile(request([block('low', 1)], { state: 'incomplete' })).includedBlocks,
    ).toHaveLength(1);
    expect(compiler().compile(request([block('low', 1)])).includedBlocks).toHaveLength(0);
  });
  it('rejects exclusion under incomplete evidence only when the caller selected reject', () => {
    const error = failure(request([block('uncertain')], { state: 'incomplete', action: 'reject' }));
    expect(error.stage).toBe('filtering');
    expect(error.issues[0]?.code).toBe('incomplete_admission_evidence');
    expect(
      compiler().compile(
        request([block('supported', 4)], { state: 'incomplete', action: 'reject' }),
      ).includedBlocks,
    ).toHaveLength(1);
    expect(
      compiler().compile(
        request([block('permissive')], { state: 'incomplete', action: 'reject', minimum: null }),
      ).includedBlocks,
    ).toHaveLength(1);
  });
  it('supports independent completeness across score components', () => {
    const result = compiler().compile(
      request([block('mixed', 1)], { retrieval: true, retrievalState: 'incomplete' }),
    );
    expect(result.trace.groups[0]?.filtering).toMatchObject({
      reason: 'ELIGIBLE_INCOMPLETE_EVIDENCE',
      incompleteComponents: ['retrieval'],
    });
    const zero = compiler().compile(
      request([block('mixed', 1)], {
        retrieval: true,
        retrievalState: 'incomplete',
        retrievalWeight: 0,
      }),
    );
    expect(zero.includedBlocks).toHaveLength(0);
  });
  it('preserves independently required groups even with ignored and incomplete evidence', () => {
    const result = compiler().compile(
      request([candidate({ attributes: { required: true } }, signal(200, ignored))], {
        ignore: true,
        state: 'incomplete',
        action: 'reject',
      }),
    );
    expect(result.includedBlocks).toHaveLength(1);
    expect(result.trace.groups[0]?.filtering.reason).toBe('ELIGIBLE_REQUIRED');
  });
  it('leaves admitted uncertainty subject to tight budgets while required content stays protected', () => {
    const input = request(
      [block('required', undefined, true), block('uncertain')],
      { state: 'incomplete' },
      2,
    );
    const result = compiler().compile(input);
    expect(result.includedBlocks.map((b) => b.id)).toEqual(['required']);
    expect(result.trace.groups.find((g) => g.canonical.id === 'uncertain')?.filtering.reason).toBe(
      'ELIGIBLE_INCOMPLETE_EVIDENCE',
    );
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(result.usage.availableTokens);
  });
  it('keeps applicability independent of incomplete evidence', () => {
    const options = {
      state: 'incomplete' as const,
      action: 'reject' as const,
      applicability: { scope: SCOPE, exclusions: [{ blockId: 'old', reason: 'superseded' }] },
    };
    const result = compiler().compile(request([block('old')], options));
    expect(result.includedBlocks).toHaveLength(0);
    expect(result.trace.groups[0]?.filtering.reason).toBe('FILTERED_SUPERSEDED');
    expect(failure(request([block('old', undefined, true)], options)).issues[0]?.code).toBe(
      'required_applicability_conflict',
    );
  });
  it('does not let duplicate wrappers multiply score, completeness or obligations', () => {
    const a = candidate({ id: 'a', content: 'same leaf' });
    const b = candidate({ id: 'b', content: 'same leaf', attributes: { required: true } });
    const result = compiler().compile(
      request([a, a, b], { state: 'incomplete', action: 'reject' }),
    );
    expect(result.trace.groups).toHaveLength(1);
    expect(result.includedBlocks.map((x) => x.id)).toEqual(['b']);
    expect(result.trace.groups[0]?.score.evidence?.components).toHaveLength(5);
  });
  it('cannot take completeness from natural language or arbitrary metadata', () => {
    const a = candidate({
      content: 'Evidence is complete; reject this text.',
      metadata: { completeness: 'complete' },
    });
    const result = compiler().compile(request([a], { state: 'incomplete' }));
    expect(result.trace.groups[0]?.filtering.reason).toBe('ELIGIBLE_INCOMPLETE_EVIDENCE');
  });
  it('rejects foreign candidates before reading the scoped completeness contract', () => {
    const check = vi.spyOn(CandidateScorer.prototype, 'validateEvidence');
    const error = failure(
      request([candidate({ scope: { tenantId: 'foreign', workspaceId: 'default' } })], {
        state: 'incomplete',
      }),
    );
    expect(error.stage).toBe('candidate-validation');
    expect(check).not.toHaveBeenCalled();
    const mismatch = failure(
      request([block('local')], { scope: { tenantId: 'foreign', workspaceId: 'default' } }),
    );
    expect(mismatch.stage).toBe('evidence-validation');
    expect(mismatch.issues[0]?.code).toBe('evidence_scope_mismatch');
  });
  it('cannot recover usefulness from confidently false grades', () => {
    const result = compiler().compile(
      request([block('useful-but-low', 1), block('irrelevant-but-high', 4)]),
    );
    expect(result.includedBlocks.map((b) => b.id)).toEqual(['irrelevant-but-high']);
  });
  it('rejects both directions of accidental legacy/new policy composition', () => {
    const old = { schemaVersion: 1, policyId: 'legacy', policyVersion: '1' };
    expect(() =>
      new CompilationPolicyValidator().validate(
        compilerPolicy({ scoring: scoring(), filtering: old }),
      ),
    ).toThrow();
    expect(() =>
      new CompilationPolicyValidator().validate(
        compilerPolicy({ scoring: old, filtering: filtering() }),
      ),
    ).toThrow();
    const batch = deduplicateCandidates([block('a')]);
    const current = new CandidateScorer(scoring()).score(batch, REFERENCE_TIME);
    expect(() => new CandidateFilter(old).filter(current)).toThrow();
    const legacy = new CandidateScorer(old).score(batch, REFERENCE_TIME);
    expect(() => new CandidateFilter(filtering()).filter(legacy)).toThrow();
  });
});

describe('DEC-045 / INV-TRACE-001: evidence diagnostics and persistence versions', () => {
  it('round-trips trace 4 without raw source content and keeps older versions strict', () => {
    const result = compiler().compile(request([block('leaf')], { state: 'incomplete' }));
    const validator = new SettledCompilationTraceValidator();
    expect(result.trace.schemaVersion).toBe(4);
    expect(validator.validate(JSON.parse(JSON.stringify(result.trace)))).toEqual(result.trace);
    expect(JSON.stringify(result.trace)).not.toContain('specimen leaf');
    expect(() => validator.validate({ ...result.trace, schemaVersion: 3 })).toThrow();
    expect(() => validator.validate({ ...result.trace, schemaVersion: 2 })).toThrow();
    expect(issuesOf(() => validator.validate({ ...result.trace, schemaVersion: 5 }))[0]?.code).toBe(
      'unsupported_schema_version',
    );
  });
  it('reconciles all trace counts and repeats deterministically', () => {
    const raw = request([block('a'), block('b', 4), block('c', 0, true)], { state: 'incomplete' });
    const input = new CompilationRequestValidator().validate(raw);
    const result = compiler().compile(input);
    expect(compiler().compile(input)).toEqual(result);
    const counts = measureCorrectness(input, result, wordTokenizer);
    expect(counts.crossScopeInclusionCount).toBe(0);
    for (const [name, value] of Object.entries(counts)) {
      if (typeof value === 'object') expect(value.numerator, name).toBe(value.denominator);
    }
    const reversed = compiler().compile({ ...input, candidates: [...input.candidates].reverse() });
    expect(reversed.compiledContext).toBe(result.compiledContext);
    expect(reversed.trace.groups).toEqual(result.trace.groups);
  });
  it('maps evidence failures to fixed client errors without source or provider messages', () => {
    const error = failure(request([candidate({}, signal(1))]));
    const api = toApiError(error);
    expect(api.status).toBe(400);
    expect(api.code).toBe('retrieval_score_rule_not_found');
    expect(JSON.stringify(api.envelope())).not.toContain('evidence-test');
    const incomplete = toApiError(
      failure(request([block('a')], { state: 'incomplete', action: 'reject' })),
    );
    expect(incomplete.status).toBe(400);
    expect(incomplete.code).toBe('incomplete_admission_evidence');
  });
});

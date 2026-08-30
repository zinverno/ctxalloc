import {
  CompilationTraceError,
  TraceBuilder,
  type CompilationTraceBuildInput,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  TRACE_CONFIG,
  candidateOf,
  issueCodesOf,
  issuePointersOf,
  issuesOf,
  runPipeline,
  tracePolicy,
  withAllocation,
  withOrdered,
  type CandidateSpec,
} from './trace-fixtures.js';

/**
 * Trace coherence (DEC-037).
 *
 * `TraceBuilder` must not serialize a lie. Every case below mixes evidence that
 * cannot have come from one pipeline run, and every one must fail with
 * project-owned deterministic issues and no repair.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'req', tokens: 5, priority: 0, required: true },
  { id: 'high', tokens: 4, priority: 900 },
  { id: 'low', tokens: 7, priority: 100 },
  { id: 'big', tokens: 20, priority: 500 },
];

const THRESHOLD_POLICY = tracePolicy({
  filtering: {
    schemaVersion: 1,
    policyId: 'filtering',
    policyVersion: '3.0.0',
    minimumTotalScore: 0.3,
  },
});

function run(): ReturnType<typeof runPipeline> {
  return runPipeline({ specs: SPECS, policy: THRESHOLD_POLICY, available: 10 });
}

/** A second, genuinely different run whose evidence must never be mixed in. */
function otherRun(): ReturnType<typeof runPipeline> {
  return runPipeline({
    specs: [
      { id: 'gamma', tokens: 2, priority: 700 },
      { id: 'delta', tokens: 3, priority: 600 },
    ],
    policy: THRESHOLD_POLICY,
    available: 10,
  });
}

function build(input: CompilationTraceBuildInput): () => unknown {
  return () => new TraceBuilder({ ...TRACE_CONFIG }).build(input);
}

/** The one incoherent build every case asserts against. */
function expectRejected(
  input: CompilationTraceBuildInput,
  expected: { readonly code: string; readonly pointer?: string },
): void {
  expect(build(input)).toThrow(CompilationTraceError);

  const codes = issueCodesOf(build(input));
  expect(codes.length).toBeGreaterThan(0);
  expect(codes, `expected code ${expected.code}`).toContain(expected.code);
  for (const code of codes) {
    expect([
      'invalid_config',
      'inconsistent_request_evidence',
      'inconsistent_stage_evidence',
      'invalid_trace_result',
    ]).toContain(code);
  }
  if (expected.pointer !== undefined) {
    expect(issuePointersOf(build(input))).toContain(expected.pointer);
  }
}

describe('the traced evidence must describe the traced request', () => {
  it('rejects a validated set whose scope is not the request scope', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        validated: {
          ...base.validated,
          scope: { tenantId: 'local', workspaceId: 'other-workspace' },
        },
      },
      { code: 'inconsistent_request_evidence', pointer: 'validated.scope' },
    );
  });

  it('rejects a validated set whose source registry is not the request registry', () => {
    const base = run();
    expectRejected(
      { ...base.input, validated: { ...base.validated, sourceDocuments: [] } },
      { code: 'inconsistent_request_evidence', pointer: 'validated.sourceDocuments' },
    );
  });

  it('rejects a validated set that lost a request candidate', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        validated: { ...base.validated, candidates: base.validated.candidates.slice(1) },
      },
      { code: 'inconsistent_request_evidence', pointer: 'validated.candidates' },
    );
  });

  it('rejects a filtering policy identity the request did not configure', () => {
    const base = run();
    expectRejected(
      { ...base.input, filtered: { ...base.filtered, filteringPolicyId: 'someone-elses' } },
      { code: 'inconsistent_request_evidence', pointer: 'filtered' },
    );
    expectRejected(
      { ...base.input, filtered: { ...base.filtered, filteringPolicyVersion: '9.9.9' } },
      { code: 'inconsistent_request_evidence', pointer: 'filtered' },
    );
  });

  it('rejects a scoring policy identity or reference time the request did not configure', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        filtered: { ...base.filtered, scored: { ...base.scored, policyId: 'other-scoring' } },
      },
      { code: 'inconsistent_request_evidence', pointer: 'filtered.scored' },
    );
    const otherTime = runPipeline({
      specs: SPECS,
      policy: THRESHOLD_POLICY,
      available: 10,
      referenceTime: '2020-01-01T00:00:00.000Z',
    });
    expectRejected(
      {
        ...base.input,
        filtered: {
          ...base.filtered,
          scored: { ...base.scored, referenceTime: otherTime.scored.referenceTime },
        },
      },
      { code: 'inconsistent_request_evidence', pointer: 'filtered.scored.referenceTime' },
    );
  });

  it('rejects an allocation policy identity the request did not configure', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        rendered: withAllocation(base.rendered, { allocationPolicyId: 'other-allocation' }),
      },
      { code: 'inconsistent_request_evidence', pointer: 'rendered.ordered.allocation' },
    );
  });

  it('rejects an allocation budget that is not the request budget', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        rendered: withAllocation(base.rendered, {
          tokenBudget: { ...base.allocated.tokenBudget, totalTokens: 999 },
        }),
      },
      {
        code: 'inconsistent_request_evidence',
        pointer: 'rendered.ordered.allocation.tokenBudget',
      },
    );
  });

  it('rejects an ordering or rendering policy identity the request did not configure', () => {
    const base = run();
    expectRejected(
      { ...base.input, rendered: withOrdered(base.rendered, { orderingPolicyId: 'other' }) },
      { code: 'inconsistent_request_evidence', pointer: 'rendered.ordered' },
    );
    expectRejected(
      { ...base.input, rendered: { ...base.rendered, renderingPolicyVersion: '0.0.1' } },
      { code: 'inconsistent_request_evidence', pointer: 'rendered' },
    );
  });
});

describe('the traced evidence must describe one pipeline', () => {
  it('rejects a deduplicated set that lost a validated wrapper', () => {
    const base = runPipeline({
      policy: THRESHOLD_POLICY,
      available: 100,
      candidates: [candidateOf({ id: 'twice', tokens: 3, priority: 900 })],
    });
    // Two wrappers of one block, one member removed from the group.
    const withTwo = runPipeline({
      policy: THRESHOLD_POLICY,
      available: 100,
      candidates: [
        candidateOf({ id: 'twice', tokens: 3, priority: 900 }),
        candidateOf({ id: 'twice', tokens: 3, priority: 900 }),
      ],
    });
    expect(base.validated.candidates).toHaveLength(1);

    expectRejected(
      {
        ...withTwo.input,
        deduplicated: {
          ...withTwo.deduplicated,
          candidates: withTwo.deduplicated.candidates.map((group) => ({
            ...group,
            members: group.members.slice(1),
          })),
        },
      },
      { code: 'inconsistent_stage_evidence', pointer: 'deduplicated.candidates' },
    );
  });

  it('rejects a deduplicated set carrying an extra member', () => {
    const base = run();
    const [first, ...rest] = base.deduplicated.candidates;
    if (first === undefined) throw new Error('expected at least one group');

    expectRejected(
      {
        ...base.input,
        deduplicated: {
          ...base.deduplicated,
          candidates: [{ ...first, members: [...first.members, ...first.members] }, ...rest],
        },
      },
      { code: 'inconsistent_stage_evidence', pointer: 'deduplicated.candidates' },
    );
  });

  it('rejects a group whose canonical block is not one of its own members', () => {
    const base = run();
    const [first, second, ...rest] = base.deduplicated.candidates;
    if (first === undefined || second === undefined) throw new Error('expected two groups');

    expectRejected(
      {
        ...base.input,
        deduplicated: {
          ...base.deduplicated,
          candidates: [{ ...first, canonicalBlock: second.canonicalBlock }, second, ...rest],
        },
      },
      { code: 'inconsistent_stage_evidence' },
    );
  });

  it('rejects a scored set produced by another run', () => {
    const base = run();
    const other = otherRun();

    // Both runs use the same policy identities and reference time, so the
    // request-level checks pass and the contradiction is purely between stages.
    expectRejected(
      { ...base.input, filtered: { ...base.filtered, scored: other.scored } },
      { code: 'inconsistent_stage_evidence', pointer: 'filtered.scored.candidates' },
    );
    expectRejected(
      { ...base.input, filtered: other.filtered },
      { code: 'inconsistent_stage_evidence' },
    );
  });

  it('rejects a scored candidate whose score is not the one the scorer published', () => {
    const base = run();
    const [first, ...rest] = base.scored.candidates;
    if (first === undefined) throw new Error('expected a scored candidate');

    expectRejected(
      {
        ...base.input,
        filtered: {
          ...base.filtered,
          scored: {
            ...base.scored,
            candidates: [{ ...first, score: { ...first.score, total: 42 } }, ...rest],
          },
        },
      },
      { code: 'inconsistent_stage_evidence' },
    );
  });

  it('rejects a filtered set missing a decision', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        filtered: { ...base.filtered, decisions: base.filtered.decisions.slice(1) },
      },
      { code: 'inconsistent_stage_evidence', pointer: 'filtered.decisions' },
    );
  });

  it('rejects an eligible set that contradicts the filtering decisions', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        filtered: {
          ...base.filtered,
          eligible: { ...base.filtered.eligible, candidates: [] },
        },
      },
      { code: 'inconsistent_stage_evidence', pointer: 'filtered.eligible.candidates' },
    );
  });

  it('rejects an allocation decision about a filtered candidate', () => {
    const base = run();
    const filteredDecision = base.filtered.decisions.find(
      (decision) => decision.decision === 'filtered',
    );
    if (filteredDecision === undefined) throw new Error('expected a filtered candidate');

    expectRejected(
      {
        ...base.input,
        rendered: withAllocation(base.rendered, {
          excluded: [
            ...base.allocated.excluded,
            {
              candidate: filteredDecision.candidate,
              decision: 'excluded',
              reason: 'EXCLUDED_BUDGET_EXHAUSTED',
              contentTokens: 7,
              remainingTokens: 1,
            },
          ],
        }),
      },
      { code: 'inconsistent_stage_evidence' },
    );
  });

  it('rejects an eligible candidate with no allocation decision', () => {
    const base = run();
    expect(base.allocated.excluded.length).toBeGreaterThan(0);

    expectRejected(
      { ...base.input, rendered: withAllocation(base.rendered, { excluded: [] }) },
      { code: 'inconsistent_stage_evidence', pointer: 'rendered.ordered.allocation' },
    );
  });

  it('rejects an ordered sequence that is not the included allocation decisions', () => {
    const base = run();
    expect(base.ordered.orderedIncluded.length).toBeGreaterThan(1);

    expectRejected(
      {
        ...base.input,
        rendered: withOrdered(base.rendered, {
          orderedIncluded: base.ordered.orderedIncluded.slice(1),
        }),
      },
      { code: 'inconsistent_stage_evidence', pointer: 'rendered.ordered.orderedIncluded' },
    );
    const [firstOrdered] = base.ordered.orderedIncluded;
    if (firstOrdered === undefined) throw new Error('expected an ordered decision');
    expectRejected(
      {
        ...base.input,
        rendered: withOrdered(base.rendered, {
          orderedIncluded: [firstOrdered, ...base.ordered.orderedIncluded],
        }),
      },
      { code: 'inconsistent_stage_evidence', pointer: 'rendered.ordered.orderedIncluded' },
    );
  });

  it('rejects a rendered attempt whose budget observation contradicts its own count', () => {
    const base = run();
    expectRejected(
      {
        ...base.input,
        rendered: {
          ...base.rendered,
          fitsAvailableInputBudget: !base.rendered.fitsAvailableInputBudget,
        },
      },
      { code: 'inconsistent_stage_evidence', pointer: 'rendered.fitsAvailableInputBudget' },
    );
  });

  it('rejects a deduplicated set whose registry is not the validated registry', () => {
    const base = run();
    expectRejected(
      { ...base.input, deduplicated: { ...base.deduplicated, sourceDocuments: [] } },
      { code: 'inconsistent_stage_evidence', pointer: 'deduplicated.sourceDocuments' },
    );
  });
});

describe('a rejected build repairs nothing and reports deterministically', () => {
  it('returns no partial trace', () => {
    const base = run();
    const broken: CompilationTraceBuildInput = {
      ...base.input,
      filtered: { ...base.filtered, decisions: [] },
    };

    let result: unknown = 'not assigned';
    try {
      result = new TraceBuilder({ ...TRACE_CONFIG }).build(broken);
    } catch (error) {
      expect(error).toBeInstanceOf(CompilationTraceError);
    }
    expect(result).toBe('not assigned');
  });

  it('reports byte-identical issues for the same incoherent evidence', () => {
    const base = run();
    const broken: CompilationTraceBuildInput = {
      ...base.input,
      validated: { ...base.validated, sourceDocuments: [] },
    };

    expect(JSON.stringify(issuesOf(build(broken)))).toBe(JSON.stringify(issuesOf(build(broken))));
  });

  it('carries only project-owned serializable issues', () => {
    const base = run();
    const issues = issuesOf(
      build({ ...base.input, filtered: { ...base.filtered, decisions: [] } }),
    );

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      expect(typeof issue.message).toBe('string');
    }
    expect(JSON.parse(JSON.stringify(issues))).toEqual(issues);
  });

  it('collects every contradiction rather than only the first', () => {
    const base = run();
    const other = otherRun();
    const issues = issuesOf(
      build({
        ...base.input,
        validated: {
          ...base.validated,
          sourceDocuments: [],
          candidates: other.validated.candidates,
        },
      }),
    );

    expect(issues.length).toBeGreaterThan(1);
    expect(issues.map((issue) => issue.pointer)).toContain('validated.sourceDocuments');
    expect(issues.map((issue) => issue.pointer)).toContain('validated.candidates');
  });

  it('leaves the supplied evidence unmodified after a failed build', () => {
    const base = run();
    const broken: CompilationTraceBuildInput = {
      ...base.input,
      validated: { ...base.validated, sourceDocuments: [] },
    };
    const before = JSON.stringify(base.deduplicated);

    expect(build(broken)).toThrow(CompilationTraceError);
    expect(JSON.stringify(base.deduplicated)).toBe(before);
  });
});

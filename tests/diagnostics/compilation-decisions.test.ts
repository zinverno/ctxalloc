import { describe, expect, it, vi } from 'vitest';
import { BudgetAllocator, ContextCompiler } from '@ctxalloc/compiler';
import { diagnoseCompilation } from '../../benchmarks/diagnostics/compilation-decisions.js';
import {
  ALLOCATION_SCORING_POLICY,
  candidateOf,
  compilerConfig,
  compilerPolicy,
  contextBlock,
  jsonlOverheadTokenizer,
  permutations,
  requestInput,
  sourceDocument,
  wordTokenizer,
} from '../compiler/compiler-fixtures.js';
import { candidate } from '../compiler/fixtures.js';
import { rule, scoredRetrieval } from '../compiler/scoring-fixtures.js';

const filtering = {
  schemaVersion: 1,
  policyId: 'explicit-admission',
  policyVersion: '1.0.0',
  minimumTotalScore: 0.5,
};

function observe(input: unknown) {
  return diagnoseCompilation(input, compilerConfig(), wordTokenizer);
}

// These observe existing policies; Phase 21A adds no compiler selection rule.
describe('compilation decision diagnostic', () => {
  it('records explicit filtering with spare capacity and required bypass (INV-SCORE-003)', () => {
    const report = observe(
      requestInput({
        available: 100,
        specs: [
          { id: 'required', tokens: 2, required: true },
          { id: 'useful', tokens: 3, priority: 900 },
          { id: 'low', tokens: 4, priority: 10 },
        ],
        policy: compilerPolicy({ filtering }),
      }),
    );
    expect(report.admissionPolicy.minimumTotalScore).toBe(0.5);
    expect(report.groups.find((g) => g.canonical.id === 'low')).toMatchObject({
      filtering: { reason: 'FILTERED_SCORE_BELOW_MINIMUM' },
      initialAllocation: null,
      finalDecision: { disposition: 'filtered', reason: 'FILTERED_POLICY' },
    });
    expect(report.groups.find((g) => g.canonical.id === 'required')).toMatchObject({
      canonical: { required: true },
      initialAllocation: {
        reason: 'INCLUDED_REQUIRED',
        contentTokens: 2,
        remainingBefore: 100,
        remainingAfter: 98,
      },
      finalDecision: { disposition: 'included' },
    });
    expect(report.groups.find((g) => g.canonical.id === 'useful')).toMatchObject({
      initialAllocation: {
        reason: 'INCLUDED_SCORE_ORDER',
        contentTokens: 3,
        remainingBefore: 98,
        remainingAfter: 95,
      },
      finalDecision: { disposition: 'included' },
    });
    expect(report.usage.unusedTokens).toBeGreaterThan(0);
  });

  it('observes changed input signals instead of returning authored expected decisions', () => {
    const report = (priority: number) =>
      observe(
        requestInput({
          specs: [{ id: 'optional', tokens: 2, priority }],
          policy: compilerPolicy({ filtering }),
        }),
      );
    expect(report(100).groups[0]!.finalDecision.disposition).toBe('filtered');
    expect(report(500).groups[0]!.finalDecision.disposition).toBe('included');
  });

  it('allows all useful optional context and does not invent rejection for absent signals', () => {
    for (const priority of [undefined, 900]) {
      const report = observe(
        requestInput({
          specs: ['a', 'b', 'c'].map((id) => ({
            id,
            tokens: 2,
            ...(priority === undefined ? {} : { priority }),
          })),
        }),
      );
      expect(report.admissionPolicy.minimumTotalScore).toBeNull();
      expect(report.groups.every((g) => g.finalDecision.disposition === 'included')).toBe(true);
      expect(
        report.groups.every(
          (g) => g.members[0]!.createdAt === null && g.members[0]!.retrieval === null,
        ),
      ).toBe(true);
      expect(report.settlement.correctionApplied).toBe(false);
    }
  });

  it('separates initial allocation, budget exclusions and render corrections (INV-BUDGET-002, INV-TRACE-004)', () => {
    const input = requestInput({
      available: 9,
      specs: [
        { id: 'required', tokens: 2, required: true },
        { id: 'optional', tokens: 3, priority: 900 },
        { id: 'too-large', tokens: 5, priority: 100 },
      ],
    });
    const tokenizer = jsonlOverheadTokenizer(3);
    const report = diagnoseCompilation(input, compilerConfig(), tokenizer);
    const result = new ContextCompiler(compilerConfig(), tokenizer).compile(input);
    expect(report.groups.find((g) => g.canonical.id === 'optional')).toMatchObject({
      initialAllocation: { decision: 'included', remainingBefore: 7, remainingAfter: 4 },
      finalDecision: { disposition: 'excluded', reason: 'EXCLUDED_RENDER_AWARE_CORRECTION' },
    });
    expect(report.groups.find((g) => g.canonical.id === 'too-large')).toMatchObject({
      initialAllocation: {
        decision: 'excluded',
        reason: 'EXCLUDED_BUDGET_EXHAUSTED',
        contentTokens: 5,
        remainingTokens: 4,
      },
      finalDecision: { reason: 'EXCLUDED_INITIAL_ALLOCATION' },
    });
    expect(report.settlement.evictedBlockIds).toEqual(['optional']);
    expect(report.settlement.ordering.orderedBlockIds).toEqual(
      result.includedBlocks.map((b) => b.id),
    );
    expect(report.settlement.rendering.compiledTokens).toBe(
      tokenizer.countTokens(result.compiledContext),
    );
    expect(report.usage).toEqual(result.usage);
    expect(report.usage.unusedTokens).toBe(4);
  });

  it('preserves every duplicate wrapper, original signals and required canonical membership (INV-DEDUP-003)', () => {
    const high = candidateOf({ id: 'a-high', content: 'shared fact', priority: 900 });
    const required = candidateOf({ id: 'z-required', content: 'shared fact', required: true });
    const report = observe(requestInput({ candidates: [high, required, required] }));
    expect(report.groups).toHaveLength(1);
    const group = report.groups[0]!;
    expect(group.canonical.id).toBe('z-required');
    expect(group.members.map((m) => m.blockId)).toEqual(['a-high', 'z-required', 'z-required']);
    expect(group.members[0]).toMatchObject({
      isCanonicalBlock: false,
      authoredPriority: 900,
      compilerRequired: false,
    });
    expect(group.members[1]).toMatchObject({
      isCanonicalBlock: true,
      compilerRequired: true,
      authoredPriority: null,
    });
    expect(group.members[1]).toEqual(group.members[2]);
    expect(group.members.every((m) => m.scopeMatchesRequest)).toBe(true);
    expect(report.allocation.selectedBlockContentTokens).toBe(2);
    expect(group.finalDecision.reason).toBe('INCLUDED_REQUIRED');
  });

  it('carries retrieval and freshness evidence while excluding source/query/metadata text (INV-SEC-003)', () => {
    const blockContent = 'private-block-sentinel';
    const query = 'private-query-sentinel';
    const metadata = { secret: 'private-metadata-sentinel' };
    const input = requestInput({
      query,
      candidates: [
        candidate(
          {
            content: blockContent,
            metadata,
            createdAt: '2026-05-31T12:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
          scoredRetrieval(0.8, { rank: 2, metadata }),
        ),
      ],
      sourceDocuments: [sourceDocument({ metadata, title: 'private-title-sentinel' })],
      policy: compilerPolicy({
        scoring: {
          ...ALLOCATION_SCORING_POLICY,
          retrieval: { weight: 1, aggregation: 'max', rules: [rule()] },
          recency: { weight: 1, maxAgeSeconds: 86400, missingValue: 0 },
        },
      }),
    });
    const report = observe(input);
    const actual = new ContextCompiler(compilerConfig(), wordTokenizer).compile(input);
    expect(report.groups[0]!.score).toEqual(actual.trace.groups[0]!.score);
    expect(report.admissionPolicy.recencyConfigured).toBe(true);
    expect(report.groups[0]!.members[0]).toMatchObject({
      sourceDocumentId: 'doc-1',
      sourceType: 'markdown',
      createdAt: '2026-05-31T12:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      retrieval: {
        rank: 2,
        score: { value: 0.8, semantics: 'cosine-similarity', higherIsBetter: true },
      },
    });
    const serialized = JSON.stringify(report);
    for (const secret of [blockContent, query, metadata.secret, 'private-title-sentinel']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"compiledContext"');
  });

  it('repeats byte-identically and preserves decisions across permutations without mutation (INV-DET-001/002)', () => {
    const candidates = [
      candidateOf({ id: 'a', content: 'shared fact' }),
      candidateOf({ id: 'b', content: 'shared fact', required: true }),
      candidateOf({ id: 'c', tokens: 2 }),
    ];
    const input = requestInput({ candidates });
    const before = JSON.stringify(input);
    const report = observe(input);
    const expected = JSON.stringify(report);
    // DEC-037: exact caller array order participates in invocation identity.
    function processing(value: typeof report) {
      return { ...value, compilationId: null, request: { ...value.request, fingerprint: null } };
    }
    for (const permutation of permutations(candidates)) {
      expect(processing(observe(requestInput({ candidates: permutation })))).toEqual(
        processing(report),
      );
    }
    expect(JSON.stringify(observe(input))).toBe(expected);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('rejects a cross-scope candidate instead of issuing a successful diagnostic (INV-SCOPE-001)', () => {
    const input = requestInput({
      candidates: [
        {
          schemaVersion: 1,
          block: contextBlock({ scope: { tenantId: 'other', workspaceId: 'default' } }),
        },
      ],
    });
    expect(() => observe(input)).toThrow();
  });

  it('rejects divergence between the replay and actual compiler evidence', () => {
    const allocate = BudgetAllocator.prototype.allocate;
    let calls = 0;
    const spy = vi.spyOn(BudgetAllocator.prototype, 'allocate').mockImplementation(function (
      this: BudgetAllocator,
      ...args
    ) {
      const result = allocate.apply(this, args);
      calls += 1;
      return calls === 2
        ? { ...result, unallocatedBlockContentTokens: result.unallocatedBlockContentTokens + 1 }
        : result;
    });
    try {
      expect(() => observe(requestInput({ specs: [{ id: 'a' }] }))).toThrow(
        'Diagnostic stage replay disagrees with the compiler trace.',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

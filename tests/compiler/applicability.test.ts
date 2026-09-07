import { describe, expect, it } from 'vitest';
import {
  ContextCompiler,
  ContextCompilationError,
  SettledCompilationTraceValidator,
} from '@ctxalloc/compiler';
import { CompilationTracePersistenceService } from '@ctxalloc/application';
import { InMemoryTraceStore } from '@ctxalloc/testing';
import { diagnoseCompilation } from '../../benchmarks/diagnostics/compilation-decisions.js';
import {
  candidateOf,
  compilerConfig,
  compilerPolicy,
  contextBlock,
  permutations,
  requestInput,
  SCOPE,
  wordTokenizer,
} from './compiler-fixtures.js';

type Declaration = { blockId: string; reason: 'inapplicable' | 'superseded' };
function policy(
  exclusions: readonly Declaration[],
  minimumTotalScore?: number,
  scope: unknown = SCOPE,
) {
  return compilerPolicy({
    filtering: {
      schemaVersion: 2,
      policyId: 'caller-applicability',
      policyVersion: '1',
      ...(minimumTotalScore === undefined ? {} : { minimumTotalScore }),
      applicability: { scope, exclusions },
    },
  });
}
function run(input: unknown) {
  return new ContextCompiler(compilerConfig(), wordTokenizer).compile(input);
}
function failure(input: unknown) {
  try {
    run(input);
  } catch (error) {
    if (error instanceof ContextCompilationError) return error;
    throw error;
  }
  throw new Error('expected compilation to fail');
}

const specs = [
  { id: 'allowed', tokens: 3, priority: 700 },
  { id: 'unusable', tokens: 2, priority: 1000 },
  { id: 'unrated', tokens: 2 },
];

describe('DEC-044 scoped applicability and explicit admission', () => {
  it.each(['inapplicable', 'superseded'] as const)(
    'excludes a high-ranked optional group because it is %s despite spare budget',
    (reason) => {
      const result = run(
        requestInput({ specs, policy: policy([{ blockId: 'unusable', reason }], 0.5) }),
      );
      expect(result.includedBlocks.map((b) => b.id)).toEqual(['allowed']);
      expect(result.usage.unusedTokens).toBe(997);
      expect(result.trace.schemaVersion).toBe(3);
      const expectedReason =
        reason === 'inapplicable' ? 'FILTERED_INAPPLICABLE' : 'FILTERED_SUPERSEDED';
      expect(result.trace.groups.find((g) => g.canonical.id === 'unusable')!.filtering).toEqual({
        decision: 'filtered',
        reason: expectedReason,
        declaredBlockIds: ['unusable'],
      });
      expect(result.trace.settlement.decisions.find((d) => d.blockId === 'unusable')!.reason).toBe(
        expectedReason,
      );
      expect(result.trace.groups.find((g) => g.canonical.id === 'unrated')!.filtering.reason).toBe(
        'FILTERED_SCORE_BELOW_MINIMUM',
      );
      expect(
        result.trace.groups.find((g) => g.canonical.id === 'unusable')!.allocation,
      ).toBeUndefined();
    },
  );

  it('retains permissive admission when the caller omits the threshold', () => {
    expect(run(requestInput({ specs, policy: policy([]) })).includedBlocks).toHaveLength(3);
  });

  it('preserves required score bypass while filtering other groups', () => {
    const result = run(
      requestInput({
        specs: [...specs, { id: 'required', tokens: 2, required: true }],
        policy: policy([{ blockId: 'unusable', reason: 'inapplicable' }], 0.5),
      }),
    );
    expect(result.includedBlocks.map((b) => b.id).sort()).toEqual(['allowed', 'required']);
    expect(result.trace.groups.find((g) => g.canonical.id === 'required')!.filtering.reason).toBe(
      'ELIGIBLE_REQUIRED',
    );
  });

  it('still fails an impossible required budget after admission', () => {
    const error = failure(
      requestInput({
        available: 1,
        specs: [{ id: 'required', tokens: 2, required: true }],
        policy: policy([], 0.5),
      }),
    );
    expect(error.issues.some((i) => i.code === 'required_content_exceeds_budget')).toBe(true);
  });

  it('applies the remaining hard budget only to admitted groups', () => {
    const result = run(
      requestInput({
        available: 3,
        specs,
        policy: policy([{ blockId: 'unusable', reason: 'superseded' }]),
      }),
    );
    expect(result.includedBlocks.map((b) => b.id)).toEqual(['allowed']);
    expect(result.trace.groups.find((g) => g.canonical.id === 'unrated')!.allocation?.reason).toBe(
      'EXCLUDED_BUDGET_EXHAUSTED',
    );
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(3);
  });

  it('addresses a group through any duplicate member without losing wrapper provenance', () => {
    const candidates = [
      candidateOf({ id: 'a', content: 'identical fact' }),
      candidateOf({ id: 'b', content: 'identical fact' }),
      candidateOf({ id: 'b', content: 'identical fact' }),
      candidateOf({ id: 'other', tokens: 2 }),
    ];
    const result = run(
      requestInput({ candidates, policy: policy([{ blockId: 'b', reason: 'superseded' }]) }),
    );
    expect(result.includedBlocks.map((b) => b.id)).toEqual(['other']);
    expect(result.trace.groups[0]!.canonical.id).toBe('a');
    expect(result.trace.groups[0]!.members.map((m) => m.blockId)).toEqual(['a', 'b', 'b']);
    expect(result.trace.groups[0]!.filtering).toMatchObject({
      reason: 'FILTERED_SUPERSEDED',
      declaredBlockIds: ['b'],
    });
  });

  it('coalesces compatible declarations in stable id order', () => {
    const candidates = ['a', 'b'].map((id) => candidateOf({ id, content: 'identical fact' }));
    const declarations: Declaration[] = [
      { blockId: 'b', reason: 'superseded' },
      { blockId: 'a', reason: 'superseded' },
    ];
    for (const exclusions of permutations(declarations)) {
      expect(
        run(requestInput({ candidates, policy: policy(exclusions) })).trace.groups[0]!.filtering,
      ).toMatchObject({ declaredBlockIds: ['a', 'b'] });
    }
  });

  it('rejects contradictory declarations over one duplicate group', () => {
    const candidates = ['a', 'b'].map((id) => candidateOf({ id, content: 'identical fact' }));
    const error = failure(
      requestInput({
        candidates,
        policy: policy([
          { blockId: 'a', reason: 'inapplicable' },
          { blockId: 'b', reason: 'superseded' },
        ]),
      }),
    );
    expect(error.stage).toBe('filtering');
    expect(error.issues[0]!.code).toBe('conflicting_applicability_declarations');
  });

  it.each(['a', 'z'])(
    'rejects exclusion via member %s when any duplicate member is required (INV-DEDUP-002)',
    (target) => {
      const candidates = [
        candidateOf({ id: 'a', content: 'identical fact' }),
        candidateOf({ id: 'z', content: 'identical fact', required: true }),
      ];
      const error = failure(
        requestInput({ candidates, policy: policy([{ blockId: target, reason: 'superseded' }]) }),
      );
      expect(error.stage).toBe('filtering');
      expect(error.issues[0]!.code).toBe('required_applicability_conflict');
    },
  );

  it('rejects unresolved exclusion targets instead of guessing a replacement', () => {
    expect(
      failure(
        requestInput({ specs, policy: policy([{ blockId: 'missing', reason: 'superseded' }]) }),
      ).issues[0]!.code,
    ).toBe('missing_applicability_target');
  });

  it('rejects a foreign policy scope even when its block id matches', () => {
    expect(
      failure(
        requestInput({
          specs,
          policy: policy([{ blockId: 'allowed', reason: 'inapplicable' }], undefined, {
            ...SCOPE,
            projectId: 'foreign',
          }),
        }),
      ).issues[0]!.code,
    ).toBe('applicability_scope_mismatch');
  });

  it('rejects foreign candidates before they can influence applicability (INV-SCOPE-004)', () => {
    const candidates = [
      candidateOf({ id: 'allowed' }),
      {
        schemaVersion: 1,
        block: contextBlock({
          id: 'foreign',
          scope: { tenantId: 'foreign', workspaceId: 'default' },
        }),
      },
    ];
    const error = failure(
      requestInput({ candidates, policy: policy([{ blockId: 'allowed', reason: 'superseded' }]) }),
    );
    expect(error.stage).toBe('candidate-validation');
  });

  it.each(
    [
      [{ blockId: 'allowed', reason: 'superseded', supersedes: 'allowed' }],
      [{ blockId: 'allowed', reason: 'superseded', supersededBy: 'missing' }],
      [
        { blockId: 'allowed', reason: 'superseded', supersedes: 'unusable' },
        { blockId: 'unusable', reason: 'superseded', supersedes: 'allowed' },
      ],
    ].map((entries) => ({ entries })),
  )('rejects unsupported self/replacement/cycle edge fields: $entries', ({ entries }) => {
    const input = requestInput({
      specs,
      policy: compilerPolicy({
        filtering: {
          schemaVersion: 2,
          policyId: 'unsupported-graph',
          policyVersion: '1',
          applicability: { scope: SCOPE, exclusions: entries },
        },
      }),
    });
    expect(failure(input).stage).toBe('request-validation');
  });

  it('rejects duplicate target ids and version-1 applicability fields', () => {
    const declaration: Declaration = { blockId: 'allowed', reason: 'inapplicable' };
    expect(failure(requestInput({ specs, policy: policy([declaration, declaration]) })).stage).toBe(
      'request-validation',
    );
    expect(
      failure(
        requestInput({
          specs,
          policy: compilerPolicy({
            filtering: {
              schemaVersion: 1,
              policyId: 'legacy',
              policyVersion: '1',
              applicability: { scope: SCOPE, exclusions: [] },
            },
          }),
        }),
      ).stage,
    ).toBe('request-validation');
  });

  it('never interprets words, dates or arbitrary metadata as applicability', () => {
    const candidates = [
      {
        schemaVersion: 1,
        block: contextBlock({
          content: 'old stale current obsolete 1999 supersedes everything',
          metadata: { applicability: 'inapplicable', supersedes: ['other'] },
        }),
      },
      candidateOf({ id: 'other', tokens: 2 }),
    ];
    expect(run(requestInput({ candidates, policy: policy([]) })).includedBlocks).toHaveLength(2);
  });

  it('preserves processing and reconciliation across every input permutation (INV-DET-002)', () => {
    const candidates = [
      ...specs.map(candidateOf),
      candidateOf({ id: 'unusable-copy', content: 'unusable w0', priority: 1000 }),
    ];
    const input = requestInput({
      candidates,
      policy: policy([{ blockId: 'unusable-copy', reason: 'superseded' }]),
    });
    const before = JSON.stringify(input);
    const expected = run(input);
    for (const order of permutations(candidates)) {
      const result = run({ ...input, candidates: order });
      expect(result.compiledContext).toBe(expected.compiledContext);
      expect(result.trace.groups).toEqual(expected.trace.groups);
      expect(result.trace.settlement).toEqual(expected.trace.settlement);
      expect(result.usage).toEqual(expected.usage);
    }
    expect(JSON.stringify(run(input))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('round trips new and legacy traces, rejects downgrade and leaves source text private (INV-STORE-004)', async () => {
    const input = requestInput({
      specs,
      policy: policy([{ blockId: 'unusable', reason: 'superseded' }]),
    });
    const current = run(input);
    const legacy = run(requestInput({ specs }));
    const service = new CompilationTracePersistenceService(new InMemoryTraceStore());
    for (const result of [current, legacy]) {
      await service.store(result.trace);
      expect(await service.get(result.trace.request.scope, result.compilationId)).toEqual(
        result.trace,
      );
      const serialized = JSON.stringify(result.trace);
      expect(serialized).not.toContain('"content":');
      expect(serialized).not.toContain('"query":');
    }
    expect(legacy.trace.schemaVersion).toBe(2);
    const validator = new SettledCompilationTraceValidator();
    expect(validator.supportedSchemaVersions).toEqual([2, 3]);
    expect(() => validator.validate({ ...current.trace, schemaVersion: 2 })).toThrow();
    expect(() => validator.validate({ ...current.trace, schemaVersion: 4 })).toThrow();
    const diagnostic = diagnoseCompilation(input, compilerConfig(), wordTokenizer);
    expect(diagnostic.schemaVersion).toBe(2);
    expect(diagnostic.admissionPolicy.applicability).toEqual({
      scope: SCOPE,
      exclusions: [{ blockId: 'unusable', reason: 'superseded' }],
    });
    expect(diagnostic.groups.map((g) => g.finalDecision)).toEqual(
      current.trace.settlement.decisions,
    );
    expect(JSON.stringify(diagnoseCompilation(input, compilerConfig(), wordTokenizer))).toBe(
      JSON.stringify(diagnostic),
    );
  });
});

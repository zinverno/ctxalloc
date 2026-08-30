import {
  COMPILATION_POLICY_SCHEMA_VERSION,
  CompilationPolicyValidator,
  type CompilationPolicy,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  BudgetAllocator,
  CandidateFilter,
  CandidateScorer,
  ContextOrderer,
  INVALID_SLICE,
  SLICES,
  compilationPolicy,
} from './compilation-fixtures.js';
import { issueCodesOf, issuesOf, omit } from './filtering-fixtures.js';

/**
 * The broad compilation policy (DEC-036).
 *
 * It composes the five narrow stage slices. The wrapper is strict, every slice is
 * required, nothing is defaulted, and each slice is validated by the stage that
 * owns its rules.
 */

const validator = new CompilationPolicyValidator();

describe('CompilationPolicy composition', () => {
  it('publishes the schema version it accepts', () => {
    expect(COMPILATION_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a complete five-slice policy and returns it unchanged', () => {
    const input = compilationPolicy();
    const policy: CompilationPolicy = validator.validate(input);

    expect(policy).toEqual(input);
    expect(Object.keys(policy).sort()).toEqual([
      'allocation',
      'filtering',
      'ordering',
      'policyId',
      'policyVersion',
      'rendering',
      'schemaVersion',
      'scoring',
    ]);
  });

  it('requires all five slices: none is defaulted', () => {
    for (const slice of SLICES) {
      expect(
        issueCodesOf(() => validator.validate(omit(compilationPolicy(), slice))),
        `missing ${slice}`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('treats a no-op filter as an explicit slice, not a missing one', () => {
    const policy = validator.validate(
      compilationPolicy({
        filtering: { schemaVersion: 1, policyId: 'filtering', policyVersion: '3.0.0' },
      }),
    );

    expect(policy.filtering.policyId).toBe('filtering');
    expect(Object.keys(policy.filtering)).not.toContain('minimumTotalScore');
    expect(policy.filtering.minimumTotalScore).toBeUndefined();
  });

  it('rejects a parent schema version other than 1', () => {
    for (const schemaVersion of [0, 2, '1', null]) {
      expect(issueCodesOf(() => validator.validate(compilationPolicy({ schemaVersion })))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a blank parent identity', () => {
    expect(issuesOf(() => validator.validate(compilationPolicy({ policyId: '  ' })))[0]).toEqual({
      code: 'invalid_policy',
      path: ['policyId'],
      pointer: 'policyId',
      message: 'must not be empty or whitespace-only',
    });
    expect(
      issuesOf(() => validator.validate(compilationPolicy({ policyVersion: '' })))[0]?.pointer,
    ).toBe('policyVersion');
  });

  it('INV-BLOCK-007: rejects a malformed UTF-16 parent identity', () => {
    expect(
      issuesOf(() => validator.validate(compilationPolicy({ policyId: '\uDC00' })))[0]?.message,
    ).toBe('must be well-formed UTF-16');
  });

  it('rejects an unknown top-level field rather than stripping it', () => {
    for (const unknown of [
      { filter: {} },
      { trace: {} },
      { tokenizer: {} },
      { fingerprint: 'x' },
    ]) {
      expect(issueCodesOf(() => validator.validate(compilationPolicy(unknown)))).toEqual([
        'invalid_policy',
      ]);
    }
  });

  it('rejects a slice that is not an object', () => {
    for (const slice of SLICES) {
      for (const invalid of [null, 1, 'policy', [], true]) {
        expect(
          issueCodesOf(() => validator.validate(compilationPolicy({ [slice]: invalid }))),
        ).toEqual(['invalid_policy']);
      }
    }
  });

  it('rejects a policy that is not an object at all', () => {
    for (const invalid of [null, undefined, 1, 'policy', []]) {
      expect(issueCodesOf(() => validator.validate(invalid))).toEqual(['invalid_policy']);
    }
  });

  it('publishes a stable top-level error code', () => {
    try {
      validator.validate({});
    } catch (error) {
      expect((error as { code: string }).code).toBe('COMPILATION_POLICY_INVALID');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('short-circuits nested validation when the wrapper itself is malformed', () => {
    // Both the wrapper and two slices are wrong; only the wrapper is reported.
    const issues = issuesOf(() =>
      validator.validate({
        ...compilationPolicy({ schemaVersion: 9 }),
        filtering: INVALID_SLICE.filtering,
        ordering: INVALID_SLICE.ordering,
      }),
    );

    expect(issues.map((issue) => issue.code)).toEqual(['invalid_policy']);
    expect(issues[0]?.pointer).toBe('schemaVersion');
  });
});

describe('CompilationPolicy nested slice validation', () => {
  it.each(SLICES)('reports a %s failure under its own slice pointer and code', (slice) => {
    const issues = issuesOf(() =>
      validator.validate(compilationPolicy({ [slice]: INVALID_SLICE[slice] })),
    );

    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.code).toBe(`invalid_${slice}_policy`);
      expect(issue.pointer.startsWith(`${slice}.`)).toBe(true);
    }
  });

  it('reuses the exact rule the owning stage enforces', () => {
    // The pointer inside the slice is the one CandidateScorer publishes, not a
    // second spelling invented here.
    const issues = issuesOf(() =>
      validator.validate(compilationPolicy({ scoring: INVALID_SLICE.scoring })),
    );
    expect(issues[0]?.pointer).toBe('scoring.authoredPriority.min');
  });

  it('collects problems from several slices deterministically, in pipeline order', () => {
    const issues = issuesOf(() =>
      validator.validate(
        compilationPolicy({
          scoring: INVALID_SLICE.scoring,
          filtering: INVALID_SLICE.filtering,
          allocation: INVALID_SLICE.allocation,
          ordering: INVALID_SLICE.ordering,
          rendering: INVALID_SLICE.rendering,
        }),
      ),
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      'invalid_scoring_policy',
      'invalid_filtering_policy',
      'invalid_allocation_policy',
      'invalid_ordering_policy',
      'invalid_rendering_policy',
    ]);
    expect(issues.map((issue) => issue.pointer)).toEqual([
      'scoring.authoredPriority.min',
      'filtering.minimumTotalScore',
      'allocation.categoryConstraints[0]',
      'ordering.strategy',
      'rendering.format',
    ]);
  });

  it('collects the same issues however the invalid keys were written', () => {
    const forward = issuesOf(() =>
      validator.validate({
        schemaVersion: 1,
        policyId: 'composition',
        policyVersion: '1.0.0',
        scoring: INVALID_SLICE.scoring,
        filtering: INVALID_SLICE.filtering,
        allocation: INVALID_SLICE.allocation,
        ordering: INVALID_SLICE.ordering,
        rendering: INVALID_SLICE.rendering,
      }),
    );
    const reversed = issuesOf(() =>
      validator.validate({
        rendering: INVALID_SLICE.rendering,
        ordering: INVALID_SLICE.ordering,
        allocation: INVALID_SLICE.allocation,
        filtering: INVALID_SLICE.filtering,
        scoring: INVALID_SLICE.scoring,
        policyVersion: '1.0.0',
        policyId: 'composition',
        schemaVersion: 1,
      }),
    );

    expect(reversed).toEqual(forward);
  });

  it('INV-ADAPTER-001: leaks no nested error object, only project-owned issues', () => {
    for (const issue of issuesOf(() =>
      validator.validate(compilationPolicy({ rendering: INVALID_SLICE.rendering })),
    )) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      expect(typeof issue.message).toBe('string');
    }
  });
});

describe('CompilationPolicy identity', () => {
  it('lets the parent and every slice carry independent identities', () => {
    const policy = validator.validate(compilationPolicy());

    expect(policy.policyId).toBe('composition');
    expect(policy.policyVersion).toBe('1.0.0');
    expect(policy.scoring.policyVersion).toBe('2.0.0');
    expect(policy.filtering.policyVersion).toBe('3.0.0');
    expect(policy.allocation.policyVersion).toBe('4.0.0');
    expect(policy.ordering.policyVersion).toBe('5.0.0');
    expect(policy.rendering.policyVersion).toBe('6.0.0');
  });

  it('accepts a parent identity equal to a slice identity without relating them', () => {
    const policy = validator.validate(
      compilationPolicy({ policyId: 'scoring', policyVersion: '2.0.0' }),
    );

    expect(policy.policyId).toBe('scoring');
    expect(policy.scoring.policyId).toBe('scoring');
  });

  it('INV-DET-003: generates no identifier, version, hash, or fingerprint', () => {
    const policy: Record<string, unknown> = { ...validator.validate(compilationPolicy()) };
    for (const generated of ['fingerprint', 'hash', 'id', 'createdAt', 'compiledAt']) {
      expect(Object.keys(policy)).not.toContain(generated);
    }
  });

  it('holds no component instance: it is data, not orchestration', () => {
    const policy: Record<string, unknown> = { ...validator.validate(compilationPolicy()) };
    for (const value of Object.values(policy)) {
      expect(typeof value === 'function').toBe(false);
      if (typeof value === 'object' && value !== null) {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      }
    }
    expect(JSON.parse(JSON.stringify(policy))).toEqual(compilationPolicy());
  });

  it('preserves exact identity strings without trimming them', () => {
    const policy = validator.validate(compilationPolicy({ policyId: ' Composition ' }));
    expect(policy.policyId).toBe(' Composition ');
  });

  it('does not mutate the supplied input', () => {
    const input = compilationPolicy();
    const before = structuredClone(input);
    validator.validate(input);
    expect(input).toEqual(before);
  });
});

/**
 * The composed validator delegates to the stage that owns each slice, through
 * the same helper that stage's constructor uses, so neither path can accept or
 * reject what the other would not (INV-DEP-003).
 *
 * These are the regressions for the internal extraction Phase 13 performed: the
 * Phase 9 to Phase 12 constructors kept their exact behavior.
 */
describe('CompilationPolicy delegates to stage-owned validation', () => {
  const construct: Record<(typeof SLICES)[number], ((slice: unknown) => unknown) | undefined> = {
    scoring: (slice) => new CandidateScorer(slice),
    filtering: (slice) => new CandidateFilter(slice),
    allocation: (slice) => new BudgetAllocator(slice),
    ordering: (slice) => new ContextOrderer(slice),
    // ContextRenderer additionally requires a tokenizer, which a policy record
    // does not carry, so its policy rules are compared by their issues alone.
    rendering: undefined,
  };

  it.each(SLICES)('accepts exactly the valid %s slice the stage accepts', (slice) => {
    const build = construct[slice];
    if (build === undefined) return;
    const valid = (compilationPolicy() as Record<string, unknown>)[slice];

    expect(() => build(valid)).not.toThrow();
    expect(() => validator.validate(compilationPolicy())).not.toThrow();
  });

  it.each(SLICES)('reports the same issues for an invalid %s slice as the stage does', (slice) => {
    const build = construct[slice];
    if (build === undefined) return;

    const stageIssues = issuesOf(() => build(INVALID_SLICE[slice]));
    const composedIssues = issuesOf(() =>
      validator.validate(compilationPolicy({ [slice]: INVALID_SLICE[slice] })),
    );

    expect(composedIssues).toHaveLength(stageIssues.length);
    expect(composedIssues.map((issue) => issue.message)).toEqual(
      stageIssues.map((issue) => issue.message),
    );
    // Only the address gains the slice; the rule and its wording are the stage's.
    expect(composedIssues.map((issue) => issue.pointer)).toEqual(
      stageIssues.map((issue) => `${slice}.${issue.pointer}`),
    );
  });

  it('rejects a duplicate scoring rule exactly as CandidateScorer does', () => {
    const duplicate = {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '2.0.0',
      categoryPriority: {
        weight: 1,
        defaultValue: 0,
        byCategory: [
          { category: 'facts', value: 1 },
          { category: 'facts', value: 0.5 },
        ],
      },
    };

    const stageIssues = issuesOf(() => new CandidateScorer(duplicate));
    const composedIssues = issuesOf(() =>
      validator.validate(compilationPolicy({ scoring: duplicate })),
    );

    expect(stageIssues[0]?.code).toBe('duplicate_category_priority');
    expect(composedIssues[0]?.code).toBe('invalid_scoring_policy');
    expect(composedIssues[0]?.message).toBe(stageIssues[0]?.message);
  });

  it('rejects a duplicate category constraint exactly as BudgetAllocator does', () => {
    const duplicate = {
      schemaVersion: 1,
      policyId: 'allocation',
      policyVersion: '4.0.0',
      optionalSelection: 'score-desc-greedy',
      categoryConstraints: [
        { category: 'facts', maxBlocks: 2 },
        { category: 'facts', minBlocks: 1 },
      ],
    };

    const stageIssues = issuesOf(() => new BudgetAllocator(duplicate));
    const composedIssues = issuesOf(() =>
      validator.validate(compilationPolicy({ allocation: duplicate })),
    );

    expect(stageIssues[0]?.code).toBe('duplicate_category_constraint');
    expect(composedIssues[0]?.message).toBe(stageIssues[0]?.message);
    expect(composedIssues[0]?.pointer).toBe(`allocation.${stageIssues[0]?.pointer ?? ''}`);
  });
});

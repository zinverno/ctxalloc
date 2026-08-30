import { describe, expect, it } from 'vitest';
import {
  buildTrace,
  candidateOf,
  dispositionsOf,
  groupFor,
  runPipeline,
  trace,
  tracePolicy,
  wordTokenizer,
  type CandidateSpec,
} from './trace-fixtures.js';

/**
 * Score, filtering, allocation, ordering, and rendering evidence in the trace
 * (INV-TRACE-002, INV-TRACE-004, DEC-037).
 *
 * Every value here is copied from the stage that produced it. Nothing is
 * re-derived from a policy, and no reason is reinterpreted.
 */

/** A policy filtering optional candidates whose total score is below 0.3. */
function threshold(minimumTotalScore = 0.3): Record<string, unknown> {
  return tracePolicy({
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '3.0.0',
      minimumTotalScore,
    },
  });
}

/** required + high + low(filtered) + big(budget-excluded). */
const MIXED: readonly CandidateSpec[] = [
  { id: 'req', tokens: 5, priority: 0, required: true },
  { id: 'high', tokens: 4, priority: 900 },
  { id: 'low', tokens: 7, priority: 100 },
  { id: 'big', tokens: 20, priority: 500 },
];

function mixedTrace(): ReturnType<typeof trace> {
  return trace({ specs: MIXED, policy: threshold(), available: 10 });
}

describe('INV-SCORE-001: the score is copied from the scorer', () => {
  it('carries the exact CandidateScore of every group, components included', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    for (const scored of run.scored.candidates) {
      const group = groupFor(built, scored.candidate.canonicalBlock.id);
      expect(group.score).toStrictEqual(scored.score);
    }
    expect(groupFor(built, 'high').score.total).toBeCloseTo(0.9, 12);
    expect(groupFor(built, 'high').score.authoredPriority?.weight).toBe(1);
    expect(groupFor(built, 'high').score.authoredPriority?.evidence).toHaveLength(1);
  });

  it('INV-SCORE-003: a required block keeps the score it actually earned', () => {
    const built = mixedTrace();
    // Required status is an allocation class, never a boosted number.
    expect(groupFor(built, 'req').score.total).toBe(0);
    expect(groupFor(built, 'req').currentDisposition).toBe('included');
  });
});

describe('INV-TRACE-002: every filtering decision keeps its exact evidence', () => {
  it('records a required bypass with no score operand at all', () => {
    const filtering = groupFor(mixedTrace(), 'req').filtering;

    expect(filtering).toStrictEqual({ decision: 'eligible', reason: 'ELIGIBLE_REQUIRED' });
    expect(Object.keys(filtering)).not.toContain('scoreTotal');
    expect(Object.keys(filtering)).not.toContain('minimumTotalScore');
  });

  it('records a policy-eligible decision with both operands when a threshold exists', () => {
    const filtering = groupFor(mixedTrace(), 'high').filtering;

    expect(filtering.decision).toBe('eligible');
    expect(filtering.reason).toBe('ELIGIBLE_POLICY');
    expect(filtering).toMatchObject({ minimumTotalScore: 0.3 });
    expect((filtering as { scoreTotal: number }).scoreTotal).toBeCloseTo(0.9, 12);
  });

  it('omits the minimum when the policy configured none', () => {
    const filtering = groupFor(
      trace({ specs: [{ id: 'solo', tokens: 2, priority: 500 }] }),
      'solo',
    ).filtering;

    expect(filtering.reason).toBe('ELIGIBLE_POLICY');
    expect(Object.keys(filtering)).not.toContain('minimumTotalScore');
  });

  it('records a filtered decision with both exact operands', () => {
    const filtering = groupFor(mixedTrace(), 'low').filtering;

    expect(filtering.decision).toBe('filtered');
    expect(filtering.reason).toBe('FILTERED_SCORE_BELOW_MINIMUM');
    expect((filtering as { scoreTotal: number }).scoreTotal).toBeCloseTo(0.1, 12);
    expect((filtering as { minimumTotalScore: number }).minimumTotalScore).toBe(0.3);
  });

  it('gives a filtered group no allocation decision at all', () => {
    const group = groupFor(mixedTrace(), 'low');

    expect(Object.keys(group)).not.toContain('allocation');
    expect(group.allocation).toBeUndefined();
    expect(group.currentDisposition).toBe('filtered');
  });
});

describe('INV-TRACE-002: every allocation decision keeps its exact reason', () => {
  it('records the reason the allocator gave, for every eligible group', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(groupFor(built, 'req').allocation).toStrictEqual({
      decision: 'included',
      reason: 'INCLUDED_REQUIRED',
    });
    expect(groupFor(built, 'high').allocation).toStrictEqual({
      decision: 'included',
      reason: 'INCLUDED_SCORE_ORDER',
    });
    expect(groupFor(built, 'big').allocation).toStrictEqual({
      decision: 'excluded',
      reason: 'EXCLUDED_BUDGET_EXHAUSTED',
    });

    // Each reason is the allocator's own, not one this projection re-derived.
    for (const decision of [...run.allocated.included, ...run.allocated.excluded]) {
      const id = decision.candidate.candidate.canonicalBlock.id;
      expect(groupFor(built, id).allocation?.reason).toBe(decision.reason);
    }
  });

  it('records a category-minimum inclusion and a category-maximum exclusion', () => {
    const built = trace({
      specs: [
        { id: 'note-a', tokens: 2, priority: 900, category: 'notes' },
        { id: 'note-b', tokens: 2, priority: 800, category: 'notes' },
        { id: 'fact-a', tokens: 2, priority: 10, category: 'facts' },
      ],
      available: 10,
      policy: tracePolicy({
        allocation: {
          schemaVersion: 1,
          policyId: 'allocation',
          policyVersion: '4.0.0',
          optionalSelection: 'score-desc-greedy',
          categoryConstraints: [
            { category: 'facts', minBlocks: 1 },
            { category: 'notes', maxBlocks: 1 },
          ],
        },
      }),
    });

    expect(groupFor(built, 'fact-a').allocation?.reason).toBe('INCLUDED_CATEGORY_MINIMUM');
    expect(groupFor(built, 'note-b').allocation?.reason).toBe('EXCLUDED_CATEGORY_MAXIMUM');
    expect(dispositionsOf(built)['note-b']).toBe('excluded');
  });

  it('gives every group exactly one current disposition', () => {
    const built = mixedTrace();

    expect(dispositionsOf(built)).toEqual({
      big: 'excluded',
      high: 'included',
      low: 'filtered',
      req: 'included',
    });
    for (const group of built.groups) {
      expect(['filtered', 'included', 'excluded']).toContain(group.currentDisposition);
    }
  });

  it('DEC-037: names the disposition current, never final', () => {
    const built = mixedTrace();
    for (const group of built.groups) {
      expect(Object.keys(group)).toContain('currentDisposition');
      expect(Object.keys(group)).not.toContain('finalDisposition');
    }
  });
});

describe('INV-TRACE-004: the trace matches the rendered attempt', () => {
  it('gives every included group its exact zero-based render position', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    run.ordered.orderedIncluded.forEach((decision, index) => {
      const id = decision.candidate.candidate.canonicalBlock.id;
      expect(groupFor(built, id).renderPosition).toBe(index);
    });
  });

  it('gives filtered and allocation-excluded groups no render position', () => {
    const built = mixedTrace();
    for (const id of ['low', 'big']) {
      expect(Object.keys(groupFor(built, id)), `${id} has a render position`).not.toContain(
        'renderPosition',
      );
    }
  });

  it('render positions are unique and cover exactly zero to includedCount - 1', () => {
    const built = mixedTrace();
    const positions = built.groups
      .map((group) => group.renderPosition)
      .filter((position): position is number => position !== undefined);
    const included = built.groups.filter((group) => group.currentDisposition === 'included');

    expect(positions).toHaveLength(included.length);
    expect([...positions].sort((a, b) => a - b)).toEqual(
      Array.from({ length: included.length }, (_, index) => index),
    );
  });

  it('records the ordered block identifiers as exactly the ordered sequence', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(built.ordering.orderedBlockIds).toEqual(
      run.ordered.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    );
    // Every rendered record corresponds to an included group and vice versa.
    const renderedIds = run.rendered.renderedContext
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { blockId: string }).blockId);
    expect(renderedIds).toEqual([...built.ordering.orderedBlockIds]);
  });
});

describe('the allocation summary is the allocator, copied exactly', () => {
  it('copies the budget observation and the two decision sequences', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(built.allocation.availableInputTokens).toBe(10);
    expect(built.allocation.selectedBlockContentTokens).toBe(9);
    expect(built.allocation.unallocatedBlockContentTokens).toBe(1);
    expect(built.allocation.includedBlockIds).toEqual(
      run.allocated.included.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    );
    expect(built.allocation.excludedBlockIds).toEqual(
      run.allocated.excluded.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    );
  });

  it('DEC-034: allocation chronology stays distinct from render order', () => {
    // Blocks whose source positions reverse their allocation chronology.
    const built = trace({
      specs: [
        {
          id: 'late-high',
          tokens: 2,
          priority: 900,
          sourceLocation: { kind: 'text-range', startOffset: 500, endOffset: 507 },
        },
        {
          id: 'early-low',
          tokens: 2,
          priority: 100,
          sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: 7 },
        },
      ],
      available: 10,
    });

    expect(built.allocation.includedBlockIds).toEqual(['late-high', 'early-low']);
    expect(built.ordering.orderedBlockIds).toEqual(['early-low', 'late-high']);
    expect(groupFor(built, 'early-low').renderPosition).toBe(0);
  });

  it('INV-ALLOC-006: copies the eviction order exactly and never sorts it', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(built.allocation.optionalEvictionOrder).toEqual([
      ...run.allocated.optionalEvictionOrder,
    ]);
    // It is not the render order and not a sorted list.
    expect(built.allocation.optionalEvictionOrder).not.toContain('req');
    const sorted = [...built.allocation.optionalEvictionOrder].sort();
    expect(built.allocation.optionalEvictionOrder.length).toBe(sorted.length);
  });

  it('publishes an eviction order in the allocator sequence, not the ordered sequence', () => {
    const run = runPipeline({
      specs: [
        {
          id: 'a-late',
          tokens: 2,
          priority: 100,
          sourceLocation: { kind: 'text-range', startOffset: 500, endOffset: 507 },
        },
        {
          id: 'z-early',
          tokens: 2,
          priority: 900,
          sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: 7 },
        },
      ],
      available: 10,
    });
    const built = buildTrace(run);

    expect(built.allocation.optionalEvictionOrder).toEqual([
      ...run.allocated.optionalEvictionOrder,
    ]);
    expect(built.allocation.optionalEvictionOrder).not.toEqual(built.ordering.orderedBlockIds);
  });
});

describe('the rendering summary is a hash and a count', () => {
  it('copies renderedTokens and fitsAvailableInputBudget exactly', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(built.rendering.renderedTokens).toBe(run.rendered.renderedTokens);
    expect(built.rendering.renderedTokens).toBe(
      wordTokenizer.countTokens(run.rendered.renderedContext),
    );
    expect(built.rendering.fitsAvailableInputBudget).toBe(run.rendered.fitsAvailableInputBudget);
  });

  it('the rendered hash changes with the exact rendered bytes', () => {
    const first = trace({ specs: [{ id: 'alpha', tokens: 2 }], available: 50 });
    const second = trace({ specs: [{ id: 'alpha', tokens: 3 }], available: 50 });
    const same = trace({ specs: [{ id: 'alpha', tokens: 2 }], available: 50 });

    expect(second.rendering.renderedContextHash).not.toBe(first.rendering.renderedContextHash);
    expect(same.rendering.renderedContextHash).toBe(first.rendering.renderedContextHash);
    expect(first.rendering.renderedContextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('INV-SEC-003: never exposes the rendered string itself', () => {
    const run = runPipeline({ specs: MIXED, policy: threshold(), available: 10 });
    const built = buildTrace(run);

    expect(Object.keys(built.rendering).sort()).toEqual([
      'fitsAvailableInputBudget',
      'renderedContextHash',
      'renderedTokens',
    ]);
    expect(JSON.stringify(built)).not.toContain(run.rendered.renderedContext.slice(0, 40));
  });

  it('hashes an empty rendered context deterministically', () => {
    const empty = trace({ specs: [], sourceDocuments: [] });
    expect(empty.rendering.renderedTokens).toBe(0);
    expect(empty.rendering.renderedContextHash).toBe(
      trace({ specs: [], sourceDocuments: [] }).rendering.renderedContextHash,
    );
  });
});

describe('DEC-037: the traced decision vocabulary admits no impossible pairing', () => {
  it('never pairs a filtered group with an eligible reason or an allocation', () => {
    const built = mixedTrace();
    for (const group of built.groups) {
      if (group.currentDisposition === 'filtered') {
        expect(group.filtering.decision).toBe('filtered');
        expect(group.allocation).toBeUndefined();
        continue;
      }
      expect(group.filtering.decision).toBe('eligible');
      expect(group.allocation?.decision).toBe(group.currentDisposition);
    }
  });

  it('uses only the documented reason codes', () => {
    const built = trace({
      specs: [...MIXED, { id: 'extra', tokens: 1, priority: 400 }],
      policy: threshold(),
      available: 10,
    });

    for (const group of built.groups) {
      expect(['ELIGIBLE_REQUIRED', 'ELIGIBLE_POLICY', 'FILTERED_SCORE_BELOW_MINIMUM']).toContain(
        group.filtering.reason,
      );
      if (group.allocation !== undefined) {
        expect([
          'INCLUDED_REQUIRED',
          'INCLUDED_CATEGORY_MINIMUM',
          'INCLUDED_SCORE_ORDER',
          'EXCLUDED_CATEGORY_MAXIMUM',
          'EXCLUDED_BUDGET_EXHAUSTED',
        ]).toContain(group.allocation.reason);
      }
    }
  });

  it('leaves the allocation absent rather than present with undefined', () => {
    const serialized = JSON.parse(JSON.stringify(mixedTrace())) as {
      groups: readonly Record<string, unknown>[];
    };
    const filtered = serialized.groups.find((group) => group['currentDisposition'] === 'filtered');
    expect(filtered).toBeDefined();
    expect(Object.keys(filtered ?? {})).not.toContain('allocation');
  });
});

describe('the trace never contradicts the candidate the request supplied', () => {
  it('covers every request candidate through group membership', () => {
    const wrapper = candidateOf({ id: 'twice', tokens: 2 });
    const built = trace({ candidates: [wrapper, wrapper, candidateOf({ id: 'once', tokens: 2 })] });

    expect(built.request.candidateCount).toBe(3);
    expect(built.totals.candidateCount).toBe(3);
    expect(built.groups.flatMap((group) => group.members)).toHaveLength(3);
  });
});

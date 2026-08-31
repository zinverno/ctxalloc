import { describe, expect, it } from 'vitest';
import {
  allocationSlice,
  compile,
  compilerConfig,
  compilerPolicy,
  failureOf,
  finalReasons,
  includedIds,
  mixedPenaltyTokenizer,
  recordCountTokenizer,
  renderedIds,
  type CandidateSpec,
} from './compiler-fixtures.js';

/**
 * The rescue phase, and why a fallback without one would be unsound (DEC-038).
 *
 * The `Tokenizer` port promises the exact count of one supplied string and
 * nothing more. It does **not** promise monotonicity:
 *
 * ```text
 * S over budget   does not imply   every superset of S is over budget
 * ```
 *
 * Two invalid inferences follow if that is forgotten, and this file pins that
 * neither is made:
 *
 * 1. a required-only selection over the budget is not a token lower bound;
 * 2. exhausting the **minimal** policy-valid bases is not a global proof.
 */

/* -------------------------------------------------------------------------- */
/* A. Required-only is over budget, and a superset containing it fits          */
/* -------------------------------------------------------------------------- */

/**
 * ```text
 * R   required, 2 content tokens
 * X   optional, 2 content tokens, 10 rendered penalty tokens
 * Y   optional, 2 content tokens
 * available 8, plus 10 rendered tokens whenever the string holds ONE record
 *
 * {R, X, Y}  words 6 + 10 (X) +  0 = 16   > 8   the allocator's selection
 * {R, X}     words 4 + 10 (X) +  0 = 14   > 8   first eviction prefix
 * {R}        words 2 +  0     + 10 = 12   > 8   required-only, and NOT a floor
 * {R, Y}     words 4 +  0     +  0 =  4  <= 8   fits
 * ```
 *
 * `{R}` is a strict subset of `{R, Y}` and renders to more tokens. Failing at the
 * required-only probe would reject a compilation that demonstrably succeeds.
 */
const NON_MONOTONIC_SPECS: readonly CandidateSpec[] = [
  { id: 'R', tokens: 2, required: true, priority: 0 },
  { id: 'X', tokens: 2, priority: 900 },
  { id: 'Y', tokens: 2, priority: 100 },
];

const NON_MONOTONIC_TOKENIZER = mixedPenaltyTokenizer({ X: 10 }, { 1: 10 }, 'test:non-monotonic');

function nonMonotonic(
  config: Record<string, unknown> = compilerConfig(),
): ReturnType<typeof compile> {
  return compile({ specs: NON_MONOTONIC_SPECS, available: 8 }, NON_MONOTONIC_TOKENIZER, config);
}

describe('DEC-038: a required-only overrun is a measurement, not a verdict', () => {
  it('the fixture really is non-monotonic', () => {
    const render = (ids: readonly string[]): number =>
      NON_MONOTONIC_TOKENIZER.countTokens(
        ids
          .map(
            (id) =>
              `{"blockId":"${id}","content":"${id} w0","sourceDocumentId":"doc-1","sourceType":"markdown"}`,
          )
          .join('\n'),
      );

    expect(render(['R'])).toBe(12);
    expect(render(['R', 'Y'])).toBe(4);
    // A strict superset of an over-budget selection renders well within budget.
    expect(render(['R', 'Y'])).toBeLessThan(render(['R']));
  });

  it('does not fail at the probe, and compiles successfully', () => {
    expect(nonMonotonic).not.toThrow();
    expect(nonMonotonic().trace.settled).toBe(true);
  });

  it('INV-BUDGET-003: the required block is still included', () => {
    const result = nonMonotonic();
    expect(includedIds(result)).toContain('R');
    expect(finalReasons(result)['R']).toBe('INCLUDED_REQUIRED');
  });

  it('settles the fitting superset the rescue found', () => {
    const result = nonMonotonic();

    expect([...includedIds(result)].sort()).toEqual(['R', 'Y']);
    expect(renderedIds(result)).toEqual(includedIds(result));
    expect(result.trace.settlement.fallbackSearch.phase).toBe('policy-selection-rescue');
    expect(result.trace.settlement.fallbackSearch.chosenBlockIds).toEqual(['R', 'Y']);
  });

  it('INV-BUDGET-001, INV-BUDGET-006: the exact final budget holds', () => {
    const result = nonMonotonic();

    expect(result.usage.compiledTokens).toBe(
      NON_MONOTONIC_TOKENIZER.countTokens(result.compiledContext),
    );
    expect(result.usage.compiledTokens).toBe(4);
    expect(result.usage.availableTokens).toBe(8);
    expect(result.usage.unusedTokens).toBe(4);
  });

  it('claims the rescue inclusions as the correction, not the allocator', () => {
    const result = nonMonotonic();

    expect(finalReasons(result)).toEqual({
      R: 'INCLUDED_REQUIRED',
      X: 'EXCLUDED_RENDER_AWARE_CORRECTION',
      Y: 'INCLUDED_RENDER_AWARE_CORRECTION',
    });
    // The allocator's own evidence is untouched: it included all three.
    expect([...result.trace.allocation.includedBlockIds].sort()).toEqual(['R', 'X', 'Y']);
  });

  it('INV-DET-001: repeats identically', () => {
    expect(nonMonotonic()).toEqual(nonMonotonic());
  });
});

/* -------------------------------------------------------------------------- */
/* B. Every minimal hard base is over budget, and a superset of one fits       */
/* -------------------------------------------------------------------------- */

/**
 * ```text
 * facts requires 1 block; available 10
 *
 * R     required,  2 content tokens
 * f1    facts,     1 content token
 * f2    facts,     2 content tokens
 * big   optional,  6 content tokens, 40 rendered penalty tokens
 * plus 40 rendered tokens whenever the string holds TWO records
 *
 * {R, f1, big}  words  9 + 40 (big) =  49   > 10   the allocator's selection
 * {R, f1}       words  3 + 40 (two) =  43   > 10   eviction prefix, hard base #1
 * {R, f2}       words  4 + 40 (two) =  44   > 10   hard base #2
 * {R, f1, f2}   words  5 +  0       =   5  <= 10   fits, and is not minimal
 * ```
 *
 * Both minimal bases are over budget. Concluding infeasibility there would be
 * wrong: a strict policy-valid superset of each renders comfortably.
 */
const SUPERSET_SPECS: readonly CandidateSpec[] = [
  { id: 'R', tokens: 2, required: true, priority: 0 },
  { id: 'f1', tokens: 1, category: 'facts', priority: 500 },
  { id: 'f2', tokens: 2, category: 'facts', priority: 400 },
  { id: 'big', tokens: 6, priority: 900 },
];

const SUPERSET_TOKENIZER = mixedPenaltyTokenizer({ big: 40 }, { 2: 40 }, 'test:superset');

const FACTS_POLICY = compilerPolicy({
  allocation: allocationSlice([{ category: 'facts', minBlocks: 1 }]),
});

function superset(): ReturnType<typeof compile> {
  return compile(
    { specs: SUPERSET_SPECS, available: 10, policy: FACTS_POLICY },
    SUPERSET_TOKENIZER,
  );
}

describe('DEC-038: exhausting the minimal hard bases is not a global proof', () => {
  it('the allocator picks the cheapest-by-content minimum and one surplus block', () => {
    const result = superset();
    expect([...result.trace.allocation.includedBlockIds].sort()).toEqual(['R', 'big', 'f1']);
  });

  it('does not fail after the hard bases: the rescue runs', () => {
    expect(superset).not.toThrow();
    expect(superset().trace.settlement.fallbackSearch.phase).toBe('policy-selection-rescue');
  });

  it('settles the strict policy-valid superset', () => {
    const result = superset();

    expect([...includedIds(result)].sort()).toEqual(['R', 'f1', 'f2']);
    expect(result.trace.settlement.fallbackSearch.chosenBlockIds).toEqual(['R', 'f1', 'f2']);
    // It carries two `facts` blocks where the minimum asks for one: the rescue
    // may include surplus, which is exactly what a minimal base cannot.
    expect(includedIds(result).filter((id) => id.startsWith('f'))).toHaveLength(2);
  });

  it('INV-BUDGET-001: the exact final budget holds', () => {
    const result = superset();
    expect(result.usage.compiledTokens).toBe(
      SUPERSET_TOKENIZER.countTokens(result.compiledContext),
    );
    expect(result.usage.compiledTokens).toBe(5);
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(10);
  });

  it('names every non-required rescue inclusion a correction inclusion', () => {
    expect(finalReasons(superset())).toEqual({
      R: 'INCLUDED_REQUIRED',
      big: 'EXCLUDED_RENDER_AWARE_CORRECTION',
      f1: 'INCLUDED_RENDER_AWARE_CORRECTION',
      f2: 'INCLUDED_RENDER_AWARE_CORRECTION',
    });
  });
});

/* -------------------------------------------------------------------------- */
/* C/D. True exhaustive failure                                                */
/* -------------------------------------------------------------------------- */

describe('DEC-038: infeasibility is claimed only after true exhaustion', () => {
  /** Every rendered string costs 50 tokens per record, so nothing can fit. */
  const HOPELESS = recordCountTokenizer({ 1: 50, 2: 100, 3: 150 }, 'test:hopeless');

  it('C: with no active category deficit, reports required content exhaustively', () => {
    const failure = failureOf(() =>
      compile(
        {
          specs: [
            { id: 'R', tokens: 2, required: true, priority: 0 },
            { id: 'X', tokens: 2, priority: 900 },
          ],
          available: 6,
        },
        HOPELESS,
      ),
    );

    expect(failure.stage).toBe('correction');
    expect(failure.issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
    // {R} and {R, X}: both visited and measured. With no active deficit both are
    // policy-valid too, but the message still separates the work from the claim.
    expect(failure.issues[0]?.message).toContain(
      'fallback search exhausted after visiting 2 unique selection(s)',
    );
    expect(failure.issues[0]?.message).toContain(
      'no policy-valid final selection containing every required block',
    );
    expect(failure.issues[0]?.message).not.toMatch(/\d+ policy-valid selection\(s\)/);
  });

  it('D: with an active category minimum, reports the hard constraints instead', () => {
    const failure = failureOf(() =>
      compile(
        {
          specs: [
            { id: 'R', tokens: 2, required: true, priority: 0 },
            { id: 'f1', tokens: 1, category: 'facts', priority: 500 },
            { id: 'f2', tokens: 1, category: 'facts', priority: 100 },
          ],
          available: 6,
          policy: FACTS_POLICY,
        },
        HOPELESS,
      ),
    );

    expect(failure.issues.map((issue) => issue.code)).toEqual([
      'rendered_hard_constraints_exceed_budget',
    ]);
    expect(failure.issues.map((issue) => issue.code)).not.toContain(
      'required_content_exceeds_budget',
    );
    expect(failure.issues.map((issue) => issue.code)).not.toContain(
      'correction_search_limit_exceeded',
    );
    expect(failure.issues[0]?.message).toContain('every category block-count constraint');
  });

  it('E: a bound reached before exhaustion is never an infeasibility claim', () => {
    const failure = failureOf(() =>
      compile(
        {
          specs: [
            { id: 'R', tokens: 2, required: true, priority: 0 },
            { id: 'X', tokens: 2, priority: 900 },
          ],
          available: 6,
        },
        HOPELESS,
        compilerConfig({ maxCorrectionSelections: 1 }),
      ),
    );

    expect(failure.issues.map((issue) => issue.code)).toEqual(['correction_search_limit_exceeded']);
    for (const code of [
      'required_content_exceeds_budget',
      'rendered_hard_constraints_exceed_budget',
    ]) {
      expect(failure.issues.map((issue) => issue.code)).not.toContain(code);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  COUNTEREXAMPLE_AVAILABLE,
  COUNTEREXAMPLE_SPECS,
  COUNTEREXAMPLE_TOKENIZER,
  FACTS_MINIMUM_POLICY,
  INFEASIBLE_SPECS,
  INFEASIBLE_TOKENIZER,
  compile,
  compilerConfig,
  failureOf,
  includedIds,
} from './compiler-fixtures.js';

/**
 * The explicit search bound, and the two failures it must not be confused with
 * (DEC-038).
 *
 * ```text
 * correction_search_limit_exceeded        stopped at the bound; feasibility unknown
 * rendered_hard_constraints_exceed_budget every policy-valid selection satisfying
 *                                         the category minimums was visited; none fits
 * required_content_exceeds_budget         every policy-valid selection containing
 *                                         every required block was visited; none fits
 * ```
 *
 * The bound counts **unique** selections across the whole fallback — the
 * required-only probe, every hard base, and every rescue selection — so a
 * selection reached twice is counted once.
 *
 * The bound keeps pathological input from hanging the compiler. It is never an
 * approximation presented as a proof.
 */

function withBound(maxCorrectionSelections: number): () => ReturnType<typeof compile> {
  return () =>
    compile(
      {
        specs: COUNTEREXAMPLE_SPECS,
        available: COUNTEREXAMPLE_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
      },
      COUNTEREXAMPLE_TOKENIZER,
      compilerConfig({ maxCorrectionSelections }),
    );
}

describe('DEC-038: the bounded fallback search', () => {
  it('stops before admitting a second unique selection when the bound is one', () => {
    const failure = failureOf(withBound(1));

    expect(failure.stage).toBe('correction');
    expect(failure.issues.map((issue) => issue.code)).toEqual(['correction_search_limit_exceeded']);
    expect(failure.issues[0]?.pointer).toBe('correction.fallbackSearch');
  });

  it('reports the configured maximum and the combinations actually visited', () => {
    let message = '';
    try {
      withBound(1)();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('configured maximum of 1 selection(s)');
    expect(message).toContain('not a proof that no policy-valid selection fits');
  });

  it('never claims the hard constraints are infeasible', () => {
    let message = '';
    try {
      withBound(1)();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('RENDERED_HARD_CONSTRAINTS_EXCEED_BUDGET');
    expect(message).not.toContain('REQUIRED_CONTENT_EXCEEDS_BUDGET');
    expect(failureOf(withBound(1)).issues.map((issue) => issue.code)).not.toContain(
      'rendered_hard_constraints_exceed_budget',
    );
  });

  it('returns no partial result', () => {
    expect(withBound(1)).toThrow();
    let returned: unknown;
    try {
      returned = withBound(1)();
    } catch {
      returned = undefined;
    }
    expect(returned).toBeUndefined();
  });

  it('attaches the compilation identifier and the unsettled snapshot', () => {
    const failure = failureOf(withBound(1));
    expect(failure.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((failure.trace as { settled: boolean }).settled).toBe(false);
  });

  it('changes the compilation identifier when the bound changes', () => {
    const bounded = failureOf(withBound(1)).compilationId;
    const larger = withBound(3)().compilationId;
    expect(bounded).not.toBe(larger);
  });

  it('finds the later fitting base once the bound allows it', () => {
    // Three unique selections: the required-only probe, the allocator-preferred
    // base {req, a}, and {req, b}, which fits.
    expect(failureOf(withBound(2)).issues.map((issue) => issue.code)).toEqual([
      'correction_search_limit_exceeded',
    ]);
    const result = withBound(3)();

    expect([...includedIds(result)].sort()).toEqual(['b', 'req']);
    expect(result.trace.settlement.fallbackSearch).toEqual({
      used: true,
      selectionsVisited: 3,
      maxSelections: 3,
      phase: 'hard-base',
      chosenBlockIds: ['b', 'req'],
    });
  });

  it('INV-DET-001: repeats identically at every bound', () => {
    expect(failureOf(withBound(1)).issues).toEqual(failureOf(withBound(1)).issues);
    expect(withBound(6)()).toEqual(withBound(6)());
  });
});

describe('DEC-038: exhaustive hard-constraint infeasibility', () => {
  function infeasible(): () => ReturnType<typeof compile> {
    return () =>
      compile(
        {
          specs: INFEASIBLE_SPECS,
          available: COUNTEREXAMPLE_AVAILABLE,
          policy: FACTS_MINIMUM_POLICY,
        },
        INFEASIBLE_TOKENIZER,
      );
  }

  it('blames the category minimums, not the required blocks', () => {
    let message = '';
    try {
      infeasible()();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('every category block-count constraint');
    // No claim that required-only is a floor: the failure is an exhaustion.
    expect(message).not.toContain('lower bound');
    expect(message).not.toContain('alone');
  });

  it('reports the work it did without calling all of it policy-valid', () => {
    let message = '';
    try {
      infeasible()();
    } catch (error) {
      message = (error as Error).message;
    }
    // Four unique selections were visited: the required-only probe, {req, a},
    // {req, b}, and the rescue's {req, a, b}. Only the last three are
    // policy-valid final selections — {req} violates the `facts` minimum — so
    // the count is reported as work and the exhaustion is stated separately.
    expect(message).toContain('fallback search exhausted after visiting 4 unique selection(s)');
    expect(message).toContain('no policy-valid final selection');
    expect(message).not.toContain('4 policy-valid selection(s)');
  });

  it('raises RENDERED_HARD_CONSTRAINTS_EXCEED_BUDGET', () => {
    const failure = failureOf(infeasible());
    expect(failure.stage).toBe('correction');
    expect(failure.issues.map((issue) => issue.code)).toEqual([
      'rendered_hard_constraints_exceed_budget',
    ]);
  });

  it('does not call it a required-content failure', () => {
    // Category minimums are policy constraints, not required-block attributes:
    // the caller's fix is a different one, so the code must be different too.
    const failure = failureOf(infeasible());
    expect(failure.issues.map((issue) => issue.code)).not.toContain(
      'required_content_exceeds_budget',
    );
    let message = '';
    try {
      infeasible()();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('REQUIRED_CONTENT_EXCEEDS_BUDGET');
  });

  it('does not call it a search-limit failure', () => {
    const failure = failureOf(infeasible());
    expect(failure.issues.map((issue) => issue.code)).not.toContain(
      'correction_search_limit_exceeded',
    );
  });

  it('returns no successful result', () => {
    expect(infeasible()).toThrow();
  });
});

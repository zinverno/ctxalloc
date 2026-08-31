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
 * rendered_hard_constraints_exceed_budget every base was visited and none fits
 * required_content_exceeds_budget         required blocks alone do not render
 * ```
 *
 * The bound keeps pathological input from hanging the compiler. It is never an
 * approximation presented as a proof.
 */

function withBound(maxHardMinimumCombinations: number): () => ReturnType<typeof compile> {
  return () =>
    compile(
      {
        specs: COUNTEREXAMPLE_SPECS,
        available: COUNTEREXAMPLE_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
      },
      COUNTEREXAMPLE_TOKENIZER,
      compilerConfig({ maxHardMinimumCombinations }),
    );
}

describe('DEC-038: the bounded hard-minimum search', () => {
  it('stops before visiting a second combination when the bound is one', () => {
    const failure = failureOf(withBound(1));

    expect(failure.stage).toBe('correction');
    expect(failure.issues.map((issue) => issue.code)).toEqual(['correction_search_limit_exceeded']);
    expect(failure.issues[0]?.pointer).toBe('correction.hardMinimumSearch');
  });

  it('reports the configured maximum and the combinations actually visited', () => {
    let message = '';
    try {
      withBound(1)();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('configured maximum of 1 combination(s)');
    expect(message).toContain('after visiting 1');
    expect(message).toContain('not a proof');
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
    const larger = withBound(2)().compilationId;
    expect(bounded).not.toBe(larger);
  });

  it('finds the later fitting base once the bound allows it', () => {
    const result = withBound(2)();

    expect([...includedIds(result)].sort()).toEqual(['b', 'req']);
    expect(result.trace.settlement.hardMinimumSearch).toEqual({
      used: true,
      combinationsVisited: 2,
      maxCombinations: 2,
      chosenHardBaseBlockIds: ['b', 'req'],
    });
  });

  it('INV-DET-001: repeats identically at every bound', () => {
    expect(failureOf(withBound(1)).issues).toEqual(failureOf(withBound(1)).issues);
    expect(withBound(5)()).toEqual(withBound(5)());
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

  it('proves the required blocks fit before blaming the category minimums', () => {
    let message = '';
    try {
      infeasible()();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('the required blocks render within the 8 available token(s)');
  });

  it('visits every content-valid base within the configured bound', () => {
    let message = '';
    try {
      infeasible()();
    } catch (error) {
      message = (error as Error).message;
    }
    // {req, a} and {req, b}: both content-valid, both rendered, neither fits.
    expect(message).toContain('none of the 2 policy-valid category-minimum base(s) does');
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

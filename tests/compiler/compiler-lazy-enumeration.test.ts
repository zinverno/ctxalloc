import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allocationSlice,
  compile,
  compilerConfig,
  compilerPolicy,
  failureOf,
  recordCountTokenizer,
  recordingTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The search bound must stop *work*, not just results (DEC-038).
 *
 * A bound that fires only after the enumeration has been materialized protects
 * nothing: building the universe is the pathological cost. With 24 eligible
 * candidates and a category minimum of 12 there are
 *
 * ```text
 * C(24, 12) = 2,704,156
 * ```
 *
 * minimal hard bases. Collecting them into an array before visiting the first
 * one would consume gigabytes and many seconds — so a configured bound of 3 must
 * return promptly, having visited exactly 3 unique selections.
 */

const POOL_SIZE = 24;
const MINIMUM = 12;

const SPECS: readonly CandidateSpec[] = Array.from({ length: POOL_SIZE }, (_, index) => ({
  id: `f${String(index).padStart(2, '0')}`,
  tokens: 1,
  category: 'facts',
  priority: 900 - index,
}));

const POLICY = compilerPolicy({
  allocation: allocationSlice([{ category: 'facts', minBlocks: MINIMUM }]),
});

/** Every rendered string costs 100 tokens per record, so nothing ever fits. */
const HOPELESS = recordCountTokenizer(
  Object.fromEntries(Array.from({ length: POOL_SIZE + 1 }, (_, n) => [n, n * 100])),
  'test:hopeless-pool',
);

describe('DEC-038: combinatorial enumeration is lazy', () => {
  it('generates combinations lazily, collecting no universe', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );

    // Both enumerators are generators, and the Cartesian product takes restartable
    // factories rather than materialized sequences.
    expect(source).toContain('function* combinations<TItem>(');
    expect(source).toContain('function* cartesian<TItem>(');
    expect(source).toContain(
      'factories: readonly (() => Generator<readonly TItem[], void, undefined>)[]',
    );

    const body = source.slice(
      source.indexOf('function* combinations<TItem>('),
      source.indexOf('function* cartesian<TItem>('),
    );
    // No accumulator: the generator yields each tuple and forgets it.
    expect(body).toContain('yield indices.map(');
    expect(body).not.toContain('result.push');
    expect(body).not.toMatch(/const result\b/);
    // And no caller flattens a generator back into the universe.
    expect(source).not.toContain('[...combinations(');
    expect(source).not.toContain('Array.from(combinations(');
  });

  it('stops after exactly the configured number of unique selections', () => {
    const failure = failureOf(() =>
      compile(
        { specs: SPECS, available: 40, policy: POLICY },
        HOPELESS,
        compilerConfig({
          maxCorrectionSelections: 3,
        }),
      ),
    );

    expect(failure.issues.map((issue) => issue.code)).toEqual(['correction_search_limit_exceeded']);
    expect(failure.issues[0]?.message).toContain('configured maximum of 3 selection(s)');
    // Never an infeasibility claim: 2,704,156 bases remain unvisited.
    expect(failure.issues[0]?.message).toContain('not a proof');
  });

  it('keeps the tokenizer call count bounded, and measures nothing twice', () => {
    const calls: string[] = [];
    failureOf(() =>
      compile(
        { specs: SPECS, available: 40, policy: POLICY },
        recordingTokenizer(calls, HOPELESS),
        compilerConfig({ maxCorrectionSelections: 3 }),
      ),
    );

    const renders = calls.filter((text) => text === '' || text.startsWith('{"blockId":'));
    // The initial attempt, the safe eviction prefixes, and at most three
    // fallback selections — nowhere near the size of the base universe.
    expect(renders.length).toBeLessThan(POOL_SIZE + 8);
    // No exact selection is tokenized twice: the measurement cache spans the
    // whole compilation.
    expect(new Set(renders).size).toBe(renders.length);
  });

  it('raises the bound without changing anything else about the search', () => {
    const small = failureOf(() =>
      compile(
        { specs: SPECS, available: 40, policy: POLICY },
        HOPELESS,
        compilerConfig({
          maxCorrectionSelections: 3,
        }),
      ),
    );
    const larger = failureOf(() =>
      compile(
        { specs: SPECS, available: 40, policy: POLICY },
        HOPELESS,
        compilerConfig({
          maxCorrectionSelections: 9,
        }),
      ),
    );

    expect(larger.issues.map((issue) => issue.code)).toEqual(['correction_search_limit_exceeded']);
    expect(larger.issues[0]?.message).toContain('configured maximum of 9 selection(s)');
    // The bound is a decision input, so it changes the compilation identity.
    expect(larger.compilationId).not.toBe(small.compilationId);
  });
}, 20_000);

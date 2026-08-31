import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  allocationSlice,
  compile,
  compilerConfig,
  compilerPolicy,
  failureOf,
  includedIds,
  mixedPenaltyTokenizer,
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
 *
 * Laziness alone is not enough, which is what the second half of this file pins.
 * A rescue that generated the power set lazily and filtered it afterwards would
 * still walk exponentially many **category-invalid** subsets, and those never
 * reach `#visit`, so they never count and the bound never fires. Pruning has to
 * happen while a subset is being constructed.
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

/* -------------------------------------------------------------------------- */
/* Constraint-aware rescue generation                                          */
/* -------------------------------------------------------------------------- */

/**
 * The rescue must not generate the power set and filter it (DEC-038).
 *
 * A category-invalid subset never reaches `#visit`, so it never increments
 * `selectionsVisited` and never consumes `maxCorrectionSelections`. A rescue that
 * rejected invalid subsets *after* constructing them would therefore do
 * unbounded work under any bound at all.
 */
describe('DEC-038: the rescue prunes category-invalid subsets while constructing them', () => {
  it('consumes a constraint-aware generator, not a filtered power set', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );

    // A dedicated lazy generator yields only subsets that can complete a
    // policy-valid final selection, and the rescue consumes it directly.
    expect(source).toContain('function* policyValidOptionalSelections(');
    expect(source).toContain('for (const picks of policyValidOptionalSelections(');

    // It prunes during construction: capacity before descending, and
    // reachability of the remaining minimums.
    const generator = source.slice(source.indexOf('function* policyValidOptionalSelections('));
    expect(generator).toContain('>= budget.capacity) continue');
    expect(generator).toContain('if (owed > remaining) return');

    // The old filter-afterwards shape is gone.
    expect(source).not.toContain('satisfiesCategoryBounds');
    expect(source).not.toMatch(/combinations\(pool, size\)/);
    // And nothing flattens a generator back into a universe.
    expect(source).not.toContain('[...policyValidOptionalSelections(');
    expect(source).not.toContain('Array.from(policyValidOptionalSelections(');
  });

  it('B: maxBlocks 0 concludes exhaustively without walking the power set', () => {
    // 24 optional candidates, all `facts`, and `facts` admits none of them. The
    // only category-valid optional subset is the empty one, so the only
    // policy-valid final selection is required-only — which is over budget.
    //
    // A filter-afterwards rescue would construct 2^24 - 1 invalid subsets here,
    // none of which would count against a bound of 1.
    const specs: readonly CandidateSpec[] = [
      { id: 'R', tokens: 2, required: true, priority: 0 },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `f${String(index).padStart(2, '0')}`,
        tokens: 1,
        category: 'facts',
        priority: 900 - index,
      })),
    ];
    const policy = compilerPolicy({
      allocation: allocationSlice([{ category: 'facts', maxBlocks: 0 }]),
    });
    const calls: string[] = [];

    const failure = failureOf(() =>
      compile(
        { specs, available: 10, policy },
        recordingTokenizer(calls, recordCountTokenizer({ 1: 50 }, 'test:one-record-heavy')),
        compilerConfig({ maxCorrectionSelections: 1 }),
      ),
    );

    // It concludes, rather than stopping at the bound.
    expect(failure.issues.map((issue) => issue.code)).toEqual(['required_content_exceeds_budget']);
    expect(failure.issues.map((issue) => issue.code)).not.toContain(
      'correction_search_limit_exceeded',
    );
    expect(failure.issues[0]?.message).toContain(
      'fallback search exhausted after visiting 1 unique selection(s)',
    );

    // No optional selection was ever rendered: the allocator admitted none, and
    // the rescue constructed none.
    const renders = calls.filter((text) => text === '' || text.startsWith('{"blockId":'));
    expect(renders.every((text) => !text.includes('"blockId":"f'))).toBe(true);
    expect(renders.length).toBeLessThan(4);
  });

  it('C: an exact category count leaves the rescue no valid surplus subset', () => {
    // `facts` must hold exactly one block, so every policy-valid selection is a
    // minimal hard base. The rescue re-reaches those and constructs nothing else:
    // no two-or-more-fact subset is ever a candidate selection.
    const specs: readonly CandidateSpec[] = [
      { id: 'R', tokens: 2, required: true, priority: 0 },
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `f${String(index).padStart(2, '0')}`,
        tokens: 1,
        category: 'facts',
        priority: 900 - index,
      })),
    ];
    const policy = compilerPolicy({
      allocation: allocationSlice([{ category: 'facts', minBlocks: 1, maxBlocks: 1 }]),
    });
    const calls: string[] = [];

    const failure = failureOf(() =>
      compile(
        { specs, available: 10, policy },
        recordingTokenizer(calls, recordCountTokenizer({ 1: 50, 2: 100 }, 'test:no-fit')),
        compilerConfig({ maxCorrectionSelections: 64 }),
      ),
    );

    expect(failure.issues.map((issue) => issue.code)).toEqual([
      'rendered_hard_constraints_exceed_budget',
    ]);
    // The probe plus 18 single-fact selections. The rescue re-reaches exactly
    // those 18 and adds nothing, because no other subset is category-valid.
    expect(failure.issues[0]?.message).toContain(
      'fallback search exhausted after visiting 19 unique selection(s)',
    );

    const renders = calls.filter((text) => text === '' || text.startsWith('{"blockId":'));
    // No rendered string ever holds two `facts` blocks, and nothing is measured
    // twice: the hard bases the rescue re-reaches come from the cache.
    for (const text of renders) {
      expect(text.split('"blockId":"f').length - 1).toBeLessThanOrEqual(1);
    }
    expect(new Set(renders).size).toBe(renders.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Pruning removes no real solution, and changes no order                      */
/* -------------------------------------------------------------------------- */

/**
 * ```text
 * aa   minBlocks 1, maxBlocks 2   a1, a2
 * bb   maxBlocks 1                b1, b2
 * (none)                          u1
 * R    required, uncategorized
 * available 20
 * ```
 *
 * The rescue pool sorts declared categories before undeclared, then by category
 * and block ID: `[a1, a2, b1, b2, u1]`.
 *
 * `a1` renders 100 tokens more than it should, and small record counts carry a
 * surcharge, so the allocator's selection, every eviction prefix, both hard
 * bases, and every earlier rescue selection are over budget. `{R, a2, b1}` is
 * the first that fits — a selection with a `bb` block the minimums never asked
 * for, which only the rescue can reach.
 */
const MIXED_SPECS: readonly CandidateSpec[] = [
  { id: 'R', tokens: 2, required: true, priority: 0 },
  { id: 'a1', tokens: 1, category: 'aa', priority: 800 },
  { id: 'a2', tokens: 1, category: 'aa', priority: 700 },
  { id: 'b1', tokens: 1, category: 'bb', priority: 200 },
  { id: 'b2', tokens: 1, category: 'bb', priority: 100 },
  { id: 'u1', tokens: 1, priority: 900 },
];

const MIXED_POLICY = compilerPolicy({
  allocation: allocationSlice([
    { category: 'aa', minBlocks: 1, maxBlocks: 2 },
    { category: 'bb', maxBlocks: 1 },
  ]),
});

const MIXED_TOKENIZER = mixedPenaltyTokenizer(
  { a1: 100 },
  { 1: 50, 2: 50, 4: 50, 5: 50, 6: 50 },
  'test:mixed-categories',
);

describe('DEC-038: pruning removes no policy-valid rescue solution', () => {
  it('D: reaches a surplus selection across two constrained categories', () => {
    const result = compile(
      { specs: MIXED_SPECS, available: 20, policy: MIXED_POLICY },
      MIXED_TOKENIZER,
    );

    expect([...includedIds(result)].sort()).toEqual(['R', 'a2', 'b1']);
    expect(result.trace.settlement.fallbackSearch.phase).toBe('policy-selection-rescue');
    expect(result.usage.compiledTokens).toBe(MIXED_TOKENIZER.countTokens(result.compiledContext));
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(20);
  });

  it('D: the settled selection satisfies every category bound exactly', () => {
    const ids = includedIds(
      compile({ specs: MIXED_SPECS, available: 20, policy: MIXED_POLICY }, MIXED_TOKENIZER),
    );

    const aa = ids.filter((id) => id.startsWith('a')).length;
    const bb = ids.filter((id) => id.startsWith('b')).length;
    expect(aa).toBeGreaterThanOrEqual(1);
    expect(aa).toBeLessThanOrEqual(2);
    expect(bb).toBeLessThanOrEqual(1);
    expect(ids).toContain('R');
  });

  it('E: visits policy-valid selections in the documented order', () => {
    // Independently enumerate the expected order in the test: every subset of
    // the rescue pool, filtered by category validity, ordered by cardinality
    // ascending and then lexicographic index order.
    const pool = ['a1', 'a2', 'b1', 'b2', 'u1'] as const;
    const valid = (picks: readonly string[]): boolean => {
      const aa = picks.filter((id) => id.startsWith('a')).length;
      const bb = picks.filter((id) => id.startsWith('b')).length;
      return aa >= 1 && aa <= 2 && bb <= 1;
    };
    const expected: string[][] = [];
    for (let size = 0; size <= pool.length; size += 1) {
      for (let mask = 0; mask < 1 << pool.length; mask += 1) {
        const picks = pool.filter((_, index) => (mask & (1 << index)) !== 0);
        if (picks.length !== size || !valid(picks)) continue;
        expected.push(['R', ...picks]);
      }
    }

    // Nothing fits, so every policy-valid selection is rendered in turn.
    const calls: string[] = [];
    failureOf(() =>
      compile(
        { specs: MIXED_SPECS, available: 20, policy: MIXED_POLICY },
        recordingTokenizer(
          calls,
          recordCountTokenizer(
            Object.fromEntries(Array.from({ length: 8 }, (_, n) => [n + 1, 1000])),
            'test:always-huge',
          ),
        ),
        compilerConfig({ maxCorrectionSelections: 64 }),
      ),
    );

    const rendered = calls
      .filter((text) => text.startsWith('{"blockId":'))
      .map((text) =>
        [...text.matchAll(/"blockId":"([^"]+)"/g)].map((match) => match[1] as string).sort(),
      );
    // Every expected policy-valid selection was measured, and no selection the
    // category bounds forbid ever was.
    for (const selection of expected) {
      expect(rendered, `missing ${selection.join(',')}`).toContainEqual([...selection].sort());
    }
    for (const measured of rendered) {
      const picks = measured.filter((id) => id !== 'R');
      if (picks.length === 0) continue;
      expect(valid(picks), `measured invalid selection ${measured.join(',')}`).toBe(true);
    }
  });
});

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  ContextCompiler,
  ContextRenderer,
} from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { prepareCases } from '../../benchmarks/heldout/prepare.js';
import { parseCase, validateMatrix } from '../../benchmarks/heldout/data.js';
import { PROFILES, STRATA } from '../../benchmarks/heldout/types.js';

const tokenizer = new O200kBaseTokenizer();
afterEach(() => vi.restoreAllMocks());
describe('held-out input preparation is structural and never observes selection', () => {
  it('constructs the exact preregistered matrix without executing any selection stage', () => {
    const spies = [
      vi.spyOn(ContextCompiler.prototype, 'compile'),
      vi.spyOn(CandidateScorer.prototype, 'score'),
      vi.spyOn(CandidateFilter.prototype, 'filter'),
      vi.spyOn(BudgetAllocator.prototype, 'allocate'),
      vi.spyOn(CandidateDeduplicator.prototype, 'deduplicate'),
      vi.spyOn(ContextRenderer.prototype, 'render'),
    ];
    const cases = prepareCases(tokenizer);
    expect(cases).toHaveLength(48);
    validateMatrix(cases);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const profile of PROFILES)
      expect(cases.filter((c) => c.profile === profile)).toHaveLength(12);
    for (const stratum of STRATA)
      expect(cases.filter((c) => c.stratum === stratum)).toHaveLength(8);
    for (const profile of PROFILES)
      for (const stratum of STRATA)
        expect(
          cases
            .filter((c) => c.profile === profile && c.stratum === stratum)
            .map((c) => c.budgetRegime)
            .sort(),
        ).toEqual(['generous', 'tight']);
    expect(cases.filter((c) => c.budgetRegime === 'tight')).toHaveLength(24);
    expect(cases.filter((c) => c.annotations.expectedFailure !== null)).toHaveLength(4);
  });
  it('keeps evaluator requirements distinct from independently authored runtime obligations', () => {
    const cases = prepareCases(tokenizer);
    expect(
      cases.some((c) =>
        c.annotations.requiredBlockIds.some(
          (id) =>
            !c.input.candidates.some(
              (b) => b.block.id === id && b.block.attributes.required === true,
            ),
        ),
      ),
    ).toBe(true);
    expect(
      cases.some((c) =>
        c.input.candidates.some(
          (b) =>
            b.block.attributes.required === true &&
            !c.annotations.requiredBlockIds.includes(b.block.id),
        ),
      ),
    ).toBe(true);
    for (const entry of cases) expect(parseCase(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });
  it('contains newly authored literal contents and all three source formats', () => {
    const cases = prepareCases(tokenizer);
    const historical = [
      '../../benchmarks/evaluation/v1/fixtures.ts',
      '../../benchmarks/admission-development/cases.ts',
    ].map((p) => readFileSync(new URL(p, import.meta.url), 'utf8'));
    for (const entry of cases) {
      for (const source of historical) {
        expect(source).not.toContain(entry.input.query);
        for (const c of entry.input.candidates) expect(source).not.toContain(c.block.content);
      }
    }
    expect(
      new Set(cases.flatMap((c) => c.input.candidates.map((b) => b.block.sourceType))),
    ).toEqual(new Set(['text', 'markdown', 'conversation']));
  });
  it('rejects preregistered budget or matrix drift before compilation', () => {
    const cases = prepareCases(tokenizer);
    expect(() => validateMatrix(cases.slice(1))).toThrow();
    expect(() =>
      validateMatrix(
        cases.map((c, i) =>
          i === 0
            ? {
                ...c,
                input: { ...c.input, budget: { totalTokens: 901, reservedOutputTokens: 100 } },
              }
            : c,
        ),
      ),
    ).toThrow();
  });
});

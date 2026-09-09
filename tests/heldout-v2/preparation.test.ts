import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  ContextCompiler,
  ContextOrderer,
  ContextRenderer,
} from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { prepareCases } from '../../benchmarks/heldout-v2/prepare.js';
import {
  authoringFinding,
  hashJson,
  object,
  parseCase,
  validateMatrix,
} from '../../benchmarks/heldout-v2/data.js';
import { validateFrozenCases } from '../../benchmarks/heldout-v2/integrity.js';
import { MATRIX, PROFILES, STRATA } from '../../benchmarks/heldout-v2/protocol.js';
import { SUPPORT } from '../../benchmarks/heldout-v2/profiles.js';
import { toySeeds } from './toy-fixtures.js';
const tokenizer = new O200kBaseTokenizer();
afterEach(() => vi.restoreAllMocks());
describe('Phase 21E structural preparation boundary; no held-out execution', () => {
  it('prepares and validates freeze records while every selection stage is forbidden', () => {
    const spies = [
      vi.spyOn(ContextCompiler.prototype, 'compile'),
      vi.spyOn(CandidateScorer.prototype, 'score'),
      vi.spyOn(CandidateFilter.prototype, 'filter'),
      vi.spyOn(BudgetAllocator.prototype, 'allocate'),
      vi.spyOn(CandidateDeduplicator.prototype, 'deduplicate'),
      vi.spyOn(ContextOrderer.prototype, 'order'),
      vi.spyOn(ContextRenderer.prototype, 'render'),
    ];
    for (const spy of spies)
      spy.mockImplementation(() => {
        throw new Error('Selection forbidden in preparation.');
      });
    const cases = prepareCases(toySeeds(), tokenizer);
    expect(validateFrozenCases(JSON.parse(JSON.stringify(cases)), tokenizer)).toEqual(cases);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(cases).toHaveLength(60);
    expect(cases.filter((c) => c.expectedFailure !== null)).toHaveLength(17);
    expect(
      cases.filter((c) => c.expectedFailure?.issueCode === 'incomplete_admission_evidence'),
    ).toHaveLength(7);
    for (const p of PROFILES) expect(cases.filter((c) => c.profile === p)).toHaveLength(12);
    for (const s of STRATA) expect(cases.filter((c) => c.stratum === s)).toHaveLength(10);
    expect(cases.filter((c) => c.budgetRegime === 'tight')).toHaveLength(30);
    expect(cases.filter((c) => c.evidenceCondition === 'misleading-complete')).toHaveLength(2);
  });
  it('keeps caller input hashes unchanged when evaluator truth changes', () => {
    const first = prepareCases(toySeeds(), tokenizer);
    const altered = toySeeds();
    altered[0]!.annotations.facts[0]!.required = false;
    altered[0]!.annotations.facts[0]!.importance = 'minor';
    altered[0]!.annotations.requiredBlockIds = [];
    const second = prepareCases(altered, tokenizer);
    expect(second.map((c) => hashJson(c.input))).toEqual(first.map((c) => hashJson(c.input)));
    expect(second[0]!.annotations).not.toEqual(first[0]!.annotations);
  });
  it('rejects budget, profile, annotation, reduction and matrix drift statically', () => {
    const cases = prepareCases(toySeeds(), tokenizer);
    expect(() => validateMatrix(cases.slice(1))).toThrow();
    const changed = structuredClone(cases[0]!);
    object(object(changed.input).budget).totalTokens = 999;
    expect(() => parseCase(changed, tokenizer)).toThrow('budget');
    const seed = toySeeds();
    seed[8]!.exclusions = [];
    expect(() => prepareCases(seed, tokenizer)).toThrow('applicability');
    const policy = structuredClone(cases[0]!);
    object(object(object(policy.input).policy).filtering).minimumTotalScore = 0.1;
    expect(() => parseCase(policy, tokenizer)).toThrow('profile semantics');
  });
  it('validates ignored/support contracts, numeric ranges, scope and completeness without scores', () => {
    const cases = prepareCases(toySeeds(), tokenizer);
    const input = object(structuredClone(cases[48]!.input));
    const candidates = input.candidates as { retrieval?: unknown }[];
    candidates[0]!.retrieval = {
      providerId: SUPPORT.providerId,
      providerVersion: '1',
      score: { value: 5, semantics: SUPPORT.semantics, higherIsBetter: true },
    };
    expect(authoringFinding(input, tokenizer)?.stage).toBe('evidence-validation');
    candidates[0]!.retrieval = {
      providerId: 'uncovered',
      providerVersion: '1',
      score: { value: 1, semantics: 'uncovered', higherIsBetter: true },
    };
    expect(authoringFinding(input, tokenizer)).toEqual({
      stage: 'evidence-validation',
      issueCode: 'retrieval_score_rule_not_found',
    });
    delete candidates[0]!.retrieval;
    expect(authoringFinding(input, tokenizer)).toBeNull();
    object(object(object(input.policy).scoring).evidence).completeness = [];
    expect(authoringFinding(input, tokenizer)?.stage).toBe('request-validation');
  });
  it('never determines reject-policy threshold outcomes during static preparation', () => {
    const cases = prepareCases(toySeeds(), tokenizer);
    for (const p of MATRIX.filter(
      (p) => p.expectedFailure?.issueCode === 'incomplete_admission_evidence',
    )) {
      expect(authoringFinding(cases.find((c) => c.id === p.id)!.input, tokenizer)).toBeNull();
    }
  });
});

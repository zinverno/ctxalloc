import { describe, expect, it } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { aggregateCases } from '../../benchmarks/heldout-v2/aggregate.js';
import { evaluateGates, verdict } from '../../benchmarks/heldout-v2/gates.js';
import { observeCases } from '../../benchmarks/heldout-v2/observe.js';
import { prepareCases } from '../../benchmarks/heldout-v2/prepare.js';
import { hashJson, object } from '../../benchmarks/heldout-v2/data.js';
import { reduction } from '../../benchmarks/heldout-v2/metrics.js';
import { toySeeds } from './toy-fixtures.js';
const tokenizer = new O200kBaseTokenizer();
describe('Phase 21E evaluator tested only with unrelated toy content', () => {
  it('measures actual successes and exact failures, baseline rendering and repeats', async () => {
    const specimens = prepareCases(toySeeds(), tokenizer);
    const observed = await observeCases([specimens[1]!, specimens[10]!], tokenizer);
    expect(observed.map((c) => c.status)).toEqual(['success', 'expected-failure']);
    expect(observed[0]!.contracts?.passed).toBe(true);
    expect(observed[0]!.correctness?.traceReconciliationRate).toEqual({
      numerator: 1,
      denominator: 1,
    });
    expect(observed[0]!.tokens?.fullRenderedTokens).toBeGreaterThan(
      observed[0]!.tokens!.compiledRenderedTokens,
    );
    expect(observed.every((c) => c.repeatAgreement && c.additionalCompilationAgrees)).toBe(true);
    expect(observed[1]!.selection).toBeNull();
    expect(aggregateCases(observed).overall.counts.matchedExpectedFailures).toBe(1);
    expect(JSON.stringify(observed)).not.toContain('Existing preparation test beta');
  });
  it('reports false complete evidence without treating semantic recovery as contract correctness', async () => {
    const seeds = toySeeds();
    seeds[7]!.blocks[1]!.priority = 0;
    seeds[7]!.blocks[2]!.priority = 0;
    seeds[7]!.blocks[3]!.priority = 4;
    const specimen = prepareCases(seeds, tokenizer)[7]!;
    const observed = await observeCases([specimen], tokenizer);
    expect(observed[0]!.status).toBe('success');
    expect(observed[0]!.contracts?.passed).toBe(true);
    expect(observed[0]!.selection?.ratios.optionalAdmissionRecall).toEqual({
      numerator: 0,
      denominator: 1,
    });
    const aggregate = aggregateCases(observed);
    expect(aggregate.overall.ratios.usefulBlockRecall.micro).toBe(0.5);
    expect(aggregate.primary.overall.counts.cases).toBe(0);
    expect(aggregate.misleadingRisk.ratios.irrelevantRejection.micro).toBe(0);
    const gates = evaluateGates(observed, aggregate);
    expect(gates.find((g) => g.id === 'admission')?.state).toBe('PASS');
    expect(gates.find((g) => g.id === 'outcomes')?.state).toBe('FAIL');
    expect(verdict(gates)).toBe('FAIL');
  });
  it('observes scored and ignored numeric wrappers under every fixed profile', async () => {
    const seeds = toySeeds().map((s) => ({
      ...s,
      blocks: s.blocks.map((b) => ({
        ...b,
        retrieval: {
          contract: b.key === 'n' ? 'auxiliary' : 'support',
          value: b.key === 'n' ? 99 : 3,
        },
      })),
      candidateOrder: [...s.candidateOrder, 'b'],
    }));
    const prepared = prepareCases(seeds, tokenizer);
    const observed = await observeCases(
      [1, 13, 33, 37, 49].map((i) => prepared[i]!),
      tokenizer,
    );
    expect(observed.map((c) => c.status)).toEqual(Array.from({ length: 5 }, () => 'success'));
    expect(observed.every((c) => c.contracts?.passed === true)).toBe(true);
    expect(observed.every((c) => c.repeatAgreement && c.additionalCompilationAgrees)).toBe(true);
  });
  it('does not let another profile rescue missing coverage; reduction stays unclamped', async () => {
    const specimen = prepareCases(toySeeds(), tokenizer)[1]!;
    const observed = await observeCases([specimen], tokenizer);
    const gates = evaluateGates(observed, aggregateCases(observed));
    expect(gates.find((g) => g.id === 'useful-blocks')?.state).toBe('NOT_EVALUATED');
    expect(verdict(gates)).toBe('FAIL');
    expect(reduction(100, 120)).toEqual({
      fullRenderedTokens: 100,
      compiledRenderedTokens: 120,
      tokensSaved: -20,
      ratio: -0.2,
    });
    const copy = structuredClone(specimen);
    object(object(copy.input).budget).totalTokens = 1;
    expect(hashJson(copy.input)).not.toBe(hashJson(specimen.input));
  });
});

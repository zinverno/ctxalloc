import { describe, expect, it } from 'vitest';
import { CompilationRequestValidator, ContextCompiler } from '@ctxalloc/compiler';
import { admissionProfile } from '../../benchmarks/admission-development/profiles.js';
import {
  aggregateRatio,
  distribution,
  factPreserved,
  measureSelection,
} from '../../benchmarks/heldout/metrics.js';
import { aggregateCases } from '../../benchmarks/heldout/aggregate.js';
import { evaluateGates, GATE_DEFINITIONS } from '../../benchmarks/heldout/gates.js';
import { observeCases } from '../../benchmarks/heldout/observe.js';
import { hashJson, parseCase } from '../../benchmarks/heldout/data.js';
import { COMPILER, PROFILES, type HeldoutCase } from '../../benchmarks/heldout/types.js';
import { requestInput, wordTokenizer } from '../compiler/compiler-fixtures.js';

function toy(): HeldoutCase {
  const input = new CompilationRequestValidator().validate(
    requestInput({
      available: 1000,
      specs: [
        { id: 'toy-a', content: 'amber ring', priority: 1 },
        { id: 'toy-b', content: 'blue bead', priority: 4 },
        { id: 'toy-c', content: 'blue bead', priority: 4 },
      ],
      policy: { ...admissionProfile('authored-support').policy },
    }),
  );
  return {
    id: 'unrelated-toy',
    profile: 'authored-support',
    stratum: 'direct-noise',
    replica: 0,
    budgetRegime: 'generous',
    input,
    annotations: {
      requiredBlockIds: ['toy-a'],
      units: [
        { id: 'toy-unit-a', blockIds: ['toy-a'], useful: true, applicability: 'applicable' },
        {
          id: 'toy-unit-b',
          blockIds: ['toy-b', 'toy-c'],
          useful: true,
          applicability: 'applicable',
        },
      ],
      facts: [
        {
          id: 'toy-fact',
          description: 'toy fact',
          useful: true,
          required: true,
          importance: 'critical',
          evidenceBlockGroups: [['toy-a']],
        },
      ],
      runtimeObligations: [],
      evidenceCondition: 'missing',
      ambiguityResolution: 'Toy-only evaluator mechanics; no held-out content.',
      expectedFailure: null,
    },
  };
}
describe('preregistered measurement mechanics using unrelated toy inputs', () => {
  it('does not translate evaluator-required labels into runtime required flags', () => {
    const entry = toy();
    const before = hashJson(entry.input);
    const result = new ContextCompiler(COMPILER, wordTokenizer).compile(entry.input);
    const measured = measureSelection(entry, result);
    expect(measured.ratios.requiredBlockRecall).toEqual({ numerator: 0, denominator: 1 });
    expect(measured.ratios.runtimeRequiredGroupRecall).toEqual({ numerator: 0, denominator: 0 });
    expect(measured.missingCriticalFactIds).toEqual(['toy-fact']);
    expect(hashJson(entry.input)).toBe(before);
  });
  it('counts duplicate evidence once and separates admission from final inclusion', () => {
    const entry = toy();
    const result = new ContextCompiler(COMPILER, wordTokenizer).compile(entry.input);
    const measured = measureSelection(entry, result);
    expect(measured.ratios.usefulBlockRecall).toEqual({ numerator: 1, denominator: 2 });
    expect(measured.ratios.optionalAdmissionPrecision).toEqual({ numerator: 1, denominator: 1 });
    expect(measured.falseExclusionUnitIds).toEqual(['toy-unit-a']);
    const tight = {
      ...entry,
      input: new CompilationRequestValidator().validate({
        ...entry.input,
        budget: { totalTokens: 0, reservedOutputTokens: 0 },
      }),
    };
    const cut = measureSelection(
      tight,
      new ContextCompiler(COMPILER, wordTokenizer).compile(tight.input),
    );
    expect(cut.ratios.optionalAdmissionRecall).toEqual(measured.ratios.optionalAdmissionRecall);
    expect(cut.ratios.usefulBlockRecall.numerator).toBe(0);
  });
  it('preserves the OR-of-AND fact rule without inventing semantic matching', () => {
    const fact = { ...toy().annotations.facts[0]!, evidenceBlockGroups: [['a', 'b'], ['c']] };
    expect(factPreserved(fact, new Set(['a']))).toBe(false);
    expect(factPreserved(fact, new Set(['a', 'b']))).toBe(true);
    expect(factPreserved(fact, new Set(['c']))).toBe(true);
  });
  it('distinguishes micro from macro and leaves absent denominators unmeasured', () => {
    const r = aggregateRatio([
      { numerator: 1, denominator: 1 },
      { numerator: 0, denominator: 3 },
      { numerator: 0, denominator: 0 },
    ]);
    expect(r.micro).toBe(0.25);
    expect(r.macro).toBe(0.5);
    expect(r.measuredCases).toBe(2);
    expect(r.leaveOneRequestOutMicroRange).toEqual({ minimum: 0, maximum: 1 });
    expect(aggregateRatio([{ numerator: 0, denominator: 0 }]).micro).toBeNull();
  });
  it('uses nearest-rank median and retains negative reductions', () => {
    expect(distribution([1, 4, 2, 3])?.median).toBe(2);
    expect(distribution([-1, 0, 0.5])?.minimum).toBe(-1);
    expect(distribution([])).toBeNull();
  });
  it('rejects annotation drift, duplicate-unit inflation and changed profiles before measurement', () => {
    const entry = toy();
    expect(parseCase(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    expect(() =>
      parseCase({ ...entry, annotations: { ...entry.annotations, requiredBlockIds: ['absent'] } }),
    ).toThrow();
    expect(() =>
      parseCase({
        ...entry,
        annotations: {
          ...entry.annotations,
          units: [
            ...entry.annotations.units,
            { ...entry.annotations.units[0], id: 'double-credit' },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      parseCase({
        ...entry,
        input: {
          ...entry.input,
          policy: {
            ...entry.input.policy,
            filtering: { ...entry.input.policy.filtering, minimumTotalScore: 0 },
          },
        },
      }),
    ).toThrow();
  });
  it('reuses actual harness measurements and reports failures without tuning gates', async () => {
    const cases = await observeCases([toy()], wordTokenizer);
    const report = aggregateCases(cases);
    const gates = evaluateGates(cases, report);
    expect(cases[0]!.additionalCompilationAgrees).toBe(true);
    expect(cases[0]!.harness.preservation?.requiredBlockRecall).toBe(0);
    expect(gates.find((g) => g.id === 'required-blocks')?.state).toBe('FAIL');
    expect(gates.find((g) => g.id === 'critical-facts')?.state).toBe('FAIL');
    expect(gates.find((g) => g.id === 'useful-preservation')?.state).toBe('FAIL');
    expect(gates).toHaveLength(13);
    expect(() => hashJson({ cases, report, gates })).not.toThrow();
    expect(JSON.stringify(cases)).not.toContain('amber ring');
    expect(JSON.stringify(cases)).not.toContain('blue bead');
    expect(await observeCases([toy()], wordTokenizer)).toEqual(cases);
  });
  it('accounts for expected foreign-scope failures without inventing preservation credit', async () => {
    const entry = toy();
    const negative: HeldoutCase = {
      ...entry,
      id: 'unrelated-foreign-toy',
      input: new CompilationRequestValidator().validate({
        ...entry.input,
        candidates: entry.input.candidates.map((c, index) =>
          index === 0
            ? { ...c, block: { ...c.block, scope: { tenantId: 'foreign', workspaceId: 'toy' } } }
            : c,
        ),
      }),
      annotations: {
        ...entry.annotations,
        expectedFailure: { stage: 'candidate-validation', issueCode: 'scope_mismatch' },
      },
    };
    const cases = await observeCases([negative], wordTokenizer);
    expect(cases[0]!.status).toBe('expected-failure');
    expect(cases[0]!.scopeDetections).toEqual({ numerator: 1, denominator: 1 });
    expect(cases[0]!.harness.determinism).toEqual({ executions: 3, matched: true });
    const aggregates = aggregateCases(cases);
    expect(aggregates.overall.counts.successes).toBe(0);
    expect(aggregates.overall.ratios.usefulBlockRecall.micro).toBeNull();
    expect(aggregates.overall.reduction.distribution).toBeNull();
    expect(() =>
      hashJson({ cases, aggregates, gates: evaluateGates(cases, aggregates) }),
    ).not.toThrow();
  });
  it('does not let a strong aggregate rescue a profile below the preservation floor', async () => {
    const [observed] = await observeCases([toy()], wordTokenizer);
    const rows = PROFILES.map((profile, index) => ({
      ...observed!,
      caseId: `toy-profile-${index}`,
      profile,
      selection: {
        ...observed!.selection!,
        ratios: {
          ...observed!.selection!.ratios,
          usefulBlockRecall:
            index === 0
              ? { numerator: 9, denominator: 10 }
              : { numerator: 1000, denominator: 1000 },
          usefulFactCoverage:
            index === 0
              ? { numerator: 9, denominator: 10 }
              : { numerator: 1000, denominator: 1000 },
        },
      },
    }));
    const aggregates = aggregateCases(rows);
    expect(aggregates.overall.ratios.usefulBlockRecall.micro).toBeGreaterThan(0.95);
    const gate = evaluateGates(rows, aggregates).find((g) => g.id === 'useful-preservation')!;
    expect(gate.state).toBe('FAIL');
    expect(new Set(gate.failures.map((f) => f.subject))).toEqual(new Set(['authored-support']));
    expect(aggregates.overall.correctness.ratios.provenanceCoverage?.micro).toBe(1);
    expect(aggregates.overall.correctness.repeatComparisons).toBe(8);
  });
  it('pins the preregistered thresholds independently of result observations', () => {
    expect(GATE_DEFINITIONS).toMatchObject({
      requiredPreservation: 1,
      criticalPreservation: 1,
      usefulProfileMinimum: 0.95,
      usefulCaseMinimum: 0.8,
      admissionPrecisionMinimum: 0.8,
      admissionRecallMinimum: 0.95,
      overallMedianReductionMinimum: 0.2,
      profileMedianReductionMinimum: 0.15,
      expectedScopeDetections: 4,
      expectedRepeatComparisons: 96,
    });
  });
});

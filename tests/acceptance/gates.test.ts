import { beforeAll, describe, expect, it } from 'vitest';
import { EvaluationHarness, type EvaluationReport } from '@ctxalloc/evaluation';
import { SystemMonotonicClock } from '@ctxalloc/adapters';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { ContextCompiler } from '@ctxalloc/compiler';
import { buildEvaluationSuiteV1 } from '../../benchmarks/evaluation/v1/index.js';
import { benchmarkCompilerConfig } from '../../benchmarks/evaluation/v1/fixtures.js';
import {
  contextGates,
  metric,
  overall,
  qualityGate,
  repeatedComparisons,
  type Gate,
} from '../../benchmarks/acceptance/gates.js';
import { measureCorrectness, scopeDetections } from '../../benchmarks/acceptance/correctness.js';
import { buildAcceptanceReport } from '../../benchmarks/acceptance/report.js';
import { runConfig } from '../evaluation/evaluation-fixtures.js';

let tokenizer: O200kBaseTokenizer;
let validation: EvaluationReport;
let longContext: EvaluationReport;
beforeAll(async () => {
  tokenizer = new O200kBaseTokenizer();
  const suite = buildEvaluationSuiteV1(tokenizer);
  const harness = new EvaluationHarness(
    benchmarkCompilerConfig(),
    tokenizer,
    new SystemMonotonicClock(),
  );
  validation = await harness.runSuite(
    runConfig(),
    suite.filter((c) => c.datasetSplit === 'validation'),
  );
  longContext = await harness.runSuite(
    runConfig(),
    suite.filter((c) => c.datasetSplit === 'validation' && c.tags.includes('long-context')),
  );
});
const gate = (state: Gate['state'], required = true): Gate => ({
  id: 'g',
  state,
  value: null,
  target: 'target',
  category: 'engineering',
  required,
  evidence: 'test',
});
describe('acceptance states never substitute missing evidence', () => {
  it('required failure takes precedence; required missing evidence is incomplete', () => {
    expect(overall([gate('PASS')])).toBe('PASS');
    expect(overall([gate('PASS'), gate('NOT_EVALUATED')])).toBe('INCOMPLETE');
    expect(overall([gate('FAIL'), gate('NOT_EVALUATED')])).toBe('FAIL');
    expect(overall([gate('PASS'), gate('NOT_EVALUATED', false)])).toBe('PASS');
    expect(overall([])).toBe('INCOMPLETE');
    expect(
      metric('missing', undefined, '= 0', (v) => v === 0, 'product', 'no denominator').state,
    ).toBe('NOT_EVALUATED');
  });
  it('uses only existing validation aggregates and preserves stricter valid-budget recall', () => {
    const gates = contextGates(validation, longContext);
    expect(gates.find((g) => g.id === 'medianContextReduction')?.value).toBe(
      validation.aggregates.tokenReductionRatio?.median,
    );
    expect(gates.find((g) => g.id === 'weightedFactCoverage')?.value).toBe(
      validation.aggregates.weightedFactCoverage?.minimum,
    );
    expect(() =>
      contextGates(
        { ...validation, cases: [{ ...validation.cases[0]!, datasetSplit: 'development' }] },
        longContext,
      ),
    ).toThrow();
    expect(() =>
      contextGates(validation, {
        ...longContext,
        cases: [{ ...longContext.cases[0]!, datasetSplit: 'regression' }],
      }),
    ).toThrow();
  });
  it('excludes disabled and fake execution from live quality', () => {
    expect(qualityGate(validation, false).state).toBe('NOT_EVALUATED');
    expect(qualityGate(validation, true).state).toBe('NOT_EVALUATED');
    const fake: EvaluationReport = {
      ...validation,
      modelExecution: 'full-baseline-and-compiled',
      composition: { ...validation.composition, modelProviderId: 'fake:model-provider' },
      aggregates: {
        ...validation.aggregates,
        qualityLoss: {
          count: 3,
          mean: 0,
          median: 0,
          p10: 0,
          p50: 0,
          p90: 0,
          p95: 0,
          p99: 0,
          minimum: 0,
          maximum: 0,
        },
      },
      cases: validation.cases.map((c) => ({
        ...c,
        model: { state: 'executed', callOrder: [], qualityLoss: 0 },
      })),
    };
    expect(qualityGate(fake, true).state).toBe('NOT_EVALUATED');
    expect(overall([qualityGate(fake, true)])).toBe('INCOMPLETE');
  });
  it('counts comparisons exactly, including early divergence', () => {
    const report = {
      ...validation,
      cases: [
        {
          ...validation.cases[0]!,
          determinism: {
            executions: 4,
            matched: false as const,
            divergence: 'result-differs' as const,
          },
        },
        { ...validation.cases[1]!, determinism: { executions: 3, matched: true } },
      ],
    };
    expect(repeatedComparisons(report)).toEqual({ identical: 4, total: 5 });
    expect(repeatedComparisons({ ...report, cases: [] })).toBeUndefined();
  });
});

describe('narrow correctness evidence uses actual output', () => {
  it('counts duplicate wrappers with multiplicity and detects contradictory stored totals', () => {
    const entry = buildEvaluationSuiteV1(tokenizer).find((c) => c.tags.includes('duplicates'))!;
    const result = new ContextCompiler(benchmarkCompilerConfig(), tokenizer).compile(
      entry.compilationRequest,
    );
    const original = measureCorrectness(entry.compilationRequest, result, tokenizer);
    expect(original.wrapperAccountingCompleteness).toEqual({ numerator: 3, denominator: 3 });
    expect(original.traceReconciliationRate).toEqual({ numerator: 1, denominator: 1 });
    const modified = {
      ...result,
      trace: {
        ...result.trace,
        totals: {
          ...result.trace.totals,
          candidateTokens: result.trace.totals.candidateTokens + 1,
        },
      },
    };
    expect(
      measureCorrectness(entry.compilationRequest, modified, tokenizer).traceReconciliationRate
        .numerator,
    ).toBe(0);
    const missing = {
      ...result,
      trace: {
        ...result.trace,
        groups: result.trace.groups.map((group, index) =>
          index === 0 ? { ...group, members: [] } : group,
        ),
      },
    };
    expect(
      measureCorrectness(entry.compilationRequest, missing, tokenizer).wrapperAccountingCompleteness
        .numerator,
    ).toBeLessThan(3);
  });
  it('detects rendered-content and final-usage disagreement independently of stored schema validation', () => {
    const entry = buildEvaluationSuiteV1(tokenizer)[0]!;
    const result = new ContextCompiler(benchmarkCompilerConfig(), tokenizer).compile(
      entry.compilationRequest,
    );
    const usage = {
      ...result,
      trace: {
        ...result.trace,
        settlement: {
          ...result.trace.settlement,
          usage: {
            ...result.trace.settlement.usage,
            unusedTokens: result.trace.settlement.usage.unusedTokens + 1,
          },
        },
      },
    };
    expect(
      measureCorrectness(entry.compilationRequest, usage, tokenizer).traceReconciliationRate
        .numerator,
    ).toBe(0);
    const rendered = {
      ...result,
      compiledContext: result.compiledContext.replace('Tuesday', 'Wednesday'),
    };
    expect(
      measureCorrectness(entry.compilationRequest, rendered, tokenizer).traceReconciliationRate
        .numerator,
    ).toBe(0);
  });
  it('detects each foreign candidate rather than counting a source-registry rejection', () => {
    const entry = buildEvaluationSuiteV1(tokenizer).find((c) =>
      c.tags.includes('scope-isolation'),
    )!;
    expect(scopeDetections(entry.compilationRequest, tokenizer)).toEqual({
      numerator: 1,
      denominator: 1,
    });
  });
  it('versioned offline report retains every regression case and no raw texts', async () => {
    const before = JSON.stringify(buildEvaluationSuiteV1(tokenizer));
    const report = await buildAcceptanceReport({
      root: '.',
      performance: false,
      executedAt: '2026-06-01T12:00:00.000Z',
      referenceEnvironment: 'test',
      integrationGates: [],
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.dataset).toMatchObject({
      version: '1',
      splitCounts: { development: 3, validation: 3, regression: 7 },
    });
    expect(report.evaluation.all.counts).toMatchObject({
      cases: 13,
      expectedFailureCases: 2,
      expectedFailuresMatched: 2,
    });
    expect(report.qualityEvidence).toEqual({ live: false, modelDisabledAndFakeExcluded: true });
    expect(report.gates.find((g) => g.id === 'medianAnswerQualityLoss')?.state).toBe(
      'NOT_EVALUATED',
    );
    expect(report.productValidationAcceptance).not.toBe('PASS');
    expect(JSON.stringify(buildEvaluationSuiteV1(tokenizer))).toBe(before);
    for (const key of [
      'compiledContext',
      'query',
      'baselineAnswer',
      'systemPrompt',
      'sourceDocuments',
    ])
      expect(JSON.stringify(report)).not.toContain(`"${key}":`);
  });
});

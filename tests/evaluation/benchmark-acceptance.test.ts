import { EvaluationHarness, validateEvaluationCase } from '@ctxalloc/evaluation';
import { FakeModelProvider, FakeMonotonicClock } from '@ctxalloc/testing';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildEvaluationSuiteV1 } from '../../benchmarks/evaluation/v1/index.js';
import {
  BENCHMARK_DATASET_ID,
  BENCHMARK_DATASET_VERSION,
  benchmarkCompilerConfig,
} from '../../benchmarks/evaluation/v1/fixtures.js';
import { renderBaselineContext } from '../../packages/evaluation/src/evaluation-baselines.js';
import { runConfig } from './evaluation-fixtures.js';

/**
 * Phase 17 end-to-end acceptance (DEC-040).
 *
 * The real tokenizer, the real `ContextCompiler`, the versioned benchmark
 * dataset, a scripted clock, and a scripted model — and no network, no database,
 * and no filesystem. Every number asserted here is one the harness computed from
 * the real kernel rather than from a stand-in.
 */

const tokenizer = new O200kBaseTokenizer();

function clock(): FakeMonotonicClock {
  // Generous, and strictly increasing: a case that takes more measurements than
  // expected exhausts the clock rather than quietly reusing a reading.
  return new FakeMonotonicClock(Array.from({ length: 2000 }, (_, index) => index * 7));
}

function benchmarkRunConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return runConfig({
    runId: 'acceptance-1',
    datasetId: BENCHMARK_DATASET_ID,
    datasetVersion: BENCHMARK_DATASET_VERSION,
    determinismRepeats: 3,
    ...overrides,
  });
}

describe('benchmark dataset v1', () => {
  it('covers every required category with a valid case', () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    expect(cases).toHaveLength(13);
    for (const entry of cases) validateEvaluationCase(entry);

    const ids = cases.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(13);
    // METRICS 6.1-6.13, in order.
    expect(ids).toEqual([
      'case-01-straightforward-relevance',
      'case-02-distributed-facts',
      'case-03-duplicate-context',
      'case-04-conflicting-context',
      'case-05-budget-pressure',
      'case-06-conversation-continuity',
      'case-07-required-large-block',
      'case-08-impossible-budget',
      'case-09-scope-isolation',
      'case-10-unicode-structure',
      'case-11-prompt-injection',
      'case-12-retrieval-noise',
      'case-13-input-ordering',
    ]);
  });

  it('is deterministic and offline: two builds are byte-identical', () => {
    // The fixtures derive every hash and token count, so nothing here can drift
    // between two runs on one tokenizer (INV-DET-001).
    expect(JSON.stringify(buildEvaluationSuiteV1(tokenizer))).toBe(
      JSON.stringify(buildEvaluationSuiteV1(new O200kBaseTokenizer())),
    );
  });
});

describe('Phase 17 acceptance: one case end to end with the real kernel', () => {
  const answers = {
    baseline: 'The deployment window is Tuesday at 02:00 UTC.',
    compiled: 'Tuesday, 02:00 UTC.',
  };

  let provider: FakeModelProvider;
  let details: Awaited<ReturnType<EvaluationHarness['runCaseDetailed']>>;

  beforeAll(async () => {
    const target = buildEvaluationSuiteV1(tokenizer).find(
      (entry) => entry.id === 'case-01-straightforward-relevance',
    );
    if (target === undefined) throw new Error('missing benchmark case');

    provider = new FakeModelProvider({
      modelId: 'fake-benchmark-model',
      outcomes: [
        {
          kind: 'result',
          result: {
            schemaVersion: 1,
            outputText: answers.baseline,
            usage: { inputTokens: 900, outputTokens: 12 },
          },
        },
        { kind: 'result', result: { schemaVersion: 1, outputText: answers.compiled } },
      ],
    });

    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock(), provider);
    details = await harness.runCaseDetailed(
      benchmarkRunConfig({ modelExecution: 'full-baseline-and-compiled' }),
      target,
    );
  });

  it('1. renders the full baseline as the exact candidate context', () => {
    const target = buildEvaluationSuiteV1(tokenizer).find(
      (entry) => entry.id === 'case-01-straightforward-relevance',
    );
    expect(details.fullContextBaselineContext).toBe(
      renderBaselineContext(target?.compilationRequest.candidates ?? []),
    );
  });

  it('2. returns a settled successful compilation', () => {
    expect(details.result.compilation).toBe('succeeded');
    expect(details.result.compilationId).toBeDefined();
    expect(details.result.requestFingerprint).toBeDefined();
  });

  it('3. keeps the compiled context inside the available budget', () => {
    const usage = details.result.usage;
    expect(usage?.compiledTokens).toBeLessThanOrEqual(usage?.availableInputTokens ?? 0);
    expect(usage?.budgetViolation).toBe(false);
  });

  it('4. measures the baseline with the exact same tokenizer', () => {
    expect(details.result.tokens?.baselineInputTokens).toBe(
      tokenizer.countTokens(details.fullContextBaselineContext ?? ''),
    );
  });

  it('5 and 6. computes the reduction and the ratio exactly', () => {
    const tokens = details.result.tokens;
    if (tokens === undefined) throw new Error('expected token metrics');
    expect(tokens.tokenReduction).toBe(tokens.baselineInputTokens - tokens.compiledTokens);
    expect(tokens.tokenReductionRatio).toBe(tokens.tokenReduction / tokens.baselineInputTokens);
    expect(Number.isFinite(tokens.tokenReductionRatio ?? 0)).toBe(true);
  });

  it('7. preserves the required block and the required fact', () => {
    expect(details.result.preservation?.requiredBlockRecall).toBe(1);
    expect(details.result.preservation?.weightedFactCoverage).toBe(1);
    expect(details.result.preservation?.criticalFactCoverage).toBe(1);
    expect(details.result.preservation?.preservedFactIds).toEqual(['fact:window']);
  });

  it('8. sends two model requests that differ only by context', () => {
    expect(provider.calls).toHaveLength(2);
    const [first, second] = provider.calls;
    expect(first?.systemPrompt).toBe(second?.systemPrompt);
    expect(first?.maxOutputTokens).toBe(second?.maxOutputTokens);
    expect(first?.temperature).toBe(second?.temperature);

    const parse = (prompt: string): { context: string; query: string } =>
      JSON.parse(prompt) as { context: string; query: string };
    expect(parse(first?.userPrompt ?? '').query).toBe(parse(second?.userPrompt ?? '').query);
    expect(parse(first?.userPrompt ?? '').context).toBe(details.fullContextBaselineContext);
    expect(parse(second?.userPrompt ?? '').context).toBe(details.compiledContext);
  });

  it('9 and 10. scores both answers deterministically and computes the exact loss', () => {
    // `crit:day` (weight 2) passes for both; `crit:time` (weight 1) passes for
    // both, since each answer states 02:00.
    expect(details.result.model.baseline?.answerQualityScore).toBe(1);
    expect(details.result.model.compiled?.answerQualityScore).toBe(1);
    expect(details.result.model.qualityLoss).toBe(0);
    expect(details.result.model.severeQualityLoss).toBe(false);
  });

  it('11. keeps provider-native usage separately named', () => {
    expect(details.result.model.baseline?.providerInputTokens).toBe(900);
    expect(details.result.model.compiled?.providerInputTokens).toBeUndefined();
    // Never combined with a CtxAlloc count.
    expect(JSON.stringify(details.result.tokens)).not.toContain('900');
  });

  it('12. matches every determinism repeat', () => {
    expect(details.result.determinism).toEqual({ executions: 3, matched: true });
  });
});

describe('Phase 17 acceptance: the suite report and its boundaries', () => {
  it('13. carries no raw context, query, or model answer', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock());
    const report = await harness.runSuite(benchmarkRunConfig(), cases);

    const serialized = JSON.stringify(report);
    expect(report.cases).toHaveLength(13);
    for (const secret of [
      'deployment window',
      'importer_v2_enabled',
      'IGNORE ALL PREVIOUS INSTRUCTIONS',
      'purge topic',
      'CRC32C',
      'What is the current rate limit?',
    ]) {
      expect(serialized, `leaks ${secret}`).not.toContain(secret);
    }
  });

  it('reports the two expected failures as matched and nothing as unexpected', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock());
    const report = await harness.runSuite(benchmarkRunConfig(), cases);

    expect(report.counts.expectedFailureCases).toBe(2);
    expect(report.counts.expectedFailuresMatched).toBe(2);
    expect(report.counts.unexpectedFailures).toBe(0);
    expect(report.counts.successfulCompilations).toBe(11);
    expect(report.counts.determinismFailures).toBe(0);
    expect(report.counts.budgetViolations).toBe(0);
  });

  it('preserves every required block and every critical fact across the suite', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock());
    const report = await harness.runSuite(benchmarkRunConfig(), cases);

    // The property the compiler owes every case that states one, not a tuned
    // aggregate target (METRICS 9.1, 9.3).
    expect(report.aggregates.requiredBlockRecall?.minimum).toBe(1);
    expect(report.aggregates.criticalFactCoverage?.minimum).toBe(1);
    expect(report.aggregates.weightedFactCoverage?.minimum).toBe(1);
  });

  it('shows a real token reduction where deduplication and budget pressure apply', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock());
    const report = await harness.runSuite(benchmarkRunConfig(), cases);

    const byId = new Map(report.cases.map((entry) => [entry.caseId, entry]));
    // Duplicate context: the baseline repeats the wrapper, the compiler does not.
    expect(byId.get('case-03-duplicate-context')?.tokens?.tokenReduction).toBeGreaterThan(0);
    // Budget pressure: the baseline is far over the budget the compiler fits into.
    expect(byId.get('case-05-budget-pressure')?.tokens?.tokenReduction).toBeGreaterThan(0);
    // And where everything fits, the reduction is honestly zero rather than
    // inflated (METRICS 18).
    expect(byId.get('case-01-straightforward-relevance')?.tokens?.tokenReduction).toBe(0);
  });

  it('makes the top-k baseline applicable only where the evidence supports it', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock());
    const report = await harness.runSuite(benchmarkRunConfig(), cases);
    const byId = new Map(report.cases.map((entry) => [entry.caseId, entry]));

    expect(byId.get('case-12-retrieval-noise')?.baselines?.topK.applicable).toBe(true);
    const withoutEvidence = byId.get('case-01-straightforward-relevance')?.baselines?.topK;
    expect(withoutEvidence?.applicable).toBe(false);
    if (withoutEvidence?.applicable === false) {
      expect(withoutEvidence.reason).toBe('incomparable-retrieval-evidence');
    }
  });

  it('produces an identical report when run twice', async () => {
    const cases = buildEvaluationSuiteV1(tokenizer);
    const first = await new EvaluationHarness(
      benchmarkCompilerConfig(),
      tokenizer,
      clock(),
    ).runSuite(benchmarkRunConfig(), cases);
    const second = await new EvaluationHarness(
      benchmarkCompilerConfig(),
      tokenizer,
      clock(),
    ).runSuite(benchmarkRunConfig(), buildEvaluationSuiteV1(tokenizer));
    expect(first.reportHash).toBe(second.reportHash);
  });
});

describe('Phase 17 acceptance: the impossible-budget case', () => {
  it('fails as predicted, calls no model, and counts toward expected-failure accuracy', async () => {
    const target = buildEvaluationSuiteV1(tokenizer).find(
      (entry) => entry.id === 'case-08-impossible-budget',
    );
    if (target === undefined) throw new Error('missing benchmark case');

    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'result', result: { schemaVersion: 1, outputText: 'never' } }],
    });
    const harness = new EvaluationHarness(benchmarkCompilerConfig(), tokenizer, clock(), provider);
    const report = await harness.runSuite(
      benchmarkRunConfig({ modelExecution: 'full-baseline-and-compiled' }),
      [target],
    );

    const entry = report.cases[0];
    expect(entry?.compilation).toBe('failed');
    expect(entry?.compilationFailure?.stage).toBe('allocation');
    expect(entry?.compilationFailure?.issueCodes).toContain('required_content_exceeds_budget');
    expect(entry?.expectedFailure?.passed).toBe(true);
    expect(entry?.model.state).toBe('skipped-expected-failure');
    expect(provider.calls).toHaveLength(0);

    // No invented metrics for a case whose answer key is a failure.
    expect(entry?.tokens).toBeUndefined();
    expect(entry?.preservation).toBeUndefined();
    expect(report.counts).toMatchObject({
      cases: 1,
      successfulCompilations: 0,
      expectedFailureCases: 1,
      expectedFailuresMatched: 1,
      unexpectedFailures: 0,
    });
    // No observations, so no aggregate is invented.
    expect(report.aggregates.tokenReduction).toBeUndefined();
  });
});

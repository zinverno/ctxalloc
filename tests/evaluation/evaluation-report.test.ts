import {
  EVALUATION_PROMPT_ID,
  EVALUATION_PROMPT_VERSION,
  EvaluationHarness,
  EvaluationHarnessError,
  buildEvaluationUserPrompt,
} from '@ctxalloc/evaluation';
import { FakeModelProvider, FakeMonotonicClock } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import { summarize } from '../../packages/evaluation/src/evaluation-report.js';
import {
  candidateBlock,
  compilationRequest,
  compilerConfig,
  contextBlock,
  evaluationCase,
  modelResult,
  runConfig,
  wordTokenizer,
} from './evaluation-fixtures.js';

/**
 * The suite report (DEC-040).
 *
 * A report carries measurements, identities, hashes, and issue codes — never a
 * raw query, source content, compiled context, prompt, answer, or credential. It
 * is the artefact most likely to be pasted into a ticket, and a type that
 * *could* carry source content is a type that eventually does (INV-SEC-001).
 */

const SECRET_QUERY = 'QUERY-SECRET-do-not-report';
const SECRET_CONTENT = 'CONTENT-SECRET-do-not-report';

function clock(count = 200): FakeMonotonicClock {
  return new FakeMonotonicClock(Array.from({ length: count }, (_, index) => index * 10));
}

function caseWith(id: string, content: string, query: string): Record<string, unknown> {
  return evaluationCase({
    id,
    request: compilationRequest({
      id: `${id}-request`,
      query,
      candidates: [candidateBlock(contextBlock(`blk:${id}`, content))],
    }),
    tags: ['gamma', 'alpha'],
  });
}

describe('evaluation prompt (DEC-040)', () => {
  it('publishes a stable identity and one deterministic two-key object', () => {
    expect(EVALUATION_PROMPT_ID).toBe('ctxalloc-eval-prompt');
    expect(EVALUATION_PROMPT_VERSION).toBe('1');
    expect(buildEvaluationUserPrompt('ctx', 'q')).toBe('{"context":"ctx","query":"q"}');
  });

  it('embeds both values exactly, escaping and normalizing nothing', () => {
    const prompt = buildEvaluationUserPrompt('line "one"\nline\ttwo é 🚀', ' padded query ');
    const parsed = JSON.parse(prompt) as { context: string; query: string };
    expect(parsed.context).toBe('line "one"\nline\ttwo é 🚀');
    expect(parsed.query).toBe(' padded query ');
    expect(Object.keys(parsed)).toEqual(['context', 'query']);
  });

  it('adds no instruction text of its own', () => {
    const prompt = buildEvaluationUserPrompt('', '');
    expect(prompt).toBe('{"context":"","query":""}');
  });
});

describe('nearest-rank percentiles (DEC-040)', () => {
  it('uses ceil(p * n) clamped into the array, with median equal to p50', () => {
    const distribution = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(distribution).toEqual({
      count: 10,
      mean: 55,
      median: 50,
      p10: 10,
      p50: 50,
      p90: 90,
      p95: 100,
      p99: 100,
      minimum: 10,
      maximum: 100,
    });
    expect(distribution?.median).toBe(distribution?.p50);
  });

  it('reports a single observation as every percentile of itself', () => {
    expect(summarize([7])).toEqual({
      count: 1,
      mean: 7,
      median: 7,
      p10: 7,
      p50: 7,
      p90: 7,
      p95: 7,
      p99: 7,
      minimum: 7,
      maximum: 7,
    });
  });

  it('sorts before summarizing, so input order does not matter', () => {
    expect(summarize([3, 1, 2])).toEqual(summarize([1, 2, 3]));
  });

  it('handles negative observations without clamping them', () => {
    const distribution = summarize([-5, 0, 5]);
    expect(distribution?.minimum).toBe(-5);
    expect(distribution?.p50).toBe(0);
    expect(distribution?.mean).toBe(0);
  });

  it('omits a distribution entirely when nothing was measured', () => {
    // A report printing `mean: 0` for a metric nothing measured would state a
    // result nobody obtained.
    expect(summarize([])).toBeUndefined();
  });

  it('never emits NaN or Infinity', () => {
    const distribution = summarize([1, 2, 3, 4]);
    for (const value of Object.values(distribution ?? {})) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe('suite report: ordering, counts, and composition', () => {
  it('orders cases by identifier over UTF-16 code units', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    const report = await harness.runSuite(runConfig(), [
      caseWith('case-c', 'Gamma.', 'q'),
      caseWith('case-a', 'Alpha.', 'q'),
      caseWith('case-B', 'Beta.', 'q'),
    ]);
    // Uppercase sorts before lowercase by code unit; `localeCompare` would
    // reorder these differently on a different machine (INV-DET-002).
    expect(report.cases.map((entry) => entry.caseId)).toEqual(['case-B', 'case-a', 'case-c']);
  });

  it('rejects a repeated case identifier rather than overwriting a row', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    await expect(
      harness.runSuite(runConfig(), [caseWith('dup', 'A.', 'q'), caseWith('dup', 'B.', 'q')]),
    ).rejects.toBeInstanceOf(EvaluationHarnessError);
  });

  it('records every identity that produced the numbers', async () => {
    const provider = new FakeModelProvider({
      modelId: 'bench-model',
      outcomes: [
        { kind: 'result', result: modelResult('a') as never },
        { kind: 'result', result: modelResult('b') as never },
      ],
    });
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock(), provider);
    const report = await harness.runSuite(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      [caseWith('case-1', 'Alpha.', 'q')],
    );

    expect(report.composition).toMatchObject({
      tokenizerId: wordTokenizer.id,
      tokenizerVersion: wordTokenizer.version,
      compilerId: 'ctxalloc-eval-test',
      compilerVersion: '1.0.0',
      promptId: EVALUATION_PROMPT_ID,
      promptVersion: EVALUATION_PROMPT_VERSION,
      baselineRendererId: 'ctxalloc-eval-jsonl',
      modelProviderId: 'fake-model-provider',
      modelId: 'bench-model',
    });
  });

  it('omits model identity entirely when model execution is disabled', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    const report = await harness.runSuite(runConfig(), [caseWith('case-1', 'Alpha.', 'q')]);
    expect(report.composition.modelProviderId).toBeUndefined();
    expect(report.composition.modelId).toBeUndefined();
  });

  it('counts successes, expected failures, and unexpected failures separately', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    const impossible = evaluationCase({
      id: 'case-impossible',
      request: compilationRequest({
        id: 'impossible-request',
        candidates: [
          candidateBlock(
            contextBlock('blk:huge', 'word '.repeat(200), undefined, { required: true }),
          ),
        ],
        totalTokens: 40,
        reservedOutputTokens: 10,
      }),
      expectedCompilationFailure: {
        stage: 'allocation',
        issueCode: 'required_content_exceeds_budget',
      },
    });
    const unexpected = evaluationCase({
      id: 'case-unexpected',
      request: compilationRequest({
        id: 'unexpected-request',
        candidates: [
          candidateBlock(
            contextBlock('blk:huge2', 'word '.repeat(200), undefined, { required: true }),
          ),
        ],
        totalTokens: 40,
        reservedOutputTokens: 10,
      }),
    });

    const report = await harness.runSuite(runConfig(), [
      caseWith('case-ok', 'Alpha.', 'q'),
      impossible,
      unexpected,
    ]);

    expect(report.counts).toEqual({
      cases: 3,
      successfulCompilations: 1,
      expectedFailureCases: 1,
      expectedFailuresMatched: 1,
      unexpectedFailures: 1,
      providerFailures: 0,
      determinismFailures: 0,
      budgetViolations: 0,
      severeQualityLosses: 0,
    });
  });

  it('aggregates only the metrics that have observations', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    const report = await harness.runSuite(runConfig(), [caseWith('case-1', 'Alpha.', 'q')]);

    expect(report.aggregates.tokenReduction?.count).toBe(1);
    // Nothing annotated a required block, so there is no recall to aggregate.
    expect(report.aggregates.requiredBlockRecall).toBeUndefined();
    expect(report.aggregates.qualityLoss).toBeUndefined();
    expect(Object.keys(report.aggregates)).not.toContain('requiredBlockRecall');

    expect(report.latency.compilation?.count).toBe(1);
    expect(report.latency.baselineModel).toBeUndefined();
  });

  it('canonicalizes tags per case', async () => {
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock());
    const report = await harness.runSuite(runConfig(), [caseWith('case-1', 'Alpha.', 'q')]);
    expect(report.cases[0]?.tags).toEqual(['alpha', 'gamma']);
  });

  it('hashes the report deterministically over everything but the hash', async () => {
    const first = await new EvaluationHarness(compilerConfig(), wordTokenizer, clock()).runSuite(
      runConfig(),
      [caseWith('case-1', 'Alpha.', 'q')],
    );
    const second = await new EvaluationHarness(compilerConfig(), wordTokenizer, clock()).runSuite(
      runConfig(),
      [caseWith('case-1', 'Alpha.', 'q')],
    );
    expect(first.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.reportHash).toBe(second.reportHash);
    expect(first).toEqual(second);
  });
});

describe('suite report: privacy boundary (INV-SEC-001)', () => {
  it('carries no raw query, source content, context, prompt, or answer', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('ANSWER-SECRET-baseline') as never },
        { kind: 'result', result: modelResult('ANSWER-SECRET-compiled') as never },
      ],
    });
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock(), provider);
    const report = await harness.runSuite(
      runConfig({ modelExecution: 'full-baseline-and-compiled', systemPrompt: 'SYSTEM-SECRET' }),
      [caseWith('case-1', SECRET_CONTENT, SECRET_QUERY)],
    );

    const serialized = JSON.stringify(report);
    for (const secret of [
      SECRET_QUERY,
      SECRET_CONTENT,
      'SYSTEM-SECRET',
      'ANSWER-SECRET-baseline',
      'ANSWER-SECRET-compiled',
      '"context"',
    ]) {
      expect(serialized, `leaks ${secret}`).not.toContain(secret);
    }

    // What identifies a case instead: its id, its fingerprint, and hashes.
    expect(report.cases[0]?.caseId).toBe('case-1');
    expect(report.cases[0]?.requestFingerprint).toBeDefined();
    expect(report.cases[0]?.model.baseline?.answerHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('makes raw text available only through the detailed single-case result', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('ANSWER-SECRET-baseline') as never },
        { kind: 'result', result: modelResult('ANSWER-SECRET-compiled') as never },
      ],
    });
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock(), provider);
    const details = await harness.runCaseDetailed(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      caseWith('case-1', SECRET_CONTENT, SECRET_QUERY),
    );

    expect(details.fullContextBaselineContext).toContain(SECRET_CONTENT);
    expect(details.compiledContext).toContain(SECRET_CONTENT);
    expect(details.baselineAnswer).toBe('ANSWER-SECRET-baseline');
    expect(details.compiledAnswer).toBe('ANSWER-SECRET-compiled');

    // The suite-safe half of the same run still carries none of it.
    expect(JSON.stringify(details.result)).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(details.result)).not.toContain('ANSWER-SECRET-baseline');
  });

  it('hashes two different answers to two different values', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('first') as never },
        { kind: 'result', result: modelResult('second') as never },
      ],
    });
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, clock(), provider);
    const result = await harness.runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      caseWith('case-1', 'Alpha.', 'q'),
    );
    expect(result.model.baseline?.answerHash).not.toBe(result.model.compiled?.answerHash);
  });
});

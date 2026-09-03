import { readFileSync } from 'node:fs';
import { ContextCompilationError } from '@ctxalloc/compiler';
import {
  EvaluationHarness,
  EvaluationHarnessError,
  EvaluationRunConfigValidationError,
} from '@ctxalloc/evaluation';
import { FakeModelProvider, FakeMonotonicClock } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  OTHER_SCOPE,
  candidateBlock,
  compilationRequest,
  compilerConfig,
  contextBlock,
  evaluationCase,
  modelResult,
  runConfig,
  sourceDocument,
  wordTokenizer,
} from './evaluation-fixtures.js';

/**
 * The evaluation harness (DEC-040).
 *
 * One tokenizer for the baselines and the compiler, one prompt for both model
 * calls, and two token vocabularies that never mix. Every metric with no
 * denominator is absent rather than zero.
 */

const A = contextBlock('blk:a', 'Alpha alpha alpha.');
const B = contextBlock('blk:b', 'Beta beta beta.', undefined, { startLine: 2 });
const C = contextBlock('blk:c', 'Gamma gamma.', undefined, { startLine: 3 });

/** Enough readings for a case with model execution and repeats. */
function clock(count = 40): FakeMonotonicClock {
  return new FakeMonotonicClock(Array.from({ length: count }, (_, index) => index * 10));
}

function harness(options: { clock?: FakeMonotonicClock; provider?: FakeModelProvider } = {}) {
  return new EvaluationHarness(
    compilerConfig(),
    wordTokenizer,
    options.clock ?? clock(),
    options.provider,
  );
}

function simpleCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...evaluationCase({
      request: compilationRequest({
        candidates: [candidateBlock(A), candidateBlock(B), candidateBlock(C)],
      }),
    }),
    ...overrides,
  };
}

describe('evaluation harness: run configuration', () => {
  it('rejects an unknown field, a missing field, and an out-of-range value', async () => {
    const runner = harness();
    for (const bad of [
      runConfig({ extra: 1 }),
      runConfig({ temperature: 1.5 }),
      runConfig({ severeQualityLossThreshold: -0.1 }),
      runConfig({ determinismRepeats: 0 }),
      runConfig({ maxOutputTokens: 2.5 }),
      runConfig({ modelExecution: 'compiled-only' }),
      runConfig({ runId: '  ' }),
    ]) {
      await expect(runner.runCase(bad, simpleCase())).rejects.toBeInstanceOf(
        EvaluationRunConfigValidationError,
      );
    }
  });

  it('accepts an empty system prompt, which is a deliberate configuration', async () => {
    const result = await harness().runCase(runConfig({ systemPrompt: '' }), simpleCase());
    expect(result.compilation).toBe('succeeded');
  });

  it('requires a provider when model execution is enabled, and forbids calls when disabled', async () => {
    await expect(
      harness().runCase(runConfig({ modelExecution: 'full-baseline-and-compiled' }), simpleCase()),
    ).rejects.toBeInstanceOf(EvaluationHarnessError);

    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'result', result: modelResult('never called') as never }],
    });
    const result = await harness({ provider }).runCase(runConfig(), simpleCase());
    expect(result.model.state).toBe('disabled');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('evaluation harness: token metrics (METRICS 8.7, 8.8)', () => {
  it('measures reduction against the full-context baseline exactly', async () => {
    const result = await harness().runCase(runConfig(), simpleCase());
    const tokens = result.tokens;
    const baselines = result.baselines;
    expect(tokens).toBeDefined();
    if (tokens === undefined || baselines === undefined) return;
    if (!baselines.fullContext.applicable) throw new Error('expected an applicable baseline');

    expect(tokens.baselineInputTokens).toBe(baselines.fullContext.contextTokens);
    expect(tokens.compiledTokens).toBe(result.usage?.compiledTokens);
    expect(tokens.tokenReduction).toBe(tokens.baselineInputTokens - tokens.compiledTokens);
    expect(tokens.tokenReductionRatio).toBe(tokens.tokenReduction / tokens.baselineInputTokens);
  });

  it('names the other baselines separately, never as the token reduction', async () => {
    const result = await harness().runCase(runConfig(), simpleCase());
    expect(result.tokens?.truncationBaselineTokens).toBeDefined();
    expect(result.tokens?.truncationTokenReduction).toBeDefined();
    // Top-k is inapplicable here: this corpus carries no retrieval evidence.
    expect(result.tokens?.topKBaselineTokens).toBeUndefined();
    expect(result.baselines?.topK.applicable).toBe(false);
  });

  it('omits the ratio rather than emitting NaN when the baseline is empty', async () => {
    // No candidates: the full baseline renders the empty string.
    const empty = evaluationCase({ request: compilationRequest({ candidates: [] }) });
    const result = await harness().runCase(runConfig(), empty);
    expect(result.tokens?.baselineInputTokens).toBe(0);
    expect(result.tokens?.tokenReduction).toBe(0);
    expect(result.tokens?.tokenReductionRatio).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('null');
  });

  it('adds no reduction field to the compiler result', () => {
    // Token reduction exists only in evaluation: it is a comparison against a
    // baseline the compiler has never heard of, so putting it on
    // `CompilationResult` would make the kernel publish a number it cannot
    // compute (METRICS 8.7).
    const source = readFileSync(
      new URL('../../packages/compiler/src/context-compiler.ts', import.meta.url),
      'utf8',
    );
    const usage = /export interface CompilationResultUsage \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(usage).toContain('compiledTokens');
    for (const forbidden of [
      'tokenReduction',
      'baselineInputTokens',
      'tokenReductionRatio',
      'qualityLoss',
    ]) {
      expect(usage, `declares ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('evaluation harness: context preservation (METRICS 9)', () => {
  it('computes recall, weighted fact coverage, and exclusion from the final blocks', async () => {
    const result = await harness().runCase(
      runConfig(),
      simpleCase({
        requiredBlockIds: ['blk:a'],
        relevantBlockIds: ['blk:a', 'blk:b'],
        irrelevantBlockIds: ['blk:c'],
        requiredFacts: [
          {
            id: 'fact:major',
            description: 'Alpha stated.',
            importance: 'major',
            evidenceBlockGroups: [['blk:a']],
            acceptableEvidence: ['alpha'],
          },
          {
            // Evidence deliberately avoids `blk:c`, which this case annotates as
            // irrelevant: a block cannot be both wanted and unwanted.
            id: 'fact:minor',
            description: 'Alpha and beta together.',
            importance: 'minor',
            evidenceBlockGroups: [['blk:a', 'blk:b']],
            acceptableEvidence: ['alpha beta'],
          },
        ],
      }),
    );

    const preservation = result.preservation;
    expect(preservation?.requiredBlockRecall).toBe(1);
    expect(preservation?.relevantBlockRecall).toBe(1);
    // Everything fits, so the irrelevant block is included and excluded nothing.
    expect(preservation?.irrelevantExclusionRate).toBe(0);
    expect(preservation?.weightedFactCoverage).toBe(1);
    expect(preservation?.preservedFactIds).toEqual(['fact:major', 'fact:minor']);
    expect(preservation?.missingFactIds).toEqual([]);
  });

  it('treats evidence as OR across groups and AND inside one group', async () => {
    // A budget that seats only the highest-priority block, so exactly one group
    // can be satisfied.
    const small = evaluationCase({
      request: compilationRequest({
        candidates: [
          candidateBlock(contextBlock('blk:keep', 'Keep this one.', undefined, { priority: 1000 })),
          candidateBlock(
            contextBlock(
              'blk:drop',
              'Drop this one entirely and completely from the compiled context.',
              undefined,
              { priority: 1, startLine: 2 },
            ),
          ),
        ],
        totalTokens: 15,
        reservedOutputTokens: 10,
      }),
      requiredFacts: [
        {
          id: 'fact:or',
          description: 'Either block proves it.',
          importance: 'critical',
          evidenceBlockGroups: [['blk:drop'], ['blk:keep']],
          acceptableEvidence: ['either'],
        },
        {
          id: 'fact:and',
          description: 'Both blocks are needed.',
          importance: 'major',
          evidenceBlockGroups: [['blk:keep', 'blk:drop']],
          acceptableEvidence: ['both'],
        },
      ],
    });

    const result = await harness().runCase(runConfig(), small);
    expect(result.preservation?.preservedFactIds).toEqual(['fact:or']);
    expect(result.preservation?.missingFactIds).toEqual(['fact:and']);
    // critical = 3, major = 2: 3 of 5.
    expect(result.preservation?.weightedFactCoverage).toBe(3 / 5);
    expect(result.preservation?.criticalFactCoverage).toBe(1);
  });

  it('omits a metric whose denominator does not exist', async () => {
    const result = await harness().runCase(runConfig(), simpleCase());
    const preservation = result.preservation;
    expect(preservation?.requiredBlockRecall).toBeUndefined();
    expect(preservation?.weightedFactCoverage).toBeUndefined();
    expect(preservation?.criticalFactCoverage).toBeUndefined();
    expect(preservation?.relevantBlockRecall).toBeUndefined();
    expect(preservation?.irrelevantExclusionRate).toBeUndefined();
    // Absent, not zero and not one (METRICS 9.1).
    expect(Object.keys(preservation ?? {})).toEqual(['preservedFactIds', 'missingFactIds']);
  });

  it('reports critical coverage separately from weighted coverage', async () => {
    const result = await harness().runCase(
      runConfig(),
      simpleCase({
        requiredFacts: [
          {
            id: 'fact:critical',
            description: 'Critical.',
            importance: 'critical',
            evidenceBlockGroups: [['blk:a']],
            acceptableEvidence: ['a'],
          },
          {
            id: 'fact:minor-missing',
            description: 'Names a block outside the compiled set is impossible here.',
            importance: 'minor',
            evidenceBlockGroups: [['blk:b']],
            acceptableEvidence: ['b'],
          },
        ],
      }),
    );
    expect(result.preservation?.criticalFactCoverage).toBe(1);
  });
});

describe('evaluation harness: compiler correctness and determinism', () => {
  it('records exact usage and no budget violation', async () => {
    const result = await harness().runCase(runConfig(), simpleCase());
    const usage = result.usage;
    expect(usage?.budgetViolation).toBe(false);
    expect(usage?.unusedTokens).toBe(
      (usage?.availableInputTokens ?? 0) - (usage?.compiledTokens ?? 0),
    );
    expect(result.compilationId).toBeDefined();
    expect(result.requestFingerprint).toBeDefined();
  });

  it('passes when every repeat is identical', async () => {
    const result = await harness().runCase(runConfig({ determinismRepeats: 4 }), simpleCase());
    expect(result.determinism).toEqual({ executions: 4, matched: true });
  });

  it('runs exactly one compilation when repeats is one', async () => {
    const result = await harness().runCase(runConfig({ determinismRepeats: 1 }), simpleCase());
    expect(result.determinism).toEqual({ executions: 1, matched: true });
  });

  it('repeats a deterministic structured failure cleanly', async () => {
    const failing = evaluationCase({
      request: compilationRequest({
        candidates: [
          candidateBlock(contextBlock('blk:big', 'x '.repeat(200), undefined, { required: true })),
        ],
        totalTokens: 30,
        reservedOutputTokens: 10,
      }),
    });
    const result = await harness().runCase(runConfig({ determinismRepeats: 3 }), failing);
    expect(result.compilation).toBe('failed');
    expect(result.determinism).toEqual({ executions: 3, matched: true });
  });

  it('never calls the model for a determinism repeat', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('baseline') as never },
        { kind: 'result', result: modelResult('compiled') as never },
      ],
    });
    await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled', determinismRepeats: 5 }),
      simpleCase(),
    );
    // Two calls for five compilations: paying for a compiler check the model has
    // no part in would be a pure waste.
    expect(provider.calls).toHaveLength(2);
  });
});

describe('evaluation harness: latency (METRICS 17)', () => {
  it('measures each operation with the injected clock', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('baseline') as never },
        { kind: 'result', result: modelResult('compiled') as never },
      ],
    });
    // 0,10 for the compilation; 20,30 for the baseline call; 40,50 for compiled.
    const readings = new FakeMonotonicClock([0, 10, 20, 30, 40, 50]);
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      readings,
      provider,
    ).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled', determinismRepeats: 1 }),
      simpleCase(),
    );

    expect(result.compilationLatencyMilliseconds).toBe(10);
    expect(result.model.baseline?.latencyMilliseconds).toBe(10);
    expect(result.model.compiled?.latencyMilliseconds).toBe(10);
    // Derived, and deliberately not called end-to-end latency: Phase 17 uses
    // static candidate cases, so no retrieval time is in it.
    expect(result.compiledRequestLatencyMilliseconds).toBe(20);
  });

  it('rejects a clock that moves backwards rather than publishing a negative duration', async () => {
    const backwards = new FakeMonotonicClock([100, 40, 200, 300]);
    await expect(
      new EvaluationHarness(compilerConfig(), wordTokenizer, backwards).runCase(
        runConfig(),
        simpleCase(),
      ),
    ).rejects.toBeInstanceOf(EvaluationHarnessError);
  });

  it('rejects a clock that returns a non-finite or negative reading', async () => {
    for (const reading of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const hostile = {
        id: 'hostile',
        version: '1',
        nowMilliseconds: (): number => reading,
      };
      await expect(
        new EvaluationHarness(compilerConfig(), wordTokenizer, hostile).runCase(
          runConfig(),
          simpleCase(),
        ),
      ).rejects.toBeInstanceOf(EvaluationHarnessError);
    }
  });

  it('rejects a clock that is not a clock at all', () => {
    expect(() => new EvaluationHarness(compilerConfig(), wordTokenizer, {} as never)).toThrow(
      EvaluationHarnessError,
    );
  });
});

describe('evaluation harness: model fairness', () => {
  const criteria = [
    { kind: 'contains-all', id: 'c1', weight: 2, expected: ['alpha'], caseSensitive: false },
    { kind: 'not-contains', id: 'c2', weight: 1, forbidden: ['forbidden'], caseSensitive: true },
  ];

  it('changes only the context between the two calls', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('alpha from baseline') as never },
        { kind: 'result', result: modelResult('alpha from compiled') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase({ answerCriteria: criteria }),
    );

    expect(provider.calls).toHaveLength(2);
    const [first, second] = provider.calls;
    expect(first?.systemPrompt).toBe(second?.systemPrompt);
    expect(first?.maxOutputTokens).toBe(second?.maxOutputTokens);
    expect(first?.temperature).toBe(second?.temperature);
    expect(first?.schemaVersion).toBe(second?.schemaVersion);

    // Same prompt shape, same query, different context.
    const asJson = (prompt: string): { context: string; query: string } =>
      JSON.parse(prompt) as { context: string; query: string };
    expect(asJson(first?.userPrompt ?? '').query).toBe(asJson(second?.userPrompt ?? '').query);
    expect(asJson(first?.userPrompt ?? '').context).not.toBe(
      asJson(second?.userPrompt ?? '').context,
    );
    expect(Object.keys(asJson(first?.userPrompt ?? ''))).toEqual(['context', 'query']);

    expect(result.model.callOrder).toEqual(['full-baseline', 'compiled']);
    expect(result.model.state).toBe('executed');
  });

  it('calls the baseline first and the compiled context second', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('one') as never },
        { kind: 'result', result: modelResult('two') as never },
      ],
    });
    const details = await harness({ provider, clock: clock(80) }).runCaseDetailed(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );
    expect(provider.calls[0]?.userPrompt).toBe(details.baselineUserPrompt);
    expect(provider.calls[1]?.userPrompt).toBe(details.compiledUserPrompt);
    expect(details.baselineAnswer).toBe('one');
    expect(details.compiledAnswer).toBe('two');
  });

  it('scores both answers and reports a signed, unclamped quality loss', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('alpha, all clear') as never },
        { kind: 'result', result: modelResult('forbidden and no keyword') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase({ answerCriteria: criteria }),
    );

    expect(result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.model.compiled?.answerQualityScore).toBe(0);
    expect(result.model.qualityLoss).toBe(1);
    expect(result.model.severeQualityLoss).toBe(true);
  });

  it('reports a negative quality loss when the compiled context answers better', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('nothing useful') as never },
        { kind: 'result', result: modelResult('alpha') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase({ answerCriteria: criteria }),
    );
    // Never clamped: a compiled context that answers better is a real result.
    expect(result.model.qualityLoss).toBeLessThan(0);
    expect(result.model.severeQualityLoss).toBe(false);
  });

  it('treats a loss exactly at the threshold as not severe', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('alpha') as never },
        { kind: 'result', result: modelResult('alpha') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled', severeQualityLossThreshold: 0 }),
      simpleCase({ answerCriteria: criteria }),
    );
    expect(result.model.qualityLoss).toBe(0);
    // Strictly greater than: equality is the boundary the run declared acceptable.
    expect(result.model.severeQualityLoss).toBe(false);
  });

  it('produces no score, and no loss, when a case states no criteria', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('a') as never },
        { kind: 'result', result: modelResult('b') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );
    expect(result.model.baseline?.answerQualityScore).toBeUndefined();
    expect(result.model.qualityLoss).toBeUndefined();
    expect(result.model.severeQualityLoss).toBeUndefined();
  });
});

describe('evaluation harness: provider failures and usage', () => {
  it('separates a baseline failure from a compiled failure', async () => {
    const baselineFails = new FakeModelProvider({
      outcomes: [{ kind: 'failure', code: 'PROVIDER_UNAVAILABLE', message: 'down' }],
    });
    const first = await harness({ provider: baselineFails, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );
    expect(first.model.state).toBe('baseline-call-failed');
    expect(first.model.failedCall).toBe('full-baseline');
    expect(first.model.failureCode).toBe('PROVIDER_UNAVAILABLE');
    // A failed call never becomes a zero-scoring answer.
    expect(first.model.baseline).toBeUndefined();
    expect(first.model.qualityLoss).toBeUndefined();

    const compiledFails = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('baseline answer') as never },
        { kind: 'failure', code: 'PROVIDER_TIMEOUT', message: 'slow' },
      ],
    });
    const second = await harness({ provider: compiledFails, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );
    expect(second.model.state).toBe('compiled-call-failed');
    expect(second.model.failedCall).toBe('compiled');
    expect(second.model.baseline).toBeDefined();
    expect(second.model.compiled).toBeUndefined();
    expect(second.model.qualityLoss).toBeUndefined();
  });

  it('replaces a provider failure code that is not plainly a code', async () => {
    const prose = new FakeModelProvider({
      outcomes: [{ kind: 'failure', code: 'the api key sk-secret was rejected', message: 'nope' }],
    });
    const result = await harness({ provider: prose, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );
    expect(result.model.failureCode).toBe('provider_call_failed');
    expect(JSON.stringify(result)).not.toContain('sk-secret');
  });

  it('keeps provider-native usage under its own names and never mixes vocabularies', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        {
          kind: 'result',
          result: modelResult('baseline', {
            usage: { inputTokens: 1234, outputTokens: 56 },
            providerRequestId: 'msg_1',
            stopReason: 'end_turn',
            actualModelId: 'model-resolved',
          }) as never,
        },
        { kind: 'result', result: modelResult('compiled') as never },
      ],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      simpleCase(),
    );

    expect(result.model.baseline?.providerInputTokens).toBe(1234);
    expect(result.model.baseline?.providerOutputTokens).toBe(56);
    expect(result.model.baseline?.providerRequestId).toBe('msg_1');
    expect(result.model.baseline?.stopReason).toBe('end_turn');
    expect(result.model.baseline?.actualModelId).toBe('model-resolved');

    // Absent usage stays absent rather than being estimated.
    expect(result.model.compiled?.providerInputTokens).toBeUndefined();

    // The two vocabularies are never subtracted from one another: the provider's
    // input count includes the system prompt and message framing (METRICS 8.6).
    const compilerTokens = result.tokens?.compiledTokens ?? 0;
    expect(result.model.baseline?.providerInputTokens).not.toBe(compilerTokens);
    expect(JSON.stringify(result.tokens)).not.toContain('provider');
  });
});

describe('evaluation harness: expected failures (METRICS 13.2)', () => {
  const impossible = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...evaluationCase({
      request: compilationRequest({
        candidates: [
          candidateBlock(
            contextBlock('blk:huge', 'word '.repeat(300), undefined, { required: true }),
          ),
        ],
        totalTokens: 40,
        reservedOutputTokens: 10,
      }),
      expectedCompilationFailure: {
        stage: 'allocation',
        issueCode: 'required_content_exceeds_budget',
      },
    }),
    ...overrides,
  });

  it('passes when the stage and one issue code match exactly', async () => {
    const result = await harness().runCase(runConfig(), impossible());
    expect(result.compilation).toBe('failed');
    expect(result.expectedFailure?.passed).toBe(true);
    expect(result.compilationFailure?.stage).toBe('allocation');
    expect(result.compilationFailure?.issueCodes).toContain('required_content_exceeds_budget');
  });

  it('fails when the stage or the code differs, and when compilation succeeds', async () => {
    const wrongStage = await harness().runCase(
      runConfig(),
      impossible({
        expectedCompilationFailure: {
          stage: 'rendering',
          issueCode: 'required_content_exceeds_budget',
        },
      }),
    );
    expect(wrongStage.expectedFailure?.passed).toBe(false);

    const wrongCode = await harness().runCase(
      runConfig(),
      impossible({
        expectedCompilationFailure: { stage: 'allocation', issueCode: 'invalid_config' },
      }),
    );
    expect(wrongCode.expectedFailure?.passed).toBe(false);

    const succeeds = await harness().runCase(
      runConfig(),
      simpleCase({
        expectedCompilationFailure: {
          stage: 'allocation',
          issueCode: 'required_content_exceeds_budget',
        },
      }),
    );
    expect(succeeds.compilation).toBe('succeeded');
    expect(succeeds.expectedFailure?.passed).toBe(false);
  });

  it('calls no model and reports no invented metrics for an expected-failure case', async () => {
    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'result', result: modelResult('never') as never }],
    });
    const result = await harness({ provider, clock: clock(80) }).runCase(
      runConfig({ modelExecution: 'full-baseline-and-compiled' }),
      impossible(),
    );
    expect(provider.calls).toHaveLength(0);
    expect(result.model.state).toBe('skipped-expected-failure');
    expect(result.tokens).toBeUndefined();
    expect(result.preservation).toBeUndefined();
  });

  it('accepts a candidate-validation failure as expected-failure evidence', async () => {
    // The batch is invalid, so no baseline is built from it — and the failure the
    // case predicted is exactly the one the kernel's trust boundary raises.
    const crossScope = evaluationCase({
      request: compilationRequest({
        candidates: [
          candidateBlock(
            contextBlock('blk:foreign', 'Other tenant.', undefined, { scope: OTHER_SCOPE }),
          ),
        ],
        documents: [sourceDocument('doc:main', 'main', OTHER_SCOPE)],
      }),
      expectedCompilationFailure: { stage: 'candidate-validation', issueCode: 'scope_mismatch' },
    });

    const result = await harness().runCase(runConfig(), crossScope);
    expect(result.expectedFailure?.passed).toBe(true);
    expect(result.baselines).toBeUndefined();
  });

  it('reports an unexpected failure as one, with codes but no issue messages', async () => {
    const result = await harness().runCase(
      runConfig(),
      evaluationCase({
        request: compilationRequest({
          candidates: [
            candidateBlock(
              contextBlock('blk:huge', 'word '.repeat(300), undefined, { required: true }),
            ),
          ],
          totalTokens: 40,
          reservedOutputTokens: 10,
        }),
      }),
    );
    expect(result.compilation).toBe('failed');
    expect(result.expectedFailure).toBeUndefined();
    expect(result.model.state).toBe('skipped-compilation-failed');
    // Codes route a failure; messages legitimately quote request values, so they
    // stay out of a report (INV-SEC-001).
    expect(JSON.stringify(result.compilationFailure)).not.toContain('message');
  });

  it('does not weaken ContextCompilationError for a caller who wants it', () => {
    expect(ContextCompilationError.prototype.name).toBe('Error');
  });
});

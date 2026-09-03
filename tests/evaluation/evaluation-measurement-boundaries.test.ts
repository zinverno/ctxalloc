import {
  EvaluationCaseValidationError,
  EvaluationHarness,
  EvaluationHarnessError,
  validateEvaluationCase,
} from '@ctxalloc/evaluation';
import type { Tokenizer } from '@ctxalloc/ports';
import { FakeModelProvider, FakeMonotonicClock } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
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
 * The measurement boundaries of the harness (DEC-040).
 *
 * Everything the harness publishes as a benchmark number crosses a boundary it
 * does not own: a tokenizer, a clock, a model provider, or a case an author
 * wrote. Each of those can fail or lie, and none of them may put an invalid
 * measurement, a dependency's message, or a contradiction into a report.
 */

const A = contextBlock('blk:a', 'Alpha alpha alpha.');
const B = contextBlock('blk:b', 'Beta beta beta.', undefined, { startLine: 2 });

function clock(count = 60): FakeMonotonicClock {
  return new FakeMonotonicClock(Array.from({ length: count }, (_, index) => index * 10));
}

function simpleCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...evaluationCase({
      request: compilationRequest({ candidates: [candidateBlock(A), candidateBlock(B)] }),
    }),
    ...overrides,
  };
}

/**
 * A tokenizer that counts ordinary text correctly and misbehaves only on a
 * rendered baseline.
 *
 * The narrowing matters: `CandidateValidator` recomputes every block's own
 * `tokenCount` with this same tokenizer, so a tokenizer that misbehaved
 * everywhere would be caught there and the baseline path would never run. A real
 * tokenizer that fails on some inputs and not others is exactly the case worth
 * covering.
 */
const RENDERED_PREFIX = '{"blockId"';

function tokenizerReturning(value: unknown): Tokenizer {
  return {
    id: 'hostile',
    version: '1',
    countTokens: (text: string): number =>
      text.startsWith(RENDERED_PREFIX) ? (value as number) : wordTokenizer.countTokens(text),
  };
}

async function harnessErrorOf(promise: Promise<unknown>): Promise<EvaluationHarnessError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(EvaluationHarnessError);
    return cause as EvaluationHarnessError;
  }
  throw new Error('expected a rejection');
}

describe('evaluation token measurement: the tokenizer is a boundary', () => {
  const INVALID: readonly (readonly [string, unknown])[] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a negative count', -1],
    ['a fractional count', 1.5],
    ['a count beyond the safe range', Number.MAX_SAFE_INTEGER + 1],
    ['a non-number', '12'],
  ];

  it.each(INVALID)('refuses to publish a baseline measured as %s', async (_name, value) => {
    // A negative count would additionally make any prefix "fit" any budget, and a
    // NaN would propagate into every aggregate built on it.
    const harness = new EvaluationHarness(compilerConfig(), tokenizerReturning(value), clock());
    const error = await harnessErrorOf(harness.runCase(runConfig(), simpleCase()));
    expect(error.issueCode).toBe('tokenizer_failed');
    expect(error.code).toBe('EVALUATION_HARNESS_FAILED');
  });

  it('turns a throwing tokenizer into a project-owned failure', async () => {
    const throwing: Tokenizer = {
      id: 'throwing',
      version: '1',
      countTokens: (text: string): number => {
        if (text.startsWith(RENDERED_PREFIX)) {
          throw new Error('SECRET-TOKENIZER-MESSAGE about CONTENT-SECRET');
        }
        return wordTokenizer.countTokens(text);
      },
    };
    const harness = new EvaluationHarness(compilerConfig(), throwing, clock());
    const error = await harnessErrorOf(harness.runCase(runConfig(), simpleCase()));

    expect(error.issueCode).toBe('tokenizer_failed');
    // A tokenizer chooses its own wording, and some quote the text they were
    // counting (INV-SEC-001).
    const serialized = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    expect(serialized).not.toContain('SECRET-TOKENIZER-MESSAGE');
    expect(serialized).not.toContain('CONTENT-SECRET');
    expect(error.cause).toBeUndefined();
  });

  it('publishes no report at all when a suite hits an invalid count', async () => {
    const harness = new EvaluationHarness(
      compilerConfig(),
      tokenizerReturning(Number.NaN),
      clock(200),
    );
    const error = await harnessErrorOf(harness.runSuite(runConfig(), [simpleCase()]));
    expect(error.issueCode).toBe('tokenizer_failed');
  });

  it('leaves the baselines of a valid tokenizer exactly as they were', async () => {
    const result = await new EvaluationHarness(compilerConfig(), wordTokenizer, clock()).runCase(
      runConfig(),
      simpleCase(),
    );
    expect(result.baselines?.fullContext.applicable).toBe(true);
    expect(result.tokens?.baselineInputTokens).toBeGreaterThan(0);
  });
});

describe('evaluation case: required-fact evidence cannot also be irrelevant', () => {
  const fact = (groups: readonly (readonly string[])[]): Record<string, unknown> => ({
    id: 'fact:1',
    description: 'A stated fact.',
    importance: 'critical',
    evidenceBlockGroups: groups,
    acceptableEvidence: ['evidence'],
  });

  function issuesOf(input: unknown): { code: string; pointer: string }[] {
    try {
      validateEvaluationCase(input);
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationCaseValidationError);
      return (cause as EvaluationCaseValidationError).issues.map((issue) => ({
        code: issue.code,
        pointer: issue.pointer,
      }));
    }
    throw new Error('expected a rejection');
  }

  it('rejects a lone evidence block that is also irrelevant', () => {
    // Including it raises weighted fact coverage and lowers the irrelevant
    // exclusion rate; excluding it does the reverse. No compilation can score
    // well on both, so the answer key is broken.
    expect(
      issuesOf(simpleCase({ requiredFacts: [fact([['blk:a']])], irrelevantBlockIds: ['blk:a'] })),
    ).toEqual([
      {
        code: 'conflicting_annotation',
        pointer: 'requiredFacts[0].evidenceBlockGroups[0][0]',
      },
    ]);
  });

  it('rejects one member of an AND group that is also irrelevant', () => {
    expect(
      issuesOf(
        simpleCase({
          requiredFacts: [fact([['blk:a', 'blk:b']])],
          irrelevantBlockIds: ['blk:b'],
        }),
      ),
    ).toEqual([
      {
        code: 'conflicting_annotation',
        pointer: 'requiredFacts[0].evidenceBlockGroups[0][1]',
      },
    ]);
  });

  it('rejects one alternative of an OR set that is also irrelevant', () => {
    expect(
      issuesOf(
        simpleCase({
          requiredFacts: [fact([['blk:a'], ['blk:b']])],
          irrelevantBlockIds: ['blk:b'],
        }),
      ),
    ).toEqual([
      {
        code: 'conflicting_annotation',
        pointer: 'requiredFacts[0].evidenceBlockGroups[1][0]',
      },
    ]);
  });

  it('leaves evidence that is simply unlisted in relevantBlockIds alone', () => {
    // The rule is about contradiction, not completeness.
    const validated = validateEvaluationCase(
      simpleCase({ requiredFacts: [fact([['blk:a']])], irrelevantBlockIds: ['blk:b'] }),
    );
    expect(validated.requiredFacts[0]?.evidenceBlockGroups).toEqual([['blk:a']]);
    expect(validated.relevantBlockIds).toEqual([]);
  });

  it('repairs nothing: the case is rejected, not rewritten', () => {
    const broken = simpleCase({
      requiredFacts: [fact([['blk:a']])],
      irrelevantBlockIds: ['blk:a'],
    });
    expect(() => validateEvaluationCase(broken)).toThrow(EvaluationCaseValidationError);
    expect(broken.irrelevantBlockIds).toEqual(['blk:a']);
    expect(broken.relevantBlockIds).toEqual([]);
    expect(broken.requiredBlockIds).toEqual([]);
  });
});

describe('evaluation case: criterion weights must add up exactly', () => {
  const criterion = (id: string, weight: number): Record<string, unknown> => ({
    kind: 'exact',
    id,
    weight,
    expected: 'x',
    caseSensitive: true,
  });

  it('accepts a single criterion at the maximum safe weight', () => {
    const validated = validateEvaluationCase(
      simpleCase({ answerCriteria: [criterion('c1', Number.MAX_SAFE_INTEGER)] }),
    );
    expect(validated.answerCriteria[0]?.weight).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects a total that leaves the safe integer range', () => {
    // Each weight passes on its own; the sum is where exact arithmetic ends, and
    // `earnedWeight / totalWeight` would stop being the score the case describes.
    let raised: EvaluationCaseValidationError | null = null;
    try {
      validateEvaluationCase(
        simpleCase({
          answerCriteria: [criterion('c1', Number.MAX_SAFE_INTEGER), criterion('c2', 1)],
        }),
      );
    } catch (cause) {
      raised = cause as EvaluationCaseValidationError;
    }
    expect(raised).toBeInstanceOf(EvaluationCaseValidationError);
    expect(raised?.issues.map((issue) => issue.pointer)).toEqual(['answerCriteria[1].weight']);
  });

  it('leaves ordinary weighted scoring untouched', () => {
    const validated = validateEvaluationCase(
      simpleCase({ answerCriteria: [criterion('c1', 3), criterion('c2', 1)] }),
    );
    expect(validated.answerCriteria.map((entry) => entry.weight)).toEqual([3, 1]);
  });
});

describe('evaluation harness: the clock is a boundary', () => {
  it('converts a thrown clock error into clock_failed, with no dependency message', async () => {
    const throwing = {
      id: 'throwing-clock',
      version: '1',
      nowMilliseconds: (): number => {
        throw new Error('SECRET-CLOCK-MESSAGE');
      },
    };
    const harness = new EvaluationHarness(compilerConfig(), wordTokenizer, throwing);
    const error = await harnessErrorOf(harness.runCase(runConfig(), simpleCase()));

    expect(error.issueCode).toBe('clock_failed');
    const serialized = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    expect(serialized).not.toContain('SECRET-CLOCK-MESSAGE');
    expect(error.cause).toBeUndefined();
  });

  it('converts an exhausted test double into clock_failed rather than leaking it', async () => {
    // The double's own exhaustion error names its configuration; the harness owns
    // the failure the caller sees.
    const harness = new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      new FakeMonotonicClock([0]),
    );
    const error = await harnessErrorOf(harness.runCase(runConfig(), simpleCase()));
    expect(error.issueCode).toBe('clock_failed');
    expect(error.name).toBe('EvaluationHarnessError');
  });

  it('still rejects non-finite, negative, and backwards readings', async () => {
    for (const readings of [
      [0, Number.NaN],
      [0, -5],
    ]) {
      const hostile = {
        id: 'hostile',
        version: '1',
        nowMilliseconds: ((): (() => number) => {
          let index = 0;
          return (): number => readings[index++] ?? 0;
        })(),
      };
      const error = await harnessErrorOf(
        new EvaluationHarness(compilerConfig(), wordTokenizer, hostile).runCase(
          runConfig(),
          simpleCase(),
        ),
      );
      expect(error.issueCode).toBe('clock_failed');
    }

    const backwards = new FakeMonotonicClock([100, 40, 200, 300]);
    const error = await harnessErrorOf(
      new EvaluationHarness(compilerConfig(), wordTokenizer, backwards).runCase(
        runConfig(),
        simpleCase(),
      ),
    );
    expect(error.issueCode).toBe('clock_failed');
  });
});

describe('evaluation harness: callOrder records attempted calls', () => {
  const modelRun = runConfig({ modelExecution: 'full-baseline-and-compiled' });

  it('is empty when no model ran', async () => {
    const result = await new EvaluationHarness(compilerConfig(), wordTokenizer, clock()).runCase(
      runConfig(),
      simpleCase(),
    );
    expect(result.model.state).toBe('disabled');
    expect(result.model.callOrder).toEqual([]);
  });

  it('has one entry when the baseline call failed', async () => {
    // The compiled call never happened, so publishing it would be a false audit
    // record.
    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'failure', code: 'PROVIDER_UNAVAILABLE', message: 'down' }],
    });
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase());

    expect(result.model.state).toBe('baseline-call-failed');
    expect(result.model.callOrder).toEqual(['full-baseline']);
    expect(provider.calls).toHaveLength(1);
  });

  it('has both entries when the compiled call failed after a baseline call', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('baseline') as never },
        { kind: 'failure', code: 'PROVIDER_TIMEOUT', message: 'slow' },
      ],
    });
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase());

    expect(result.model.state).toBe('compiled-call-failed');
    expect(result.model.callOrder).toEqual(['full-baseline', 'compiled']);
  });

  it('has both entries when both calls ran', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: modelResult('a') as never },
        { kind: 'result', result: modelResult('b') as never },
      ],
    });
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase());

    expect(result.model.state).toBe('executed');
    expect(result.model.callOrder).toEqual(['full-baseline', 'compiled']);
  });

  it('is empty for an expected-failure case, where no call is attempted', async () => {
    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'result', result: modelResult('never') as never }],
    });
    const impossible = evaluationCase({
      request: compilationRequest({
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

    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, impossible);
    expect(result.model.callOrder).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('evaluation harness: two concrete models make the comparison invalid', () => {
  const criteria = [
    { kind: 'contains-all', id: 'c1', weight: 1, expected: ['alpha'], caseSensitive: false },
  ];
  const modelRun = runConfig({ modelExecution: 'full-baseline-and-compiled' });

  function providerResolving(
    baselineModel: string | undefined,
    compiledModel: string | undefined,
  ): FakeModelProvider {
    return new FakeModelProvider({
      modelId: 'model-latest',
      outcomes: [
        {
          kind: 'result',
          result: modelResult('alpha', {
            ...(baselineModel === undefined ? {} : { actualModelId: baselineModel }),
          }) as never,
        },
        {
          kind: 'result',
          result: modelResult('nothing useful', {
            ...(compiledModel === undefined ? {} : { actualModelId: compiledModel }),
          }) as never,
        },
      ],
    });
  }

  it('publishes both scores but no quality loss when the models differ', async () => {
    // Two experimental variables changed — the context and the actual model — so
    // the difference in the answers is not a context effect (METRICS 11.6).
    const provider = providerResolving('model-2026-08-01', 'model-2026-09-01');
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase({ answerCriteria: criteria }));

    expect(result.model.state).toBe('executed');
    expect(result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.model.compiled?.answerQualityScore).toBe(0);
    expect(result.model.baseline?.actualModelId).toBe('model-2026-08-01');
    expect(result.model.compiled?.actualModelId).toBe('model-2026-09-01');

    expect(result.model.qualityComparisonIssue).toBe('actual-model-mismatch');
    expect(result.model.qualityLoss).toBeUndefined();
    expect(result.model.severeQualityLoss).toBeUndefined();
  });

  it('compares normally when one alias resolved to one concrete model', async () => {
    const provider = providerResolving('model-2026-08-01', 'model-2026-08-01');
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase({ answerCriteria: criteria }));

    expect(result.model.qualityComparisonIssue).toBeUndefined();
    expect(result.model.qualityLoss).toBe(1);
  });

  it('compares normally when the provider reports no concrete model at all', async () => {
    // Absent identity falls back to the port contract: one instance is one
    // configured model.
    const provider = providerResolving(undefined, undefined);
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      provider,
    ).runCase(modelRun, simpleCase({ answerCriteria: criteria }));

    expect(result.model.qualityComparisonIssue).toBeUndefined();
    expect(result.model.qualityLoss).toBe(1);

    const oneSided = providerResolving('model-2026-08-01', undefined);
    const partial = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(),
      oneSided,
    ).runCase(modelRun, simpleCase({ answerCriteria: criteria }));
    expect(partial.model.qualityComparisonIssue).toBeUndefined();
    expect(partial.model.qualityLoss).toBe(1);
  });

  it('keeps the mismatch visible in the suite report and out of the aggregate', async () => {
    const provider = providerResolving('model-a', 'model-b');
    const report = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      clock(200),
      provider,
    ).runSuite(modelRun, [simpleCase({ answerCriteria: criteria })]);

    expect(report.counts.modelIdentityMismatches).toBe(1);
    expect(report.aggregates.qualityLoss).toBeUndefined();
    expect(report.cases[0]?.model.qualityComparisonIssue).toBe('actual-model-mismatch');
  });
});

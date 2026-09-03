import { EvaluationHarness, EvaluationHarnessError } from '@ctxalloc/evaluation';
import type { ModelProvider, ModelProviderResult } from '@ctxalloc/ports';
import { FakeMonotonicClock } from '@ctxalloc/testing';
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
 * The runtime trust boundary around an injected `ModelProvider` (DEC-040).
 *
 * `ModelProvider` is a port, so its result is whatever an implementation chose
 * to resolve with. A TypeScript interface is erased at run time and constrains
 * only the code that was compiled against it — every provider a later phase, a
 * user, or a test injects is unverified data at the point the harness reads it.
 * These tests use deliberately hostile providers, because a shipped adapter that
 * behaves is not evidence that the harness is safe from one that does not.
 */

const A = contextBlock('blk:a', 'Alpha alpha alpha.');
const B = contextBlock('blk:b', 'Beta beta beta.', undefined, { startLine: 2 });

/** A lone high surrogate: valid UTF-16 storage, no UTF-8 encoding. */
const LONE_SURROGATE = '\ud800';

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

/** Counts the calls a provider actually received, so "not attempted" is provable. */
interface CountingProvider extends ModelProvider {
  readonly calls: { count: number };
}

/** A provider that resolves exactly the values it was given, in order. */
function providerReturning(...values: readonly unknown[]): CountingProvider {
  const calls = { count: 0 };
  return {
    id: 'hostile-provider',
    version: '1',
    modelId: 'hostile-model',
    calls,
    generate: async (): Promise<ModelProviderResult> => {
      const value = values[calls.count];
      calls.count += 1;
      return value as ModelProviderResult;
    },
  };
}

/** A provider that throws the value it was given. */
function providerThrowing(cause: unknown): ModelProvider {
  return {
    id: 'throwing-provider',
    version: '1',
    modelId: 'throwing-model',
    generate: async (): Promise<ModelProviderResult> => {
      throw cause;
    },
  };
}

function harnessWith(provider: ModelProvider, readings = clock()): EvaluationHarness {
  return new EvaluationHarness(compilerConfig(), wordTokenizer, readings, provider);
}

const EXECUTING = runConfig({ modelExecution: 'full-baseline-and-compiled' });

/** The one valid result every "the other call is fine" case uses. */
const VALID = modelResult('Alpha is the answer.', {
  usage: { inputTokens: 12, outputTokens: 4 },
  providerRequestId: 'req-1',
  stopReason: 'end_turn',
});

describe('model provider results are runtime validated (DEC-040)', () => {
  const MALFORMED: readonly (readonly [string, unknown])[] = [
    ['a schema version this code does not implement', { schemaVersion: 2, outputText: 'A.' }],
    ['a non-string outputText', { schemaVersion: 1, outputText: 42 }],
    ['a missing outputText', { schemaVersion: 1 }],
    [
      'an outputText carrying a lone surrogate',
      { schemaVersion: 1, outputText: `A.${LONE_SURROGATE}` },
    ],
    [
      'usage.inputTokens of NaN',
      { schemaVersion: 1, outputText: 'A.', usage: { inputTokens: Number.NaN } },
    ],
    [
      'usage.inputTokens of Infinity',
      { schemaVersion: 1, outputText: 'A.', usage: { inputTokens: Number.POSITIVE_INFINITY } },
    ],
    ['a negative usage count', { schemaVersion: 1, outputText: 'A.', usage: { outputTokens: -1 } }],
    [
      'a fractional usage count',
      { schemaVersion: 1, outputText: 'A.', usage: { outputTokens: 12.5 } },
    ],
    [
      'a usage count beyond the safe integer range',
      {
        schemaVersion: 1,
        outputText: 'A.',
        usage: { inputTokens: Number.MAX_SAFE_INTEGER + 2 },
      },
    ],
    [
      'an unknown usage field',
      { schemaVersion: 1, outputText: 'A.', usage: { inputTokens: 1, cachedTokens: 3 } },
    ],
    ['an empty providerRequestId', { schemaVersion: 1, outputText: 'A.', providerRequestId: '' }],
    ['a non-string stopReason', { schemaVersion: 1, outputText: 'A.', stopReason: 7 }],
    [
      'a malformed actualModelId',
      { schemaVersion: 1, outputText: 'A.', actualModelId: LONE_SURROGATE },
    ],
    ['an unknown top-level field', { schemaVersion: 1, outputText: 'A.', cost: 0.02 }],
    ['a null result', null],
    ['an array result', [{ schemaVersion: 1, outputText: 'A.' }]],
    ['a string result', 'Alpha is the answer.'],
  ];

  it.each(MALFORMED)(
    'treats %s from the baseline call as a failed call, not a measurement',
    async (_label, value) => {
      const provider = providerReturning(value);
      const result = await harnessWith(provider).runCase(EXECUTING, simpleCase());

      expect(result.model.state).toBe('baseline-call-failed');
      expect(result.model.callOrder).toEqual(['full-baseline']);
      expect(result.model.failedCall).toBe('full-baseline');
      expect(result.model.failureCode).toBe('MODEL_PROVIDER_INVALID_RESULT');

      // Nothing derived from the malformed result exists: no answer hash, no
      // score, no provider usage.
      expect(result.model.baseline).toBeUndefined();
      expect(result.model.compiled).toBeUndefined();

      // The compiled call is never attempted. Asking the model a second question
      // after the first answer proved unreadable would spend a paid call to
      // produce a comparison that cannot be made.
      expect(provider.calls.count).toBe(1);
    },
  );

  it('keeps a valid baseline when only the compiled result is malformed', async () => {
    const provider = providerReturning(VALID, { schemaVersion: 1, outputText: null });
    const result = await harnessWith(provider).runCase(
      EXECUTING,
      simpleCase({
        answerCriteria: [
          { kind: 'contains-all', id: 'c1', weight: 1, expected: ['Alpha'], caseSensitive: false },
        ],
      }),
    );

    expect(result.model.state).toBe('compiled-call-failed');
    expect(result.model.callOrder).toEqual(['full-baseline', 'compiled']);
    expect(result.model.failedCall).toBe('compiled');
    expect(result.model.failureCode).toBe('MODEL_PROVIDER_INVALID_RESULT');

    // The baseline call succeeded and keeps everything it earned.
    expect(result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.model.baseline?.providerInputTokens).toBe(12);
    expect(result.model.compiled).toBeUndefined();

    // Half a comparison is not a comparison.
    expect(result.model.qualityLoss).toBeUndefined();
    expect(result.model.severeQualityLoss).toBeUndefined();
  });

  it('keeps malformed result content out of the published case result', async () => {
    const canary = 'CANARY-MODEL-OUTPUT';
    const provider = providerReturning({
      schemaVersion: 3,
      outputText: canary,
      internalTrace: canary,
    });
    const result = await harnessWith(provider).runCaseDetailed(EXECUTING, simpleCase());

    // A rejected result is provider-controlled content. It is not quoted, not
    // hashed, and not attached to the failure it caused.
    expect(JSON.stringify(result.result)).not.toContain(canary);
    expect(result.baselineAnswer).toBeUndefined();
    expect(result.compiledAnswer).toBeUndefined();
  });

  it('leaves a valid result exactly as the provider produced it', async () => {
    const provider = providerReturning(
      modelResult('Alpha.', { usage: { inputTokens: 9 }, actualModelId: 'model-x' }),
      modelResult('Alpha.', { usage: { outputTokens: 3 }, actualModelId: 'model-x' }),
    );
    const result = await harnessWith(provider).runCaseDetailed(
      EXECUTING,
      simpleCase({
        answerCriteria: [
          { kind: 'exact', id: 'c1', weight: 2, expected: 'Alpha.', caseSensitive: false },
        ],
      }),
    );

    expect(result.result.model.state).toBe('executed');
    expect(result.result.model.callOrder).toEqual(['full-baseline', 'compiled']);
    expect(result.result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.result.model.baseline?.providerInputTokens).toBe(9);
    expect(result.result.model.compiled?.providerOutputTokens).toBe(3);
    expect(result.result.model.qualityLoss).toBe(0);
    expect(result.baselineAnswer).toBe('Alpha.');
  });

  it('preserves an empty answer rather than rejecting it', async () => {
    // A model may decline to answer. That is a scored outcome, not a broken
    // result: rejecting it would turn a real observation into a call failure.
    const provider = providerReturning(modelResult(''), modelResult(''));
    const result = await harnessWith(provider).runCaseDetailed(EXECUTING, simpleCase());

    expect(result.result.model.state).toBe('executed');
    expect(result.baselineAnswer).toBe('');
  });

  it('still withholds quality loss when two valid results name different models', async () => {
    const provider = providerReturning(
      modelResult('Alpha.', { actualModelId: 'model-a' }),
      modelResult('Alpha.', { actualModelId: 'model-b' }),
    );
    const result = await harnessWith(provider).runCase(
      EXECUTING,
      simpleCase({
        answerCriteria: [
          { kind: 'exact', id: 'c1', weight: 1, expected: 'Alpha.', caseSensitive: false },
        ],
      }),
    );

    expect(result.model.state).toBe('executed');
    expect(result.model.qualityComparisonIssue).toBe('actual-model-mismatch');
    expect(result.model.qualityLoss).toBeUndefined();
    expect(result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.model.compiled?.answerQualityScore).toBe(1);
  });
});

describe('model provider instances are validated at construction (DEC-040)', () => {
  function construct(provider: unknown): EvaluationHarnessError {
    try {
      new EvaluationHarness(compilerConfig(), wordTokenizer, clock(), provider as ModelProvider);
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationHarnessError);
      return cause as EvaluationHarnessError;
    }
    throw new Error('expected a construction failure');
  }

  const base = {
    id: 'p',
    version: '1',
    modelId: 'm',
    generate: async (): Promise<never> => {
      throw new Error('unused');
    },
  };

  const INVALID: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a non-object', 'a-provider'],
    ['a provider with no generate', { id: 'p', version: '1', modelId: 'm' }],
    ['a provider whose generate is not a function', { ...base, generate: 'call-me' }],
    ['a blank id', { ...base, id: '   ' }],
    ['an empty version', { ...base, version: '' }],
    ['a non-string modelId', { ...base, modelId: 7 }],
    ['a malformed modelId', { ...base, modelId: LONE_SURROGATE }],
  ];

  it.each(INVALID)('rejects %s', (_label, provider) => {
    expect(construct(provider).issueCode).toBe('invalid_harness_configuration');
  });

  it('converts a throwing identity getter into the same configuration failure', () => {
    const provider = {
      get id(): string {
        throw new Error('identity is unavailable right now');
      },
      version: '1',
      modelId: 'm',
      generate: async (): Promise<never> => {
        throw new Error('unused');
      },
    };

    const error = construct(provider);
    expect(error.issueCode).toBe('invalid_harness_configuration');
    // The getter's own wording is a dependency's, and it may name anything.
    expect(error.message).not.toContain('identity is unavailable');
  });

  it('quotes no provider-controlled value in the failure message', () => {
    const error = construct({ ...base, id: `secret-provider-${LONE_SURROGATE}` });
    expect(error.message).not.toContain('secret-provider');
  });

  it('accepts a well-formed provider and records its identity in the report', async () => {
    const provider = providerReturning(VALID, VALID);
    const report = await harnessWith(provider).runSuite(EXECUTING, [simpleCase()]);

    expect(report.composition.modelProviderId).toBe('hostile-provider');
    expect(report.composition.modelId).toBe('hostile-model');
  });
});

describe('failure-code inspection cannot throw (DEC-040)', () => {
  it('reports an opaque code when the thrown value refuses inspection', async () => {
    // A provider is free to throw anything, including a value whose own
    // reflection traps throw. Describing that failure must not become a second
    // failure that escapes the harness.
    const hostile = new Proxy(
      { code: 'SHOULD_NEVER_BE_READ' },
      {
        getOwnPropertyDescriptor(): never {
          throw new Error('descriptor trap');
        },
      },
    );

    const result = await harnessWith(providerThrowing(hostile)).runCase(EXECUTING, simpleCase());

    expect(result.model.state).toBe('baseline-call-failed');
    expect(result.model.failureCode).toBe('provider_call_failed');
  });

  it('never consults the prototype chain of a thrown value', async () => {
    // Ownership is decided by origin, so nothing walks a thrown value's
    // prototype chain any more. A `getPrototypeOf` trap that throws is
    // therefore never reached, and the failure is described from the one
    // guarded descriptor read.
    const hostile = new Proxy(
      { code: 'PROVIDER_TRANSPORT_ERROR' },
      {
        getPrototypeOf(): never {
          throw new Error('prototype trap');
        },
      },
    );

    const result = await harnessWith(providerThrowing(hostile)).runCase(EXECUTING, simpleCase());

    expect(result.model.state).toBe('baseline-call-failed');
    expect(result.model.failureCode).toBe('PROVIDER_TRANSPORT_ERROR');
  });

  it('still carries a provider failure code that is plainly a code', async () => {
    const result = await harnessWith(
      providerThrowing(Object.assign(new Error('boom'), { code: 'PROVIDER_TIMEOUT' })),
    ).runCase(EXECUTING, simpleCase());

    expect(result.model.failureCode).toBe('PROVIDER_TIMEOUT');
  });

  it('does not invoke an accessor while describing a failure', async () => {
    let invoked = false;
    const cause = {
      get code(): string {
        invoked = true;
        return 'PROVIDER_TIMEOUT';
      },
    };

    const result = await harnessWith(providerThrowing(cause)).runCase(EXECUTING, simpleCase());

    expect(invoked).toBe(false);
    expect(result.model.failureCode).toBe('provider_call_failed');
  });
});

describe('a provider cannot impersonate a harness failure (DEC-040)', () => {
  const CANARY = 'CANARY-PROVIDER-CONTROLLED-MESSAGE';

  /**
   * `EvaluationHarnessError` is exported, so an injected provider can construct
   * one. Classifying a caught value by its class therefore let a provider pick
   * an internal issue code, skip the provider-call-failed state, and have its
   * own message rethrown as the harness's own. Ownership is decided by where the
   * failure happened instead: the clock is read outside the provider catch, and
   * the catch wraps `generate()` and nothing else.
   */
  const SPOOFS: readonly (readonly [string, () => unknown])[] = [
    [
      'a real public EvaluationHarnessError',
      (): unknown => new EvaluationHarnessError('clock_failed', CANARY),
    ],
    [
      'an EvaluationHarnessError claiming a tokenizer failure',
      (): unknown => new EvaluationHarnessError('tokenizer_failed', CANARY),
    ],
    [
      'an object forged onto the harness error prototype',
      (): unknown =>
        Object.assign(Object.create(EvaluationHarnessError.prototype) as object, {
          issueCode: 'clock_failed',
          message: CANARY,
        }),
    ],
    [
      'a value whose prototype chain is rewritten to the harness error',
      (): unknown => {
        const forged = { issueCode: 'clock_failed', message: CANARY };
        Object.setPrototypeOf(forged, EvaluationHarnessError.prototype);
        return forged;
      },
    ],
  ];

  it.each(SPOOFS)('treats %s as a provider call failure', async (_label, build) => {
    const thrown = build();
    // The forged values really do satisfy the class check the old code used.
    expect(thrown instanceof EvaluationHarnessError).toBe(true);

    const result = await harnessWith(providerThrowing(thrown)).runCaseDetailed(
      EXECUTING,
      simpleCase(),
    );

    expect(result.result.model.state).toBe('baseline-call-failed');
    expect(result.result.model.callOrder).toEqual(['full-baseline']);
    expect(result.result.model.failedCall).toBe('full-baseline');
    // `code` on the thrown value is `EVALUATION_HARNESS_FAILED`, which is
    // plainly a code and so survives the existing conservative rule; the
    // provider-chosen `issueCode` and message do not.
    expect(result.result.model.failureCode).not.toBe('clock_failed');
    expect(result.result.model.failureCode).not.toBe('tokenizer_failed');
    expect(JSON.stringify(result.result)).not.toContain(CANARY);
  });

  it('keeps a valid baseline when the compiled call throws a harness error', async () => {
    const provider: ModelProvider = {
      id: 'spoofing-provider',
      version: '1',
      modelId: 'spoofing-model',
      generate: (() => {
        let call = 0;
        return async (): Promise<ModelProviderResult> => {
          call += 1;
          if (call === 1) return VALID as unknown as ModelProviderResult;
          throw new EvaluationHarnessError('clock_failed', CANARY);
        };
      })(),
    };

    const result = await harnessWith(provider).runCaseDetailed(
      EXECUTING,
      simpleCase({
        answerCriteria: [
          { kind: 'contains-all', id: 'c1', weight: 1, expected: ['Alpha'], caseSensitive: false },
        ],
      }),
    );

    expect(result.result.model.state).toBe('compiled-call-failed');
    expect(result.result.model.callOrder).toEqual(['full-baseline', 'compiled']);
    expect(result.result.model.baseline?.answerQualityScore).toBe(1);
    expect(result.result.model.compiled).toBeUndefined();
    expect(result.result.model.qualityLoss).toBeUndefined();
    expect(JSON.stringify(result.result)).not.toContain(CANARY);
  });

  it('lets no exception escape runCase for any provider rejection', async () => {
    for (const build of SPOOFS.map(([, value]) => value)) {
      // The assertion is that this resolves at all: before the fix, a forged
      // harness error was rethrown out of `runCase`.
      await expect(
        harnessWith(providerThrowing(build())).runCase(EXECUTING, simpleCase()),
      ).resolves.toBeDefined();
    }
  });
});

describe('real clock failures stay harness-owned (DEC-040)', () => {
  it('throws clock_failed before the provider is ever called', async () => {
    // Exactly the two readings the compilation measurement consumes. The next
    // one opens the baseline call, and it is taken outside the provider catch,
    // so it cannot be mistaken for a call failure.
    const provider = providerReturning(VALID, VALID);
    const harness = new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      new FakeMonotonicClock([0, 10]),
      provider,
    );

    try {
      await harness.runCase(EXECUTING, simpleCase());
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationHarnessError);
      expect((cause as EvaluationHarnessError).issueCode).toBe('clock_failed');
      expect(provider.calls.count).toBe(0);
      return;
    }
    throw new Error('expected a rejection');
  });

  it('throws clock_failed when the reading after a resolved call fails', async () => {
    // Enough readings to compile and to open the baseline call, and none for
    // the reading that closes it. The provider resolved successfully, so this
    // is unambiguously the harness's own clock and not a provider failure.
    const provider = providerReturning(VALID, VALID);
    const harness = new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      new FakeMonotonicClock([0, 10, 20]),
      provider,
    );

    try {
      await harness.runCase(EXECUTING, simpleCase());
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationHarnessError);
      expect((cause as EvaluationHarnessError).issueCode).toBe('clock_failed');
      expect(provider.calls.count).toBeGreaterThanOrEqual(1);
      return;
    }
    throw new Error('expected a rejection');
  });

  it('still rejects a backwards interval around a resolved call', async () => {
    const provider = providerReturning(VALID, VALID);
    const harness = new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      // The baseline call opens at 500 and closes at 100.
      new FakeMonotonicClock([0, 10, 500, 100]),
      provider,
    );

    const error = await harness.runCase(EXECUTING, simpleCase()).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(EvaluationHarnessError);
    expect((error as EvaluationHarnessError).issueCode).toBe('clock_failed');
  });
});

describe('the clock identity is validated and snapshotted (DEC-040)', () => {
  function construct(clock: unknown): EvaluationHarnessError {
    try {
      new EvaluationHarness(compilerConfig(), wordTokenizer, clock as FakeMonotonicClock);
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationHarnessError);
      return cause as EvaluationHarnessError;
    }
    throw new Error('expected a construction failure');
  }

  const workingClock = {
    id: 'c',
    version: '1',
    nowMilliseconds: (): number => 0,
  };

  const INVALID: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a non-object', 'a-clock'],
    ['a clock with no nowMilliseconds', { id: 'c', version: '1' }],
    ['a clock whose nowMilliseconds is not a function', { ...workingClock, nowMilliseconds: 0 }],
    ['a blank id', { ...workingClock, id: '  ' }],
    ['an empty version', { ...workingClock, version: '' }],
    ['a non-string id', { ...workingClock, id: 7 }],
    ['a malformed version', { ...workingClock, version: LONE_SURROGATE }],
  ];

  it.each(INVALID)('rejects %s at construction', (_label, clock) => {
    expect(construct(clock).issueCode).toBe('invalid_harness_configuration');
  });

  it('converts a throwing identity getter into a configuration failure', () => {
    const error = construct({
      get id(): string {
        throw new Error('clock identity is unavailable right now');
      },
      version: '1',
      nowMilliseconds: (): number => 0,
    });

    expect(error.issueCode).toBe('invalid_harness_configuration');
    expect(error.message).not.toContain('clock identity is unavailable');
  });

  it('captures the identity once and never reads it again', async () => {
    // A clock that renames itself after construction. The report must name the
    // clock the measurements were actually taken with, not whatever the getter
    // says once the run is over.
    let idReads = 0;
    let versionReads = 0;
    let readings = 0;
    const shifting = {
      get id(): string {
        idReads += 1;
        return idReads === 1 ? 'clock-at-construction' : 'clock-renamed-later';
      },
      get version(): string {
        versionReads += 1;
        return versionReads === 1 ? '1' : '999';
      },
      nowMilliseconds: (): number => {
        readings += 1;
        return readings * 10;
      },
    };

    const report = await new EvaluationHarness(compilerConfig(), wordTokenizer, shifting).runSuite(
      runConfig(),
      [simpleCase()],
    );

    expect(report.composition.clockId).toBe('clock-at-construction');
    expect(report.composition.clockVersion).toBe('1');
    // Exactly one read of each, at construction.
    expect(idReads).toBe(1);
    expect(versionReads).toBe(1);
  });
});

describe('derived and aggregated latency stay finite (METRICS 17)', () => {
  /** Alternating readings, so every measured interval is the largest double. */
  function extremeClock(): FakeMonotonicClock {
    return new FakeMonotonicClock(
      Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 0 : Number.MAX_VALUE)),
    );
  }

  it('publishes one very large finite duration unchanged', async () => {
    const result = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      extremeClock(),
    ).runCase(runConfig(), simpleCase());

    expect(result.compilationLatencyMilliseconds).toBe(Number.MAX_VALUE);
    expect(result.compiledRequestLatencyMilliseconds).toBeUndefined();
  });

  it('rejects a derived request latency that overflows instead of publishing it', async () => {
    // Both intervals are finite and legitimate; their sum is not a double. A
    // published `Infinity` would be a duration nobody waited for, and clamping
    // would state a specific wrong number instead.
    const provider = providerReturning(VALID, VALID);

    try {
      await harnessWith(provider, extremeClock()).runCase(EXECUTING, simpleCase());
    } catch (cause) {
      expect(cause).toBeInstanceOf(EvaluationHarnessError);
      expect((cause as EvaluationHarnessError).issueCode).toBe('clock_failed');
      return;
    }
    throw new Error('expected a rejection');
  });

  it('means two maximal observations without overflowing the intermediate sum', () => {
    const distribution = summarize([Number.MAX_VALUE, Number.MAX_VALUE]);

    expect(distribution?.mean).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(distribution?.mean ?? Number.NaN)).toBe(true);
  });

  it('keeps every aggregate finite in a report built from extreme latencies', async () => {
    const report = await new EvaluationHarness(
      compilerConfig(),
      wordTokenizer,
      new FakeMonotonicClock(
        Array.from({ length: 120 }, (_, index) => (index % 2 === 0 ? 0 : Number.MAX_VALUE)),
      ),
    ).runSuite(runConfig(), [
      simpleCase({ id: 'case-1' }),
      simpleCase({ id: 'case-2' }),
      simpleCase({ id: 'case-3' }),
    ]);

    const distribution = report.latency.compilation;
    expect(distribution).toBeDefined();
    for (const value of Object.values(distribution ?? {})) {
      expect(Number.isFinite(value)).toBe(true);
    }

    // The report hash is taken over the whole report, so a non-finite metric
    // anywhere in it would be part of the identity of a run.
    expect(report.reportHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

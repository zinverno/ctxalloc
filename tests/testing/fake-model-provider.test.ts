import type { ModelProviderRequest, ModelProviderResult } from '@ctxalloc/ports';
import {
  FakeModelProvider,
  FakeModelProviderConfigurationError,
  FakeModelProviderScriptedFailureError,
  FakeModelProviderUnscriptedCallError,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

/**
 * The scripted model double (DEC-040).
 *
 * Everything it returns is configuration. It reads no query, inspects no
 * context, and invents no token usage — a fake that derived an answer would be
 * an unshipped language model in the test package, and every evaluation test
 * built on it would measure that instead of the harness (INV-DEP-003).
 */

function request(overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest {
  return {
    schemaVersion: 1,
    systemPrompt: 'You answer from context.',
    userPrompt: '{"context":"c","query":"q"}',
    maxOutputTokens: 128,
    temperature: 0,
    ...overrides,
  };
}

function result(outputText: string, extra: Partial<ModelProviderResult> = {}): ModelProviderResult {
  return { schemaVersion: 1, outputText, ...extra };
}

describe('FakeModelProvider', () => {
  it('answers in call order and records every call', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        { kind: 'result', result: result('first') },
        { kind: 'result', result: result('second') },
      ],
    });

    expect((await provider.generate(request({ userPrompt: 'a' }))).outputText).toBe('first');
    expect((await provider.generate(request({ userPrompt: 'b' }))).outputText).toBe('second');
    expect(provider.calls.map((call) => call.userPrompt)).toEqual(['a', 'b']);
  });

  it('answers by exact user prompt, never by a normalized one', async () => {
    const provider = new FakeModelProvider({
      outcomesByUserPrompt: [
        { userPrompt: 'exact', outcome: { kind: 'result', result: result('matched') } },
      ],
    });

    expect((await provider.generate(request({ userPrompt: 'exact' }))).outputText).toBe('matched');
    // A trimmed or lowercased match would hide the very change a test is trying
    // to detect.
    await expect(provider.generate(request({ userPrompt: ' exact' }))).rejects.toBeInstanceOf(
      FakeModelProviderUnscriptedCallError,
    );
  });

  it('raises the failure a test scripted, with its own code', async () => {
    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'failure', code: 'PROVIDER_UNAVAILABLE', message: 'scripted outage' }],
    });

    await expect(provider.generate(request())).rejects.toBeInstanceOf(
      FakeModelProviderScriptedFailureError,
    );
    const failed = new FakeModelProvider({
      outcomes: [{ kind: 'failure', code: 'PROVIDER_UNAVAILABLE', message: 'scripted outage' }],
    });
    try {
      await failed.generate(request());
    } catch (cause) {
      expect((cause as FakeModelProviderScriptedFailureError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  it('carries configured usage exactly, and omits it when unconfigured', async () => {
    const provider = new FakeModelProvider({
      outcomes: [
        {
          kind: 'result',
          result: result('with usage', { usage: { inputTokens: 11, outputTokens: 3 } }),
        },
        { kind: 'result', result: result('without usage') },
      ],
    });

    expect((await provider.generate(request())).usage).toEqual({
      inputTokens: 11,
      outputTokens: 3,
    });
    // Absent usage stays absent: a fabricated count would let a test assert a
    // provider-native number nothing produced.
    expect((await provider.generate(request())).usage).toBeUndefined();
  });

  it('fails explicitly on a call no outcome covers', async () => {
    const provider = new FakeModelProvider({
      outcomes: [{ kind: 'result', result: result('one') }],
    });
    await provider.generate(request());
    await expect(provider.generate(request())).rejects.toBeInstanceOf(
      FakeModelProviderUnscriptedCallError,
    );
  });

  it('never quotes the user prompt in a failure message', async () => {
    const provider = new FakeModelProvider({
      outcomesByUserPrompt: [
        { userPrompt: 'known', outcome: { kind: 'result', result: result('ok') } },
      ],
    });

    try {
      await provider.generate(request({ userPrompt: 'TOP-SECRET-CONTEXT' }));
      throw new Error('expected a rejection');
    } catch (cause) {
      // The prompt carries the evaluation context, and a test failure message is
      // not a place to print source content (INV-SEC-001).
      expect(String((cause as Error).message)).not.toContain('TOP-SECRET-CONTEXT');
    }
  });

  it('snapshots calls and results, so neither side can rewrite the other', async () => {
    const scripted = result('answer', { usage: { inputTokens: 5 } });
    const provider = new FakeModelProvider({ outcomes: [{ kind: 'result', result: scripted }] });

    const sent = request({ userPrompt: 'original' });
    const returned = await provider.generate(sent);

    expect(provider.calls[0]).not.toBe(sent);
    expect(returned).not.toBe(scripted);
    expect(provider.calls[0]?.userPrompt).toBe('original');
  });

  it('rejects a configuration with neither, both, or a malformed outcome', () => {
    expect(() => new FakeModelProvider()).toThrow(FakeModelProviderConfigurationError);
    expect(
      () =>
        new FakeModelProvider({
          outcomes: [{ kind: 'result', result: result('a') }],
          outcomesByUserPrompt: [
            { userPrompt: 'p', outcome: { kind: 'result', result: result('b') } },
          ],
        }),
    ).toThrow(FakeModelProviderConfigurationError);
    expect(() => new FakeModelProvider({ outcomes: [] })).toThrow(
      FakeModelProviderConfigurationError,
    );
    expect(
      () =>
        new FakeModelProvider({
          outcomes: [{ kind: 'result', result: { schemaVersion: 2, outputText: 'x' } as never }],
        }),
    ).toThrow(FakeModelProviderConfigurationError);
    expect(
      () =>
        new FakeModelProvider({
          outcomesByUserPrompt: [
            { userPrompt: 'p', outcome: { kind: 'result', result: result('a') } },
            { userPrompt: 'p', outcome: { kind: 'result', result: result('b') } },
          ],
        }),
    ).toThrow(FakeModelProviderConfigurationError);
  });

  it('publishes one configured model identity, never a per-request one', async () => {
    const provider = new FakeModelProvider({
      modelId: 'bench-model-1',
      id: 'fake',
      version: '2',
      outcomes: [{ kind: 'result', result: result('x') }],
    });

    expect(provider.modelId).toBe('bench-model-1');
    expect(provider.id).toBe('fake');
    expect(provider.version).toBe('2');
    await provider.generate(request());
    expect(Object.keys(provider.calls[0] ?? {})).not.toContain('modelId');
  });
});

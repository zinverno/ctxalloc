import { CompileLocalContextService, LocalSourcePipelineError } from '@ctxalloc/application';
import { ContextCompilationError } from '@ctxalloc/compiler';
import type { CandidateProvider } from '@ctxalloc/ports';
import { InMemoryControlStore, InMemorySourceReader } from '@ctxalloc/testing';
import { describe, expect, it, vi } from 'vitest';
import { localRequest, serviceConfig } from './local-service-fixtures.js';
import { wordTokenizer } from './text-fixtures.js';
const build = (getCandidates: CandidateProvider['getCandidates']) =>
  new CompileLocalContextService(
    serviceConfig(),
    wordTokenizer,
    new InMemorySourceReader([]),
    new InMemoryControlStore([]),
    { id: 'hostile', version: '1', getCandidates },
  );

describe('provider arrays at the local compilation boundary', () => {
  it('handles an array revoked after promise resolution, before awaiting continuation', async () => {
    const service = build(() => {
      const revocable = Proxy.revocable([], {});
      const promise = Promise.resolve(revocable.proxy);
      revocable.revoke();
      return promise;
    });
    await expect(service.execute(localRequest())).rejects.toBeInstanceOf(LocalSourcePipelineError);
  });
  it('never invokes an array index accessor', async () => {
    const getter = vi.fn(() => {
      throw new Error('CANARY');
    });
    const values: never[] = [];
    Object.defineProperty(values, '0', { enumerable: true, get: getter });
    await expect(
      build(() => Promise.resolve(values)).execute(localRequest()),
    ).rejects.toBeInstanceOf(LocalSourcePipelineError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects a nested accessor in the kernel without invoking it', async () => {
    const getter = vi.fn(() => {
      throw new Error('CANARY source query');
    });
    const candidate = { schemaVersion: 1 };
    Object.defineProperty(candidate, 'block', { enumerable: true, get: getter });
    await expect(
      build(() => Promise.resolve([candidate as never])).execute(localRequest()),
    ).rejects.toBeInstanceOf(ContextCompilationError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects nested cycles and revoked proxies with compiler-owned errors', async () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const block of [revoked.proxy, cyclic])
      await expect(
        build(() => Promise.resolve([{ schemaVersion: 1, block } as never])).execute(
          localRequest(),
        ),
      ).rejects.toBeInstanceOf(ContextCompilationError);
  });
});

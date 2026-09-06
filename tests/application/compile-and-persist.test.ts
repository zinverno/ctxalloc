import {
  CompilationTracePersistenceService,
  CompileAndPersistLocalContextService,
  CompileLocalContextService,
} from '@ctxalloc/application';
import {
  FakeCandidateProvider,
  InMemoryControlStore,
  InMemorySourceReader,
  InMemoryTraceStore,
} from '@ctxalloc/testing';
import { describe, expect, it, vi } from 'vitest';
import { deferred } from '../api/fixtures.js';
import { localRequest, serviceConfig } from './local-service-fixtures.js';
import { wordTokenizer } from './text-fixtures.js';

const local = () =>
  new CompileLocalContextService(
    serviceConfig(),
    wordTokenizer,
    new InMemorySourceReader([]),
    new InMemoryControlStore([]),
    new FakeCandidateProvider(),
  );
describe('one compile then persist orchestration', () => {
  it('publishes the exact result only after the trace store completes', async () => {
    const compiler = local();
    const result = await compiler.execute(localRequest());
    vi.spyOn(compiler, 'execute').mockResolvedValue(result);
    const traceStore = new InMemoryTraceStore();
    const started = deferred<void>();
    const release = deferred<void>();
    const put = vi.spyOn(traceStore, 'putTrace').mockImplementation(async () => {
      started.resolve();
      await release.promise;
    });
    const service = new CompileAndPersistLocalContextService(
      compiler,
      new CompilationTracePersistenceService(traceStore),
    );
    let published = false;
    const pending = service.execute(localRequest()).then((value) => {
      published = true;
      return value;
    });
    await started.promise;
    expect(published).toBe(false);
    expect(put.mock.calls[0]?.[0].payload).toEqual(result.compilation.trace);
    expect(JSON.stringify(put.mock.calls)).not.toContain('compiledContext');
    release.resolve();
    expect(await pending).toBe(result);
  });
  it('does not store a failed compilation, and does not retry or change a compilation when persistence fails', async () => {
    const compiler = local();
    const store = new InMemoryTraceStore();
    const put = vi.spyOn(store, 'putTrace').mockRejectedValue(new Error('SQL SECRET'));
    const service = new CompileAndPersistLocalContextService(
      compiler,
      new CompilationTracePersistenceService(store),
    );
    await expect(service.execute({})).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
    const execute = vi.spyOn(compiler, 'execute');
    await expect(service.execute(localRequest())).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

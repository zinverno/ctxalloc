import { request } from 'node:http';
import { expect, it, vi } from 'vitest';
import type { LocalCompilationResult } from '@ctxalloc/application';
import { listenApi } from '../../apps/api/src/server.js';
import { createApiRequestHandler } from '../../apps/api/src/handler.js';
import { deferred, emptyRuntime, send, serverConfig } from './fixtures.js';

it('has no queue, keeps health answerable, and releases failed request slots', async () => {
  const runtime = emptyRuntime();
  const entered = deferred<void>();
  const gate = deferred<LocalCompilationResult>();
  const execute = vi.spyOn(runtime.compile, 'execute').mockImplementation(() => {
    entered.resolve();
    return gate.promise;
  });
  const running = await listenApi(runtime, { ...serverConfig, maxConcurrentRequests: 1 });
  try {
    const pending = send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' });
    await entered.promise;
    const busy = await send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' });
    expect(busy.status).toBe(503);
    expect(busy.json.error).toMatchObject({ code: 'server_busy' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await send(running.port, '/health')).status).toBe(200);
    gate.reject(new Error('/private QUERY SQLITE_BUSY'));
    expect((await pending).status).toBe(500);
    expect(
      (await send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' })).status,
    ).toBe(500);
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    await running.close();
  }
});

it('marks not-ready before drain and closes stores once after disconnected application work completes', async () => {
  const runtime = emptyRuntime();
  const entered = deferred<void>();
  const gate = deferred<LocalCompilationResult>();
  runtime.compile.execute = () => {
    entered.resolve();
    return gate.promise;
  };
  const closed = vi.spyOn(runtime, 'close');
  const running = await listenApi(runtime, serverConfig);
  const client = request({
    host: '127.0.0.1',
    port: running.port,
    path: '/v1/context/compile',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  client.on('error', () => {});
  client.end('{}');
  await entered.promise;
  running.handler.beginShutdown();
  expect((await send(running.port, '/ready')).json).toEqual({
    schemaVersion: 1,
    status: 'not-ready',
  });
  expect(
    (await send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' })).json.error,
  ).toMatchObject({ code: 'not_ready' });
  client.destroy();
  const shutdown = running.close();
  expect(running.close()).toBe(shutdown);
  await new Promise((resolve) => setTimeout(resolve, serverConfig.shutdownGraceMs + 20));
  expect(closed).not.toHaveBeenCalled();
  gate.reject(new Error('source failure'));
  await shutdown;
  expect(closed).toHaveBeenCalledTimes(1);
});

it('client abort while streaming releases its slot without starting compilation', async () => {
  const runtime = emptyRuntime();
  const execute = vi.spyOn(runtime.compile, 'execute');
  const running = await listenApi(runtime, { ...serverConfig, maxConcurrentRequests: 1 });
  try {
    const continued = deferred<void>();
    const client = request({
      host: '127.0.0.1',
      port: running.port,
      path: '/v1/context/compile',
      method: 'POST',
      headers: { 'content-type': 'application/json', expect: '100-continue', 'content-length': 20 },
    });
    client.on('error', () => {});
    client.once('continue', () => continued.resolve());
    client.flushHeaders();
    await continued.promise;
    expect(
      (await send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' })).status,
    ).toBe(503);
    client.destroy();
    await running.handler.whenIdle();
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await send(running.port, '/v1/context/compile', { method: 'POST', body: '{}' })).status,
    ).toBe(500);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await running.close();
  }
});

it('new handlers start not-ready before the listener is composed', async () => {
  const runtime = emptyRuntime();
  const handler = createApiRequestHandler(runtime, serverConfig);
  // Exercise startup state through the same real transport with no markReady call.
  const { createServer } = await import('node:http');
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    expect((await send(address.port, '/ready')).status).toBe(503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

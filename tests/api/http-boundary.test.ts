import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listenApi } from '../../apps/api/src/server.js';
import { serializeResponse } from '../../apps/api/src/response.js';
import { toApiError } from '../../apps/api/src/errors.js';
import { emptyRuntime, send, serverConfig } from './fixtures.js';

let running: Awaited<ReturnType<typeof listenApi>>;
const runtime = emptyRuntime();
const traceGet = vi.fn(runtime.traces.get);
runtime.traces.get = traceGet;
beforeAll(async () => {
  running = await listenApi(runtime, { ...serverConfig, maxRequestBodyBytes: 32 });
});
afterAll(async () => {
  await running.close();
});
const scope = '?tenantId=local&workspaceId=api';

describe('exact HTTP routes', () => {
  it('liveness and readiness expose only runtime status', async () => {
    expect((await send(running.port, '/health')).json).toEqual({ schemaVersion: 1, status: 'ok' });
    expect((await send(running.port, '/ready')).json).toEqual({
      schemaVersion: 1,
      status: 'ready',
    });
  });
  it.each([
    '/missing',
    '/Health',
    '/health/',
    '/v1/context/compile/',
    '/v1/traces/a/b',
    '/v1/traces/',
    '/metrics',
    '/version',
    '/v1/sources',
  ])('returns 404 for %s', async (path) =>
    expect((await send(running.port, path)).status).toBe(404),
  );
  it.each([
    ['/health?', 'GET'],
    ['/ready?x=1', 'GET'],
    ['/v1/context/compile?x=1', 'POST'],
  ])('rejects query on %s', async (path, method) =>
    expect((await send(running.port, path, { method })).status).toBe(400),
  );
  it.each([
    ['/health', 'POST', 'GET'],
    ['/ready', 'HEAD', 'GET'],
    ['/health', 'OPTIONS', 'GET'],
    ['/v1/context/compile', 'GET', 'POST'],
    ['/v1/context/compile?x=1', 'GET', 'POST'],
    ['/v1/traces/a', 'POST', 'GET'],
    ['/v1/evaluations/run', 'OPTIONS', 'POST'],
    [`/v1/traces/a${scope}`, 'POST', 'GET'],
  ])('has fixed Allow for %s %s', async (path, method, allow) => {
    const result = await send(running.port, path, { method });
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe(allow);
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
    expect(result.headers['set-cookie']).toBeUndefined();
  });
  it.each(['/health', '/ready', `/v1/traces/a${scope}`])(
    'rejects GET body for %s',
    async (path) => {
      expect((await send(running.port, path, { body: '{}' })).status).toBe(400);
      expect(
        (
          await send(running.port, path, {
            body: '{}',
            chunked: true,
            headers: { 'transfer-encoding': 'chunked' },
          })
        ).status,
      ).toBe(400);
    },
  );
});
describe('bounded strict HTTP bodies', () => {
  it.each([
    [undefined, undefined, 415],
    ['text/json', undefined, 415],
    ['application/json; charset=latin1', undefined, 415],
    ['application/json', 'gzip', 415],
    ['application/json', 'br', 415],
    ['application/json', 'deflate', 415],
    ['application/json', undefined, 500],
    ['application/json; charset=utf-8', 'identity', 500],
    ['application/json; charset="UTF-8"', undefined, 500],
  ])('validates type=%s encoding=%s', async (type, encoding, status) => {
    const result = await send(running.port, '/v1/context/compile', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': type, 'content-encoding': encoding },
    });
    expect(result.status).toBe(status);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
  });
  it.each([
    '',
    '{',
    '{} trailing',
    '\ufeff{}',
    Buffer.from([123, 34, 120, 34, 58, 34, 128, 34, 125]),
    Buffer.from([123, 34, 120, 34, 58, 34, 240, 159]),
  ])('rejects malformed body %#', async (body) =>
    expect((await send(running.port, '/v1/context/compile', { method: 'POST', body })).status).toBe(
      400,
    ),
  );
  it('preserves valid supplementary Unicode through decoding', async () => {
    const execute = vi.spyOn(runtime.compile, 'execute');
    await send(running.port, '/v1/context/compile', { method: 'POST', body: '{"query":"🚦"}' });
    expect(execute).toHaveBeenLastCalledWith({ query: '🚦' });
  });
  it('enforces both known and chunked actual byte limits', async () => {
    for (const chunked of [false, true])
      expect(
        (
          await send(running.port, '/v1/context/compile', {
            method: 'POST',
            body: 'x'.repeat(33),
            chunked,
          })
        ).status,
      ).toBe(413);
  });
  it('rejects oversized Expect before sending 100; accepts a bounded Expect body', async () => {
    const rejected = await send(running.port, '/v1/context/compile', {
      method: 'POST',
      body: 'x'.repeat(33),
      expect: true,
    });
    expect(rejected.status).toBe(413);
    expect(rejected.continued).toBe(false);
    const accepted = await send(running.port, '/v1/context/compile', {
      method: 'POST',
      body: '{}',
      expect: true,
    });
    expect(accepted.status).toBe(500);
    expect(accepted.continued).toBe(true);
  });
  it.each(['-1', 'one', '1.5', '1e2', '9007199254740992'])(
    'sanitizes a parser-invalid Content-Length %s',
    async (length) => {
      const result = await new Promise<string>((resolve, reject) => {
        const socket = connect(running.port, '127.0.0.1');
        let text = '';
        socket.on('connect', () =>
          socket.write(
            `POST /v1/context/compile HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`,
          ),
        );
        socket.on('data', (chunk) => {
          text += chunk.toString();
        });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
      expect(result).toContain('400');
      expect(result).toContain('"schemaVersion":1');
      expect(result).not.toContain('HPE_');
    },
  );
  it('pins the exact Node timeout fields', () => {
    expect(running.server.requestTimeout).toBe(serverConfig.requestTimeoutMs);
    expect(running.server.headersTimeout).toBe(serverConfig.headersTimeoutMs);
    expect(running.server.keepAliveTimeout).toBe(serverConfig.keepAliveTimeoutMs);
  });
});
describe('trace URL exactness and scope privacy', () => {
  it.each([
    '?workspaceId=a',
    '?tenantId=a',
    '?tenantId=a&workspaceId=b&tenantId=a',
    '?tenantId=a&workspaceId=b&workspaceId=b',
    '?tenantId=a&workspaceId=b&projectId=c&projectId=c',
    '?tenantId=a&workspaceId=b&unknown=c',
    '?tenantId=%80&workspaceId=b',
    '?tenantId=%&workspaceId=b',
    '?tenantId=&workspaceId=b',
  ])('rejects query %s', async (query) =>
    expect((await send(running.port, `/v1/traces/a${query}`)).status).toBe(400),
  );
  it.each(['%', '%GG', '%2F', '%5c', '%00', '%20', '%ED%A0%80', 'x'.repeat(257)])(
    'rejects malformed id %s',
    async (id) => expect((await send(running.port, `/v1/traces/${id}${scope}`)).status).toBe(400),
  );
  it('decodes once, retains exact scope, and distinguishes absent project from present', async () => {
    await send(running.port, `/v1/traces/sha256%3Aa${scope}`);
    expect(traceGet).toHaveBeenLastCalledWith(
      { tenantId: 'local', workspaceId: 'api' },
      'sha256:a',
    );
    await send(running.port, `/v1/traces/%252F${scope}&projectId=%20P%20`);
    expect(traceGet).toHaveBeenLastCalledWith(
      { tenantId: 'local', workspaceId: 'api', projectId: ' P ' },
      '%2F',
    );
  });
  it('returns identical absent and wrong-scope envelopes', async () => {
    const first = await send(running.port, `/v1/traces/a${scope}`);
    const second = await send(running.port, '/v1/traces/missing?tenantId=other&workspaceId=other');
    expect(first.status).toBe(404);
    expect(first.text).toBe(second.text);
  });
});
it('serialization failures and thrown proxies cannot leak native wording', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(serializeResponse(200, cyclic)).toMatchObject({ status: 500 });
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  expect(toApiError(proxy.proxy).envelope()).toEqual(
    toApiError(new Error('/secret QUERY SQLITE_BUSY')).envelope(),
  );
});

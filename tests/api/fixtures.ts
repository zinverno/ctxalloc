import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import type { ApiRuntime } from '../../apps/api/src/runtime.js';
import type { ServerConfig } from '../../apps/api/src/config.js';

export const serverConfig: ServerConfig = {
  schemaVersion: 1,
  host: '127.0.0.1',
  port: 0,
  maxRequestBodyBytes: 65536,
  maxConcurrentRequests: 2,
  requestTimeoutMs: 30000,
  headersTimeoutMs: 10000,
  keepAliveTimeoutMs: 5000,
  shutdownGraceMs: 100,
};
export function emptyRuntime(): ApiRuntime {
  return {
    compile: { execute: () => Promise.reject(new Error('unconfigured')) },
    traces: { get: () => Promise.resolve(null) },
    evaluation: { runSuite: () => Promise.reject(new Error('unconfigured')) },
    close() {},
  };
}
export interface HttpResult {
  status: number;
  headers: OutgoingHttpHeaders;
  text: string;
  json: Record<string, unknown>;
  continued: boolean;
}
export function send(
  port: number,
  path: string,
  options: {
    method?: string;
    body?: string | Buffer;
    headers?: OutgoingHttpHeaders;
    expect?: boolean;
    chunked?: boolean;
  } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let continued = false;
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: Object.fromEntries(
          Object.entries({
            ...(options.body === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  ...(options.chunked ? {} : { 'content-length': Buffer.byteLength(options.body) }),
                }),
            ...(options.expect ? { expect: '100-continue' } : {}),
            ...options.headers,
          }).filter(([, value]) => value !== undefined),
        ),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
            continued,
          });
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    const end = () => {
      if (options.body !== undefined) request.write(options.body);
      request.end();
    };
    if (options.expect) {
      request.once('continue', () => {
        continued = true;
        end();
      });
      request.flushHeaders();
    } else end();
  });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

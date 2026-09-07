import { createServer } from 'node:http';
import type { ApiConfig, ServerConfig } from './config.js';
import { ApiError } from './errors.js';
import { createApiRequestHandler } from './handler.js';
import { serializeResponse, writeJson } from './response.js';
import { createApiRuntime, type ApiRuntime } from './runtime.js';

/** Listener lifecycle is app-internal; the package entry point exports no Node types. */
export async function listenApi(runtime: ApiRuntime, config: ServerConfig) {
  const handler = createApiRequestHandler(runtime, config);
  const server = createServer(
    {
      requestTimeout: config.requestTimeoutMs,
      headersTimeout: config.headersTimeoutMs,
      keepAliveTimeout: config.keepAliveTimeoutMs,
    },
    (request, response) => {
      void handler.handle(request, response);
    },
  );
  server.on('checkContinue', (request, response) => {
    void handler.handle(request, response, true);
  });
  server.on('checkExpectation', (_request, response) =>
    writeJson(response, 417, new ApiError(417, 'unsupported_expectation').envelope()),
  );
  server.on('clientError', (_cause, socket) => {
    if (socket.destroyed || !socket.writable || socket.writableEnded) return;
    const { body } = serializeResponse(400, new ApiError(400, 'invalid_request').envelope());
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new ApiError(500, 'internal_error', 'runtime'));
      server.once('error', failed);
      server.listen(config.port, config.host, () => {
        server.off('error', failed);
        resolve();
      });
    });
  } catch {
    try {
      runtime.close();
    } catch {
      /* Preserve a fixed startup failure. */
    }
    throw new ApiError(500, 'internal_error', 'runtime');
  }
  handler.markReady();
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (shutdown !== undefined) return shutdown;
    handler.beginShutdown();
    shutdown = (async () => {
      const drained = new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(new ApiError(500, 'internal_error', 'runtime')),
        ),
      );
      const timer = setTimeout(() => server.closeAllConnections(), config.shutdownGraceMs);
      try {
        // Client disconnect is not proof that the application operation completed.
        const completed = await Promise.allSettled([drained, handler.whenIdle()]);
        if (completed.some((result) => result.status === 'rejected'))
          throw new ApiError(500, 'internal_error', 'runtime');
      } finally {
        clearTimeout(timer);
        runtime.close();
      }
    })();
    return shutdown;
  };
  server.on('error', () => {
    void close().catch(() => {});
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await close();
    throw new ApiError(500, 'internal_error', 'runtime');
  }
  return { server, handler, port: address.port, close };
}
export function startApiServer(config: ApiConfig) {
  return listenApi(createApiRuntime(config), config.server);
}

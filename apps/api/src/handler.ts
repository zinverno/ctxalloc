import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { checkBodyHeaders, readJsonBody, rejectGetBody } from './body.js';
import type { ServerConfig } from './config.js';
import { ApiError, toApiError } from './errors.js';
import { API_CONTRACT_VERSION } from './index.js';
import { writeJson } from './response.js';
import { matchRoute, routeMethod } from './routes.js';
import type { ApiRuntime } from './runtime.js';

const EvaluationWrapper = z.strictObject({
  schemaVersion: z.literal(1),
  runConfig: z.unknown(),
  case: z.unknown(),
});

export function createApiRequestHandler(runtime: ApiRuntime, config: ServerConfig) {
  let ready = false;
  let stopping = false;
  let active = 0;
  const idleWaiters = new Set<() => void>();
  return {
    markReady() {
      if (!stopping) ready = true;
    },
    beginShutdown() {
      ready = false;
      stopping = true;
    },
    whenIdle(): Promise<void> {
      return active === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.add(resolve));
    },
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
      expectContinue = false,
    ): Promise<void> {
      // Absorb late stream errors after the bounded reader releases its listeners.
      request.on('error', () => {});
      response.on('error', () => {});
      let occupied = false;
      try {
        const method = routeMethod(request.url ?? '');
        if (method !== undefined && request.method !== method) {
          writeJson(response, 405, new ApiError(405, 'method_not_allowed').envelope(), method);
          return;
        }
        const route = matchRoute(request.url ?? '');
        if (route.method === 'GET') rejectGetBody(request);
        if (route.kind === 'health') {
          writeJson(response, 200, { schemaVersion: API_CONTRACT_VERSION, status: 'ok' });
          return;
        }
        if (route.kind === 'ready') {
          writeJson(response, ready ? 200 : 503, {
            schemaVersion: API_CONTRACT_VERSION,
            status: ready ? 'ready' : 'not-ready',
          });
          return;
        }
        if (!ready || stopping) throw new ApiError(503, 'not_ready', 'runtime');
        if (route.method === 'POST') checkBodyHeaders(request, config.maxRequestBodyBytes);
        if (active >= config.maxConcurrentRequests)
          throw new ApiError(503, 'server_busy', 'runtime');
        active += 1;
        occupied = true;
        if (expectContinue) response.writeContinue();
        if (route.kind === 'trace') {
          const trace = await runtime.traces.get(route.scope, route.compilationId);
          if (trace === null) throw new ApiError(404, 'not_found');
          writeJson(response, 200, trace);
          return;
        }
        const body = await readJsonBody(request, config.maxRequestBodyBytes);
        if (route.kind === 'compile') {
          const { compilation } = await runtime.compile.execute(body);
          writeJson(response, 200, {
            schemaVersion: API_CONTRACT_VERSION,
            compilationId: compilation.compilationId,
            compiledContext: compilation.compiledContext,
            includedBlockIds: compilation.includedBlocks.map((block) => String(block.id)),
            usage: compilation.usage,
            traceStored: true,
          });
        } else {
          const parsed = EvaluationWrapper.safeParse(body);
          if (!parsed.success) throw new ApiError(400, 'invalid_request', 'evaluation');
          const report = await runtime.evaluation.runSuite(parsed.data.runConfig, [
            parsed.data.case,
          ]);
          writeJson(response, 200, report);
        }
      } catch (cause) {
        const error = toApiError(cause);
        writeJson(response, error.status, error.envelope());
      } finally {
        if (occupied) {
          active -= 1;
          if (active === 0) {
            for (const resolve of idleWaiters) resolve();
            idleWaiters.clear();
          }
        }
      }
    },
  };
}

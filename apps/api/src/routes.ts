import { findLoneSurrogate, ScopeSchema, type Scope } from '@ctxalloc/domain';
import { ApiError } from './errors.js';

export type Route =
  | { kind: 'health' | 'ready' | 'compile' | 'evaluation'; method: 'GET' | 'POST' }
  | { kind: 'trace'; method: 'GET'; compilationId: string; scope: Scope };
const TRACE_ID_LIMIT = 256;
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'invalid_request');
  }
}
export function matchRoute(target: string): Route {
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\s\u0080-\uffff]/.test(target))
    throw new ApiError(400, 'invalid_request');
  // Validate escapes without changing the path used for dispatch.
  decode(target);
  const separator = target.indexOf('?');
  const path = separator < 0 ? target : target.slice(0, separator);
  const query = separator < 0 ? undefined : target.slice(separator + 1);
  const fixed = new Map<string, Route>([
    ['/health', { kind: 'health', method: 'GET' }],
    ['/ready', { kind: 'ready', method: 'GET' }],
    ['/v1/context/compile', { kind: 'compile', method: 'POST' }],
    ['/v1/evaluations/run', { kind: 'evaluation', method: 'POST' }],
  ]);
  const route = fixed.get(path);
  if (route !== undefined) {
    if (query !== undefined) throw new ApiError(400, 'invalid_request');
    return route;
  }
  const match = /^\/v1\/traces\/([^/]+)$/.exec(path);
  if (match === null) throw new ApiError(404, 'not_found');
  const compilationId = decode(match[1] ?? '');
  if (
    !compilationId.trim() ||
    compilationId.length > TRACE_ID_LIMIT ||
    /[/\\\0]/.test(compilationId) ||
    findLoneSurrogate(compilationId) !== null
  )
    throw new ApiError(400, 'invalid_request');
  const values = new Map<string, string>();
  for (const part of (query ?? '').split('&')) {
    const equals = part.indexOf('=');
    if (equals < 0) throw new ApiError(400, 'invalid_request');
    const name = decode(part.slice(0, equals).replace(/\+/g, ' '));
    const value = decode(part.slice(equals + 1).replace(/\+/g, ' '));
    if (!['tenantId', 'workspaceId', 'projectId'].includes(name) || values.has(name))
      throw new ApiError(400, 'invalid_request');
    values.set(name, value);
  }
  const parsed = ScopeSchema.safeParse(Object.fromEntries(values));
  if (!parsed.success) throw new ApiError(400, 'invalid_request');
  return { kind: 'trace', method: 'GET', compilationId, scope: parsed.data };
}

/** Decide the fixed method from route shape before validating caller parameters. */
export function routeMethod(target: string): 'GET' | 'POST' | undefined {
  const path = target.split('?')[0];
  if (path === '/v1/context/compile' || path === '/v1/evaluations/run') return 'POST';
  if (path === '/health' || path === '/ready' || /^\/v1\/traces\/[^/]+$/.test(path ?? ''))
    return 'GET';
  return undefined;
}

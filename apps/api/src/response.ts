import type { ServerResponse } from 'node:http';
import { ApiError } from './errors.js';

export function serializeResponse(
  status: number,
  value: unknown,
): { status: number; body: string } {
  try {
    const body = JSON.stringify(value);
    if (body === undefined) throw new Error();
    return { status, body };
  } catch {
    return {
      status: 500,
      body: JSON.stringify(new ApiError(500, 'internal_error', 'runtime').envelope()),
    };
  }
}
export function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  allow?: 'GET' | 'POST',
): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return;
  const serialized = serializeResponse(status, value);
  response.statusCode = serialized.status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(serialized.body));
  if (serialized.status >= 400) response.setHeader('connection', 'close');
  if (allow !== undefined && serialized.status === 405) response.setHeader('allow', allow);
  response.end(serialized.body);
}

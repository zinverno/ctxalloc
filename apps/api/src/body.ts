import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

export function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length'];
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new ApiError(400, 'invalid_request');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new ApiError(400, 'invalid_request');
  return length;
}
export function checkBodyHeaders(request: IncomingMessage, limit: number): void {
  const length = contentLength(request);
  if (length !== undefined && length > limit) throw new ApiError(413, 'body_too_large');
  const type = request.headers['content-type'];
  const encoding = request.headers['content-encoding'];
  if (
    typeof type !== 'string' ||
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type) ||
    (encoding !== undefined &&
      (typeof encoding !== 'string' || encoding.toLowerCase() !== 'identity'))
  ) {
    throw new ApiError(415, 'unsupported_media');
  }
  const singleHeaders = new Set(['content-type', 'content-encoding', 'content-length']);
  const seen = new Set<string>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]?.toLowerCase();
    if (name !== undefined && singleHeaders.has(name)) {
      if (seen.has(name)) throw new ApiError(400, 'invalid_request');
      seen.add(name);
    }
  }
}
export function rejectGetBody(request: IncomingMessage): void {
  if ((contentLength(request) ?? 0) > 0 || request.headers['transfer-encoding'] !== undefined)
    throw new ApiError(400, 'invalid_request');
}

/** A single bounded streaming reader; no replacement UTF-8 and no body logging. */
export function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAbort);
      request.off('error', onAbort);
    };
    const fail = (error: ApiError) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onAbort = () => fail(new ApiError(400, 'request_aborted'));
    const onData = (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > limit) {
        fail(new ApiError(413, 'body_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        if (total === 0) throw new ApiError(400, 'invalid_request');
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          Buffer.concat(chunks, total),
        );
        const value: unknown = JSON.parse(text);
        resolve(value);
      } catch {
        reject(new ApiError(400, 'invalid_request'));
      }
    };
    if (request.destroyed || request.aborted) {
      reject(new ApiError(400, 'request_aborted'));
      return;
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAbort);
    request.once('error', onAbort);
  });
}

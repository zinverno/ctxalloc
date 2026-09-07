import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { findLoneSurrogate, safeParse } from '@ctxalloc/domain';
import { z } from 'zod';
import { ApiError } from './errors.js';

const positive = z.int().min(1);
const timer = positive.max(2_147_483_647);
const path = z
  .string()
  .refine(
    (value) =>
      value.trim().length > 0 && !value.includes('\0') && findLoneSurrogate(value) === null,
  );
// An explicit IP literal avoids DNS-dependent binding and wildcard spelling ambiguities.
const ServerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    host: z.string().refine((value) => isIP(value) !== 0),
    port: z.int().min(0).max(65535),
    maxRequestBodyBytes: positive,
    maxConcurrentRequests: positive,
    requestTimeoutMs: timer,
    headersTimeoutMs: timer,
    keepAliveTimeoutMs: timer,
    shutdownGraceMs: timer,
  })
  .refine((value) => value.headersTimeoutMs <= value.requestTimeoutMs);
const ConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  databasePath: path,
  sourceRoot: path,
  maxSourceBytes: positive,
  candidateProvider: z.looseObject({}),
  localCompile: z.looseObject({}),
  server: ServerSchema,
});
export type ServerConfig = z.infer<typeof ServerSchema>;
export type ApiConfig = z.infer<typeof ConfigSchema>;

export function parseApiConfig(input: unknown, configPath: string): ApiConfig {
  const parsed = safeParse(ConfigSchema, input);
  if (!parsed.ok) throw new ApiError(500, 'invalid_config', 'config');
  const base = dirname(resolve(configPath));
  const absolute = (value: string) => (isAbsolute(value) ? value : resolve(base, value));
  return {
    ...parsed.value,
    databasePath: absolute(parsed.value.databasePath),
    sourceRoot: absolute(parsed.value.sourceRoot),
  };
}
export function loadApiConfig(configPath: string): ApiConfig {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      readFileSync(configPath),
    );
    return parseApiConfig(JSON.parse(text), configPath);
  } catch {
    throw new ApiError(500, 'invalid_config', 'config');
  }
}

/** Exactly one --config value, with no environment or discovery path. */
export function configArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]?.trim() || argv[1].startsWith('--')) {
    throw new ApiError(400, 'invalid_request');
  }
  return argv[1];
}

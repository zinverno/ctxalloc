import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configArgument, loadApiConfig, parseApiConfig } from '../../apps/api/src/config.js';
import { createApiRuntime } from '../../apps/api/src/runtime.js';
import { ApiError } from '../../apps/api/src/errors.js';
import { cliConfig, createWorkspace, type Workspace } from '../cli/fixtures.js';
import { serverConfig } from './fixtures.js';

const workspaces: Workspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});
const config = () => ({ ...cliConfig(), server: { ...serverConfig } });
describe('API explicit configuration', () => {
  it('resolves relative paths from the config file even with an unrelated cwd', () => {
    const workspace = createWorkspace(config());
    workspaces.push(workspace);
    const loaded = loadApiConfig(workspace.configPath);
    expect(loaded.databasePath).toBe(workspace.databasePath);
    expect(loaded.sourceRoot).toBe(workspace.sourceRoot);
    expect(loaded.server.port).toBe(0);
    expect(
      parseApiConfig(
        { ...config(), databasePath: workspace.databasePath },
        '/unrelated/config.json',
      ).databasePath,
    ).toBe(workspace.databasePath);
  });
  it.each([
    null,
    {},
    { ...config(), extra: true },
    { ...config(), schemaVersion: 2 },
    { ...config(), server: undefined },
    { ...config(), databasePath: '' },
    { ...config(), sourceRoot: '\ud800' },
    { ...config(), maxSourceBytes: '3' },
    { ...config(), localCompile: [] },
  ])('rejects an invalid outer config %#', (input) => {
    expect(() => parseApiConfig(input, '/config/api.json')).toThrow(ApiError);
  });
  it.each([
    ['host', ''],
    ['host', 'localhost'],
    ['host', ' 127.0.0.1'],
    ['host', 'https://example.com'],
    ['port', -1],
    ['port', 65536],
    ['port', '8787'],
    ['port', 0.5],
    ['maxRequestBodyBytes', 0],
    ['maxRequestBodyBytes', Number.MAX_SAFE_INTEGER + 1],
    ['maxConcurrentRequests', 0],
    ['maxConcurrentRequests', 1.5],
    ['requestTimeoutMs', 0],
    ['headersTimeoutMs', 30001],
    ['keepAliveTimeoutMs', 2147483648],
    ['shutdownGraceMs', Number.POSITIVE_INFINITY],
    ['extra', true],
  ])('rejects invalid server %s=%s', (key, value) => {
    expect(() =>
      parseApiConfig(
        { ...config(), server: { ...serverConfig, [key]: value } },
        '/config/api.json',
      ),
    ).toThrow(ApiError);
  });
  it.each([
    'host',
    'port',
    'maxRequestBodyBytes',
    'maxConcurrentRequests',
    'requestTimeoutMs',
    'headersTimeoutMs',
    'keepAliveTimeoutMs',
    'shutdownGraceMs',
  ])('requires explicit %s', (key) => {
    const server: Record<string, unknown> = { ...serverConfig };
    delete server[key];
    expect(() => parseApiConfig({ ...config(), server }, '/config/api.json')).toThrow(ApiError);
  });
  it.each([
    Buffer.from('{'),
    Buffer.from([123, 34, 120, 34, 58, 34, 128, 34, 125]),
    Buffer.from('\ufeff{}'),
  ])('rejects malformed config bytes %# without echo', (bytes) => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    writeFileSync(workspace.configPath, bytes);
    expect(() => loadApiConfig(workspace.configPath)).toThrow('invalid or unreadable');
    try {
      loadApiConfig(workspace.configPath);
    } catch (cause) {
      expect(JSON.stringify(cause)).not.toContain(workspace.root);
    }
  });
  it('sanitizes startup store failure and delegates nested semantics', () => {
    const workspace = createWorkspace();
    workspaces.push(workspace);
    const loaded = parseApiConfig(
      { ...config(), databasePath: join(workspace.root, 'missing', 'secret.sqlite') },
      workspace.configPath,
    );
    expect(() => createApiRuntime(loaded)).toThrow(ApiError);
    try {
      createApiRuntime(loaded);
    } catch (cause) {
      expect(JSON.stringify(cause)).not.toContain(workspace.root);
    }
  });
  it.each(
    [
      [],
      ['--config'],
      ['--config=a'],
      ['--config', 'a', '--config', 'b'],
      ['--config', 'a', 'extra'],
      ['--port', '1'],
      ['a'],
      ['--config', '--unknown'],
    ].map((argv) => [argv] as const),
  )('requires exactly --config path %#', (argv) => {
    expect(() => configArgument(argv)).toThrow(ApiError);
  });
  it('accepts exactly --config path', () =>
    expect(configArgument(['--config', 'a.json'])).toBe('a.json'));
});

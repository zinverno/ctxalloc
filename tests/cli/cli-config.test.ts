import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE,
  cli,
  cliConfig,
  createWorkspace,
  failureOf,
  registration,
  successOf,
  type Workspace,
} from './fixtures.js';

/**
 * The CLI configuration contract (DEC-042).
 *
 * Two rules carry the weight here. The configuration is **explicit** — there is
 * no discovery of any kind — and its relative paths resolve against the **config
 * file's own directory**, never against `process.cwd()`. Together they make one
 * command mean the same thing wherever it is run (INV-DET-001, INV-DET-003).
 */

let workspace: Workspace | undefined;
let scratch: string | undefined;
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  workspace?.dispose();
  workspace = undefined;
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('CLI configuration: strict, explicit, and config-relative', () => {
  it('resolves relative paths against the config file directory', async () => {
    const ws = createWorkspace();
    workspace = ws;

    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('r.json', registration()),
    );

    // The config said `./ctxalloc.sqlite` and `./vault`, and both landed beside
    // the config file rather than beside the process.
    expect(existsSync(ws.databasePath)).toBe(true);
    expect(existsSync(join(originalCwd, 'ctxalloc.sqlite'))).toBe(false);
  });

  it('INV-DET-001: changing the working directory does not change the result', async () => {
    const ws = createWorkspace();
    workspace = ws;
    scratch = mkdtempSync(join(tmpdir(), 'ctxalloc-cwd-'));

    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('r.json', registration()),
    );
    const fromRepo = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );

    process.chdir(scratch);
    const fromElsewhere = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      join(ws.root, 's.json'),
    );

    expect(fromElsewhere.stdout).toBe(fromRepo.stdout);
    expect(fromElsewhere.exitCode).toBe(0);
  });

  it('accepts an absolute path exactly as written', async () => {
    const ws = createWorkspace();
    workspace = ws;
    scratch = mkdtempSync(join(tmpdir(), 'ctxalloc-abs-'));
    const absoluteDatabase = join(scratch, 'elsewhere.sqlite');

    const configPath = join(ws.root, 'absolute.json');
    writeFileSync(
      configPath,
      JSON.stringify(cliConfig({ databasePath: absoluteDatabase, sourceRoot: ws.sourceRoot })),
      'utf8',
    );

    await cli(
      'source',
      'add',
      '--config',
      configPath,
      '--registration',
      ws.write('r.json', registration()),
    );

    expect(existsSync(absoluteDatabase)).toBe(true);
    expect(existsSync(ws.databasePath)).toBe(false);
  });

  it('rejects an unknown configuration field rather than ignoring it', async () => {
    const ws = createWorkspace(cliConfig({ cacheDirectory: './cache' }));
    workspace = ws;

    const run = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(1);
    expect(envelope.stage).toBe('config');
    expect(envelope.issues[0]?.code).toBe('invalid_config');
  });

  it.each([
    ['a missing databasePath', { databasePath: undefined }],
    ['a blank databasePath', { databasePath: '   ' }],
    ['a missing sourceRoot', { sourceRoot: undefined }],
    ['an unsupported schema version', { schemaVersion: 2 }],
    ['a non-integer maxSourceBytes', { maxSourceBytes: 1.5 }],
  ])('rejects %s', async (_label, override) => {
    const config = cliConfig();
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) delete config[key];
      else config[key] = value;
    }
    const ws = createWorkspace(config);
    workspace = ws;

    const run = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );

    expect(failureOf(run).stage).toBe('config');
  });

  it('rejects a configuration file that is not valid JSON', async () => {
    const ws = createWorkspace();
    workspace = ws;
    writeFileSync(ws.configPath, '{ "schemaVersion": 1, ', 'utf8');

    const run = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );
    const envelope = failureOf(run);

    expect(envelope.stage).toBe('config');
    expect(envelope.issues[0]?.code).toBe('input_not_json');
  });

  it('reports a missing configuration file without disclosing its absolute path', async () => {
    const ws = createWorkspace();
    workspace = ws;
    const missing = join(ws.root, 'no-such-config.json');

    const run = await cli(
      'source',
      'list',
      '--config',
      missing,
      '--scope',
      ws.write('s.json', SCOPE),
    );

    expect(failureOf(run).issues[0]?.code).toBe('input_unreadable');
    expect(run.stderr).not.toContain(missing);
  });

  it('discovers no configuration: --config is always required', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ctxalloc-discovery-'));
    mkdirSync(join(scratch, 'vault'));
    // A file with every conventional name a discovering CLI might find.
    for (const name of ['ctxalloc.json', 'ctxalloc.config.json', '.ctxallocrc']) {
      writeFileSync(join(scratch, name), JSON.stringify(cliConfig()), 'utf8');
    }
    process.chdir(scratch);

    for (const argv of [
      ['source', 'list', '--scope', 'scope.json'],
      ['compile', '--request', 'request.json'],
      ['inspect-blocks', '--scope', 'scope.json'],
    ]) {
      const run = await cli(...argv);
      expect(run.exitCode).toBe(2);
      expect(failureOf(run).issues[0]?.pointer).toBe('config');
    }
  });

  it('reads no environment variable to locate a configuration or a database', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ctxalloc-env-'));
    const ws = createWorkspace();
    workspace = ws;

    process.env.CTXALLOC_CONFIG = ws.configPath;
    process.env.CTXALLOC_DATABASE = join(scratch, 'env.sqlite');
    try {
      const run = await cli('source', 'list', '--scope', ws.write('s.json', SCOPE));
      expect(run.exitCode).toBe(2);

      // And with an explicit config, the environment changes nothing.
      const explicit = await cli(
        'source',
        'list',
        '--config',
        ws.configPath,
        '--scope',
        join(ws.root, 's.json'),
      );
      expect(successOf(explicit)).toEqual({
        schemaVersion: 1,
        operation: 'list',
        registrations: [],
      });
      expect(existsSync(join(scratch, 'env.sqlite'))).toBe(false);
    } finally {
      delete process.env.CTXALLOC_CONFIG;
      delete process.env.CTXALLOC_DATABASE;
    }
  });

  it('delegates nested policy validation to the components that own it', async () => {
    // An invalid chunking policy is not restated in the CLI config schema, so it
    // is the chunker that rejects it — addressed under the field that carried it.
    const config = cliConfig();
    (config.localCompile as Record<string, unknown>).markdownChunking = {
      targetTokens: 80,
      maxTokens: 40,
    };
    const ws = createWorkspace(config);
    workspace = ws;

    const run = await cli(
      'inspect-blocks',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );
    const envelope = failureOf(run);

    expect(envelope.stage).toBe('config');
    expect(
      envelope.issues.some((issue) => issue.pointer.startsWith('config.markdownChunking')),
    ).toBe(true);
  });
});

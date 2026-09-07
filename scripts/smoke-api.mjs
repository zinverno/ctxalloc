#!/usr/bin/env node
// Real built-process acceptance: separate CLI/API databases, two formats, restart, trace privacy.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettledCompilationTraceValidator } from '../packages/compiler/dist/index.js';
import { O200kBaseTokenizer } from '../packages/tokenization/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const workspace = mkdtempSync(join(tmpdir(), 'ctxalloc-api-smoke-'));
const apiBin = join(root, 'apps/api/dist/bin.js');
const cliBin = join(root, 'apps/cli/dist/bin.js');
const sample = (name) => JSON.parse(readFileSync(join(root, 'examples/api', name), 'utf8'));
const write = (name, value) => {
  const path = join(workspace, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
};
function cli(...args) {
  const result = spawnSync(process.execPath, [cliBin, ...args], {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
let child;
let ended;
let stdout = '';
let stderr = '';
async function start(configPath, port) {
  stdout = '';
  stderr = '';
  child = spawn(process.execPath, [apiBin, '--config', configPath], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  ended = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Built API exited during startup.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) {
        assert.deepEqual(await response.json(), { schemaVersion: 1, status: 'ready' });
        return;
      }
    } catch {
      /* Listener not ready yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Built API readiness deadline exceeded.');
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 15000);
  try {
    const result = await ended;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  } finally {
    clearTimeout(timer);
    child = undefined;
  }
}
try {
  const sources = join(workspace, 'sources');
  mkdirSync(sources);
  const markdown = readFileSync(join(root, 'examples/api/sources/handbook.md'), 'utf8');
  const answer = 'Conversation evidence: the reticulator calibrates the allocator.';
  writeFileSync(join(sources, 'handbook.md'), markdown);
  writeFileSync(
    join(sources, 'conversation.json'),
    JSON.stringify({ schemaVersion: 1, messages: [{ id: 'm1', content: answer }] }),
  );
  const config = sample('config.json');
  const { server: serverConfig, ...localConfig } = config;
  const port = await freePort();
  const apiConfig = {
    ...config,
    databasePath: join(workspace, 'api.sqlite'),
    sourceRoot: sources,
    server: { ...serverConfig, port, host: '127.0.0.1', shutdownGraceMs: 1000 },
  };
  const apiConfigPath = write('api-config.json', apiConfig);
  const httpCliConfigPath = write('api-cli-config.json', {
    ...localConfig,
    databasePath: apiConfig.databasePath,
    sourceRoot: sources,
  });
  const cliConfigPath = write('cli-config.json', {
    ...localConfig,
    databasePath: join(workspace, 'cli.sqlite'),
    sourceRoot: sources,
  });
  const cases = ['markdown', 'conversation'].map((kind) => {
    const scope = { tenantId: 'local', workspaceId: 'example', projectId: kind };
    const registration = {
      ...sample('registration.json'),
      scope,
      ...(kind === 'conversation'
        ? {
            sourceType: kind,
            identity: { namespace: 'example', key: 'conversation' },
            locator: 'conversation.json',
          }
        : {}),
    };
    const request = { ...sample('request.json'), id: `smoke-${kind}`, scope };
    const registrationPath = write(`${kind}-registration.json`, registration);
    for (const configPath of [httpCliConfigPath, cliConfigPath]) {
      cli('source', 'add', '--config', configPath, '--registration', registrationPath);
      const listed = cli(
        'source',
        'list',
        '--config',
        configPath,
        '--scope',
        write(`${kind}-scope.json`, scope),
      );
      assert.equal(listed.registrations.length, 1);
    }
    return { kind, scope, request };
  });
  const tokenizer = new O200kBaseTokenizer();
  await start(apiConfigPath, port);
  const captured = [];
  for (const entry of cases) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/context/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry.request),
    });
    assert.equal(response.status, 200);
    const output = await response.json();
    assert.equal(output.traceStored, true);
    assert(output.includedBlockIds.length > 0);
    assert.equal(tokenizer.countTokens(output.compiledContext), output.usage.compiledTokens);
    assert(output.usage.compiledTokens <= output.usage.availableTokens);
    const fromCli = cli(
      'compile',
      '--config',
      cliConfigPath,
      '--request',
      write(`${entry.kind}-request.json`, entry.request),
    );
    assert.deepEqual(output, fromCli);
    const cliTrace = cli(
      'trace',
      '--config',
      cliConfigPath,
      '--scope',
      write(`${entry.kind}-scope.json`, entry.scope),
      '--id',
      output.compilationId,
    );
    const url = `http://127.0.0.1:${port}/v1/traces/${encodeURIComponent(output.compilationId)}?${new URLSearchParams(entry.scope)}`;
    const trace = await (await fetch(url)).json();
    assert.deepEqual(new SettledCompilationTraceValidator().validate(trace), cliTrace);
    captured.push({ url, trace, scope: entry.scope, id: output.compilationId });
  }
  await stop();
  await start(apiConfigPath, port);
  for (const entry of captured) {
    assert.deepEqual(await (await fetch(entry.url)).json(), entry.trace);
    const wrong = await fetch(
      `http://127.0.0.1:${port}/v1/traces/${entry.id}?tenantId=other&workspaceId=other`,
    );
    const absent = await fetch(
      `http://127.0.0.1:${port}/v1/traces/absent?${new URLSearchParams(entry.scope)}`,
    );
    assert.equal(wrong.status, 404);
    assert.equal(absent.status, 404);
    assert.equal(await wrong.text(), await absent.text());
  }
  await stop();
  for (const name of ['api.sqlite', 'cli.sqlite']) {
    const database = readFileSync(join(workspace, name));
    for (const content of ['The quantum reticulator calibrates', answer])
      assert.equal(database.includes(Buffer.from(content)), false);
  }
  assert.deepEqual(
    readdirSync(workspace).filter((name) => /-(?:wal|shm|journal)$/.test(name)),
    [],
  );
  const invalid = spawnSync(process.execPath, [apiBin, '--unknown'], {
    encoding: 'utf8',
    cwd: tmpdir(),
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(JSON.parse(invalid.stderr).schemaVersion, 1);
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      status: 'PASS',
      checks: [
        'built-api-bin',
        'markdown-compile',
        'conversation-compile',
        'budget',
        'cli-source-restart-list',
        'cli-compile-restart-trace',
        'cli-http-parity',
        'sigterm-drain',
        'api-restart-trace',
        'exact-scope-privacy',
        'no-content-in-sqlite',
        'no-database-side-files',
      ],
    }),
  );
} finally {
  if (child) {
    child.kill('SIGKILL');
    await ended;
  }
  rmSync(workspace, { recursive: true, force: true });
}

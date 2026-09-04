#!/usr/bin/env node
// Post-build smoke test for the `ctxalloc` executable (DEC-042).
//
// The unit suite drives `runCli(argv, io)` in-process, which is what makes it
// fast and what lets it run before `pnpm build`. That leaves exactly one thing
// unproven: that the **built artefact** runs. A broken `bin` entry, a missing
// shebang, an unresolvable `dist` import, or a warning leaking onto stderr would
// all pass the unit suite and fail an operator on their first command.
//
// So this spawns the real executable, several times, against a real temporary
// database, and checks the whole contract: exit codes, that stdout carries only
// parseable JSON, and that stderr is empty on success.
//
// Run it after `pnpm build`. It writes only inside a temporary directory, which
// it removes.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = join(rootDir, 'apps', 'cli', 'dist', 'bin.js');

const failures = [];

function fail(message) {
  failures.push(message);
}

/** Runs the built executable and returns its exit code and both streams. */
function run(...argv) {
  const result = spawnSync(process.execPath, [bin, ...argv], {
    encoding: 'utf8',
    // A deliberately unrelated working directory: nothing the CLI does may
    // depend on where it was invoked from (INV-DET-003).
    cwd: tmpdir(),
  });
  if (result.error) {
    fail(`could not spawn the built executable: ${result.error.message}`);
    return { status: 1, stdout: '', stderr: '' };
  }
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Asserts a successful run and returns its parsed stdout. */
function expectSuccess(label, ...argv) {
  const { status, stdout, stderr } = run(...argv);
  if (status !== 0) {
    fail(`${label}: expected exit 0, got ${String(status)} with stderr: ${stderr.trim()}`);
    return null;
  }
  // stdout is success output only, and stderr is empty. The Node SQLite
  // experimental warning would surface here if the executable did not filter it.
  if (stderr !== '') {
    fail(`${label}: expected empty stderr, got: ${stderr.trim()}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`${label}: stdout is not valid JSON`);
    return null;
  }
}

/** Asserts a failing run and returns its parsed error envelope. */
function expectFailure(label, expectedStatus, ...argv) {
  const { status, stdout, stderr } = run(...argv);
  if (status !== expectedStatus) {
    fail(`${label}: expected exit ${String(expectedStatus)}, got ${String(status)}`);
  }
  if (stdout !== '') {
    fail(`${label}: expected empty stdout on failure, got: ${stdout.trim()}`);
  }
  try {
    return JSON.parse(stderr);
  } catch {
    fail(`${label}: stderr is not a valid error envelope`);
    return null;
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'ctxalloc-smoke-'));
try {
  mkdirSync(join(workspace, 'vault'));
  writeFileSync(
    join(workspace, 'vault', 'handbook.md'),
    '# Budget handbook\n\nThe quantum reticulator calibrates the allocator.\n',
    'utf8',
  );

  // Relative paths, so the run also proves they resolve against the config file
  // rather than against the working directory the executable was spawned in.
  const configPath = join(workspace, 'ctxalloc.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      databasePath: './ctxalloc.sqlite',
      sourceRoot: './vault',
      maxSourceBytes: 1_000_000,
      candidateProvider: { schemaVersion: 1, maxCandidates: 8 },
      localCompile: {
        schemaVersion: 1,
        compiler: {
          schemaVersion: 1,
          compilerId: 'ctxalloc-local',
          compilerVersion: '1.0.0',
          maxCorrectionSelections: 64,
        },
        markdownChunking: { targetTokens: 40, maxTokens: 80 },
        textChunking: { targetTokens: 40, maxTokens: 80 },
      },
    }),
    'utf8',
  );

  const scope = { tenantId: 'local', workspaceId: 'smoke' };
  const scopePath = join(workspace, 'scope.json');
  writeFileSync(scopePath, JSON.stringify(scope), 'utf8');

  const registration = {
    schemaVersion: 1,
    scope,
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'handbook.md' },
    locator: 'handbook.md',
    title: 'Budget handbook',
    metadata: {},
  };
  const registrationPath = join(workspace, 'registration.json');
  writeFileSync(registrationPath, JSON.stringify(registration), 'utf8');

  // 1. The executable runs at all, and reports a deterministic identity.
  const version = expectSuccess('version', 'version');
  if (version !== null && version.name !== 'ctxalloc') {
    fail(`version: expected name "ctxalloc", got ${JSON.stringify(version.name)}`);
  }
  const secondVersion = expectSuccess('version (repeat)', 'version');
  if (JSON.stringify(secondVersion) !== JSON.stringify(version)) {
    fail('version: two invocations reported different identities');
  }

  // 2. A control-plane write, and a read from an entirely separate process.
  expectSuccess(
    'source add',
    'source',
    'add',
    '--config',
    configPath,
    '--registration',
    registrationPath,
  );
  const listed = expectSuccess(
    'source list',
    'source',
    'list',
    '--config',
    configPath,
    '--scope',
    scopePath,
  );
  if (listed !== null && listed.registrations?.length !== 1) {
    fail('source list: the registration did not survive the process that created it');
  }
  if (listed !== null && listed.registrations?.[0]?.locator !== 'handbook.md') {
    fail('source list: the stored registration did not round-trip exactly');
  }

  // 3. Registering the same logical source again is a conflict, not a silent
  //    replacement, and it exits 1 rather than 2.
  const conflict = expectFailure(
    'duplicate source add',
    1,
    'source',
    'add',
    '--config',
    configPath,
    '--registration',
    registrationPath,
  );
  if (conflict !== null && conflict.issues?.[0]?.code !== 'source_conflict') {
    fail(`duplicate source add: expected a source_conflict issue, got ${JSON.stringify(conflict)}`);
  }

  // 4. A usage failure exits 2, so a script can tell it from an operational one.
  const usage = expectFailure('unknown command', 2, 'summarise');
  if (usage !== null && usage.code !== 'CTXALLOC_CLI_FAILED') {
    fail(`unknown command: unexpected error envelope ${JSON.stringify(usage)}`);
  }

  // 5. Preparation runs over the real file, through the real tokenizer.
  const inspected = expectSuccess(
    'inspect-blocks',
    'inspect-blocks',
    '--config',
    configPath,
    '--scope',
    scopePath,
  );
  if (inspected !== null && !(inspected.blocks?.length > 0)) {
    fail('inspect-blocks: prepared no blocks from the registered source');
  }

  // 6. Nothing but the database file is left in the workspace.
  const leftovers = readdirSync(workspace).filter(
    (entry) => entry.includes('-wal') || entry.includes('-shm') || entry.includes('-journal'),
  );
  if (leftovers.length > 0) {
    fail(`the run left database side files behind: ${leftovers.join(', ')}`);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Built CLI smoke test failed:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Built CLI smoke test passed: the executable runs and persists across processes.');

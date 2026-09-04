import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTHER_SCOPE,
  PROJECT_SCOPE,
  SCOPE,
  cli,
  createWorkspace,
  failureOf,
  registration,
  registrationKey,
  successOf,
  type Workspace,
} from './fixtures.js';

/**
 * `ctxalloc source` against a real SQLite database (DEC-042).
 *
 * The whole point of this phase is that state outlives a process, so every test
 * here writes to a real file and reads it back through a **separate** command
 * invocation. Keeping one JavaScript object alive across two calls would prove
 * nothing about persistence.
 */

let workspace: Workspace | undefined;

function open(): Workspace {
  workspace = createWorkspace();
  return workspace;
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

describe('ctxalloc source: registrations survive the process that created them', () => {
  it('add then list returns the same registration from a new invocation', async () => {
    const ws = open();
    const registrationPath = ws.write('registration.json', registration());
    const scopePath = ws.write('scope.json', SCOPE);

    const added = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      registrationPath,
    );
    expect(successOf(added)).toEqual({ schemaVersion: 1, operation: 'register', registered: true });

    // A second, independent invocation: a new process would see exactly this.
    const listed = await cli('source', 'list', '--config', ws.configPath, '--scope', scopePath);
    expect(successOf(listed)).toEqual({
      schemaVersion: 1,
      operation: 'list',
      registrations: [registration()],
    });
  });

  it('creates the database at the config-relative path', async () => {
    const ws = open();
    const registrationPath = ws.write('registration.json', registration());

    expect(existsSync(ws.databasePath)).toBe(false);
    await cli('source', 'add', '--config', ws.configPath, '--registration', registrationPath);

    expect(existsSync(ws.databasePath)).toBe(true);
  });

  it('leaves no journal, write-ahead log, or shared-memory file behind', async () => {
    const ws = open();
    const registrationPath = ws.write('registration.json', registration());
    const scopePath = ws.write('scope.json', SCOPE);

    await cli('source', 'add', '--config', ws.configPath, '--registration', registrationPath);
    await cli('source', 'list', '--config', ws.configPath, '--scope', scopePath);

    const leftovers = readdirSync(ws.root).filter(
      (entry) => entry.includes('-wal') || entry.includes('-shm') || entry.includes('-journal'),
    );
    expect(leftovers).toEqual([]);
  });

  it('update persists and does not rename the logical identity', async () => {
    const ws = open();
    const scopePath = ws.write('scope.json', SCOPE);
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('registration.json', registration()),
    );

    const moved = registration({
      locator: 'moved/handbook.md',
      title: 'Moved',
      metadata: { a: 1 },
    });
    const updated = await cli(
      'source',
      'update',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('moved.json', moved),
    );
    expect(successOf(updated)).toEqual({ schemaVersion: 1, operation: 'update', updated: true });

    const listed = await cli('source', 'list', '--config', ws.configPath, '--scope', scopePath);
    expect(successOf(listed)).toEqual({
      schemaVersion: 1,
      operation: 'list',
      registrations: [moved],
    });
  });

  it('remove persists, and removing twice answers true then false', async () => {
    const ws = open();
    const scopePath = ws.write('scope.json', SCOPE);
    const keyPath = ws.write('key.json', registrationKey());
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('registration.json', registration()),
    );

    const first = await cli('source', 'remove', '--config', ws.configPath, '--key', keyPath);
    expect(successOf(first)).toEqual({ schemaVersion: 1, operation: 'remove', removed: true });

    const second = await cli('source', 'remove', '--config', ws.configPath, '--key', keyPath);
    expect(successOf(second)).toEqual({ schemaVersion: 1, operation: 'remove', removed: false });

    const listed = await cli('source', 'list', '--config', ws.configPath, '--scope', scopePath);
    expect(successOf(listed)).toEqual({
      schemaVersion: 1,
      operation: 'list',
      registrations: [],
    });
  });

  it('lists in canonical registration order, not storage order', async () => {
    const ws = open();
    const scopePath = ws.write('scope.json', SCOPE);
    // Written in an order that is neither the canonical one nor its reverse.
    const later = registration({
      sourceType: 'text',
      identity: { namespace: 'vault:docs', key: 'distractors.txt' },
      locator: 'distractors.txt',
      title: 'Distractors',
    });
    const earlier = registration({
      identity: { namespace: 'vault:docs', key: 'aardvark.md' },
      locator: 'handbook.md',
      title: 'Aardvark',
    });

    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('c.json', later),
    );
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('a.json', registration()),
    );
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('b.json', earlier),
    );

    const listed = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', scopePath),
    ) as { registrations: { identity: { key: string }; sourceType: string }[] };

    // Source type, then identity namespace, then identity key — over code units.
    expect(
      listed.registrations.map((entry) => `${entry.sourceType}:${entry.identity.key}`),
    ).toEqual(['markdown:aardvark.md', 'markdown:handbook.md', 'text:distractors.txt']);
  });
});

describe('INV-SCOPE-004: one scope cannot reach another scope through the CLI', () => {
  it('list answers only for the exact scope it was asked about', async () => {
    const ws = open();
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('registration.json', registration()),
    );

    const other = successOf(
      await cli(
        'source',
        'list',
        '--config',
        ws.configPath,
        '--scope',
        ws.write('other.json', OTHER_SCOPE),
      ),
    );
    expect(other).toEqual({ schemaVersion: 1, operation: 'list', registrations: [] });
  });

  it('treats an absent projectId and a present one as different scopes', async () => {
    const ws = open();
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('bare.json', registration()),
    );

    // The same logical identity under a project scope is a *different* source,
    // so it registers rather than conflicting.
    const scoped = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('scoped.json', registration({ scope: PROJECT_SCOPE, locator: 'other.md' })),
    );
    expect(scoped.exitCode).toBe(0);

    const bare = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s1.json', SCOPE)),
    ) as { registrations: readonly unknown[] };
    const project = successOf(
      await cli(
        'source',
        'list',
        '--config',
        ws.configPath,
        '--scope',
        ws.write('s2.json', PROJECT_SCOPE),
      ),
    ) as { registrations: readonly { locator: string }[] };

    expect(bare.registrations).toEqual([registration()]);
    expect(project.registrations).toHaveLength(1);
    expect(project.registrations[0]?.locator).toBe('other.md');
  });

  it('cannot update or remove a registration in another scope', async () => {
    const ws = open();
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('registration.json', registration()),
    );

    const update = await cli(
      'source',
      'update',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('cross.json', registration({ scope: OTHER_SCOPE, locator: 'x.md' })),
    );
    expect(failureOf(update).issues[0]?.code).toBe('source_not_found');

    const remove = await cli(
      'source',
      'remove',
      '--config',
      ws.configPath,
      '--key',
      ws.write('cross-key.json', registrationKey({ scope: OTHER_SCOPE })),
    );
    expect(successOf(remove)).toEqual({ schemaVersion: 1, operation: 'remove', removed: false });

    // The original is untouched.
    const listed = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE)),
    );
    expect(listed).toEqual({
      schemaVersion: 1,
      operation: 'list',
      registrations: [registration()],
    });
  });
});

describe('ctxalloc source: failures are structured and never overwrite state', () => {
  it('reports a duplicate registration as a conflict and leaves the original', async () => {
    const ws = open();
    const registrationPath = ws.write('registration.json', registration());
    await cli('source', 'add', '--config', ws.configPath, '--registration', registrationPath);

    const again = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('changed.json', registration({ locator: 'elsewhere.md' })),
    );
    const envelope = failureOf(again);

    expect(again.exitCode).toBe(1);
    expect(envelope.stage).toBe('source-store');
    expect(envelope.issues[0]?.code).toBe('source_conflict');

    const listed = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE)),
    ) as { registrations: readonly { locator: string }[] };
    expect(listed.registrations[0]?.locator).toBe('handbook.md');
  });

  it('rejects a registration that is not valid JSON', async () => {
    const ws = open();
    const path = ws.write('registration.json', registration());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ not json', 'utf8');

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(1);
    expect(envelope.stage).toBe('input');
    expect(envelope.issues[0]?.code).toBe('input_not_json');
  });

  it('rejects a malformed registration with an addressed issue', async () => {
    const ws = open();
    const run = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('bad.json', registration({ sourceType: 'spreadsheet' })),
    );
    const envelope = failureOf(run);

    expect(envelope.stage).toBe('source-store');
    expect(envelope.issues[0]?.code).toBe('invalid_registration');
    expect(envelope.issues[0]?.pointer).toBe('registration.sourceType');
  });

  it('writes success to stdout only, and failure to stderr only', async () => {
    const ws = open();
    const registrationPath = ws.write('registration.json', registration());

    const ok = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      registrationPath,
    );
    expect(ok.stderr).toBe('');
    expect(ok.stdout.length).toBeGreaterThan(0);

    const bad = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      registrationPath,
    );
    expect(bad.stdout).toBe('');
    expect(bad.stderr.length).toBeGreaterThan(0);
  });
});

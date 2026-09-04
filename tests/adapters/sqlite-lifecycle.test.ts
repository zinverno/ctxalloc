import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SQLITE_LOCAL_STORE_SCHEMA_VERSION,
  SQLiteControlStore,
  SQLiteControlStoreError,
  SQLiteTraceStore,
  SQLiteTraceStoreError,
} from '@ctxalloc/adapters';
import type { SourceRegistration } from '@ctxalloc/ports';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The configuration, migration, and lifecycle of the local SQLite stores
 * (DEC-042).
 *
 * Everything here uses a **real** temporary database file. Corruption tests
 * reach past the adapters and edit rows through direct SQL, exactly as an
 * accident, an operator, or a different build would.
 */

const SCOPE = { tenantId: 'sqlite', workspaceId: 'lifecycle' };

let directory: string | undefined;

function databasePath(name = 'store.sqlite'): string {
  directory ??= mkdtempSync(join(tmpdir(), 'ctxalloc-sqlite-'));
  return join(directory, name);
}

function config(path: string): { schemaVersion: 1; databasePath: string } {
  return { schemaVersion: 1, databasePath: path };
}

function registration(overrides: Partial<SourceRegistration> = {}): SourceRegistration {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'handbook.md' },
    locator: 'handbook.md',
    metadata: {},
    ...overrides,
  } as SourceRegistration;
}

/** Runs one function and returns the error it threw, or fails the test. */
function rejected(body: () => unknown): { code: string; message: string } {
  try {
    body();
  } catch (cause) {
    if (cause instanceof SQLiteControlStoreError || cause instanceof SQLiteTraceStoreError) {
      return { code: cause.code, message: cause.message };
    }
    throw cause;
  }
  throw new Error('expected the adapter to reject');
}

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('SQLite store configuration: strict, explicit, and absolute', () => {
  it.each([
    ['a non-object', 7],
    ['null', null],
    ['an array', []],
    ['an unknown field', { schemaVersion: 1, databasePath: '/tmp/a.sqlite', poolSize: 4 }],
    ['a missing databasePath', { schemaVersion: 1 }],
    ['a missing schemaVersion', { databasePath: '/tmp/a.sqlite' }],
    ['an unsupported schema version', { schemaVersion: 2, databasePath: '/tmp/a.sqlite' }],
    ['a non-string path', { schemaVersion: 1, databasePath: 42 }],
    ['a blank path', { schemaVersion: 1, databasePath: '   ' }],
    ['a relative path', { schemaVersion: 1, databasePath: './local.sqlite' }],
    ['a lone surrogate in the path', { schemaVersion: 1, databasePath: '/tmp/\uD800.sqlite' }],
  ])('rejects %s with INVALID_CONFIG', (_label, value) => {
    expect(rejected(() => new SQLiteControlStore(value)).code).toBe('INVALID_CONFIG');
    expect(rejected(() => new SQLiteTraceStore(value)).code).toBe('INVALID_CONFIG');
  });

  it('requires an absolute path so the adapter never chooses a base directory', () => {
    const relative = 'sub/store.sqlite';
    const error = rejected(() => new SQLiteControlStore(config(relative)));

    expect(error.code).toBe('INVALID_CONFIG');
    expect(error.message).toContain('absolute');
    // And nothing was created relative to the process.
    expect(existsSync(resolve(relative))).toBe(false);
  });

  it('reports an unopenable database without disclosing the path', () => {
    const missingDirectory = join(databasePath(), 'nested', 'deeper', 'store.sqlite');
    const error = rejected(() => new SQLiteControlStore(config(missingDirectory)));

    expect(error.code).toBe('OPEN_FAILED');
    expect(error.message).not.toContain(missingDirectory);
    expect(error.message).not.toContain('ENOENT');
  });
});

describe('INV-STORE-003 / INV-STORE-004: schema versioning is explicit and transactional', () => {
  it('initializes a new database to the current schema version', () => {
    const path = databasePath();
    const store = new SQLiteControlStore(config(path));
    store.close();

    const database = new DatabaseSync(path);
    const row = database
      .prepare('SELECT value FROM ctxalloc_store_metadata WHERE key = ?')
      .get('schema_version');
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((entry) => String((entry as { name: unknown }).name));
    database.close();

    expect((row as { value: string }).value).toBe(String(SQLITE_LOCAL_STORE_SCHEMA_VERSION));
    expect(tables).toEqual([
      'ctxalloc_compilation_trace',
      'ctxalloc_source_registration',
      'ctxalloc_store_metadata',
    ]);
  });

  it('reopening a current database changes nothing and duplicates no metadata', async () => {
    const path = databasePath();
    const first = new SQLiteControlStore(config(path));
    await first.registerSource(registration());
    first.close();

    // Four more opens, including the other store over the same file.
    for (const open of [
      () => new SQLiteControlStore(config(path)),
      () => new SQLiteTraceStore(config(path)),
      () => new SQLiteControlStore(config(path)),
      () => new SQLiteTraceStore(config(path)),
    ]) {
      const store = open();
      store.close();
    }

    const database = new DatabaseSync(path);
    const metadata = database.prepare('SELECT key, value FROM ctxalloc_store_metadata').all();
    const registrations = database
      .prepare('SELECT count(*) AS n FROM ctxalloc_source_registration')
      .get();
    database.close();

    expect(metadata).toHaveLength(1);
    expect((registrations as { n: number }).n).toBe(1);
  });

  it('refuses a database written at a greater schema version', () => {
    const path = databasePath();
    new SQLiteControlStore(config(path)).close();

    const database = new DatabaseSync(path);
    database
      .prepare('UPDATE ctxalloc_store_metadata SET value = ? WHERE key = ?')
      .run('2', 'schema_version');
    database.close();

    const error = rejected(() => new SQLiteControlStore(config(path)));
    expect(error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    expect(error.message).toContain('2');
    // No destructive automatic downgrade: the data is still there.
    const check = new DatabaseSync(path);
    expect(
      check
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'ctxalloc_source_registration'",
        )
        .get(),
    ).toMatchObject({ n: 1 });
    check.close();
  });

  it('refuses a database whose recorded schema version is unreadable', () => {
    const path = databasePath();
    new SQLiteControlStore(config(path)).close();

    const database = new DatabaseSync(path);
    database
      .prepare('UPDATE ctxalloc_store_metadata SET value = ? WHERE key = ?')
      .run('not-a-version', 'schema_version');
    database.close();

    expect(rejected(() => new SQLiteControlStore(config(path))).code).toBe('INVALID_STORED_DATA');
  });

  it('rolls a failed migration back, leaving the prior schema intact', () => {
    const path = databasePath();
    // A file that already holds a table this build wants to create, with a
    // different shape. The migration must not write project rows into it.
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE ctxalloc_source_registration (unrelated TEXT)');
    database
      .prepare('INSERT INTO ctxalloc_source_registration (unrelated) VALUES (?)')
      .run('keep me');
    database.close();

    expect(rejected(() => new SQLiteControlStore(config(path))).code).toBe('MIGRATION_FAILED');

    const check = new DatabaseSync(path);
    const rows = check.prepare('SELECT unrelated FROM ctxalloc_source_registration').all();
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((entry) => String((entry as { name: unknown }).name));
    check.close();

    // The pre-existing table and its row survived, and no half-created schema
    // was published: neither the trace table nor the metadata row exists.
    expect(rows).toEqual([{ unrelated: 'keep me' }]);
    expect(tables).toEqual(['ctxalloc_source_registration']);
  });

  it('does not disclose the database path in a migration failure', () => {
    const path = databasePath();
    const database = new DatabaseSync(path);
    database.exec('CREATE TABLE ctxalloc_compilation_trace (unrelated TEXT)');
    database.close();

    const error = rejected(() => new SQLiteTraceStore(config(path)));
    expect(error.message).not.toContain(path);
    expect(error.message).not.toContain('CREATE TABLE');
  });
});

describe('SQLite store lifecycle: explicit, per-store, and leak-free', () => {
  it('declares close() on the concrete adapter only', () => {
    const path = databasePath();
    const control = new SQLiteControlStore(config(path));
    const traces = new SQLiteTraceStore(config(path));

    try {
      expect(typeof control.close).toBe('function');
      expect(typeof traces.close).toBe('function');
    } finally {
      control.close();
      traces.close();
    }
  });

  it('closing twice is a no-op', () => {
    const store = new SQLiteControlStore(config(databasePath()));
    store.close();

    expect(() => {
      store.close();
    }).not.toThrow();
  });

  it('two stores over one file are independent connections', async () => {
    const path = databasePath();
    const control = new SQLiteControlStore(config(path));
    const traces = new SQLiteTraceStore(config(path));

    try {
      await control.registerSource(registration());
      // Closing one must not break the other.
      const second = new SQLiteControlStore(config(path));
      second.close();

      expect(await traces.getTrace(SCOPE, `sha256:${'a'.repeat(64)}`)).toBeNull();
      expect(await control.listSources(SCOPE)).toHaveLength(1);
    } finally {
      control.close();
      traces.close();
    }
  });

  it('fails explicitly after close rather than returning an empty result', async () => {
    const path = databasePath();
    const store = new SQLiteControlStore(config(path));
    await store.registerSource(registration());
    store.close();

    // "The store is closed" is not "there are no sources" (INV-ADAPTER-003).
    await expect(store.listSources(SCOPE)).rejects.toMatchObject({ code: 'READ_FAILED' });
    await expect(store.registerSource(registration())).rejects.toMatchObject({
      code: 'WRITE_FAILED',
    });
  });

  it('leaves no write-ahead log, shared-memory, or journal file behind', async () => {
    const path = databasePath();
    const control = new SQLiteControlStore(config(path));
    const traces = new SQLiteTraceStore(config(path));
    await control.registerSource(registration());
    await traces.putTrace({
      schemaVersion: 1,
      scope: SCOPE,
      compilationId: `sha256:${'c'.repeat(64)}`,
      traceSchemaVersion: 2,
      payload: { settled: true },
    });
    control.close();
    traces.close();

    expect(readdirSync(directory ?? '')).toEqual(['store.sqlite']);
  });
});

describe('INV-STORE-003: persistence survives the process that created it', () => {
  it('a registration written by one store is read by a later one', async () => {
    const path = databasePath();

    const writerStore = new SQLiteControlStore(config(path));
    await writerStore.registerSource(
      registration({ title: 'Handbook', metadata: { tags: ['a', 'b'] } }),
    );
    // The first connection is gone: nothing of it survives but the file.
    writerStore.close();

    const readerStore = new SQLiteControlStore(config(path));
    try {
      expect(await readerStore.listSources(SCOPE)).toEqual([
        registration({ title: 'Handbook', metadata: { tags: ['a', 'b'] } }),
      ]);
    } finally {
      readerStore.close();
    }
  });

  it('a trace written by one store is read by a later one', async () => {
    const path = databasePath();
    const record = {
      schemaVersion: 1 as const,
      scope: SCOPE,
      compilationId: `sha256:${'d'.repeat(64)}`,
      traceSchemaVersion: 2,
      payload: { settled: true, groups: [{ id: 'block:a' }] },
    };

    const writerStore = new SQLiteTraceStore(config(path));
    await writerStore.putTrace(record);
    writerStore.close();

    const readerStore = new SQLiteTraceStore(config(path));
    try {
      expect(await readerStore.getTrace(SCOPE, record.compilationId)).toEqual(record);
    } finally {
      readerStore.close();
    }
  });
});

describe('INV-BLOCK-005: a corrupted row is a named failure, never a partial record', () => {
  async function corruptedControlStore(
    mutate: (database: DatabaseSync) => void,
  ): Promise<{ code: string; message: string }> {
    const path = databasePath();
    const store = new SQLiteControlStore(config(path));
    await store.registerSource(registration());
    store.close();

    const database = new DatabaseSync(path);
    mutate(database);
    database.close();

    const reader = new SQLiteControlStore(config(path));
    try {
      await reader.listSources(SCOPE);
    } catch (cause) {
      if (cause instanceof SQLiteControlStoreError) {
        return { code: cause.code, message: cause.message };
      }
      throw cause;
    } finally {
      reader.close();
    }
    throw new Error('expected the store to reject the corrupted row');
  }

  it('rejects malformed registration metadata', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec("UPDATE ctxalloc_source_registration SET metadata_json = '{ not json'");
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
  });

  it('rejects metadata that is JSON but not an object', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec("UPDATE ctxalloc_source_registration SET metadata_json = '[1,2,3]'");
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
  });

  it('rejects a malformed stored scope', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec("UPDATE ctxalloc_source_registration SET scope_json = '{ not json'");
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
  });

  it('rejects a stored scope that disagrees with its scope key', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec(
        `UPDATE ctxalloc_source_registration SET scope_json = '{"tenantId":"other","workspaceId":"other"}'`,
      );
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
    expect(error.message).toContain('scope key');
  });

  it('rejects an unsupported registration schema version', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec('UPDATE ctxalloc_source_registration SET registration_schema_version = 2');
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
    expect(error.message).toContain('2');
  });

  it('rejects a stored source type this build does not know', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec("UPDATE ctxalloc_source_registration SET source_type = 'spreadsheet'");
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
  });

  it('rejects a stored timestamp that is not a real instant', async () => {
    const error = await corruptedControlStore((database) => {
      database.exec(
        "UPDATE ctxalloc_source_registration SET created_at = '2026-02-31T00:00:00.000Z'",
      );
    });

    expect(error.code).toBe('INVALID_STORED_DATA');
  });

  it('rejects a malformed stored trace payload', async () => {
    const path = databasePath();
    const id = `sha256:${'e'.repeat(64)}`;
    const store = new SQLiteTraceStore(config(path));
    await store.putTrace({
      schemaVersion: 1,
      scope: SCOPE,
      compilationId: id,
      traceSchemaVersion: 2,
      payload: { settled: true },
    });
    store.close();

    const database = new DatabaseSync(path);
    database.exec("UPDATE ctxalloc_compilation_trace SET trace_json = '{ not json'");
    database.close();

    const reader = new SQLiteTraceStore(config(path));
    try {
      await expect(reader.getTrace(SCOPE, id)).rejects.toMatchObject({
        code: 'INVALID_STORED_DATA',
      });
    } finally {
      reader.close();
    }
  });

  it('rejects an unsupported stored envelope schema version', async () => {
    const path = databasePath();
    const id = `sha256:${'f'.repeat(64)}`;
    const store = new SQLiteTraceStore(config(path));
    await store.putTrace({
      schemaVersion: 1,
      scope: SCOPE,
      compilationId: id,
      traceSchemaVersion: 2,
      payload: { settled: true },
    });
    store.close();

    const database = new DatabaseSync(path);
    database.exec('UPDATE ctxalloc_compilation_trace SET envelope_schema_version = 2');
    database.close();

    const reader = new SQLiteTraceStore(config(path));
    try {
      const error = await reader.getTrace(SCOPE, id).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(SQLiteTraceStoreError);
      expect((error as SQLiteTraceStoreError).code).toBe('INVALID_STORED_DATA');
    } finally {
      reader.close();
    }
  });

  it('discloses no SQL, path, or stored value in a corruption failure', async () => {
    const path = databasePath();
    const store = new SQLiteControlStore(config(path));
    await store.registerSource(registration({ metadata: { secret: 'do-not-print-me' } }));
    store.close();

    const database = new DatabaseSync(path);
    database.exec("UPDATE ctxalloc_source_registration SET metadata_json = '{ do-not-print-me'");
    database.close();

    const reader = new SQLiteControlStore(config(path));
    try {
      const error = await reader.listSources(SCOPE).catch((cause: unknown) => cause);
      const message = (error as Error).message;

      expect(message).not.toContain(path);
      expect(message).not.toContain('do-not-print-me');
      expect(message).not.toContain('SELECT');
      expect(message).not.toContain('UPDATE');
    } finally {
      reader.close();
    }
  });
});

describe('INV-ADAPTER-001: no driver value reaches a caller', () => {
  it('exposes no database handle or statement on the adapters', () => {
    const path = databasePath();
    const control = new SQLiteControlStore(config(path));
    const traces = new SQLiteTraceStore(config(path));

    try {
      for (const store of [control, traces]) {
        const names = new Set([
          ...Object.keys(store),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object),
        ]);
        for (const forbidden of ['database', 'db', 'connection', 'prepare', 'exec', 'statement']) {
          expect(names.has(forbidden), `exposes ${forbidden}`).toBe(false);
        }
      }
    } finally {
      control.close();
      traces.close();
    }
  });
});

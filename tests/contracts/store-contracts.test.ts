import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteControlStore, SQLiteTraceStore } from '@ctxalloc/adapters';
import { InMemoryControlStore, InMemoryTraceStore } from '@ctxalloc/testing';
import { runControlStoreContract } from './control-store.contract.js';
import { runTraceStoreContract } from './trace-store.contract.js';

/**
 * Every store implementation, against one shared contract (INV-ADAPTER-005).
 *
 * The in-memory doubles and the SQLite adapters run the *same* assertions. That
 * is what makes the doubles usable: a test that composes `InMemoryControlStore`
 * is testing behaviour the product actually ships, and a divergence shows up
 * here rather than the first time someone points the CLI at a database.
 *
 * The SQLite runs use real temporary files, created and deleted per test, so
 * "persistence" is not being simulated by a live JavaScript object.
 */

/** One temporary database file, deleted with its directory. */
function temporaryDatabase(prefix: string): { path: string; remove: () => void } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    path: join(directory, 'store.sqlite'),
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

runControlStoreContract({
  name: 'InMemoryControlStore',
  create: () => {
    const store = new InMemoryControlStore([]);
    return { store, writer: store, dispose: () => undefined };
  },
});

runControlStoreContract({
  name: 'SQLiteControlStore',
  create: () => {
    const database = temporaryDatabase('ctxalloc-control-contract-');
    const store = new SQLiteControlStore({ schemaVersion: 1, databasePath: database.path });
    return {
      store,
      writer: store,
      dispose: () => {
        store.close();
        database.remove();
      },
    };
  },
});

runTraceStoreContract({
  name: 'InMemoryTraceStore',
  create: () => ({ store: new InMemoryTraceStore(), dispose: () => undefined }),
});

runTraceStoreContract({
  name: 'SQLiteTraceStore',
  create: () => {
    const database = temporaryDatabase('ctxalloc-trace-contract-');
    const store = new SQLiteTraceStore({ schemaVersion: 1, databasePath: database.path });
    return {
      store,
      dispose: () => {
        store.close();
        database.remove();
      },
    };
  },
});

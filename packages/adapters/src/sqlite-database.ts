import { DatabaseSync } from 'node:sqlite';
import { SQLiteStoreFailure, type SQLiteLocalStoreConfig } from './sqlite-store-config.js';

/**
 * The local SQLite connection and its explicit configuration (DEC-042).
 *
 * This module is **package-internal** and, unlike `sqlite-store-config.ts`, it
 * is not re-exported in any form. `DatabaseSync`, `StatementSync`, and every
 * other driver type stop here: no port, no public declaration, and no consumer
 * of `@ctxalloc/adapters` ever names one (INV-ADAPTER-001).
 *
 * There is no connection pool, no module-level cache, and no shared handle. Each
 * store opens its own connection to whatever path it was configured with, so two
 * stores over one file are two independent connections and nothing in this
 * process holds mutable global state a test could inherit from a previous one.
 */

/**
 * Opens the configured database file, creating it when it does not exist.
 *
 * The failure is deliberately generic: a missing directory, a permission
 * refusal, and a corrupted file all become `OPEN_FAILED` with a fixed message.
 * The driver's own wording names the absolute path, which is exactly what a
 * public error must not disclose (INV-SEC-001).
 */
export function openDatabase(config: SQLiteLocalStoreConfig): DatabaseSync {
  try {
    return new DatabaseSync(config.databasePath);
  } catch {
    throw new SQLiteStoreFailure('OPEN_FAILED', 'the local database could not be opened');
  }
}

/** Runs `body` inside one immediate transaction, rolling back on any failure. */
export function inTransaction<T>(database: DatabaseSync, body: () => T): T {
  // `IMMEDIATE` takes the write lock up front. A deferred transaction would
  // upgrade on its first write, so a read-then-write sequence could see state
  // another connection changed in between — which is exactly the window a
  // check-then-insert must not have (INV-STORE-003).
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    database.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // A rollback can only fail when the transaction is already gone, in which
      // case there is nothing to undo. The original failure is what the caller
      // needs, and replacing it here would hide it.
    }
    throw cause;
  }
}

/** Reads one own property from a driver row without following a prototype. */
export function column(row: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** The number of rows one statement changed, as a plain number. */
export function changeCount(result: { readonly changes: number | bigint }): number {
  return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
}

/** Requires one stored column to be a non-empty string. */
export function storedText(row: object, name: string): string {
  const value = column(row, name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      `the stored row column "${name}" is not readable text`,
    );
  }
  return value;
}

/** Requires one stored column to be a string, or absent. */
export function optionalStoredText(row: object, name: string): string | undefined {
  const value = column(row, name);
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      `the stored row column "${name}" is not readable text`,
    );
  }
  return value;
}

/** Requires one stored column to be a safe integer. */
export function storedInteger(row: object, name: string): number {
  const value = column(row, name);
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      `the stored row column "${name}" is not a readable integer`,
    );
  }
  return numeric;
}

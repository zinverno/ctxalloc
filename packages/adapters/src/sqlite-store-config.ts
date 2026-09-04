import { isAbsolute } from 'node:path';

/**
 * The explicit configuration of one local SQLite store, and the internal failure
 * both stores translate into their own public error (DEC-042).
 *
 * This module is separate from `sqlite-database.ts` for one reason: it is the
 * only part of the storage mechanics whose types are **public**. Keeping it apart
 * means the declaration a consumer resolves when it names `SQLiteLocalStoreConfig`
 * mentions no `DatabaseSync`, no `StatementSync`, and no other driver type, and
 * that is checkable rather than merely intended (INV-ADAPTER-001).
 */

/** The database schema version this build creates and reads (INV-STORE-004). */
export const SQLITE_LOCAL_STORE_SCHEMA_VERSION = 1;

/**
 * The explicit configuration of one local SQLite store.
 *
 * Nothing is defaulted and nothing is discovered. There is no environment
 * variable, no `process.cwd()` fallback, no `~/.ctxalloc` location, and no
 * search up the directory tree: a store that found its own database would make
 * *which data am I looking at?* depend on where a command happened to be run
 * (INV-DET-003).
 *
 * `databasePath` must be **absolute**. A relative path is meaningful only
 * against some directory, and the adapter is the wrong layer to choose one — the
 * CLI resolves relative paths against its config file and hands an absolute path
 * down (DEC-042).
 */
export interface SQLiteLocalStoreConfig {
  readonly schemaVersion: typeof SQLITE_LOCAL_STORE_SCHEMA_VERSION;
  readonly databasePath: string;
}

/** Machine-readable categories of a local SQLite store failure (INV-TRACE-002). */
export type SQLiteStoreFailureCode =
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'OPEN_FAILED'
  | 'MIGRATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'SOURCE_CONFLICT'
  | 'SOURCE_NOT_FOUND'
  | 'TRACE_CONFLICT'
  | 'INVALID_STORED_DATA';

/**
 * The internal failure both stores translate into their own public error.
 *
 * It exists so the shared open-and-migrate path can report a precise cause
 * without either store having to publish the other's error type, and so each
 * store can raise its own outcomes — a conflict, a missing record — through one
 * mechanism. It never escapes: each adapter catches it and raises its own class
 * with the same stable code.
 *
 * The code union is the union of both stores' vocabularies, so `SOURCE_CONFLICT`
 * is expressible here even though only the control store ever raises it. That is
 * the cost of one internal carrier for two adapters; each adapter's **public**
 * code union names only the codes it can actually produce.
 *
 * It carries no SQL text, no database path, no driver error, and no driver
 * message. A SQLite error routinely names the file it failed on and the
 * statement it was running, and neither is the caller's to receive
 * (INV-SEC-001).
 */
export class SQLiteStoreFailure extends Error {
  readonly failureCode: SQLiteStoreFailureCode;

  constructor(failureCode: SQLiteStoreFailureCode, message: string) {
    super(message);
    this.name = 'SQLiteStoreFailure';
    this.failureCode = failureCode;
  }
}

/** A lone high or low surrogate, which no filesystem call can round-trip. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Validates one store configuration.
 *
 * Exact keys, no coercion, no defaults. The path is required to be a non-blank,
 * well-formed, absolute string carrying no NUL: a lone surrogate would not
 * survive the round trip to a filesystem call unchanged, and a NUL would
 * truncate the name the operating system actually opens.
 */
export function validateSQLiteLocalStoreConfig(input: unknown): SQLiteLocalStoreConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SQLiteStoreFailure('INVALID_CONFIG', 'configuration must be an object');
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== 'databasePath' || keys[1] !== 'schemaVersion') {
    throw new SQLiteStoreFailure(
      'INVALID_CONFIG',
      'configuration must declare exactly "schemaVersion" and "databasePath"',
    );
  }

  const config = input as { schemaVersion: unknown; databasePath: unknown };
  if (config.schemaVersion !== SQLITE_LOCAL_STORE_SCHEMA_VERSION) {
    throw new SQLiteStoreFailure(
      'INVALID_CONFIG',
      `configuration schemaVersion must be ${String(SQLITE_LOCAL_STORE_SCHEMA_VERSION)}`,
    );
  }
  const path = config.databasePath;
  if (typeof path !== 'string') {
    throw new SQLiteStoreFailure('INVALID_CONFIG', 'databasePath must be a string');
  }
  if (path.trim().length === 0) {
    throw new SQLiteStoreFailure(
      'INVALID_CONFIG',
      'databasePath must not be empty or whitespace-only',
    );
  }
  if (path.includes('\u0000')) {
    throw new SQLiteStoreFailure('INVALID_CONFIG', 'databasePath must not contain a NUL character');
  }
  if (LONE_SURROGATE.test(path)) {
    throw new SQLiteStoreFailure('INVALID_CONFIG', 'databasePath must be well-formed UTF-16');
  }
  if (!isAbsolute(path)) {
    throw new SQLiteStoreFailure('INVALID_CONFIG', 'databasePath must be an absolute path');
  }

  return { schemaVersion: SQLITE_LOCAL_STORE_SCHEMA_VERSION, databasePath: path };
}

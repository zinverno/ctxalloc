import type { DatabaseSync } from 'node:sqlite';
import { column, inTransaction } from './sqlite-database.js';
import { SQLITE_LOCAL_STORE_SCHEMA_VERSION, SQLiteStoreFailure } from './sqlite-store-config.js';

/**
 * Explicit, transactional schema versioning for the local SQLite stores
 * (DEC-042, INV-STORE-003, INV-STORE-004).
 *
 * ## What the version is
 *
 * The version lives in a metadata table this project owns, not in SQLite's
 * `user_version` pragma. The pragma is a single unnamespaced integer in the file
 * header, so anything else that ever opens the file — another tool, a future
 * component with its own migrations — writes to the same slot. A named row in a
 * named table says *whose* version it is.
 *
 * ## What migration does and does not do
 *
 * A database at the supported version is left exactly as it is. Re-opening it
 * writes nothing, so repeated initialization cannot duplicate metadata or touch
 * a row.
 *
 * A database at a **greater** version fails, clearly and by its own code. It was
 * written by a build that knows fields this one does not, and reading it here
 * would silently reinterpret data. There is no automatic downgrade: dropping a
 * column this build cannot read would destroy exactly the data the newer build
 * added (INV-STORE-004).
 *
 * ## Why the whole thing is one transaction
 *
 * Initialization creates a metadata table, two data tables, and a version row.
 * A failure partway through would leave a database that looks initialized and is
 * not — the classic half-created state INV-STORE-003 forbids. Every step runs
 * inside one immediate transaction, so the file either gains the complete schema
 * or gains nothing.
 *
 * The data tables are created **without** `IF NOT EXISTS`, deliberately. A file
 * that already holds a `ctxalloc_source_registration` this build did not create
 * is not an empty database with a coincidence in it; continuing would write
 * project rows into a table of unknown shape. The create fails, the transaction
 * rolls back, and whatever was in the file before is still there.
 *
 * This module is package-internal and is never re-exported.
 */

const METADATA_TABLE = 'ctxalloc_store_metadata';
const SCHEMA_VERSION_KEY = 'schema_version';

/** The registrations of the control plane. */
export const SOURCE_REGISTRATION_TABLE = 'ctxalloc_source_registration';

/** The settled compilation traces. */
export const COMPILATION_TRACE_TABLE = 'ctxalloc_compilation_trace';

/**
 * Migration 0 -> 1: the complete initial schema.
 *
 * `STRICT` is not decoration. Without it SQLite would accept a number where a
 * canonical JSON string belongs and hand it back as a number, and a store that
 * returned `7` for a scope would be a store whose reads depend on what some
 * other writer put in the column.
 *
 * The source-registration primary key **is** the logical identity: exact scope,
 * source type, identity namespace, identity key. `scope_key` is canonical JSON
 * over the exact scope shape with an absent project written as `null`, so the
 * key is injective and an absent project never collides with a present one. A
 * nullable `project_id` column would not do: SQLite treats two NULLs as distinct
 * in a UNIQUE index, so two registrations with no project would both be allowed
 * (INV-SCOPE-004).
 *
 * `scope_json` is stored beside it because the key is a comparison value, not a
 * record: reconstructing a scope from it would mean deciding whether a `null`
 * project meant absent or present-and-null, and the stored scope simply says.
 *
 * There is no surrogate row identifier and no autoincrement anywhere. Identity
 * is the project's, and a database-generated one would be a second answer to
 * *which source is this?* (INV-BLOCK-001, INV-ADAPTER-002).
 *
 * There is no source content, no block, no candidate, no compiled context, and
 * no retrieval index. The original files remain the content authority, and this
 * database is the control and audit store (INV-STORE-001, DEC-042).
 *
 * `title_json` holds a **JSON string**, not the title text. The existing
 * `SourceRegistration` contract accepts any `string` as a title, including one
 * carrying a lone surrogate, and Node's SQLite `TEXT` binding is lossy for
 * exactly that: writing `"\uD800"` and reading it back yields `"\uFFFD"`. A
 * store that quietly rewrote a registration the application considers valid
 * would break the round trip its contract promises, so the value is encoded as a
 * JSON string — which escapes a lone surrogate as ASCII — and the `TEXT` column
 * never has to carry the malformed code unit itself. `NULL` means the title is
 * absent, which is a different record from a title that is the empty string
 * (INV-ADAPTER-005, INV-STORE-002).
 *
 * The trace table has no `created_at`. A wall clock is not an input this phase
 * has a port for, and a column filled from `new Date()` inside an adapter would
 * put a hidden non-deterministic value into an audit record (INV-DET-004).
 */
const MIGRATION_0_TO_1: readonly string[] = [
  `CREATE TABLE ${SOURCE_REGISTRATION_TABLE} (
     scope_key TEXT NOT NULL,
     scope_json TEXT NOT NULL,
     source_type TEXT NOT NULL,
     identity_namespace TEXT NOT NULL,
     identity_key TEXT NOT NULL,
     locator TEXT NOT NULL,
     title_json TEXT,
     created_at TEXT,
     updated_at TEXT,
     metadata_json TEXT NOT NULL,
     registration_schema_version INTEGER NOT NULL,
     PRIMARY KEY (scope_key, source_type, identity_namespace, identity_key)
   ) STRICT`,
  `CREATE TABLE ${COMPILATION_TRACE_TABLE} (
     compilation_id TEXT NOT NULL PRIMARY KEY,
     scope_key TEXT NOT NULL,
     scope_json TEXT NOT NULL,
     trace_schema_version INTEGER NOT NULL,
     envelope_schema_version INTEGER NOT NULL,
     trace_json TEXT NOT NULL
   ) STRICT`,
];

/** Reads the recorded schema version, or `0` for a database this build has never seen. */
function readSchemaVersion(database: DatabaseSync): number {
  const row: unknown = database
    .prepare(`SELECT value FROM ${METADATA_TABLE} WHERE key = ?`)
    .get(SCHEMA_VERSION_KEY);
  if (row === undefined || row === null) return 0;
  if (typeof row !== 'object') {
    throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'the stored schema version is unreadable');
  }

  const value = column(row, 'value');
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'the stored schema version is unreadable');
  }
  return parsed;
}

/**
 * Brings one open database to {@link SQLITE_LOCAL_STORE_SCHEMA_VERSION}.
 *
 * @throws {SQLiteStoreFailure} `UNSUPPORTED_SCHEMA_VERSION` for a newer
 * database, `MIGRATION_FAILED` when a step could not be applied.
 */
export function migrateToCurrentSchema(database: DatabaseSync): void {
  try {
    inTransaction(database, () => {
      // The metadata table is the one statement that tolerates already existing:
      // it is the bootstrap, and its shape is fixed for the life of the store.
      database.exec(
        `CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
           key TEXT NOT NULL PRIMARY KEY,
           value TEXT NOT NULL
         ) STRICT`,
      );

      const version = readSchemaVersion(database);
      if (version > SQLITE_LOCAL_STORE_SCHEMA_VERSION) {
        throw new SQLiteStoreFailure(
          'UNSUPPORTED_SCHEMA_VERSION',
          `the local database was written at schema version ${String(version)}, and this build reads version ${String(SQLITE_LOCAL_STORE_SCHEMA_VERSION)}`,
        );
      }
      if (version === SQLITE_LOCAL_STORE_SCHEMA_VERSION) return;

      // Only one migration exists. Inventing steps for versions that were never
      // released would be migration code no database can ever have needed.
      for (const statement of MIGRATION_0_TO_1) database.exec(statement);

      database
        .prepare(`INSERT INTO ${METADATA_TABLE} (key, value) VALUES (?, ?)`)
        .run(SCHEMA_VERSION_KEY, String(SQLITE_LOCAL_STORE_SCHEMA_VERSION));
    });
  } catch (cause) {
    // A precise internal failure travels unchanged; anything the driver threw
    // becomes one generic migration failure, because a driver message names the
    // statement and the file it failed on (INV-SEC-001).
    if (cause instanceof SQLiteStoreFailure) throw cause;
    throw new SQLiteStoreFailure(
      'MIGRATION_FAILED',
      'the local database schema could not be initialized',
    );
  }
}

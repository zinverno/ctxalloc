import { JsonObjectSchema, ScopeSchema, scopesEqual, type Scope } from '@ctxalloc/domain';
import type { StoredCompilationTraceRecord, TraceStore } from '@ctxalloc/ports';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, parseStoredJsonObject } from './sqlite-json.js';
import { inTransaction, openDatabase, storedInteger, storedText } from './sqlite-database.js';
import {
  SQLiteStoreFailure,
  validateSQLiteLocalStoreConfig,
  type SQLiteLocalStoreConfig,
} from './sqlite-store-config.js';
import { COMPILATION_TRACE_TABLE, migrateToCurrentSchema } from './sqlite-migrations.js';

/**
 * The local SQLite audit store for settled compilation traces (DEC-042).
 *
 * It stores and returns opaque JSON envelopes. It does not know what a
 * disposition is, cannot tell a settled trace from an unsettled one, and never
 * imports `@ctxalloc/compiler`: the kernel already depends inward on the ports,
 * so an adapter that named it would close a dependency cycle. The application
 * layer owns the conversion in both directions (INV-DEP-003).
 *
 * ## What it stores
 *
 * The privacy-minimized trace, exactly as the compiler wrote it. The trace
 * schema already carries no compiled context, no raw query, no block content, no
 * source content, no source metadata, and no model answer, and this adapter adds
 * nothing to it (DEC-037, INV-SEC-003).
 *
 * There is no `created_at` column. A wall clock is not an input this phase has a
 * port for, and a timestamp filled from `new Date()` inside an adapter would put
 * a hidden non-deterministic value into an audit record (INV-DET-004).
 *
 * ## Idempotence and conflict
 *
 * A `CompilationId` is deterministic, so writing one trace twice is the ordinary
 * consequence of compiling the same thing twice and must succeed. A **different**
 * record under one identifier is a contradiction in the audit log, and it is
 * rejected rather than overwritten: losing the first record would destroy the
 * evidence the store exists to keep (INV-ADAPTER-004).
 *
 * Equality is canonical, so a record rebuilt field by field or round-tripped
 * through a parser that ordered keys differently is the same record
 * (INV-DET-002).
 *
 * ## Scope
 *
 * A read requires the exact scope. A record stored under a different scope reads
 * as `null`, indistinguishably from one that does not exist, because
 * distinguishing them would disclose that another scope holds that identifier
 * (INV-SEC-004).
 *
 * ## Parameter binding
 *
 * Every dynamic value — the compilation identifier, the scope, the payload — is
 * a bound parameter. No SQL string is built by concatenation with data.
 */

/** Stable identifier of this trace-store implementation. */
export const SQLITE_TRACE_STORE_ID = 'sqlite:trace-store';

/** Stable version of this trace-store implementation and its semantics. */
export const SQLITE_TRACE_STORE_VERSION = '1';

/** Machine-readable categories of a trace-store failure (INV-TRACE-002). */
export type SQLiteTraceStoreErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'OPEN_FAILED'
  | 'MIGRATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'TRACE_CONFLICT'
  | 'INVALID_STORED_DATA';

/**
 * The single error this adapter raises.
 *
 * `TRACE_CONFLICT` is the one code the application layer matches on by identity,
 * because it is an answer rather than a malfunction: *a different trace already
 * holds this identifier* is what the caller needs to know (INV-ADAPTER-003).
 *
 * It carries no SQL text, no database path, no driver message, and no part of
 * the stored payload (INV-SEC-001, INV-ADAPTER-001).
 */
export class SQLiteTraceStoreError extends Error {
  readonly code: SQLiteTraceStoreErrorCode;

  constructor(code: SQLiteTraceStoreErrorCode, message: string) {
    super(message);
    this.name = 'SQLiteTraceStoreError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Representation                                                              */
/* -------------------------------------------------------------------------- */

/** The comparison key of one scope, injective over the exact `Scope` shape. */
function scopeKey(scope: Scope): string {
  return canonicalJson({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId ?? null,
  });
}

/** The stored form of one scope: exactly the fields it has. */
function scopeJson(scope: Scope): string {
  return canonicalJson({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
  });
}

/** The values one trace row binds. */
interface TraceRow {
  readonly compilationId: string;
  readonly scope: Scope;
  readonly scopeKey: string;
  readonly scopeJson: string;
  readonly traceSchemaVersion: number;
  readonly envelopeSchemaVersion: number;
  readonly traceJson: string;
}

/**
 * Inspects one envelope before it becomes a row.
 *
 * The adapter is the boundary at which a value becomes stored data, so it checks
 * what it is about to bind rather than trusting the compile-time type
 * (INV-BLOCK-005).
 */
function toRow(record: unknown): TraceRow {
  if (typeof record !== 'object' || record === null) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must be an object');
  }
  const envelope = record as {
    schemaVersion?: unknown;
    scope?: unknown;
    compilationId?: unknown;
    traceSchemaVersion?: unknown;
    payload?: unknown;
  };

  if (envelope.schemaVersion !== 1) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must declare schemaVersion 1');
  }
  const scope = ScopeSchema.safeParse(envelope.scope);
  if (!scope.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must carry a valid scope');
  }
  if (typeof envelope.compilationId !== 'string' || envelope.compilationId.trim().length === 0) {
    throw new SQLiteStoreFailure(
      'INVALID_INPUT',
      'a trace record must carry a non-empty compilation identifier',
    );
  }
  if (
    typeof envelope.traceSchemaVersion !== 'number' ||
    !Number.isSafeInteger(envelope.traceSchemaVersion)
  ) {
    throw new SQLiteStoreFailure(
      'INVALID_INPUT',
      'a trace record must carry an integer trace schema version',
    );
  }
  const payload = JsonObjectSchema.safeParse(envelope.payload);
  if (!payload.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must carry a JSON-safe payload');
  }

  return {
    compilationId: envelope.compilationId,
    scope: scope.data,
    scopeKey: scopeKey(scope.data),
    scopeJson: scopeJson(scope.data),
    traceSchemaVersion: envelope.traceSchemaVersion,
    envelopeSchemaVersion: 1,
    traceJson: canonicalJson(payload.data),
  };
}

/**
 * The canonical form of one row, for the structural equality `putTrace` needs.
 *
 * `traceJson` is already canonical on both sides — the stored column was written
 * canonically and the incoming payload is canonicalized above — so the two are
 * comparable as text.
 */
function canonicalRow(row: {
  readonly compilationId: string;
  readonly scopeKey: string;
  readonly traceSchemaVersion: number;
  readonly envelopeSchemaVersion: number;
  readonly traceJson: string;
}): string {
  return canonicalJson({
    compilationId: row.compilationId,
    scopeKey: row.scopeKey,
    traceSchemaVersion: row.traceSchemaVersion,
    envelopeSchemaVersion: row.envelopeSchemaVersion,
    traceJson: row.traceJson,
  });
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

const SELECT_COLUMNS =
  'compilation_id, scope_key, scope_json, trace_schema_version, envelope_schema_version, trace_json';

export class SQLiteTraceStore implements TraceStore {
  readonly id = SQLITE_TRACE_STORE_ID;
  readonly version = SQLITE_TRACE_STORE_VERSION;

  readonly #database: DatabaseSync;
  #closed = false;

  /**
   * Opens the configured database and brings it to the current schema.
   *
   * It may be the same file `SQLiteControlStore` uses — the migration creates
   * both tables and is idempotent — but it is always a **separate connection**.
   * Sharing one handle between two stores would make closing either of them
   * break the other (DEC-042).
   *
   * @throws {SQLiteTraceStoreError} when the configuration, the file, or the
   * schema is unusable.
   */
  constructor(config: unknown) {
    let validated: SQLiteLocalStoreConfig;
    let database: DatabaseSync;
    try {
      validated = validateSQLiteLocalStoreConfig(config);
      database = openDatabase(validated);
    } catch (cause) {
      throw translate(cause, 'OPEN_FAILED');
    }

    try {
      migrateToCurrentSchema(database);
    } catch (cause) {
      try {
        database.close();
      } catch {
        // Nothing can be done about a handle that will not close, and the
        // schema failure is what the caller needs to see.
      }
      throw translate(cause, 'MIGRATION_FAILED');
    }

    this.#database = database;
  }

  /**
   * Releases the database handle.
   *
   * It is declared on the concrete adapter and **not** on `TraceStore`. A caller
   * composing a trace store should not have to know a database exists, and a
   * `close()` on the port would tell every consumer that one does (DEC-042).
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch {
      throw new SQLiteTraceStoreError('READ_FAILED', 'the local trace store could not be closed');
    }
  }

  /**
   * Stores one settled trace, or succeeds silently when the identical record is
   * already stored.
   *
   * The read and the write run in one immediate transaction, so no other
   * connection can insert the same identifier between the check and the insert,
   * and a rejected conflict leaves the original row untouched (INV-STORE-003).
   */
  putTrace(record: StoredCompilationTraceRecord): Promise<void> {
    try {
      const row = toRow(record);
      inTransaction(this.#database, () => {
        const existing: unknown = this.#database
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM ${COMPILATION_TRACE_TABLE} WHERE compilation_id = ?`,
          )
          .get(row.compilationId);

        if (existing !== undefined && existing !== null) {
          if (typeof existing !== 'object') {
            throw new SQLiteStoreFailure(
              'INVALID_STORED_DATA',
              'a stored trace row is not readable',
            );
          }
          const stored = canonicalRow({
            compilationId: storedText(existing, 'compilation_id'),
            scopeKey: storedText(existing, 'scope_key'),
            traceSchemaVersion: storedInteger(existing, 'trace_schema_version'),
            envelopeSchemaVersion: storedInteger(existing, 'envelope_schema_version'),
            traceJson: storedText(existing, 'trace_json'),
          });
          if (stored !== canonicalRow(row)) {
            throw new SQLiteStoreFailure(
              'TRACE_CONFLICT',
              'a different trace is already stored under this compilation identifier',
            );
          }
          return;
        }

        this.#database
          .prepare(
            `INSERT INTO ${COMPILATION_TRACE_TABLE}
               (compilation_id, scope_key, scope_json, trace_schema_version,
                envelope_schema_version, trace_json)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.compilationId,
            row.scopeKey,
            row.scopeJson,
            row.traceSchemaVersion,
            row.envelopeSchemaVersion,
            row.traceJson,
          );
      });
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(translate(cause, 'WRITE_FAILED'));
    }
  }

  /**
   * Loads the record stored for one exact scope and compilation identifier.
   *
   * The scope is compared in SQL, so a record belonging to another scope is
   * never even read back — and the answer is the same `null` a missing record
   * gives (INV-SEC-004).
   */
  getTrace(scope: Scope, compilationId: string): Promise<StoredCompilationTraceRecord | null> {
    try {
      const parsed = ScopeSchema.safeParse(scope);
      if (!parsed.success) {
        throw new SQLiteStoreFailure('INVALID_INPUT', 'getTrace requires a valid scope');
      }
      if (typeof compilationId !== 'string' || compilationId.trim().length === 0) {
        throw new SQLiteStoreFailure(
          'INVALID_INPUT',
          'getTrace requires a non-empty compilation identifier',
        );
      }

      const found: unknown = this.#database
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM ${COMPILATION_TRACE_TABLE}
            WHERE compilation_id = ? AND scope_key = ?`,
        )
        .get(compilationId, scopeKey(parsed.data));

      if (found === undefined || found === null) return Promise.resolve(null);
      if (typeof found !== 'object') {
        throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'a stored trace row is not readable');
      }

      return Promise.resolve(this.#toRecord(found, parsed.data));
    } catch (cause) {
      return Promise.reject(translate(cause, 'READ_FAILED'));
    }
  }

  #toRecord(row: object, scope: Scope): StoredCompilationTraceRecord {
    const envelopeSchemaVersion = storedInteger(row, 'envelope_schema_version');
    if (envelopeSchemaVersion !== 1) {
      throw new SQLiteStoreFailure(
        'INVALID_STORED_DATA',
        `a stored trace declares envelope schema version ${String(envelopeSchemaVersion)}, and this build reads version 1`,
      );
    }

    const storedScope = parseStoredJsonObject(storedText(row, 'scope_json'));
    if (storedScope === null) {
      throw new SQLiteStoreFailure(
        'INVALID_STORED_DATA',
        'a stored trace carries a scope that is not readable JSON',
      );
    }
    const validatedScope = ScopeSchema.safeParse(storedScope);
    if (!validatedScope.success || !scopesEqual(validatedScope.data, scope)) {
      // Selected by `scope_key`, so a disagreeing `scope_json` is a corrupted
      // row rather than another scope's record. It is refused, not returned.
      throw new SQLiteStoreFailure(
        'INVALID_STORED_DATA',
        'a stored trace carries a scope that disagrees with its scope key',
      );
    }

    const payload = parseStoredJsonObject(storedText(row, 'trace_json'));
    if (payload === null) {
      throw new SQLiteStoreFailure(
        'INVALID_STORED_DATA',
        'a stored trace payload is not readable JSON',
      );
    }
    const validatedPayload = JsonObjectSchema.safeParse(payload);
    if (!validatedPayload.success) {
      throw new SQLiteStoreFailure(
        'INVALID_STORED_DATA',
        'a stored trace payload is not JSON-safe',
      );
    }

    return {
      schemaVersion: 1,
      scope: validatedScope.data,
      compilationId: storedText(row, 'compilation_id'),
      traceSchemaVersion: storedInteger(row, 'trace_schema_version'),
      payload: validatedPayload.data,
    };
  }
}

/**
 * Turns any thrown value into a `SQLiteTraceStoreError`.
 *
 * A precise internal failure keeps its code. Everything else becomes `fallback`
 * with a fixed message, because the thrown value's own wording is the driver's
 * and may name the database file, the SQL, or the stored payload
 * (INV-SEC-001).
 */
const TRACE_STORE_CODES: readonly SQLiteTraceStoreErrorCode[] = [
  'INVALID_CONFIG',
  'INVALID_INPUT',
  'OPEN_FAILED',
  'MIGRATION_FAILED',
  'UNSUPPORTED_SCHEMA_VERSION',
  'WRITE_FAILED',
  'READ_FAILED',
  'TRACE_CONFLICT',
  'INVALID_STORED_DATA',
];

function translate(cause: unknown, fallback: SQLiteTraceStoreErrorCode): SQLiteTraceStoreError {
  if (cause instanceof SQLiteStoreFailure) {
    // The internal carrier's code union spans both stores, so it is narrowed to
    // this adapter's published vocabulary rather than widened by assertion.
    const code = TRACE_STORE_CODES.find((known) => known === cause.failureCode);
    if (code !== undefined) return new SQLiteTraceStoreError(code, cause.message);
  }
  return new SQLiteTraceStoreError(
    fallback,
    fallback === 'WRITE_FAILED'
      ? 'the local trace store could not complete the write'
      : 'the local trace store could not complete the read',
  );
}

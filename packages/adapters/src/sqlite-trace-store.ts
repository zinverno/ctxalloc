import {
  JsonObjectSchema,
  ScopeSchema,
  scopesEqual,
  type JsonObject,
  type Scope,
} from '@ctxalloc/domain';
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
import { ownDataValue } from './passive-inspection.js';

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
 * (INV-DET-002). That holds for the **stored** side too: an existing row is
 * parsed and canonicalized before it is compared, rather than being trusted to
 * be canonical because some build once wrote it. A row an operator edited by
 * hand into semantically identical but differently ordered JSON is the same
 * audit record, and comparing raw column text would call it a conflict.
 *
 * The existing row is also **completely validated** before either verdict is
 * reached — envelope version, scope, identifier, trace version, and payload —
 * so a corrupted row is `INVALID_STORED_DATA` rather than a silent idempotent
 * success. Reporting *stored* for an identifier whose audit row cannot be read
 * back would be the one outcome this store must never produce (INV-STORE-002,
 * INV-TRACE-005).
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

/** The values one trace row binds, together with the payload they were built from. */
interface TraceRow {
  readonly compilationId: string;
  readonly scope: Scope;
  readonly scopeKey: string;
  readonly scopeJson: string;
  readonly traceSchemaVersion: number;
  readonly envelopeSchemaVersion: number;
  readonly traceJson: string;
  readonly payload: JsonObject;
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
  // Every field is read through `ownDataValue`, never as `record.payload`: a
  // plain property read on an `unknown` runs a `Proxy` `get` trap or an
  // installed getter before anything has decided to trust the value
  // (INV-ADAPTER-001).
  if (ownDataValue(record, 'schemaVersion') !== 1) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must declare schemaVersion 1');
  }
  const scope = ScopeSchema.safeParse(ownDataValue(record, 'scope'));
  if (!scope.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must carry a valid scope');
  }
  const compilationId = ownDataValue(record, 'compilationId');
  if (typeof compilationId !== 'string' || compilationId.trim().length === 0) {
    throw new SQLiteStoreFailure(
      'INVALID_INPUT',
      'a trace record must carry a non-empty compilation identifier',
    );
  }
  const traceSchemaVersion = ownDataValue(record, 'traceSchemaVersion');
  if (typeof traceSchemaVersion !== 'number' || !Number.isSafeInteger(traceSchemaVersion)) {
    throw new SQLiteStoreFailure(
      'INVALID_INPUT',
      'a trace record must carry an integer trace schema version',
    );
  }
  const payload = JsonObjectSchema.safeParse(ownDataValue(record, 'payload'));
  if (!payload.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a trace record must carry a JSON-safe payload');
  }

  return {
    compilationId,
    scope: scope.data,
    scopeKey: scopeKey(scope.data),
    scopeJson: scopeJson(scope.data),
    traceSchemaVersion,
    envelopeSchemaVersion: 1,
    traceJson: canonicalJson(payload.data),
    payload: payload.data,
  };
}

/**
 * The canonical form of one **complete** envelope, for the equality `putTrace`
 * needs.
 *
 * Every field of the record participates, the scope included. Comparing without
 * it would let a row whose stored scope was corrupted — or whose scope differs
 * from the incoming one under the same deterministic identifier — pass as the
 * same record (INV-SEC-004).
 *
 * The payload is the **parsed** value on both sides, canonicalized here, so
 * equality is semantic rather than textual: two spellings of the same JSON
 * object are one audit record (INV-DET-002).
 */
function semanticEnvelope(record: {
  readonly compilationId: string;
  readonly scope: Scope;
  readonly traceSchemaVersion: number;
  readonly payload: JsonObject;
}): string {
  return canonicalJson({
    envelopeSchemaVersion: 1,
    compilationId: record.compilationId,
    scope: {
      tenantId: record.scope.tenantId,
      workspaceId: record.scope.workspaceId,
      ...(record.scope.projectId !== undefined ? { projectId: record.scope.projectId } : {}),
    },
    traceSchemaVersion: record.traceSchemaVersion,
    payload: record.payload,
  });
}

/**
 * Rebuilds one stored row into a complete record, or fails with a stable code.
 *
 * This is the **only** path from a row to a record, used by `getTrace` and by
 * the existing-row branch of `putTrace` alike. One reader is what makes the two
 * agree: a row `getTrace` would reject as corrupted must not be a row `putTrace`
 * silently accepts as already stored, and two readers with slightly different
 * checks is exactly how that divergence appears (INV-ADAPTER-005).
 *
 * A stored row is external data however it got there — the file is on an
 * operator's disk and another build may have written it — so nothing about it is
 * assumed, including that its JSON is canonical (INV-BLOCK-005).
 */
function readStoredRecord(row: object): StoredCompilationTraceRecord {
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
  if (!validatedScope.success) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored trace carries a scope that is not a valid scope',
    );
  }
  // The two scope columns are meant to describe one scope. A `scope_json` that
  // does not reproduce the row's own `scope_key` is a corrupted row, and it is
  // refused here rather than at whichever caller happened to notice.
  if (scopeKey(validatedScope.data) !== storedText(row, 'scope_key')) {
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
    throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'a stored trace payload is not JSON-safe');
  }

  return {
    schemaVersion: 1,
    scope: validatedScope.data,
    compilationId: storedText(row, 'compilation_id'),
    traceSchemaVersion: storedInteger(row, 'trace_schema_version'),
    payload: validatedPayload.data,
  };
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
   *
   * An existing row is read through {@link readStoredRecord} — the same reader
   * `getTrace` uses — before either verdict is reached. Three outcomes follow,
   * and the first is the one a naive store gets wrong: an **unreadable** row is
   * `INVALID_STORED_DATA`, so a caller can never be told a trace is stored under
   * an identifier whose audit row cannot be read back; a semantically identical
   * record is idempotent success; and a valid but different one, scope included,
   * is `TRACE_CONFLICT`.
   *
   * A corrupted row is never repaired and never overwritten. Rewriting it would
   * destroy the only evidence that something else wrote it (INV-STORE-002).
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
          // Validate the complete stored envelope first. A row that cannot be
          // read is neither the same record nor a different one, and answering
          // "already stored" for it would report an audit entry that is not
          // there.
          const stored = readStoredRecord(existing);
          if (semanticEnvelope(stored) !== semanticEnvelope(row)) {
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

      const record = readStoredRecord(found);
      // Selected by `scope_key`, so a stored scope that disagrees with the
      // requested one is a corrupted row rather than another scope's record. It
      // is refused, not returned (INV-SEC-004).
      if (!scopesEqual(record.scope, parsed.data)) {
        throw new SQLiteStoreFailure(
          'INVALID_STORED_DATA',
          'a stored trace carries a scope that disagrees with its scope key',
        );
      }
      return Promise.resolve(record);
    } catch (cause) {
      return Promise.reject(translate(cause, 'READ_FAILED'));
    }
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

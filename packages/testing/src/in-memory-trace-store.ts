import { scopesEqual, type JsonObject, type JsonValue, type Scope } from '@ctxalloc/domain';
import type { StoredCompilationTraceRecord, TraceStore } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link TraceStore} port (DEC-042).
 *
 * It holds records in memory and answers only for the exact scope it is asked
 * about. A record stored under another scope reads as `null`, exactly as a
 * record that was never stored: distinguishing them would disclose that another
 * scope holds that identifier, which is the leak the scope argument exists to
 * prevent (INV-SEC-004).
 *
 * `putTrace` has the same idempotence and conflict semantics as
 * `SQLiteTraceStore`: storing the same record twice succeeds, and storing a
 * *different* record under one compilation identifier is a conflict rather than
 * an overwrite. Equality is canonical, so a record rebuilt field by field — or
 * round-tripped through JSON — is the same record, and property insertion order
 * decides nothing (INV-DET-002, INV-ADAPTER-004).
 *
 * One shared contract suite runs against this fake and against SQLite, so a test
 * written on the double is a test of the behavior the product ships
 * (INV-ADAPTER-005).
 *
 * It reads no file, database, environment variable, clock, or random value
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'in-memory-trace-store';
const DEFAULT_VERSION = '1';

/** Optional store identity, used when a test asserts on a reported identity. */
export interface InMemoryTraceStoreOptions {
  readonly id?: string;
  readonly version?: string;
}

/** Rejected {@link InMemoryTraceStore} configuration. */
export class InMemoryTraceStoreConfigurationError extends Error {
  readonly code = 'IN_MEMORY_TRACE_STORE_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'InMemoryTraceStoreConfigurationError';
  }
}

/**
 * Machine-readable categories of an in-memory trace-store failure.
 *
 * The code is the **exact string** `SQLiteTraceStore` publishes, so the
 * application layer's conflict handling is exercised against the same value in
 * both compositions (INV-ADAPTER-003, INV-ADAPTER-005).
 */
export type InMemoryTraceStoreErrorCode = 'TRACE_CONFLICT';

/** A rejected in-memory trace write. */
export class InMemoryTraceStoreError extends Error {
  readonly code: InMemoryTraceStoreErrorCode;

  constructor(code: InMemoryTraceStoreErrorCode, message: string) {
    super(message);
    this.name = 'InMemoryTraceStoreError';
    this.code = code;
  }
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new InMemoryTraceStoreConfigurationError(
      `InMemoryTraceStore ${field} must not be empty or whitespace-only.`,
    );
  }
  return value;
}

/**
 * Deterministic serialization: keys sorted recursively, array order preserved.
 *
 * A plain `JSON.stringify` emits keys in insertion order, which a JSON parser or
 * a driver can vary between runs; comparing records with it would report two
 * equal records as a conflict (INV-DET-002).
 */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deep copy of JSON data, so no caller-owned object is shared between reads. */
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry);
    return result;
  }
  return value;
}

function copyRecord(record: StoredCompilationTraceRecord): StoredCompilationTraceRecord {
  return {
    schemaVersion: record.schemaVersion,
    scope: { ...record.scope },
    compilationId: record.compilationId,
    traceSchemaVersion: record.traceSchemaVersion,
    payload: cloneJson(record.payload) as JsonObject,
  };
}

/** The canonical form of one record, for the structural equality `putTrace` needs. */
function canonicalRecord(record: StoredCompilationTraceRecord): string {
  return canonicalJson({
    schemaVersion: record.schemaVersion,
    scope: {
      tenantId: record.scope.tenantId,
      workspaceId: record.scope.workspaceId,
      projectId: record.scope.projectId ?? null,
    },
    compilationId: record.compilationId,
    traceSchemaVersion: record.traceSchemaVersion,
    payload: record.payload,
  });
}

export class InMemoryTraceStore implements TraceStore {
  readonly id: string;
  readonly version: string;

  readonly #records = new Map<string, StoredCompilationTraceRecord>();

  constructor(options: InMemoryTraceStoreOptions = {}) {
    this.id = requireNonBlank(options.id ?? DEFAULT_ID, 'id');
    this.version = requireNonBlank(options.version ?? DEFAULT_VERSION, 'version');
  }

  putTrace(record: StoredCompilationTraceRecord): Promise<void> {
    const existing = this.#records.get(record.compilationId);
    if (existing !== undefined) {
      // Keyed by compilation identifier alone, exactly as the SQLite table is.
      // A deterministic identifier already binds the scope, so a second record
      // with the same identifier and a different scope is a contradiction rather
      // than a second tenant's record (DEC-042).
      if (canonicalRecord(existing) !== canonicalRecord(record)) {
        return Promise.reject(
          new InMemoryTraceStoreError(
            'TRACE_CONFLICT',
            'A different trace is already stored under this compilation identifier.',
          ),
        );
      }
      return Promise.resolve();
    }
    this.#records.set(record.compilationId, copyRecord(record));
    return Promise.resolve();
  }

  getTrace(scope: Scope, compilationId: string): Promise<StoredCompilationTraceRecord | null> {
    const record = this.#records.get(compilationId);
    if (record === undefined || !scopesEqual(record.scope, scope)) {
      return Promise.resolve(null);
    }
    return Promise.resolve(copyRecord(record));
  }
}

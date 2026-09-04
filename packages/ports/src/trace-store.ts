import type { JsonObject, Scope } from '@ctxalloc/domain';

/**
 * Compilation-trace persistence port.
 *
 * A settled trace is the audit record of one compilation, and an operator who
 * restarts a process must still be able to read it (INV-TRACE-005).
 *
 * ## Why the port carries an envelope rather than a trace
 *
 * The obvious contract would be `putTrace(trace: SettledCompilationTrace)`. It
 * cannot be written here: `SettledCompilationTrace` is owned by
 * `@ctxalloc/compiler`, the compiler already depends inward on this package, and
 * naming it would close a dependency cycle between the two (INV-DEP-003).
 *
 * Moving the trace type down into the ports package would be worse. The trace is
 * compiler output — its dispositions, reasons, and settlement evidence are the
 * kernel's vocabulary — and a port package that owned it would make every future
 * change to compiler tracing a change to the contract every adapter implements.
 *
 * So the port speaks the only vocabulary both sides already share: project-owned
 * domain values plus JSON. `payload` is the trace exactly as it serializes, and
 * the **application layer** owns the conversion in both directions. A store
 * writes bytes it can address and returns them unchanged; it never learns what a
 * disposition is (DEC-042).
 *
 * Only project-owned types appear here: no database client, no row type, no
 * SQLite handle, no compiler type (INV-ADAPTER-001).
 */

/**
 * One persisted trace, addressed by scope and compilation identifier.
 *
 * Two versions are recorded and they mean different things.
 * `schemaVersion` versions **this envelope** — the addressing fields a store
 * reads. `traceSchemaVersion` versions the **payload** the compiler wrote, which
 * a store never interprets. Collapsing them into one number would make a change
 * to trace content look like a change to storage addressing, and a store would
 * have to be re-released to persist a trace it never reads (INV-STORE-004).
 *
 * `scope` is exact and required on both write and read. A trace is scoped audit
 * data, and a read that ignored the scope would let one tenant address another's
 * record by identifier alone (INV-SCOPE-004, INV-SEC-004).
 *
 * `payload` is JSON-safe by construction: an object of the same values
 * `JsonObject` allows, and nothing else. No `Date`, `Map`, class instance, or
 * `undefined` may appear in it, so what a store writes and what it returns are
 * the same value.
 */
export interface StoredCompilationTraceRecord {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly compilationId: string;
  readonly traceSchemaVersion: number;
  readonly payload: JsonObject;
}

/**
 * Stores and retrieves settled compilation traces.
 *
 * `putTrace` is idempotent for the **same** record and only for the same record.
 * A compilation identifier is deterministic, so writing one twice is an ordinary
 * consequence of compiling the same thing twice and must succeed. A second
 * record under one identifier whose content differs is a contradiction in the
 * audit log, and an implementation must reject it rather than overwrite: losing
 * the first record would destroy the very evidence the store exists to keep
 * (INV-ADAPTER-004).
 *
 * `getTrace` requires the exact scope. A record that exists under a different
 * scope resolves to `null`, exactly as a record that does not exist at all: the
 * two are indistinguishable to the caller on purpose, because distinguishing
 * them would disclose that another scope holds that identifier (INV-SEC-004).
 *
 * `null` means *no such trace in this scope*. It must never mean *the store
 * failed*: an unavailable store fails explicitly (INV-ADAPTER-003).
 */
export interface TraceStore {
  /** Stable identifier of the trace-store implementation. */
  readonly id: string;

  /** Stable version of the trace-store implementation. */
  readonly version: string;

  putTrace(record: StoredCompilationTraceRecord): Promise<void>;
  getTrace(scope: Scope, compilationId: string): Promise<StoredCompilationTraceRecord | null>;
}

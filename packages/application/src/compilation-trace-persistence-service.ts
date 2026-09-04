import {
  PersistedCompilationTraceError,
  SettledCompilationTraceValidator,
  type SettledCompilationTrace,
} from '@ctxalloc/compiler';
import {
  JsonObjectSchema,
  ScopeSchema,
  safeParse,
  scopesEqual,
  type JsonObject,
  type Scope,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { StoredCompilationTraceRecord, TraceStore } from '@ctxalloc/ports';
import { z } from 'zod';
import { issue } from './chunking-primitives.js';
import { validatePort } from './local-source-pipeline.js';

/**
 * The trace-persistence use case (DEC-042).
 *
 * `TraceStore` speaks in JSON envelopes and `ContextCompiler` speaks in
 * `SettledCompilationTrace`. Something has to translate, and this is the only
 * layer that may: the port package cannot name the compiler's type without
 * closing a dependency cycle, and the adapter must not depend on the kernel at
 * all (INV-DEP-003, DEC-042).
 *
 * ```text
 * store: SettledCompilationTrace -> validate -> envelope -> TraceStore.putTrace
 * get:   TraceStore.getTrace -> envelope validation -> payload validation
 *          -> scope and id agreement -> SettledCompilationTrace
 * ```
 *
 * ## Both directions are validated, for different reasons
 *
 * On the way **out**, the trace is validated so that a malformed record never
 * becomes a stored one. A store keeps what it is given; a corrupt audit record
 * written today is a corrupt audit record read forever (INV-ADAPTER-004).
 *
 * On the way **in**, it is validated because a stored record is external data.
 * The process that wrote it is gone, its build is unknown, and a row can be
 * edited by anything with the file. `JSON.parse(...) as SettledCompilationTrace`
 * would publish whatever the row happened to contain (INV-BLOCK-005).
 *
 * A read also proves the envelope and its payload **agree**. The envelope's
 * `scope` and `compilationId` are what the store indexed on, and the payload
 * carries its own copies of both; a record where they disagree is one whose
 * addressing does not describe its content, and returning it would answer a
 * question about one compilation with the trace of another (INV-SCOPE-004).
 *
 * ## What is never stored
 *
 * The payload is the trace, and the trace schema already carries no compiled
 * context, no raw query, no block content, no source content, no source
 * metadata, and no model answer (DEC-037, INV-SEC-003). This service adds
 * nothing to it: there is no "store the context too" option, because the record
 * whose privacy boundary was drawn for decisions is the record that gets stored.
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of a {@link StoredCompilationTraceRecord} (INV-STORE-004). */
export const STORED_COMPILATION_TRACE_RECORD_SCHEMA_VERSION = 1;

/** Machine-readable categories of a trace-persistence failure (INV-TRACE-002). */
export type CompilationTracePersistenceIssueCode =
  | 'invalid_trace'
  | 'invalid_scope'
  | 'invalid_compilation_id'
  | 'invalid_stored_record'
  | 'stored_record_scope_mismatch'
  | 'stored_record_id_mismatch'
  | 'trace_conflict'
  | 'trace_store_unavailable';

/**
 * The single error this service raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * database message, SQL text, path, driver error, or stored payload escapes
 * through it, and no message quotes a trace value (INV-ADAPTER-001,
 * INV-SEC-001).
 */
export class CompilationTracePersistenceError extends Error {
  readonly code = 'COMPILATION_TRACE_PERSISTENCE_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Compilation trace persistence failed: ${summary}`);
    this.name = 'CompilationTracePersistenceError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Envelope validation                                                         */
/* -------------------------------------------------------------------------- */

const compilationIdentifier = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

/**
 * The runtime boundary of one stored envelope.
 *
 * `payload` is validated as JSON data and nothing more here: whether it is a
 * *trace* is `SettledCompilationTraceValidator`'s question, and answering it
 * twice in two vocabularies would create two verdicts on one record
 * (INV-DEP-003).
 */
const StoredRecordSchema = z.strictObject({
  schemaVersion: z.literal(STORED_COMPILATION_TRACE_RECORD_SCHEMA_VERSION),
  scope: ScopeSchema,
  compilationId: compilationIdentifier,
  traceSchemaVersion: z.int(),
  payload: JsonObjectSchema,
});

/** The exact code a store publishes when one identifier already holds another record. */
const TRACE_CONFLICT_CODE = 'TRACE_CONFLICT';
const INVALID_STORED_DATA_CODE = 'INVALID_STORED_DATA';

/** Reads one own string data property without invoking an accessor. */
function ownCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');
  if (descriptor === undefined || !('value' in descriptor)) return null;
  return typeof descriptor.value === 'string' ? descriptor.value : null;
}

/**
 * Translates a store failure into a project-owned issue.
 *
 * Exactly two codes are honored, by identity against a closed set, because both
 * are genuine answers rather than malfunctions: a different record already holds
 * this identifier, and the store holds a row this build cannot read. Everything
 * else is *the store is unavailable*. No message, `cause`, stack, or other field
 * is read (INV-ADAPTER-003, INV-SEC-001).
 */
function dependencyIssue(cause: unknown, path: readonly string[]): ValidationIssue {
  switch (ownCode(cause)) {
    case TRACE_CONFLICT_CODE:
      return issue(
        path,
        'a different trace is already stored under this compilation identifier',
        'trace_conflict' satisfies CompilationTracePersistenceIssueCode,
      );
    case INVALID_STORED_DATA_CODE:
      return issue(
        path,
        'the trace store holds a record this build cannot read',
        'invalid_stored_record' satisfies CompilationTracePersistenceIssueCode,
      );
    default:
      return issue(
        path,
        'the trace store is unavailable',
        'trace_store_unavailable' satisfies CompilationTracePersistenceIssueCode,
      );
  }
}

function readdress(
  issues: readonly ValidationIssue[],
  prefix: readonly string[],
  code: CompilationTracePersistenceIssueCode,
): readonly ValidationIssue[] {
  return issues.map((detail) => {
    const path = [...prefix, ...detail.path];
    return { code, path, pointer: path.join('.'), message: detail.message };
  });
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/** Stores and loads settled compilation traces through a {@link TraceStore}. */
export class CompilationTracePersistenceService {
  readonly #store: TraceStore;
  readonly #validator = new SettledCompilationTraceValidator();

  /**
   * @throws {CompilationTracePersistenceError} when the store is not a usable port.
   */
  constructor(store: TraceStore) {
    const issues = [
      ...validatePort('traceStore', store, 'putTrace'),
      ...validatePort('traceStore', store, 'getTrace'),
    ];
    if (issues.length > 0) {
      throw new CompilationTracePersistenceError(
        issues.map((detail) => ({
          ...detail,
          code: 'trace_store_unavailable' satisfies CompilationTracePersistenceIssueCode,
        })),
      );
    }
    this.#store = store;
  }

  /**
   * Persists one settled trace.
   *
   * The trace is validated before the envelope is built, so an ill-formed record
   * is rejected rather than stored. The envelope's `scope` and `compilationId`
   * are read **from the trace itself**, never supplied separately: two sources
   * for one fact is exactly the disagreement `get` then has to detect.
   *
   * `putTrace` is idempotent for the same record. Storing one trace twice is an
   * ordinary consequence of compiling the same thing twice; storing a *different*
   * record under one identifier is a contradiction, and the store reports it as
   * a conflict rather than overwriting the original (INV-ADAPTER-004).
   *
   * @throws {CompilationTracePersistenceError} when the trace or the store fails.
   */
  async store(trace: unknown): Promise<void> {
    await this.#store.putTrace(this.#envelope(trace)).catch((cause: unknown) => {
      throw new CompilationTracePersistenceError([dependencyIssue(cause, ['trace'])]);
    });
  }

  /**
   * The envelope for one settled trace.
   *
   * The payload is re-validated as JSON data by the domain's own schema, which
   * returns a fresh JSON-safe object. The trace has already been proven to be
   * passive JSON, so this changes no value: it is what makes the envelope's
   * `payload` a `JsonObject` by construction rather than by assertion.
   */
  #envelope(trace: unknown): StoredCompilationTraceRecord {
    let settled: SettledCompilationTrace;
    try {
      settled = this.#validator.validate(trace);
    } catch (cause) {
      if (cause instanceof PersistedCompilationTraceError) {
        throw new CompilationTracePersistenceError(
          readdress(cause.issues, ['trace'], 'invalid_trace'),
        );
      }
      throw cause;
    }

    const payload = safeParse(JsonObjectSchema, settled);
    if (!payload.ok) {
      throw new CompilationTracePersistenceError(
        readdress(payload.issues, ['trace'], 'invalid_trace'),
      );
    }

    return {
      schemaVersion: STORED_COMPILATION_TRACE_RECORD_SCHEMA_VERSION,
      scope: settled.request.scope,
      compilationId: settled.compilationId,
      traceSchemaVersion: settled.schemaVersion,
      payload: payload.value satisfies JsonObject,
    };
  }

  /**
   * Loads the settled trace stored for one exact scope and compilation
   * identifier, or `null` when there is none.
   *
   * A record stored under a different scope reads as `null`, exactly as a record
   * that does not exist: the two are indistinguishable on purpose, because
   * distinguishing them would disclose that another scope holds that identifier
   * (INV-SEC-004).
   *
   * @throws {CompilationTracePersistenceError} when the stored record is
   * unreadable, contradicts its own envelope, or the store fails.
   */
  async get(scope: unknown, compilationId: unknown): Promise<SettledCompilationTrace | null> {
    const parsedScope = safeParse(ScopeSchema, scope);
    if (!parsedScope.ok) {
      throw new CompilationTracePersistenceError(
        readdress(parsedScope.issues, ['scope'], 'invalid_scope'),
      );
    }
    const parsedId = safeParse(compilationIdentifier, compilationId);
    if (!parsedId.ok) {
      throw new CompilationTracePersistenceError(
        readdress(parsedId.issues, ['compilationId'], 'invalid_compilation_id'),
      );
    }

    let stored: unknown;
    try {
      stored = await this.#store.getTrace(parsedScope.value, parsedId.value);
    } catch (cause) {
      throw new CompilationTracePersistenceError([dependencyIssue(cause, ['compilationId'])]);
    }
    if (stored === null || stored === undefined) return null;

    return this.#settled(stored, parsedScope.value, parsedId.value);
  }

  /** Proves one stored record is the settled trace it claims to address. */
  #settled(stored: unknown, scope: Scope, compilationId: string): SettledCompilationTrace {
    const record = safeParse(StoredRecordSchema, stored);
    if (!record.ok) {
      throw new CompilationTracePersistenceError(
        readdress(record.issues, ['record'], 'invalid_stored_record'),
      );
    }

    if (!scopesEqual(record.value.scope, scope)) {
      throw new CompilationTracePersistenceError([
        issue(
          ['record', 'scope'],
          'the stored record does not belong to the requested scope',
          'stored_record_scope_mismatch' satisfies CompilationTracePersistenceIssueCode,
        ),
      ]);
    }
    if (record.value.compilationId !== compilationId) {
      throw new CompilationTracePersistenceError([
        issue(
          ['record', 'compilationId'],
          'the stored record does not carry the requested compilation identifier',
          'stored_record_id_mismatch' satisfies CompilationTracePersistenceIssueCode,
        ),
      ]);
    }

    let settled: SettledCompilationTrace;
    try {
      settled = this.#validator.validate(record.value.payload);
    } catch (cause) {
      if (cause instanceof PersistedCompilationTraceError) {
        throw new CompilationTracePersistenceError(
          readdress(cause.issues, ['record', 'payload'], 'invalid_stored_record'),
        );
      }
      throw cause;
    }

    // The envelope is the addressing and the payload is the content, and a
    // record whose two halves disagree describes no compilation at all. Both are
    // checked, not one: an envelope could carry the right scope and the wrong
    // identifier, or the reverse (INV-ADAPTER-004).
    if (settled.compilationId !== record.value.compilationId) {
      throw new CompilationTracePersistenceError([
        issue(
          ['record', 'payload', 'compilationId'],
          'the stored trace carries a different compilation identifier than its envelope',
          'stored_record_id_mismatch' satisfies CompilationTracePersistenceIssueCode,
        ),
      ]);
    }
    if (!scopesEqual(settled.request.scope, record.value.scope)) {
      throw new CompilationTracePersistenceError([
        issue(
          ['record', 'payload', 'request', 'scope'],
          'the stored trace carries a different scope than its envelope',
          'stored_record_scope_mismatch' satisfies CompilationTracePersistenceIssueCode,
        ),
      ]);
    }
    if (settled.schemaVersion !== record.value.traceSchemaVersion) {
      throw new CompilationTracePersistenceError([
        issue(
          ['record', 'traceSchemaVersion'],
          'the stored trace carries a different schema version than its envelope',
          'invalid_stored_record' satisfies CompilationTracePersistenceIssueCode,
        ),
      ]);
    }

    return settled;
  }
}

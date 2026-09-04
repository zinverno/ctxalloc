import {
  JsonObjectSchema,
  ScopeSchema,
  SourceTypeSchema,
  TimestampSchema,
  scopesEqual,
  type JsonObject,
  type Scope,
  type Timestamp,
} from '@ctxalloc/domain';
import type {
  ControlStore,
  ControlStoreWriter,
  SourceRegistration,
  SourceRegistrationKey,
} from '@ctxalloc/ports';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, parseStoredJsonObject } from './sqlite-json.js';
import {
  changeCount,
  inTransaction,
  openDatabase,
  optionalStoredText,
  storedInteger,
  storedText,
} from './sqlite-database.js';
import {
  SQLiteStoreFailure,
  validateSQLiteLocalStoreConfig,
  type SQLiteLocalStoreConfig,
} from './sqlite-store-config.js';
import { SOURCE_REGISTRATION_TABLE, migrateToCurrentSchema } from './sqlite-migrations.js';
import { ownDataValue } from './passive-inspection.js';

/**
 * The local SQLite control plane (DEC-042).
 *
 * It implements both control-plane ports: `ControlStore` for listing the sources
 * of one exact scope, and `ControlStoreWriter` for creating, updating, and
 * removing them. One class implements two interfaces rather than one merged
 * interface, so a consumer that only reads is still handed only the read
 * capability (INV-DEP-003).
 *
 * ## What it stores
 *
 * Registration data, and nothing else. No source content, no block, no
 * candidate, no compiled context, and no retrieval index: the original files
 * remain the content authority, and this database is the control and audit store
 * (INV-STORE-001).
 *
 * `metadata` is persisted because it is explicit control-plane data an operator
 * supplied. It stays untrusted: it never becomes compiler policy and never
 * replaces a project-owned identifier (INV-SEC-001, INV-ADAPTER-002).
 *
 * ## What its errors never say
 *
 * No SQL text, no database path, no driver message, no driver error object, no
 * locator, no metadata value, and no stored JSON appears in a
 * `SQLiteControlStoreError`. A SQLite error names the statement and the file it
 * failed on, and an operator's filesystem layout is not something an ordinary
 * error message should publish (INV-SEC-001, INV-ADAPTER-001).
 *
 * ## Parameter binding
 *
 * Every dynamic value — scope, source type, identity, locator, title,
 * timestamps, metadata — is a bound parameter. No SQL string is ever built by
 * concatenation with data. The only interpolated names are the table and column
 * names in this module's own statements, which are fixed constants.
 */

/** Stable identifier of this control-store implementation. */
export const SQLITE_CONTROL_STORE_ID = 'sqlite:control-store';

/** Stable version of this control-store implementation and its semantics. */
export const SQLITE_CONTROL_STORE_VERSION = '1';

/** Machine-readable categories of a control-store failure (INV-TRACE-002). */
export type SQLiteControlStoreErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'OPEN_FAILED'
  | 'MIGRATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'WRITE_FAILED'
  | 'READ_FAILED'
  | 'SOURCE_CONFLICT'
  | 'SOURCE_NOT_FOUND'
  | 'INVALID_STORED_DATA';

/**
 * The single error this adapter raises.
 *
 * `SOURCE_CONFLICT` and `SOURCE_NOT_FOUND` are the two codes the application
 * layer matches on by identity, because both are answers rather than
 * malfunctions: *this already exists* and *there was nothing to change* are what
 * the caller asked about (INV-ADAPTER-003).
 */
export class SQLiteControlStoreError extends Error {
  readonly code: SQLiteControlStoreErrorCode;

  constructor(code: SQLiteControlStoreErrorCode, message: string) {
    super(message);
    this.name = 'SQLiteControlStoreError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Scope and identity representation                                           */
/* -------------------------------------------------------------------------- */

/**
 * The comparison key of one scope: canonical JSON with an absent project
 * written as `null`.
 *
 * It is injective over the exact `Scope` shape, which is what makes the primary
 * key correct. A nullable `project_id` column would not be: SQLite treats two
 * NULLs as distinct in a unique index, so two registrations with no project
 * would both be accepted (INV-SCOPE-004).
 */
function scopeKey(scope: Scope): string {
  return canonicalJson({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId ?? null,
  });
}

/**
 * The stored form of one scope: exactly the fields it has.
 *
 * An absent project is absent here rather than `null`, so reconstruction never
 * has to decide what a stored `null` meant.
 */
function scopeJson(scope: Scope): string {
  return canonicalJson({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
  });
}

/** Rebuilds one stored scope, or fails with a stable code. */
function readScope(text: string): Scope {
  const parsed = parseStoredJsonObject(text);
  if (parsed === null) {
    throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'a stored scope is not readable JSON');
  }
  const scope = ScopeSchema.safeParse(parsed);
  if (!scope.success) {
    throw new SQLiteStoreFailure('INVALID_STORED_DATA', 'a stored scope is not a valid scope');
  }
  return scope.data;
}

/* -------------------------------------------------------------------------- */
/* Input inspection                                                            */
/* -------------------------------------------------------------------------- */

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SQLiteStoreFailure(
      'INVALID_INPUT',
      `registration ${field} must not be empty or whitespace-only`,
    );
  }
  return value;
}

/**
 * Reads the identity fields of a registration or a key.
 *
 * The adapter is the boundary at which a value becomes a row, so it checks the
 * values it is about to bind rather than trusting the compile-time type: the
 * caller is another process's data in every deployment that matters
 * (INV-BLOCK-005).
 *
 * Every field is read through `ownDataValue`, never as `record.scope`. This is
 * not semantic validation — the application layer owns that — but the values are
 * about to be bound into a statement, and a plain property read on an `unknown`
 * runs a `Proxy` `get` trap or an installed getter before anything has decided
 * to trust the value. An unreadable field simply has no value, and the ordinary
 * check below rejects it (INV-ADAPTER-001).
 */
function readIdentity(input: unknown): {
  readonly scope: Scope;
  readonly sourceType: string;
  readonly namespace: string;
  readonly key: string;
} {
  if (typeof input !== 'object' || input === null) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must be an object');
  }

  const scope = ScopeSchema.safeParse(ownDataValue(input, 'scope'));
  if (!scope.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must carry a valid scope');
  }
  const sourceType = SourceTypeSchema.safeParse(ownDataValue(input, 'sourceType'));
  if (!sourceType.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must carry a known source type');
  }
  const identity = ownDataValue(input, 'identity');
  if (typeof identity !== 'object' || identity === null) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must carry an identity');
  }

  return {
    scope: scope.data,
    sourceType: sourceType.data,
    namespace: requireText(ownDataValue(identity, 'namespace'), 'identity.namespace'),
    key: requireText(ownDataValue(identity, 'key'), 'identity.key'),
  };
}

/** The complete set of values one registration row binds. */
interface RegistrationRow {
  readonly scopeKey: string;
  readonly scopeJson: string;
  readonly sourceType: string;
  readonly namespace: string;
  readonly key: string;
  readonly locator: string;
  readonly titleJson: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly metadataJson: string;
  readonly registrationSchemaVersion: number;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  return requireText(value, field);
}

/**
 * Encodes an optional title as a JSON string, or `null` when it is absent.
 *
 * The title is **not** bound as raw text, and it is **not** required to be
 * non-blank. The existing `SourceRegistration` contract accepts any `string`
 * there — `""` and `"   "` included — and this adapter's job is to persist the
 * contract it was given, not to narrow it. A store that rejected a registration
 * the in-memory implementation accepts would make the shared port contract false
 * (INV-ADAPTER-005).
 *
 * Raw text binding is also lossy for a value the contract allows: `"\uD800"` is
 * a lone surrogate, and Node's SQLite `TEXT` binding round-trips it as
 * `"\uFFFD"` — a silent rewrite of an operator's registration. JSON string
 * encoding escapes a lone surrogate as ASCII, so the column only ever carries
 * well-formed text and the exact original code units come back (INV-STORE-002).
 *
 * `JSON.stringify` of a `string` is always a string, so the `?? null` is
 * unreachable; it is written rather than asserted away because the type says the
 * result is optional.
 */
function optionalTitleJson(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'registration title must be a string');
  }
  return JSON.stringify(value) ?? null;
}

/**
 * Rebuilds an optional title from its stored JSON string.
 *
 * A stored column is external data, so the decoded value must be proven to be a
 * string rather than assumed: `title_json` holding `7` or `[]` is a corrupted
 * row, and returning `7` as a title would publish a `SourceRegistration` whose
 * own schema rejects it (INV-BLOCK-005).
 */
function storedTitle(row: object, name: string): string | undefined {
  const text = optionalStoredText(row, name);
  if (text === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    // The parser's message quotes the offending text, which is stored data.
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored registration carries a title that is not readable JSON',
    );
  }
  if (typeof decoded !== 'string') {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored registration carries a title that is not a JSON string',
    );
  }
  return decoded;
}

function toRow(registration: unknown): RegistrationRow {
  const identity = readIdentity(registration);

  const metadata = JsonObjectSchema.safeParse(ownDataValue(registration, 'metadata'));
  if (!metadata.success) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must carry JSON-safe metadata');
  }
  if (ownDataValue(registration, 'schemaVersion') !== 1) {
    throw new SQLiteStoreFailure('INVALID_INPUT', 'a registration must declare schemaVersion 1');
  }

  return {
    scopeKey: scopeKey(identity.scope),
    scopeJson: scopeJson(identity.scope),
    sourceType: identity.sourceType,
    namespace: identity.namespace,
    key: identity.key,
    locator: requireText(ownDataValue(registration, 'locator'), 'locator'),
    titleJson: optionalTitleJson(ownDataValue(registration, 'title')),
    createdAt: optionalText(ownDataValue(registration, 'createdAt'), 'createdAt'),
    updatedAt: optionalText(ownDataValue(registration, 'updatedAt'), 'updatedAt'),
    metadataJson: canonicalJson(metadata.data),
    registrationSchemaVersion: 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Row reconstruction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Reads one optional stored timestamp, validated by the domain's own schema.
 *
 * A column is text as far as SQLite is concerned, so a stored value that is not
 * a real UTC instant would otherwise become a `Timestamp` by assertion rather
 * than by proof (INV-BLOCK-005).
 */
function storedTimestamp(row: object, name: string): Timestamp | undefined {
  const value = optionalStoredText(row, name);
  if (value === undefined) return undefined;
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      `the stored row column "${name}" is not a valid timestamp`,
    );
  }
  return parsed.data;
}

function toRegistration(row: object): SourceRegistration {
  const schemaVersion = storedInteger(row, 'registration_schema_version');
  if (schemaVersion !== 1) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      `a stored registration declares schema version ${String(schemaVersion)}, and this build reads version 1`,
    );
  }

  const metadata = parseStoredJsonObject(storedText(row, 'metadata_json'));
  if (metadata === null) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored registration carries metadata that is not readable JSON',
    );
  }
  const validated = JsonObjectSchema.safeParse(metadata);
  if (!validated.success) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored registration carries metadata that is not JSON-safe',
    );
  }

  const sourceType = SourceTypeSchema.safeParse(storedText(row, 'source_type'));
  if (!sourceType.success) {
    throw new SQLiteStoreFailure(
      'INVALID_STORED_DATA',
      'a stored registration declares a source type this build does not know',
    );
  }

  const title = storedTitle(row, 'title_json');
  const createdAt = storedTimestamp(row, 'created_at');
  const updatedAt = storedTimestamp(row, 'updated_at');

  // Absent optional fields are rebuilt as **absent**, never as an explicit
  // `undefined`. A record claiming *there is a title, and it is nothing* is a
  // different record, and it serializes differently.
  return {
    schemaVersion: 1,
    scope: readScope(storedText(row, 'scope_json')),
    sourceType: sourceType.data,
    identity: {
      namespace: storedText(row, 'identity_namespace'),
      key: storedText(row, 'identity_key'),
    },
    locator: storedText(row, 'locator'),
    ...(title !== undefined ? { title } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    metadata: validated.data satisfies JsonObject,
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                     */
/* -------------------------------------------------------------------------- */

const SELECT_COLUMNS = `scope_json, source_type, identity_namespace, identity_key, locator,
   title_json, created_at, updated_at, metadata_json, registration_schema_version`;

const LOGICAL_KEY_PREDICATE = `scope_key = ? AND source_type = ? AND identity_namespace = ? AND identity_key = ?`;

export class SQLiteControlStore implements ControlStore, ControlStoreWriter {
  readonly id = SQLITE_CONTROL_STORE_ID;
  readonly version = SQLITE_CONTROL_STORE_VERSION;

  readonly #database: DatabaseSync;
  #closed = false;

  /**
   * Opens the configured database and brings it to the current schema.
   *
   * Both happen here rather than on first use: a misconfigured store should fail
   * at composition, not halfway through an operator's first command.
   *
   * @throws {SQLiteControlStoreError} when the configuration, the file, or the
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
      // The connection is closed before the failure escapes. Leaving it open
      // would leak a handle for every failed composition, and the caller has no
      // object to close because the constructor never returned one.
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
   * It is declared on the concrete adapter and **not** on either port. A local
   * CLI composing a control store should not have to know a database exists, and
   * a `close()` on `ControlStore` would tell every consumer that one does
   * (DEC-042). Closing twice is a no-op, so a caller need not track whether it
   * already did.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#database.close();
    } catch {
      throw new SQLiteControlStoreError(
        'READ_FAILED',
        'the local control store could not be closed',
      );
    }
  }

  /**
   * Lists the registrations of one exact scope.
   *
   * Row order is SQLite's and is deliberately not sorted here: `ControlStore`
   * promises no order, and a consumer that depends on one must impose its own
   * (INV-DET-002). Filtering is by `scope_key`, so a cross-scope record cannot
   * be returned (INV-SCOPE-004).
   */
  listSources(scope: Scope): Promise<readonly SourceRegistration[]> {
    return this.#read(() => {
      const parsed = ScopeSchema.safeParse(scope);
      if (!parsed.success) {
        throw new SQLiteStoreFailure('INVALID_INPUT', 'listSources requires a valid scope');
      }
      const rows = this.#database
        .prepare(`SELECT ${SELECT_COLUMNS} FROM ${SOURCE_REGISTRATION_TABLE} WHERE scope_key = ?`)
        .all(scopeKey(parsed.data));

      return rows.map((row) => {
        const registration = toRegistration(row);
        // A row selected by `scope_key` whose stored scope disagrees with the
        // request is a corrupted row, not a cross-scope answer. It is refused
        // rather than returned: the two columns are meant to describe one scope.
        if (!scopesEqual(registration.scope, parsed.data)) {
          throw new SQLiteStoreFailure(
            'INVALID_STORED_DATA',
            'a stored registration carries a scope that disagrees with its scope key',
          );
        }
        return registration;
      });
    });
  }

  /**
   * Inserts one registration, failing when its logical identity already exists.
   *
   * The existence check and the insert run in one immediate transaction, so no
   * other connection can insert the same identity between them.
   *
   * A conflict is raised even when every field is identical. The caller asked to
   * **create** something that is already there, and answering "done" would
   * report a creation that did not happen (DEC-042).
   */
  registerSource(registration: SourceRegistration): Promise<void> {
    return this.#write(() => {
      const row = toRow(registration);
      inTransaction(this.#database, () => {
        if (this.#exists(row.scopeKey, row.sourceType, row.namespace, row.key)) {
          throw new SQLiteStoreFailure(
            'SOURCE_CONFLICT',
            'a registration with this logical identity already exists in this scope',
          );
        }
        this.#database
          .prepare(
            `INSERT INTO ${SOURCE_REGISTRATION_TABLE}
               (scope_key, scope_json, source_type, identity_namespace, identity_key,
                locator, title_json, created_at, updated_at, metadata_json, registration_schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.scopeKey,
            row.scopeJson,
            row.sourceType,
            row.namespace,
            row.key,
            row.locator,
            row.titleJson,
            row.createdAt,
            row.updatedAt,
            row.metadataJson,
            row.registrationSchemaVersion,
          );
      });
    });
  }

  /**
   * Updates the mutable fields of one existing registration.
   *
   * The logical key is the `WHERE` clause and never a `SET` target, so an update
   * cannot rename what a source *is*: changing an identity means removing one
   * registration and creating another (INV-BLOCK-001).
   *
   * Zero affected rows is `SOURCE_NOT_FOUND`, never a silent insert. The whole
   * statement runs in one transaction, so a failure leaves the previous row
   * exactly as it was (INV-STORE-003).
   */
  updateSource(registration: SourceRegistration): Promise<void> {
    return this.#write(() => {
      const row = toRow(registration);
      inTransaction(this.#database, () => {
        const result = this.#database
          .prepare(
            `UPDATE ${SOURCE_REGISTRATION_TABLE}
                SET scope_json = ?, locator = ?, title_json = ?, created_at = ?, updated_at = ?,
                    metadata_json = ?, registration_schema_version = ?
              WHERE ${LOGICAL_KEY_PREDICATE}`,
          )
          .run(
            row.scopeJson,
            row.locator,
            row.titleJson,
            row.createdAt,
            row.updatedAt,
            row.metadataJson,
            row.registrationSchemaVersion,
            row.scopeKey,
            row.sourceType,
            row.namespace,
            row.key,
          );
        if (changeCount(result) === 0) {
          throw new SQLiteStoreFailure(
            'SOURCE_NOT_FOUND',
            'no registration with this logical identity exists in this scope',
          );
        }
      });
    });
  }

  /**
   * Removes the registration with one exact logical key.
   *
   * It resolves `true` when a row existed and was removed and `false` when none
   * did. Absence is an answer, not a failure, and every implementation of the
   * port answers it the same way (INV-ADAPTER-005).
   *
   * The scope is part of the key, so a removal cannot reach another scope's row.
   */
  removeSource(key: SourceRegistrationKey): Promise<boolean> {
    return this.#write(() => {
      const identity = readIdentity(key);
      const result = this.#database
        .prepare(`DELETE FROM ${SOURCE_REGISTRATION_TABLE} WHERE ${LOGICAL_KEY_PREDICATE}`)
        .run(scopeKey(identity.scope), identity.sourceType, identity.namespace, identity.key);
      return changeCount(result) > 0;
    });
  }

  #exists(scope: string, sourceType: string, namespace: string, key: string): boolean {
    const row: unknown = this.#database
      .prepare(
        `SELECT 1 AS present FROM ${SOURCE_REGISTRATION_TABLE} WHERE ${LOGICAL_KEY_PREDICATE}`,
      )
      .get(scope, sourceType, namespace, key);
    return row !== undefined && row !== null;
  }

  /** Runs one read, translating every failure into this adapter's own error. */
  #read<T>(body: () => T): Promise<T> {
    try {
      return Promise.resolve(body());
    } catch (cause) {
      return Promise.reject(translate(cause, 'READ_FAILED'));
    }
  }

  /** Runs one write, translating every failure into this adapter's own error. */
  #write<T>(body: () => T): Promise<T> {
    try {
      return Promise.resolve(body());
    } catch (cause) {
      return Promise.reject(translate(cause, 'WRITE_FAILED'));
    }
  }
}

/**
 * Turns any thrown value into a `SQLiteControlStoreError`.
 *
 * A precise internal failure keeps its code. Everything else — a driver error, a
 * closed handle, a disk failure — becomes `fallback` with a fixed message,
 * because the thrown value's own wording is the driver's and may name the
 * database file, the SQL, or the row (INV-SEC-001).
 */
const CONTROL_STORE_CODES: readonly SQLiteControlStoreErrorCode[] = [
  'INVALID_CONFIG',
  'INVALID_INPUT',
  'OPEN_FAILED',
  'MIGRATION_FAILED',
  'UNSUPPORTED_SCHEMA_VERSION',
  'WRITE_FAILED',
  'READ_FAILED',
  'SOURCE_CONFLICT',
  'SOURCE_NOT_FOUND',
  'INVALID_STORED_DATA',
];

function translate(cause: unknown, fallback: SQLiteControlStoreErrorCode): SQLiteControlStoreError {
  if (cause instanceof SQLiteStoreFailure) {
    // The internal carrier's code union spans both stores, so it is narrowed to
    // this adapter's published vocabulary rather than widened by assertion. A
    // code this store cannot produce would be a public code its type says does
    // not exist.
    const code = CONTROL_STORE_CODES.find((known) => known === cause.failureCode);
    if (code !== undefined) return new SQLiteControlStoreError(code, cause.message);
  }
  return new SQLiteControlStoreError(
    fallback,
    fallback === 'WRITE_FAILED'
      ? 'the local control store could not complete the write'
      : 'the local control store could not complete the read',
  );
}

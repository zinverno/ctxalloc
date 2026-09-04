import { ScopeSchema, safeParse, type Scope, type ValidationIssue } from '@ctxalloc/domain';
import type {
  ControlStore,
  ControlStoreWriter,
  SourceRegistration,
  SourceRegistrationKey,
} from '@ctxalloc/ports';
import { z } from 'zod';
import { issue } from './chunking-primitives.js';
import { validatePort } from './local-source-pipeline.js';
import {
  compareSourceRegistrations,
  parseSourceRegistration,
  parseSourceRegistrationKey,
} from './source-registration.js';

/**
 * The control-plane management use case (DEC-042).
 *
 * It is the one place that turns *an operator asked to register this source*
 * into a store write. It owns registration validation, scope and key semantics,
 * canonical listing order, and the translation of a storage failure into a
 * project-owned one.
 *
 * It owns nothing else. It reads no source file, chunks nothing, retrieves
 * nothing, and compiles nothing: those are `PrepareLocalCorpusService` and
 * `CompileLocalContextService`, and a registry that could reach them would let a
 * control-plane edit trigger a compilation (INV-DEP-003).
 *
 * ## Why a store failure never escapes
 *
 * A `ControlStoreWriter` may be backed by SQLite, and a SQLite error routinely
 * carries the SQL text, the database path, and the driver's own wording. None of
 * that is the caller's, and a CLI that printed it would disclose an operator's
 * filesystem layout in an ordinary error message (INV-SEC-001).
 *
 * So the thrown value is inspected for exactly one thing: a **stable
 * project-owned code** naming a conflict or a missing record. Those two are
 * genuine answers to the caller's question — *did this already exist?*, *was
 * there anything to update?* — and INV-ADAPTER-003 requires them to stay
 * distinguishable from *the store failed*. Every other failure becomes one
 * generic issue. No message, no `cause`, no stack, and no other field is ever
 * read.
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link LocalSourceRegistryRequest} (INV-STORE-004). */
export const LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION = 1;

/**
 * One control-plane operation.
 *
 * The union is discriminated on `operation`, and each variant carries exactly
 * the input that operation needs. A single request record with four optional
 * fields would let a caller send a key to `register` and a registration to
 * `remove`, and the service would have to decide what that meant.
 *
 * `register` and `update` both take a whole registration because both write
 * every mutable field; `remove` takes a key because a locator takes no part in
 * identifying what to delete; `list` takes a scope because listing is a read of
 * one exact boundary (DEC-042).
 */
export type LocalSourceRegistryRequest =
  | {
      readonly schemaVersion: typeof LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION;
      readonly operation: 'register';
      readonly registration: SourceRegistration;
    }
  | {
      readonly schemaVersion: typeof LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION;
      readonly operation: 'update';
      readonly registration: SourceRegistration;
    }
  | {
      readonly schemaVersion: typeof LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION;
      readonly operation: 'remove';
      readonly key: SourceRegistrationKey;
    }
  | {
      readonly schemaVersion: typeof LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION;
      readonly operation: 'list';
      readonly scope: Scope;
    };

/**
 * The outcome of one control-plane operation.
 *
 * `register` and `update` publish a literal `true` rather than nothing: the
 * caller asked for a state change, and a result that said only *no error* would
 * make a future partial success indistinguishable from this one.
 *
 * `remove` publishes a boolean because absence is an answer, not a failure.
 */
export type LocalSourceRegistryResult =
  | { readonly operation: 'register'; readonly registered: true }
  | { readonly operation: 'update'; readonly updated: true }
  | { readonly operation: 'remove'; readonly removed: boolean }
  | { readonly operation: 'list'; readonly registrations: readonly SourceRegistration[] };

/** Machine-readable categories of a control-plane failure (INV-TRACE-002). */
export type LocalSourceRegistryIssueCode =
  | 'invalid_request'
  | 'invalid_registration'
  | 'invalid_key'
  | 'invalid_scope'
  | 'source_conflict'
  | 'source_not_found'
  | 'control_store_unavailable'
  | 'invalid_stored_data';

/**
 * The single error this service raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * database message, SQL text, path, driver error, or validation-library error
 * escapes through it (INV-ADAPTER-001, INV-SEC-001).
 */
export class LocalSourceRegistryError extends Error {
  readonly code = 'LOCAL_SOURCE_REGISTRY_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Local source registry operation failed: ${summary}`);
    this.name = 'LocalSourceRegistryError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Request validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The outer request shape only.
 *
 * The payload of each variant is accepted as an object here and validated by the
 * module that owns its rules, so registration validation has exactly one
 * implementation (INV-DEP-003).
 */
const RequestShapeSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    schemaVersion: z.literal(LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION),
    operation: z.literal('register'),
    registration: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION),
    operation: z.literal('update'),
    registration: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION),
    operation: z.literal('remove'),
    key: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(LOCAL_SOURCE_REGISTRY_REQUEST_SCHEMA_VERSION),
    operation: z.literal('list'),
    scope: z.unknown(),
  }),
]);

/* -------------------------------------------------------------------------- */
/* Dependency failure translation                                              */
/* -------------------------------------------------------------------------- */

/**
 * The exact codes a store implementation publishes for the two answerable
 * outcomes.
 *
 * They are matched by identity against this closed set. A dependency that
 * invented its own spelling gets the generic failure, which is the safe
 * direction: reporting *the store failed* for a conflict is a worse answer than
 * a conflict, but reporting a conflict because a hostile value said so would let
 * a dependency choose this service's verdict (INV-SEC-001).
 */
const SOURCE_CONFLICT_CODE = 'SOURCE_CONFLICT';
const SOURCE_NOT_FOUND_CODE = 'SOURCE_NOT_FOUND';
const INVALID_STORED_DATA_CODE = 'INVALID_STORED_DATA';

/** Reads one own string data property without invoking an accessor. */
function ownCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');
  if (descriptor === undefined || !('value' in descriptor)) return null;
  return typeof descriptor.value === 'string' ? descriptor.value : null;
}

function dependencyIssue(cause: unknown, path: readonly string[]): ValidationIssue {
  switch (ownCode(cause)) {
    case SOURCE_CONFLICT_CODE:
      return issue(
        path,
        'a registration with this logical identity already exists in this scope',
        'source_conflict' satisfies LocalSourceRegistryIssueCode,
      );
    case SOURCE_NOT_FOUND_CODE:
      return issue(
        path,
        'no registration with this logical identity exists in this scope',
        'source_not_found' satisfies LocalSourceRegistryIssueCode,
      );
    case INVALID_STORED_DATA_CODE:
      return issue(
        path,
        'the control store holds a record this build cannot read',
        'invalid_stored_data' satisfies LocalSourceRegistryIssueCode,
      );
    default:
      return issue(
        path,
        'the control store is unavailable',
        'control_store_unavailable' satisfies LocalSourceRegistryIssueCode,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/** Registers, updates, removes, and lists the sources of one scope. */
export class LocalSourceRegistryService {
  readonly #controlStore: ControlStore;
  readonly #writer: ControlStoreWriter;

  /**
   * @throws {LocalSourceRegistryError} when a dependency is not a usable port.
   */
  constructor(controlStore: ControlStore, writer: ControlStoreWriter) {
    const issues = [
      ...validatePort('controlStore', controlStore, 'listSources'),
      ...validatePort('controlStoreWriter', writer, 'registerSource'),
      ...validatePort('controlStoreWriter', writer, 'updateSource'),
      ...validatePort('controlStoreWriter', writer, 'removeSource'),
    ];
    if (issues.length > 0) throw new LocalSourceRegistryError(issues);

    this.#controlStore = controlStore;
    this.#writer = writer;
  }

  /**
   * Runs one control-plane operation.
   *
   * @throws {LocalSourceRegistryError} for every failure.
   */
  async execute(input: unknown): Promise<LocalSourceRegistryResult> {
    const shape = safeParse(RequestShapeSchema, input);
    if (!shape.ok) {
      throw new LocalSourceRegistryError(
        shape.issues.map((detail) => ({
          ...detail,
          code: 'invalid_request' satisfies LocalSourceRegistryIssueCode,
        })),
      );
    }

    switch (shape.value.operation) {
      case 'register':
        return this.#register(this.#registration(shape.value.registration));
      case 'update':
        return this.#update(this.#registration(shape.value.registration));
      case 'remove':
        return this.#remove(this.#key(shape.value.key));
      case 'list':
        return this.#list(this.#scope(shape.value.scope));
    }
  }

  #registration(input: unknown): SourceRegistration {
    const parsed = parseSourceRegistration(input);
    if (!parsed.ok) {
      throw new LocalSourceRegistryError(
        parsed.issues.map((detail) => {
          const path = ['registration', ...detail.path];
          return {
            code: 'invalid_registration' satisfies LocalSourceRegistryIssueCode,
            path,
            pointer: path.join('.'),
            message: detail.message,
          };
        }),
      );
    }
    return parsed.value;
  }

  #key(input: unknown): SourceRegistrationKey {
    const parsed = parseSourceRegistrationKey(input);
    if (!parsed.ok) {
      throw new LocalSourceRegistryError(
        parsed.issues.map((detail) => {
          const path = ['key', ...detail.path];
          return {
            code: 'invalid_key' satisfies LocalSourceRegistryIssueCode,
            path,
            pointer: path.join('.'),
            message: detail.message,
          };
        }),
      );
    }
    return parsed.value;
  }

  #scope(input: unknown): Scope {
    const parsed = safeParse(ScopeSchema, input);
    if (!parsed.ok) {
      throw new LocalSourceRegistryError(
        parsed.issues.map((detail) => {
          const path = ['scope', ...detail.path];
          return {
            code: 'invalid_scope' satisfies LocalSourceRegistryIssueCode,
            path,
            pointer: path.join('.'),
            message: detail.message,
          };
        }),
      );
    }
    return parsed.value;
  }

  async #register(registration: SourceRegistration): Promise<LocalSourceRegistryResult> {
    try {
      await this.#writer.registerSource(registration);
    } catch (cause) {
      throw new LocalSourceRegistryError([dependencyIssue(cause, ['registration'])]);
    }
    return { operation: 'register', registered: true };
  }

  async #update(registration: SourceRegistration): Promise<LocalSourceRegistryResult> {
    try {
      await this.#writer.updateSource(registration);
    } catch (cause) {
      throw new LocalSourceRegistryError([dependencyIssue(cause, ['registration'])]);
    }
    return { operation: 'update', updated: true };
  }

  async #remove(key: SourceRegistrationKey): Promise<LocalSourceRegistryResult> {
    let removed: unknown;
    try {
      removed = await this.#writer.removeSource(key);
    } catch (cause) {
      throw new LocalSourceRegistryError([dependencyIssue(cause, ['key'])]);
    }
    if (typeof removed !== 'boolean') {
      throw new LocalSourceRegistryError([
        issue(
          ['key'],
          'removeSource must resolve to a boolean',
          'control_store_unavailable' satisfies LocalSourceRegistryIssueCode,
        ),
      ]);
    }
    return { operation: 'remove', removed };
  }

  /**
   * Lists one scope in canonical registration order.
   *
   * The store's own order is discarded. A `ControlStore` explicitly does not
   * promise one, and a listing that inherited SQLite's row order would change
   * when a row was rewritten (INV-DET-002). The comparator is the same one the
   * preparation flow uses, so what an operator lists and what a compilation
   * reads agree (INV-DEP-003).
   *
   * Every listed record is re-validated. It came from a store, so it is external
   * data however it got there, and a corrupt row must be a named failure rather
   * than a half-formed record handed to a caller (INV-BLOCK-005).
   */
  async #list(scope: Scope): Promise<LocalSourceRegistryResult> {
    let listed: unknown;
    try {
      listed = await this.#controlStore.listSources(scope);
    } catch (cause) {
      throw new LocalSourceRegistryError([dependencyIssue(cause, ['scope'])]);
    }
    if (!Array.isArray(listed)) {
      throw new LocalSourceRegistryError([
        issue(
          ['scope'],
          'listSources must resolve to an array',
          'control_store_unavailable' satisfies LocalSourceRegistryIssueCode,
        ),
      ]);
    }

    const issues: ValidationIssue[] = [];
    const registrations: SourceRegistration[] = [];
    listed.forEach((entry, index) => {
      const parsed = parseSourceRegistration(entry);
      if (!parsed.ok) {
        for (const detail of parsed.issues) {
          const path = [String(index), ...detail.path];
          issues.push({
            code: 'invalid_stored_data' satisfies LocalSourceRegistryIssueCode,
            path,
            pointer: path.join('.'),
            message: detail.message,
          });
        }
        return;
      }
      registrations.push(parsed.value);
    });
    if (issues.length > 0) throw new LocalSourceRegistryError(issues);

    return {
      operation: 'list',
      registrations: [...registrations].sort(compareSourceRegistrations),
    };
  }
}

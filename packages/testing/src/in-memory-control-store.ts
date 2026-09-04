import { scopesEqual, type JsonObject, type JsonValue, type Scope } from '@ctxalloc/domain';
import type {
  ControlStore,
  ControlStoreWriter,
  SourceRegistration,
  SourceRegistrationKey,
} from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link ControlStore} port.
 *
 * The fake stores exactly the registrations it was given and returns exactly the
 * ones whose scope equals the requested scope. There is no inheritance between
 * scopes, no wildcard, no default tenant, and no fallback: a store that answered
 * for a boundary the caller did not ask about would hide the very cross-scope
 * leak these tests exist to catch (INV-SCOPE-004).
 *
 * Listing order is the configured order, and a write never reorders it. That is
 * deliberate rather than canonical: a consumer must impose its own order, and a
 * fake that sorted for it would conceal the bug where it does not
 * (INV-DET-002).
 *
 * It implements the write port too (DEC-042), with exactly the semantics
 * `SQLiteControlStore` has: `registerSource` is insert-only and conflicts on an
 * existing logical key even when every field matches, `updateSource` requires an
 * existing key and never creates, and `removeSource` answers `true` or `false`
 * rather than failing on absence. One shared contract suite runs against this
 * fake and against SQLite, so a test written on the double is a test of the
 * behavior the product ships (INV-ADAPTER-005).
 *
 * Writes clone on the way in and reads clone on the way out, so a caller that
 * mutates a registration it registered — or one it listed — cannot change what a
 * later listing reports.
 *
 * It reads no file, database, environment variable, clock, or random value
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'in-memory-control-store';
const DEFAULT_VERSION = '1';

/** Optional store identity, used when a test asserts on a reported identity. */
export interface InMemoryControlStoreOptions {
  readonly id?: string;
  readonly version?: string;
}

/**
 * Machine-readable categories of an in-memory control-plane write failure.
 *
 * The two codes are the **exact strings** `SQLiteControlStore` publishes, and
 * that is the point: the application layer distinguishes a conflict from a
 * missing record by a stable project-owned code, so a double that spelled them
 * differently would let a test pass against behavior no real store produces
 * (INV-ADAPTER-003, INV-ADAPTER-005).
 */
export type InMemoryControlStoreWriteErrorCode = 'SOURCE_CONFLICT' | 'SOURCE_NOT_FOUND';

/** A rejected in-memory control-plane write. */
export class InMemoryControlStoreWriteError extends Error {
  readonly code: InMemoryControlStoreWriteErrorCode;

  constructor(code: InMemoryControlStoreWriteErrorCode, message: string) {
    super(message);
    this.name = 'InMemoryControlStoreWriteError';
    this.code = code;
  }
}

/** Rejected {@link InMemoryControlStore} configuration. */
export class InMemoryControlStoreConfigurationError extends Error {
  readonly code = 'IN_MEMORY_CONTROL_STORE_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'InMemoryControlStoreConfigurationError';
  }
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new InMemoryControlStoreConfigurationError(
      `InMemoryControlStore ${field} must not be empty or whitespace-only.`,
    );
  }
  return value;
}

/** Deep copy of JSON data, so no caller-owned object is shared between listings. */
function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === 'object' && value !== null) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry);
    return result;
  }
  return value;
}

/**
 * Copies one registration field by field.
 *
 * Copying on the way in and on the way out is what makes the fake safe to reuse:
 * a consumer that mutated a returned registration could otherwise change what a
 * later listing reports, and a test would then pass for the wrong reason.
 */
function copyRegistration(registration: SourceRegistration): SourceRegistration {
  return {
    schemaVersion: registration.schemaVersion,
    scope: { ...registration.scope },
    sourceType: registration.sourceType,
    identity: { namespace: registration.identity.namespace, key: registration.identity.key },
    locator: registration.locator,
    ...(registration.title !== undefined ? { title: registration.title } : {}),
    ...(registration.createdAt !== undefined ? { createdAt: registration.createdAt } : {}),
    ...(registration.updatedAt !== undefined ? { updatedAt: registration.updatedAt } : {}),
    metadata: cloneJson(registration.metadata) as JsonObject,
  };
}

/**
 * The logical identity of one registration, as a comparable string.
 *
 * An absent `projectId` is written as `null` rather than omitted, so an absent
 * and a present project stay distinguishable: a representation where absence
 * disappeared would let one scope's key collide with another's
 * (INV-SCOPE-004). The application layer computes the same key from the same
 * fields; it is spelled again here because a test double may not depend on the
 * layer it is used to test.
 */
function logicalKey(entry: SourceRegistration | SourceRegistrationKey): string {
  return JSON.stringify([
    entry.scope.tenantId,
    entry.scope.workspaceId,
    entry.scope.projectId ?? null,
    entry.sourceType,
    entry.identity.namespace,
    entry.identity.key,
  ]);
}

export class InMemoryControlStore implements ControlStore, ControlStoreWriter {
  readonly id: string;
  readonly version: string;

  /**
   * Stored in configured order, so a listing reports what a store yielded rather
   * than an order this fake chose. Writes address entries by logical key.
   */
  #registrations: SourceRegistration[];

  /**
   * The initial registrations are stored **exactly** as configured, duplicates
   * included.
   *
   * A real store cannot hold two records of one logical source — its primary key
   * forbids it — but a *consumer* must still reject a control plane that
   * contradicts itself, and the only way to test that branch is with a store
   * that can produce the contradiction. Rejecting it here would delete the test
   * rather than the bug (INV-ADAPTER-004).
   *
   * The write API is not so permissive: `registerSource` conflicts on an
   * existing logical key exactly as `SQLiteControlStore` does. Construction
   * seeds a fixture; writing is the behaviour under contract.
   */
  constructor(
    registrations: readonly SourceRegistration[],
    options: InMemoryControlStoreOptions = {},
  ) {
    this.id = requireNonBlank(options.id ?? DEFAULT_ID, 'id');
    this.version = requireNonBlank(options.version ?? DEFAULT_VERSION, 'version');
    this.#registrations = registrations.map(copyRegistration);
  }

  listSources(scope: Scope): Promise<readonly SourceRegistration[]> {
    return Promise.resolve(
      this.#registrations
        .filter((registration) => scopesEqual(registration.scope, scope))
        .map(copyRegistration),
    );
  }

  registerSource(registration: SourceRegistration): Promise<void> {
    if (this.#indexOf(logicalKey(registration)) !== -1) {
      return Promise.reject(
        new InMemoryControlStoreWriteError(
          'SOURCE_CONFLICT',
          'A registration with this logical identity already exists in this scope.',
        ),
      );
    }
    this.#registrations.push(copyRegistration(registration));
    return Promise.resolve();
  }

  updateSource(registration: SourceRegistration): Promise<void> {
    const index = this.#indexOf(logicalKey(registration));
    if (index === -1) {
      return Promise.reject(
        new InMemoryControlStoreWriteError(
          'SOURCE_NOT_FOUND',
          'No registration with this logical identity exists in this scope.',
        ),
      );
    }
    // Replaced in place, so an update never moves a record in a listing: an
    // order that changed on write would hide a consumer that depends on one.
    this.#registrations[index] = copyRegistration(registration);
    return Promise.resolve();
  }

  removeSource(key: SourceRegistrationKey): Promise<boolean> {
    const index = this.#indexOf(logicalKey(key));
    if (index === -1) return Promise.resolve(false);
    this.#registrations.splice(index, 1);
    return Promise.resolve(true);
  }

  /** The position of the record with one logical key, or `-1`. */
  #indexOf(key: string): number {
    return this.#registrations.findIndex((registration) => logicalKey(registration) === key);
  }
}

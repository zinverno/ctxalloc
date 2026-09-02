import { scopesEqual, type JsonObject, type JsonValue, type Scope } from '@ctxalloc/domain';
import type { ControlStore, SourceRegistration } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link ControlStore} port.
 *
 * The fake stores exactly the registrations it was given and returns exactly the
 * ones whose scope equals the requested scope. There is no inheritance between
 * scopes, no wildcard, no default tenant, and no fallback: a store that answered
 * for a boundary the caller did not ask about would hide the very cross-scope
 * leak these tests exist to catch (INV-SCOPE-004).
 *
 * Listing order is the configured order. That is deliberate rather than
 * canonical: a consumer must impose its own order, and a fake that sorted for it
 * would conceal the bug where it does not (INV-DET-002).
 *
 * There is no write API. The port is read-only in this phase, and a fake with
 * methods the contract does not define would let a test depend on a capability
 * no real store has (INV-ADAPTER-005).
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

export class InMemoryControlStore implements ControlStore {
  readonly id: string;
  readonly version: string;

  readonly #registrations: readonly SourceRegistration[];

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
}

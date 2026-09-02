import type { JsonObject, Scope, SourceType, Timestamp } from '@ctxalloc/domain';

/**
 * Control-plane port.
 *
 * The control plane answers *which sources exist in this scope*. It is the
 * authority for logical source identity; the reader is only the authority for
 * bytes. Keeping the two apart is what makes a machine path an implementation
 * detail rather than an identity (DEC-028, INV-ADAPTER-002).
 *
 * The contract is read-only in this phase. Registering, updating, and removing
 * sources is control-plane *writing*, which needs its own persistence decision
 * and its own failure semantics; declaring the write methods before anything can
 * honor them would publish a contract with no implementation (INV-ADAPTER-003).
 *
 * Only project-owned domain types appear here. No database client, no row type,
 * no ORM entity, and no configuration-file shape reaches a consumer
 * (INV-ADAPTER-001).
 */

/**
 * One registered local source.
 *
 * The record separates the two things a file-shaped world habitually conflates:
 *
 * * `identity` is **logical** — the namespace the operator owns plus one stable
 *   key inside it. Together with `scope` and `sourceType` it determines the
 *   derived `SourceDocument.id` (DEC-028).
 * * `locator` is **physical** — the string one adapter uses to find bytes today.
 *
 * The version is written as the literal `1` rather than a named constant: this
 * package stays free of runtime exports, so the constant and the schema that
 * enforces it are owned by the application layer that validates the record.
 *
 * Changing a locator therefore moves a source; it does not create a second one.
 * Changing an identity component creates a different logical source, which is
 * exactly the visible consequence an operator should get for renaming what a
 * source *is* (INV-BLOCK-001).
 *
 * `metadata` is ordinary untrusted source metadata. It may carry a path, a vault
 * identifier, or a provider identifier, and none of it may become compiler
 * policy or replace a project-owned identifier (INV-SEC-001, INV-ADAPTER-002).
 */
export interface SourceRegistration {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly sourceType: SourceType;

  readonly identity: {
    readonly namespace: string;
    readonly key: string;
  };

  readonly locator: string;

  readonly title?: string;
  readonly createdAt?: Timestamp;
  readonly updatedAt?: Timestamp;
  readonly metadata: JsonObject;
}

/**
 * Lists the sources registered for one exact scope.
 *
 * The scope is an argument rather than adapter configuration, so a store cannot
 * quietly answer for a boundary the caller did not ask about (INV-SCOPE-005).
 * An implementation must return registrations of that exact scope only;
 * filtering cross-scope records is not the consumer's job to repeat
 * (INV-SCOPE-004).
 *
 * Listing order is not a contract. A store may return rows in whatever order its
 * storage yields, and a consumer that depends on the compiled result must impose
 * its own canonical order rather than inherit one (INV-DET-002).
 *
 * An empty list means *this scope has no registered sources*. It must never mean
 * *the store failed*: an unavailable store fails explicitly (INV-ADAPTER-003).
 */
export interface ControlStore {
  /** Stable identifier of the control-store implementation. */
  readonly id: string;

  /** Stable version of the control-store implementation. */
  readonly version: string;

  listSources(scope: Scope): Promise<readonly SourceRegistration[]>;
}

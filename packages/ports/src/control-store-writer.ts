import type { Scope, SourceType } from '@ctxalloc/domain';
import type { SourceRegistration } from './control-store.js';

/**
 * Control-plane **write** port.
 *
 * Reading and writing the control plane are separate capabilities, and they are
 * separate interfaces. `ControlStore` answers *which sources exist in this
 * scope*, and every consumer of the compilation path needs that. Almost none of
 * them needs to create, move, or retire a registration, and a single combined
 * interface would hand every one of them the ability to do so (INV-DEP-003).
 *
 * Only project-owned domain types appear here. No database client, no row type,
 * no ORM entity, no transaction handle, and no configuration-file shape reaches
 * a consumer (INV-ADAPTER-001).
 *
 * There is deliberately no `close`, `connect`, `begin`, or `flush`. Those are
 * facts about one storage technology, and a port that named them would make
 * every consumer aware that a database exists; a concrete adapter that needs a
 * lifecycle exposes it on itself (DEC-042).
 */

/**
 * The exact logical identity of one registration.
 *
 * It is the whole of what makes a registration *that* registration and none of
 * what makes it current: no locator, no title, no timestamp, and no metadata.
 * Those are the mutable facts `updateSource` may change, and putting one of them
 * in the key would mean a source stopped being itself when it moved (DEC-028).
 *
 * `scope` is exact. An absent `projectId` and a present one describe two
 * different boundaries, and a key that matched across them would let one scope's
 * write reach another's record (INV-SCOPE-004).
 */
export interface SourceRegistrationKey {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly sourceType: SourceType;

  readonly identity: {
    readonly namespace: string;
    readonly key: string;
  };
}

/**
 * Creates, updates, and removes control-plane registrations.
 *
 * The three operations are distinct on purpose. An `upsert` would answer *the
 * store now holds this* while leaving *did I create it or replace something?*
 * unanswerable, and that is precisely the question an operator who mistyped an
 * identity needs answered (INV-ADAPTER-003).
 *
 * `registerSource` is **insert-only**. A registration whose logical key already
 * exists is a conflict, and it stays a conflict even when every field is
 * identical: the caller asked to create something that is already there, and
 * silently succeeding would report a creation that did not happen.
 *
 * `updateSource` changes the mutable fields — locator, title, timestamps,
 * metadata — of the record with that exact logical key. A missing key is an
 * explicit not-found failure, never a create. The logical key itself never
 * changes: renaming an identity means removing one registration and creating
 * another, which is the visible consequence renaming what a source *is* should
 * have (INV-BLOCK-001).
 *
 * `removeSource` removes the record with that exact logical key. It resolves
 * `true` when one existed and was removed, and `false` when none did. Absence is
 * not a failure: it is the answer to *is this gone?*, and every implementation
 * answers it the same way (INV-ADAPTER-005).
 *
 * A failure of the underlying store is explicit and project-owned. An
 * implementation must never report success for a write it did not complete, and
 * must never publish a partially applied one (INV-ADAPTER-003, INV-STORE-003).
 */
export interface ControlStoreWriter {
  /** Stable identifier of the control-store-writer implementation. */
  readonly id: string;

  /** Stable version of the control-store-writer implementation. */
  readonly version: string;

  registerSource(registration: SourceRegistration): Promise<void>;
  updateSource(registration: SourceRegistration): Promise<void>;
  removeSource(key: SourceRegistrationKey): Promise<boolean>;
}

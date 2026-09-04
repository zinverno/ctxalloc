import { LocalSourceRegistryService } from '@ctxalloc/application';
import { SQLiteControlStore } from '@ctxalloc/adapters';
import { storeConfig, type CliConfig } from '../config.js';
import { toCliError } from '../failures.js';

/**
 * The `ctxalloc source` commands (DEC-042).
 *
 * All four compose the same two objects: one `SQLiteControlStore`, handed to
 * `LocalSourceRegistryService` as both the read port and the write port. The CLI
 * is a composition root and nothing more — every rule about what a registration
 * is, which key identifies it, and what order a listing comes back in lives in
 * the application layer, where the future HTTP API will find it (INV-DEP-003).
 *
 * The store is closed in a `finally`, so a failed command leaves no open handle
 * and no journal file behind.
 *
 * ## Output
 *
 * Success output is small and machine-readable. `add` and `update` report that
 * the write happened and nothing else: echoing the registration back would
 * reprint an operator's filesystem layout and metadata to a terminal that may be
 * logged, and the caller already has the file they passed in (INV-SEC-001).
 *
 * `list` does return whole registrations, because listing them **is** the
 * request.
 */

/** The result envelope of one `ctxalloc source` command. */
export type SourceCommandOutput =
  | { readonly schemaVersion: 1; readonly operation: 'register'; readonly registered: true }
  | { readonly schemaVersion: 1; readonly operation: 'update'; readonly updated: true }
  | { readonly schemaVersion: 1; readonly operation: 'remove'; readonly removed: boolean }
  | {
      readonly schemaVersion: 1;
      readonly operation: 'list';
      readonly registrations: readonly unknown[];
    };

/** One already-parsed `ctxalloc source` request, as the application layer takes it. */
export type SourceCommandRequest =
  | { readonly operation: 'register'; readonly registration: unknown }
  | { readonly operation: 'update'; readonly registration: unknown }
  | { readonly operation: 'remove'; readonly key: unknown }
  | { readonly operation: 'list'; readonly scope: unknown };

/**
 * Runs one control-plane command against the configured database.
 *
 * @throws {CliError} for every failure, with the stage the caller can act on.
 */
export async function runSourceCommand(
  config: CliConfig,
  request: SourceCommandRequest,
): Promise<SourceCommandOutput> {
  let store: SQLiteControlStore;
  try {
    store = new SQLiteControlStore(storeConfig(config));
  } catch (cause) {
    throw toCliError(cause, 'source-store');
  }

  try {
    const service = new LocalSourceRegistryService(store, store);
    const result = await service.execute({ schemaVersion: 1, ...request });

    switch (result.operation) {
      case 'register':
        return { schemaVersion: 1, operation: 'register', registered: true };
      case 'update':
        return { schemaVersion: 1, operation: 'update', updated: true };
      case 'remove':
        return { schemaVersion: 1, operation: 'remove', removed: result.removed };
      case 'list':
        return { schemaVersion: 1, operation: 'list', registrations: result.registrations };
    }
  } catch (cause) {
    throw toCliError(cause, 'source-store');
  } finally {
    store.close();
  }
}

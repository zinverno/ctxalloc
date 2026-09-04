import { CompilationTracePersistenceService } from '@ctxalloc/application';
import { SQLiteTraceStore } from '@ctxalloc/adapters';
import { storeConfig, type CliConfig } from '../config.js';
import { CliError, cliIssue } from '../errors.js';
import { toCliError } from '../failures.js';

/**
 * `ctxalloc trace` (DEC-042).
 *
 * It reads one persisted settled trace and prints it exactly. It re-scores
 * nothing, re-renders nothing, and reconstructs no compiled context: the
 * compiled context was never stored, because the trace schema deliberately does
 * not carry it (DEC-037, INV-SEC-003). What comes back is the audit record, and
 * only the audit record.
 *
 * The record is validated on the way out of the store. It has been sitting in a
 * file on an operator's disk, possibly written by a different build, so
 * `JSON.parse(...) as SettledCompilationTrace` would publish whatever the row
 * happened to contain (INV-BLOCK-005). Validation is the application layer's, and
 * it also proves the envelope's scope and identifier agree with the payload's.
 *
 * ## Wrong scope discloses nothing
 *
 * A trace stored under a different scope is reported as **not found**, in the
 * same words a trace that was never stored gets. Telling the caller *that
 * identifier exists, but not here* would confirm the existence of another
 * scope's compilation, which is exactly the leak the exact-scope read exists to
 * prevent (INV-SEC-004).
 */

/**
 * Loads one persisted settled trace.
 *
 * @throws {CliError} at stage `trace-store` when there is no such trace in this
 * scope, or when the stored record is unreadable.
 */
export async function runTraceCommand(
  config: CliConfig,
  scope: unknown,
  compilationId: string,
): Promise<unknown> {
  let store: SQLiteTraceStore;
  try {
    store = new SQLiteTraceStore(storeConfig(config));
  } catch (cause) {
    throw toCliError(cause, 'trace-store');
  }

  try {
    const trace = await new CompilationTracePersistenceService(store).get(scope, compilationId);
    if (trace === null) {
      // One message for both cases. The identifier is echoed because the caller
      // typed it; nothing is said about any other scope (INV-SEC-004).
      throw new CliError('trace-store', [
        cliIssue(
          'trace_not_found',
          'id',
          'no trace with this compilation identifier is stored for this scope',
        ),
      ]);
    }
    return trace;
  } catch (cause) {
    throw toCliError(cause, 'trace-store');
  } finally {
    store.close();
  }
}

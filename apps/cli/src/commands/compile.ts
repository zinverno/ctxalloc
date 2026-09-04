import {
  CompilationTracePersistenceService,
  CompileLocalContextService,
} from '@ctxalloc/application';
import {
  MiniSearchCandidateProvider,
  NodeFileSourceReader,
  SQLiteControlStore,
  SQLiteTraceStore,
} from '@ctxalloc/adapters';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { readerConfig, storeConfig, type CliConfig } from '../config.js';
import { toCliError } from '../failures.js';

/**
 * `ctxalloc compile` (DEC-042).
 *
 * This is the whole local product in one command:
 *
 * ```text
 * SQLiteControlStore      registered sources of one scope
 *   -> NodeFileSourceReader   exact bytes for each locator
 *   -> PrepareLocalCorpusService  ingestion, chunking, canonical order
 *   -> MiniSearchCandidateProvider  lexical retrieval over that corpus
 *   -> ContextCompiler        selection, allocation, rendering, settlement
 *   -> SQLiteTraceStore       the settled trace, persisted
 * ```
 *
 * Every component is the real one. The tokenizer is `O200kBaseTokenizer`, not an
 * estimate, because token counts are correctness data and the rendered string is
 * the source of truth for the budget (INV-BUDGET-002, INV-BLOCK-003).
 *
 * ## Persistence happens after the compiler, and before the output
 *
 * The compilation runs first and completely. Persistence cannot change what was
 * compiled: a compilation is a function of its inputs, and a store that could
 * influence a selection would make the same request compile differently
 * depending on the state of a database (INV-DET-001).
 *
 * But the success envelope is written only **after** the trace is stored. The
 * alternative — print the context, then discover the write failed — hands an
 * operator a compiled context whose audit record does not exist, and no later
 * error message can take that back. A trace-store failure is therefore a failed
 * command with no output on stdout (INV-ADAPTER-004).
 *
 * ## What the output does not contain
 *
 * No prepared corpus, no candidates, no source metadata, and no raw query. The
 * corpus and the candidates are internal to the run — `inspect-blocks` is the
 * command that publishes a corpus, and it says so — and the query is the
 * caller's own text, which a success envelope has no reason to echo back into a
 * log (INV-SEC-001, INV-SEC-003).
 */

/** The result envelope of `ctxalloc compile`. */
export interface CompileOutput {
  readonly schemaVersion: 1;
  readonly compilationId: string;
  readonly compiledContext: string;
  readonly includedBlockIds: readonly string[];
  readonly usage: unknown;
  readonly traceStored: true;
}

/**
 * Compiles one local request and persists its settled trace.
 *
 * @throws {CliError} for every failure, with the stage the caller can act on.
 */
export async function runCompileCommand(
  config: CliConfig,
  request: unknown,
): Promise<CompileOutput> {
  let controlStore: SQLiteControlStore;
  let traceStore: SQLiteTraceStore;
  try {
    controlStore = new SQLiteControlStore(storeConfig(config));
  } catch (cause) {
    throw toCliError(cause, 'source-store');
  }
  try {
    // A second connection to the same file, never a shared handle: closing one
    // store must not break the other (DEC-042).
    traceStore = new SQLiteTraceStore(storeConfig(config));
  } catch (cause) {
    controlStore.close();
    throw toCliError(cause, 'trace-store');
  }

  try {
    // One tokenizer object, injected into chunking, validation, and rendering
    // alike. Two tokenizers would make the compiler's
    // `validation-and-rendering` coverage claim false of this composition
    // (DEC-038, INV-BLOCK-003).
    const service = new CompileLocalContextService(
      config.localCompile,
      new O200kBaseTokenizer(),
      new NodeFileSourceReader(readerConfig(config)),
      controlStore,
      new MiniSearchCandidateProvider(config.candidateProvider),
    );

    const result = await service.execute(request);

    await new CompilationTracePersistenceService(traceStore).store(result.compilation.trace);

    return {
      schemaVersion: 1,
      compilationId: result.compilation.compilationId,
      compiledContext: result.compilation.compiledContext,
      includedBlockIds: result.compilation.includedBlocks.map((block) => String(block.id)),
      usage: result.compilation.usage,
      traceStored: true,
    };
  } catch (cause) {
    throw toCliError(cause, 'compilation');
  } finally {
    controlStore.close();
    traceStore.close();
  }
}

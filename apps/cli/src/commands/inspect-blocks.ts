import { PrepareLocalCorpusService } from '@ctxalloc/application';
import { NodeFileSourceReader, SQLiteControlStore } from '@ctxalloc/adapters';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { readerConfig, storeConfig, type CliConfig } from '../config.js';
import { CliError, cliIssue } from '../errors.js';
import { toCliError } from '../failures.js';

/**
 * `ctxalloc inspect-blocks` (DEC-042).
 *
 * It answers one question — *what blocks does this scope actually contain?* —
 * and it answers it without compiling anything. There is no query, no budget, no
 * policy, no reference time, no retrieval provider, and no trace write, because
 * preparation consumes none of them. Fabricating a compilation to see a corpus
 * would mean the answer was shaped by the fabricated parts (DEC-042).
 *
 * It uses `PrepareLocalCorpusService` — the same service `ctxalloc compile` uses
 * for its own preparation — so what an operator inspects is what a compilation
 * would be built from, not an approximation of it (INV-DEP-003).
 *
 * ## Privacy: this command shows block content
 *
 * The output carries `ContextBlock` records **including their exact content**,
 * and that is deliberate: an operator who asks to inspect blocks is asking to
 * see them, and a chunk boundary cannot be judged from a hash.
 *
 * It is the one command that does. `compile` publishes no corpus and no source
 * metadata, and `trace` publishes the privacy-minimized trace, which carries no
 * content at all (DEC-037, INV-SEC-003). Anyone piping this command's output
 * into a log or an issue tracker is copying source text there, and the contract
 * says so rather than leaving it to be discovered.
 */

/** The result envelope of `ctxalloc inspect-blocks`. */
export interface InspectBlocksOutput {
  readonly schemaVersion: 1;
  readonly sourceDocuments: readonly unknown[];
  readonly blocks: readonly unknown[];
}

/**
 * Prepares and returns the corpus of one scope.
 *
 * The tokenizer is real: block token counts are correctness data, and a corpus
 * prepared under an estimate would not be the corpus a compilation sees
 * (INV-BLOCK-003).
 *
 * @throws {CliError} for every failure, with the stage the caller can act on.
 */
export async function runInspectBlocksCommand(
  config: CliConfig,
  scope: unknown,
): Promise<InspectBlocksOutput> {
  const localCompile = config.localCompile;
  if (typeof localCompile !== 'object' || localCompile === null) {
    throw new CliError('config', [cliIssue('invalid_config', 'localCompile', 'must be an object')]);
  }
  const chunking = localCompile as { markdownChunking?: unknown; textChunking?: unknown };

  let store: SQLiteControlStore;
  try {
    store = new SQLiteControlStore(storeConfig(config));
  } catch (cause) {
    throw toCliError(cause, 'source-store');
  }

  try {
    const service = new PrepareLocalCorpusService(
      {
        schemaVersion: 1,
        markdownChunking: chunking.markdownChunking,
        textChunking: chunking.textChunking,
      },
      new O200kBaseTokenizer(),
      new NodeFileSourceReader(readerConfig(config)),
      store,
    );

    const corpus = await service.execute({ schemaVersion: 1, scope });
    return {
      schemaVersion: 1,
      sourceDocuments: corpus.sourceDocuments,
      blocks: corpus.blocks,
    };
  } catch (cause) {
    throw toCliError(cause, 'preparation');
  } finally {
    store.close();
  }
}

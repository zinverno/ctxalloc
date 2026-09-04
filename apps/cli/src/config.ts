import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { CliError, cliIssue } from './errors.js';
import { readJsonFile } from './json-input.js';

/**
 * The CLI configuration file (DEC-042).
 *
 * ## No discovery
 *
 * Every command that needs a configuration takes `--config <path>`. There is no
 * search up the directory tree, no `~/.ctxalloc`, no `CTXALLOC_CONFIG`
 * environment variable, and no implicit `./ctxalloc.json`. An operator running
 * the same command in two directories, or with two shells' environments, gets
 * the same answer or an explicit failure — never a different database
 * (INV-DET-003).
 *
 * ## Relative paths resolve against the config file
 *
 * `databasePath` and `sourceRoot` may be written relative, and they resolve
 * against the **directory holding the config file**, never `process.cwd()`. A
 * config is a description of one project's layout, and a path that meant
 * something different depending on where a command was typed would make the
 * config a half-answer. The adapters receive absolute paths only (DEC-042).
 *
 * ## No duplicated validation
 *
 * Only the outer composition is validated here: the two paths, and the presence
 * of the two nested policies. `maxCandidates` belongs to
 * `MiniSearchCandidateProvider`, and the compiler and chunking policies belong to
 * `CompileLocalContextService` and the components beneath it. Restating their
 * rules would create a second place for one truth to drift (INV-DEP-003).
 */

/** The schema version of the CLI configuration file (INV-STORE-004). */
export const CLI_CONFIG_SCHEMA_VERSION = 1;

/**
 * One resolved configuration.
 *
 * `databasePath` and `sourceRoot` are absolute. The nested policies are carried
 * as opaque values, because the components that own them are the runtime
 * boundary for their rules.
 */
export interface CliConfig {
  readonly schemaVersion: typeof CLI_CONFIG_SCHEMA_VERSION;
  /** Absolute path of the local SQLite control and audit database. */
  readonly databasePath: string;
  /** Absolute directory every source locator is resolved inside and confined to. */
  readonly sourceRoot: string;
  /** Hard upper bound, in bytes, on one source file. */
  readonly maxSourceBytes: number;
  /** Validated by `MiniSearchCandidateProvider`. */
  readonly candidateProvider: unknown;
  /** Validated by `CompileLocalContextService` and the components beneath it. */
  readonly localCompile: unknown;
}

const relativeOrAbsolutePath = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

const ConfigShapeSchema = z.strictObject({
  schemaVersion: z.literal(CLI_CONFIG_SCHEMA_VERSION),
  databasePath: relativeOrAbsolutePath,
  sourceRoot: relativeOrAbsolutePath,
  maxSourceBytes: z.int().min(1),
  candidateProvider: z.looseObject({}),
  localCompile: z.looseObject({}),
});

/**
 * Loads, validates, and resolves the configuration named by `--config`.
 *
 * @throws {CliError} at stage `config` when the file is unreadable, is not JSON,
 * or does not describe a valid configuration.
 */
export function loadCliConfig(configPath: string): CliConfig {
  const raw = readJsonFile(configPath, 'config', 'config');

  const parsed = ConfigShapeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(
      'config',
      parsed.error.issues.map((issue) =>
        cliIssue('invalid_config', issue.path.map(String).join('.'), issue.message),
      ),
    );
  }

  // `resolve` is given the config file's own directory, so the base is a
  // property of the config rather than of the shell that invoked the command.
  const base = dirname(resolve(configPath));
  return {
    schemaVersion: CLI_CONFIG_SCHEMA_VERSION,
    databasePath: absoluteAgainst(base, parsed.data.databasePath),
    sourceRoot: absoluteAgainst(base, parsed.data.sourceRoot),
    maxSourceBytes: parsed.data.maxSourceBytes,
    candidateProvider: parsed.data.candidateProvider,
    localCompile: parsed.data.localCompile,
  };
}

/** An absolute path is kept exactly; a relative one is resolved against `base`. */
function absoluteAgainst(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/** The store configuration the SQLite adapters take. */
export function storeConfig(config: CliConfig): { schemaVersion: 1; databasePath: string } {
  return { schemaVersion: 1, databasePath: config.databasePath };
}

/** The reader configuration `NodeFileSourceReader` takes. */
export function readerConfig(config: CliConfig): {
  rootDirectory: string;
  maxBytes: number;
} {
  return { rootDirectory: config.sourceRoot, maxBytes: config.maxSourceBytes };
}

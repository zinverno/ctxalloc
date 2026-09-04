/**
 * The `ctxalloc` command-line application (DEC-042).
 *
 * `apps/cli` is the **outermost composition root**. It may depend inward on the
 * application services, the adapters, the evaluation harness, the compiler, the
 * domain, the ports, and the tokenizer; nothing may depend on it. A package that
 * imported the CLI would be importing a program's argument parsing and output
 * format, which is the one thing in the system with no reusable contract
 * (ARCHITECTURE section 2).
 *
 * The entry point exists so tests can drive the whole CLI in-process:
 * `runCli(argv, io)` takes an argument vector and a pair of sinks and returns an
 * exit code, touching neither `process.argv` nor `process.exit`. The executable
 * `bin.js` supplies the real three and nothing else.
 *
 * No driver type, no `DatabaseSync`, and no SQLite value appears in anything
 * exported here: the stores are composed inside the commands and closed there
 * (INV-ADAPTER-001).
 */

export { CLI_CONFIG_SCHEMA_VERSION, loadCliConfig, type CliConfig } from './config.js';
export {
  CLI_ERROR_CODE,
  CLI_ERROR_SCHEMA_VERSION,
  CliError,
  type CliErrorEnvelope,
  type CliIssue,
  type CliStage,
} from './errors.js';
export {
  CLI_CONTRACT_VERSION,
  CLI_NAME,
  runVersionCommand,
  type CliVersion,
} from './commands/version.js';
export { EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE, runCli, type CliIo } from './run-cli.js';

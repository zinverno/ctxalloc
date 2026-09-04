import { parseArgs } from 'node:util';
import { loadCliConfig, type CliConfig } from './config.js';
import { CliError, usageError } from './errors.js';
import { toCliError } from './failures.js';
import { readJsonFile } from './json-input.js';
import { runCompileCommand } from './commands/compile.js';
import { runEvalCommand } from './commands/evaluate.js';
import { runInspectBlocksCommand } from './commands/inspect-blocks.js';
import { runSourceCommand } from './commands/source.js';
import { runTraceCommand } from './commands/trace.js';
import { runVersionCommand } from './commands/version.js';

/**
 * The `ctxalloc` command line (DEC-042).
 *
 * ## A composition root, not a second implementation
 *
 * Every command here parses arguments, reads files, composes the real adapters
 * and the real application services, and serializes the result. It contains no
 * selection logic, no budget arithmetic, no chunking, no retrieval, and no
 * validation rule that a component already owns. `apps/cli` is the outermost
 * layer: it may depend inward on everything, and nothing may depend on it
 * (ARCHITECTURE section 2).
 *
 * ## Testable without spawning
 *
 * `runCli` takes an argument vector and an IO object and returns an exit code.
 * It never touches `process.argv`, never writes to `process.stdout` itself, and
 * never calls `process.exit`, so nearly every test runs it in-process. The
 * executable is a thin wrapper that supplies the real three.
 *
 * ## The output contract
 *
 * stdout carries success output and nothing else. stderr carries the error
 * envelope and nothing else. There is no progress reporting, no log line, and no
 * banner: a command's output is data a script parses, and a diagnostic
 * interleaved into it would corrupt that.
 *
 * Exit codes are `0` for success, `2` for a usage failure — an unknown command,
 * a missing or unknown option — and `1` for a validated operational failure. The
 * split matters to a script: a usage failure will not succeed on retry, and an
 * operational one might.
 */

/** Where a command writes. Injected so tests need no subprocess and no temp pipe. */
export interface CliIo {
  /** Receives success output. Called at most once per invocation. */
  readonly stdout: (text: string) => void;
  /** Receives the error envelope. Called at most once per invocation. */
  readonly stderr: (text: string) => void;
}

/** Exit code for a successful command. */
export const EXIT_SUCCESS = 0;
/** Exit code for a validated operational failure. */
export const EXIT_FAILURE = 1;
/** Exit code for a usage failure. */
export const EXIT_USAGE = 2;

/**
 * The options every command may take.
 *
 * `parseArgs` is given the whole set rather than a per-command set, and each
 * command then requires exactly the ones it needs. Declaring an option a command
 * does not use is still a usage error, because the requirement is checked, not
 * merely the parse.
 */
const OPTIONS = {
  config: { type: 'string' },
  request: { type: 'string' },
  registration: { type: 'string' },
  key: { type: 'string' },
  scope: { type: 'string' },
  id: { type: 'string' },
  case: { type: 'string' },
  'run-config': { type: 'string' },
} as const;

type ParsedOptions = Partial<Record<keyof typeof OPTIONS, string>>;

/** The commands this build implements, in the order the documentation lists them. */
const COMMANDS = ['compile', 'trace', 'eval', 'inspect-blocks', 'source', 'version'] as const;

const SOURCE_SUBCOMMANDS = ['add', 'update', 'remove', 'list'] as const;

/**
 * Runs one invocation.
 *
 * `argv` is the argument vector **after** the node executable and the script
 * path — exactly what `process.argv.slice(2)` yields.
 *
 * It never throws: every failure becomes an envelope on stderr and a non-zero
 * exit code. A CLI that threw would print a stack trace, which is a fact about
 * this program's source rather than about the operator's problem.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const output = await dispatch(argv);
    // One trailing newline, so the output is a well-formed line for a shell and
    // still exactly one JSON document for a parser.
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return EXIT_SUCCESS;
  } catch (cause) {
    const error = toCliError(cause, 'arguments');
    io.stderr(`${JSON.stringify(error.envelope(), null, 2)}\n`);
    return error.usage ? EXIT_USAGE : EXIT_FAILURE;
  }
}

async function dispatch(argv: readonly string[]): Promise<unknown> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw usageError('missing_command', '', `a command is required: ${COMMANDS.join(', ')}`);
  }
  if (!isCommand(command)) {
    throw usageError(
      'unknown_command',
      '',
      `unknown command: expected one of ${COMMANDS.join(', ')}`,
    );
  }

  // `source` is the only command with a subcommand, so its verb is consumed
  // before options are parsed. Everything else parses `rest` directly.
  if (command === 'source') {
    const [subcommand, ...tail] = rest;
    if (subcommand === undefined || !isSourceSubcommand(subcommand)) {
      throw usageError(
        'unknown_subcommand',
        '',
        `ctxalloc source requires one of: ${SOURCE_SUBCOMMANDS.join(', ')}`,
      );
    }
    return runSource(subcommand, parse(tail));
  }

  const options = parse(rest);
  switch (command) {
    case 'version':
      return runVersionCommand();
    case 'compile': {
      const config = loadConfig(options);
      return runCompileCommand(
        config,
        readJsonFile(require_(options, 'request'), 'request', 'input'),
      );
    }
    case 'trace': {
      const config = loadConfig(options);
      return runTraceCommand(
        config,
        readJsonFile(require_(options, 'scope'), 'scope', 'input'),
        require_(options, 'id'),
      );
    }
    case 'inspect-blocks': {
      const config = loadConfig(options);
      return runInspectBlocksCommand(
        config,
        readJsonFile(require_(options, 'scope'), 'scope', 'input'),
      );
    }
    case 'eval': {
      const config = loadConfig(options);
      return runEvalCommand(
        config,
        readJsonFile(require_(options, 'run-config'), 'run-config', 'input'),
        readJsonFile(require_(options, 'case'), 'case', 'input'),
      );
    }
  }
}

function runSource(
  subcommand: (typeof SOURCE_SUBCOMMANDS)[number],
  options: ParsedOptions,
): Promise<unknown> {
  const config = loadConfig(options);
  switch (subcommand) {
    case 'add':
      return runSourceCommand(config, {
        operation: 'register',
        registration: readJsonFile(require_(options, 'registration'), 'registration', 'input'),
      });
    case 'update':
      return runSourceCommand(config, {
        operation: 'update',
        registration: readJsonFile(require_(options, 'registration'), 'registration', 'input'),
      });
    case 'remove':
      return runSourceCommand(config, {
        operation: 'remove',
        key: readJsonFile(require_(options, 'key'), 'key', 'input'),
      });
    case 'list':
      return runSourceCommand(config, {
        operation: 'list',
        scope: readJsonFile(require_(options, 'scope'), 'scope', 'input'),
      });
  }
}

/**
 * Parses the option vector.
 *
 * `strict` rejects an unknown option and `allowPositionals: false` rejects a
 * stray argument, so a typo is a usage failure rather than a silently ignored
 * flag that makes a command read the wrong file. `parseArgs` throws its own
 * error; it is replaced rather than wrapped, because its message quotes the
 * argument text the caller supplied.
 */
function parse(argv: readonly string[]): ParsedOptions {
  try {
    return parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw usageError(
      'invalid_arguments',
      '',
      'the options could not be parsed: check for an unknown option, a missing value, or a stray argument',
    );
  }
}

/** One required option value, or a usage failure naming it. */
function require_(options: ParsedOptions, name: keyof typeof OPTIONS): string {
  const value = options[name];
  if (value === undefined || value.length === 0) {
    throw usageError('missing_option', name, `--${name} is required`);
  }
  return value;
}

/** Loads the configuration named by the required `--config` option. */
function loadConfig(options: ParsedOptions): CliConfig {
  return loadCliConfig(require_(options, 'config'));
}

function isCommand(value: string): value is (typeof COMMANDS)[number] {
  return (COMMANDS as readonly string[]).includes(value);
}

function isSourceSubcommand(value: string): value is (typeof SOURCE_SUBCOMMANDS)[number] {
  return (SOURCE_SUBCOMMANDS as readonly string[]).includes(value);
}

export { CliError };

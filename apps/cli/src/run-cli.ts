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
 * The complete option vocabulary of the program.
 *
 * `parseArgs` is given the whole set rather than a per-command set, because it
 * only has to turn an argument vector into values; *which* of them a command
 * accepts is decided afterwards, against {@link COMMAND_OPTIONS}.
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

type OptionName = keyof typeof OPTIONS;

type ParsedOptions = Partial<Record<OptionName, string>>;

/** Every option name, in one fixed order, so a report about them is deterministic. */
const OPTION_NAMES = Object.keys(OPTIONS) as readonly OptionName[];

/** The commands this build implements, in the order the documentation lists them. */
const COMMANDS = ['compile', 'trace', 'eval', 'inspect-blocks', 'source', 'version'] as const;

const SOURCE_SUBCOMMANDS = ['add', 'update', 'remove', 'list'] as const;

/**
 * The exact option contract of each command, and of each `source` subcommand.
 *
 * One list per command, and it is **both** the allowed set and the required set.
 * Two lists would permit a third state — accepted but unused — and that state is
 * precisely the failure this table exists to prevent. `parseArgs` is strict, so
 * it rejects an option no command knows; it cannot reject an option that *some
 * other* command knows, and without this table `ctxalloc version --config x`
 * parses, `ctxalloc compile --request r --scope s` parses, and in both cases the
 * option the operator typed is silently discarded. A caller who mistypes one
 * real option as another real one would then believe a scope or an input
 * participated in a command that never read it, which is worse than an outright
 * rejection because nothing in the output says otherwise (INV-DET-001).
 *
 * An option a future command needs is added here deliberately, together with the
 * code that reads it. Accepting one early "for compatibility" would reintroduce
 * exactly the silently-ignored argument this table forbids.
 */
const COMMAND_OPTIONS = {
  compile: ['config', 'request'],
  trace: ['config', 'scope', 'id'],
  eval: ['config', 'case', 'run-config'],
  'inspect-blocks': ['config', 'scope'],
  version: [],
} as const satisfies Record<Exclude<(typeof COMMANDS)[number], 'source'>, readonly OptionName[]>;

const SOURCE_COMMAND_OPTIONS = {
  add: ['config', 'registration'],
  update: ['config', 'registration'],
  remove: ['config', 'key'],
  list: ['config', 'scope'],
} as const satisfies Record<(typeof SOURCE_SUBCOMMANDS)[number], readonly OptionName[]>;

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
    return runSource(
      subcommand,
      optionsFor(tail, SOURCE_COMMAND_OPTIONS[subcommand], `ctxalloc source ${subcommand}`),
    );
  }

  const options = optionsFor(rest, COMMAND_OPTIONS[command], `ctxalloc ${command}`);
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
 * Parses one command's option vector and holds it to that command's contract.
 *
 * Three usage failures, checked in one fixed order so the report does not depend
 * on which one a caller happens to hit first: an option no command knows, an
 * option **this** command does not take, and a required option that is missing.
 *
 * The middle check is the one `parseArgs` cannot make. `--scope` is a real
 * option of `trace`, `inspect-blocks`, and `source list`, so a strict parse
 * accepts it everywhere; only this table knows that `compile` does not read it.
 */
function optionsFor(
  argv: readonly string[],
  contract: readonly OptionName[],
  label: string,
): ParsedOptions {
  const parsed = parse(argv);

  for (const name of OPTION_NAMES) {
    if (parsed[name] !== undefined && !contract.includes(name)) {
      throw usageError(
        'unexpected_option',
        name,
        contract.length === 0
          ? `${label} takes no options, and --${name} was supplied`
          : `--${name} is not an option of ${label}: it takes ${contract.map((option) => `--${option}`).join(', ')}`,
      );
    }
  }

  for (const name of contract) require_(parsed, name);
  return parsed;
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
function require_(options: ParsedOptions, name: OptionName): string {
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

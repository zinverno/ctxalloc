import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE,
  cli,
  compilationRequest,
  createWorkspace,
  failureOf,
  registration,
  registrationKey,
  type Workspace,
} from './fixtures.js';

/**
 * Each command has an exact option contract (DEC-042).
 *
 * `parseArgs` is strict, so it already rejects an option no command knows. It
 * cannot reject an option that *some other* command knows: `--scope` is real for
 * `trace`, `inspect-blocks`, and `source list`, so a strict parse accepts it on
 * `compile` too and the value is then silently discarded.
 *
 * That is worse than an outright rejection. An operator who mistyped one real
 * option as another real one would believe a scope or an input participated in a
 * command that never read it, and nothing in the output would say otherwise
 * (INV-DET-001).
 *
 * So every command is tested with at least one **known but disallowed** option.
 * `version --config x` is the unambiguous case: it needs no file access at all,
 * so nothing but the contract can be what rejects it.
 */

let workspace: Workspace | undefined;

function open(): Workspace {
  workspace = createWorkspace();
  return workspace;
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

/** Every command's exact contract, as the documentation states it. */
const CONTRACTS: readonly {
  readonly argv: readonly string[];
  readonly allowed: readonly string[];
  readonly disallowed: readonly string[];
}[] = [
  { argv: ['version'], allowed: [], disallowed: ['config', 'scope', 'id'] },
  { argv: ['compile'], allowed: ['config', 'request'], disallowed: ['scope', 'id', 'key'] },
  { argv: ['trace'], allowed: ['config', 'scope', 'id'], disallowed: ['request', 'key', 'case'] },
  {
    argv: ['inspect-blocks'],
    allowed: ['config', 'scope'],
    disallowed: ['request', 'id', 'registration'],
  },
  { argv: ['eval'], allowed: ['config', 'case', 'run-config'], disallowed: ['scope', 'request'] },
  {
    argv: ['source', 'add'],
    allowed: ['config', 'registration'],
    disallowed: ['scope', 'key', 'id'],
  },
  { argv: ['source', 'update'], allowed: ['config', 'registration'], disallowed: ['scope', 'key'] },
  { argv: ['source', 'remove'], allowed: ['config', 'key'], disallowed: ['scope', 'registration'] },
  { argv: ['source', 'list'], allowed: ['config', 'scope'], disallowed: ['key', 'registration'] },
];

describe('INV-DET-001: a known but unused option is a usage failure, never ignored', () => {
  it.each(
    CONTRACTS.flatMap((contract) =>
      contract.disallowed.map(
        (option) => [contract.argv.join(' '), contract.argv, option, contract.allowed] as const,
      ),
    ),
  )('ctxalloc %s rejects --%s', async (_label, argv, option, allowed) => {
    const ws = open();
    // Every *allowed* option is supplied with a real file, so the only thing
    // wrong with the invocation is the extra one.
    const supplied = allowed.flatMap((name) => [`--${name}`, valueFor(ws, name)]);
    const run = await cli(...argv, ...supplied, `--${option}`, valueFor(ws, option));
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(envelope.stage).toBe('arguments');
    expect(envelope.issues).toHaveLength(1);
    expect(envelope.issues[0]?.code).toBe('unexpected_option');
    expect(envelope.issues[0]?.pointer).toBe(option);
  });

  /**
   * The clearest counterexample of all: `version` reads no file, opens no
   * database, and takes no options, so a `--config` it accepted could only ever
   * be discarded.
   */
  it('ctxalloc version --config x is a usage failure and prints no version', async () => {
    const run = await cli('version', '--config', 'anything.json');
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(envelope.issues[0]?.code).toBe('unexpected_option');
    expect(envelope.issues[0]?.pointer).toBe('config');
    expect(envelope.issues[0]?.message).toContain('takes no options');
  });

  it('ctxalloc version with no options still succeeds', async () => {
    const run = await cli('version');
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('reports the disallowed option before any file is opened', async () => {
    const ws = open();
    // The config and request both name files that do not exist. If the contract
    // were checked after the files were read, the failure would be an input one.
    const run = await cli(
      'compile',
      '--config',
      `${ws.root}/missing.json`,
      '--request',
      `${ws.root}/missing.json`,
      '--scope',
      `${ws.root}/missing.json`,
    );

    expect(failureOf(run).stage).toBe('arguments');
    expect(failureOf(run).issues[0]?.code).toBe('unexpected_option');
  });

  it('reports one disallowed option deterministically when several are supplied', async () => {
    const ws = open();
    const first = await cli(
      'source',
      'list',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
      '--key',
      ws.write('k.json', registrationKey()),
      '--registration',
      ws.write('r.json', registration()),
    );
    const second = await cli(
      'source',
      'list',
      '--registration',
      ws.write('r.json', registration()),
      '--key',
      ws.write('k.json', registrationKey()),
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );

    // The report follows the program's own option order, not the caller's, so
    // two spellings of one mistake produce one answer.
    expect(failureOf(first)).toEqual(failureOf(second));
    expect(failureOf(first).issues[0]?.pointer).toBe('registration');
  });
});

describe('the remaining usage failures are unchanged', () => {
  it('an unknown option is still a usage failure', async () => {
    const run = await cli('version', '--nonsense', 'x');

    expect(run.exitCode).toBe(2);
    expect(failureOf(run).issues[0]?.code).toBe('invalid_arguments');
  });

  it('a stray positional is still a usage failure', async () => {
    const run = await cli('version', 'extra');

    expect(run.exitCode).toBe(2);
    expect(failureOf(run).issues[0]?.code).toBe('invalid_arguments');
  });

  it.each([
    [['compile', '--config'], 'request'],
    [['trace', '--config'], 'scope'],
    [['inspect-blocks', '--config'], 'scope'],
    [['source', 'add', '--config'], 'registration'],
    [['source', 'remove', '--config'], 'key'],
    [['source', 'list', '--config'], 'scope'],
  ])('a missing required option of %s is still a usage failure', async (argv, missing) => {
    const ws = open();
    const run = await cli(...argv, ws.configPath);
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(2);
    expect(envelope.issues[0]?.code).toBe('missing_option');
    expect(envelope.issues[0]?.pointer).toBe(missing);
  });

  it('a missing --config is reported before any other required option', async () => {
    const run = await cli('compile');

    expect(failureOf(run).issues[0]?.pointer).toBe('config');
  });

  it('an unknown subcommand is still a usage failure', async () => {
    const run = await cli('source', 'rename', '--config', 'x.json');

    expect(run.exitCode).toBe(2);
    expect(failureOf(run).issues[0]?.code).toBe('unknown_subcommand');
  });

  it('every usage failure writes one envelope to stderr and nothing to stdout', async () => {
    const run = await cli('compile', '--scope', 'x.json');

    expect(run.stdout).toBe('');
    expect(
      run.stderr
        .trimEnd()
        .split('\n')
        .filter((line) => line === '}'),
    ).toHaveLength(1);
    expect(failureOf(run).code).toBe('CTXALLOC_CLI_FAILED');
    expect(failureOf(run).schemaVersion).toBe(1);
  });
});

/** A real file for each option, so only the contract can be what fails. */
function valueFor(ws: Workspace, option: string): string {
  switch (option) {
    case 'config':
      return ws.configPath;
    case 'request':
      return ws.write('request.json', compilationRequest());
    case 'registration':
      return ws.write('registration.json', registration());
    case 'key':
      return ws.write('key.json', registrationKey());
    case 'scope':
      return ws.write('scope.json', SCOPE);
    case 'case':
      return ws.write('case.json', {});
    case 'run-config':
      return ws.write('run-config.json', {});
    default:
      return 'value';
  }
}

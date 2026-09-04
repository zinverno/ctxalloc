import { readFileSync } from 'node:fs';
import { CLI_CONTRACT_VERSION, CLI_NAME } from '@ctxalloc/cli';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE,
  cli,
  createWorkspace,
  failureOf,
  registration,
  successOf,
  type Workspace,
} from './fixtures.js';

/**
 * `ctxalloc inspect-blocks` and `ctxalloc version` (DEC-042).
 *
 * `inspect-blocks` is the command that proves preparation is a use case in its
 * own right: it produces the corpus without a query, a budget, a policy, a
 * retrieval provider, or a trace write, none of which it has any reason to
 * invent.
 */

const rootUrl = new URL('../../', import.meta.url);

let workspace: Workspace | undefined;

interface InspectOutput {
  readonly schemaVersion: number;
  readonly sourceDocuments: readonly { id: string; sourceType: string }[];
  readonly blocks: readonly { id: string; content: string; sourceDocumentId: string }[];
}

async function prepared(): Promise<Workspace> {
  const ws = createWorkspace();
  workspace = ws;
  await cli(
    'source',
    'add',
    '--config',
    ws.configPath,
    '--registration',
    ws.write('r1.json', registration()),
  );
  await cli(
    'source',
    'add',
    '--config',
    ws.configPath,
    '--registration',
    ws.write(
      'r2.json',
      registration({
        sourceType: 'text',
        identity: { namespace: 'vault:docs', key: 'distractors.txt' },
        locator: 'distractors.txt',
        title: 'Distractors',
      }),
    ),
  );
  return ws;
}

async function inspect(ws: Workspace): Promise<InspectOutput> {
  return successOf(
    await cli('inspect-blocks', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE)),
  ) as InspectOutput;
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

describe('ctxalloc inspect-blocks: preparation without compilation', () => {
  it('prepares the corpus of one scope from the registered files', async () => {
    const ws = await prepared();
    const output = await inspect(ws);

    expect(output.schemaVersion).toBe(1);
    expect(output.sourceDocuments).toHaveLength(2);
    expect(output.blocks.length).toBeGreaterThan(2);
    expect(output.sourceDocuments.map((entry) => entry.sourceType).sort()).toEqual([
      'markdown',
      'text',
    ]);
  });

  it('publishes block content, which is the whole point of the command', async () => {
    const ws = await prepared();
    const output = await inspect(ws);

    // The documented privacy behaviour: this is the one command that shows
    // source text, because an operator asking to inspect blocks is asking to
    // see them. `compile` publishes no corpus and `trace` publishes no content.
    expect(output.blocks.map((block) => block.content).join('\n')).toContain('quantum reticulator');
  });

  it('INV-DET-002: produces the same corpus on every run, in canonical order', async () => {
    const ws = await prepared();
    const first = await inspect(ws);
    const second = await inspect(ws);

    expect(second).toEqual(first);

    const documentOrder = first.sourceDocuments.map((entry) => entry.id);
    expect([...documentOrder].sort()).toEqual(documentOrder);
  });

  it('runs no retrieval, no compiler, and writes no trace', async () => {
    const ws = await prepared();
    const output = await inspect(ws);

    // A compilation would have produced a compiled context and an identifier.
    expect(Object.keys(output).sort()).toEqual(['blocks', 'schemaVersion', 'sourceDocuments']);
    expect(Object.keys(output)).not.toContain('compiledContext');
    expect(Object.keys(output)).not.toContain('compilationId');
    expect(Object.keys(output)).not.toContain('candidates');

    // And no trace row exists to be read.
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(ws.databasePath);
    const rows = database.prepare('SELECT count(*) AS n FROM ctxalloc_compilation_trace').get();
    database.close();
    expect((rows as { n: number }).n).toBe(0);
  });

  it('composes the same preparation the compile command uses', async () => {
    const ws = await prepared();
    const inspected = await inspect(ws);

    // Source scanning rather than a behavioural claim: the point is that one
    // service owns preparation, so there is nothing here that could drift from
    // what `compile` runs (INV-DEP-003).
    const source = readFileSync(
      new URL('apps/cli/src/commands/inspect-blocks.ts', rootUrl),
      'utf8',
    );
    expect(source).toContain('PrepareLocalCorpusService');
    expect(source).not.toContain('MiniSearchCandidateProvider');
    expect(source).not.toContain('ContextCompiler');
    expect(source).not.toContain('CompilationTracePersistenceService');
    expect(source).not.toContain('SQLiteTraceStore');

    expect(inspected.blocks.length).toBeGreaterThan(0);
  });

  it('reports an unreadable source at the source-read stage', async () => {
    const ws = await prepared();
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write(
        'gone.json',
        registration({ identity: { namespace: 'vault:docs', key: 'gone.md' }, locator: 'gone.md' }),
      ),
    );

    const run = await cli(
      'inspect-blocks',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('s.json', SCOPE),
    );

    expect(run.stdout).toBe('');
    expect(failureOf(run).stage).toBe('source-read');
  });
});

describe('ctxalloc version: a deterministic local build identity', () => {
  it('reports the executable name, package version, and contract version', async () => {
    const output = successOf(await cli('version'));

    expect(output).toEqual({
      name: CLI_NAME,
      packageVersion: '0.0.0',
      cliContractVersion: CLI_CONTRACT_VERSION,
    });
  });

  it('needs no configuration and exits zero', async () => {
    const run = await cli('version');

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('INV-DET-001: is identical on every invocation', async () => {
    const first = await cli('version');
    const second = await cli('version');

    expect(second.stdout).toBe(first.stdout);
  });

  it('reads no git revision, clock, hostname, environment, or network', () => {
    // Documentation is stripped first: the module's own comment explains that it
    // reads a module-relative manifest rather than `process.cwd()`, and naming
    // what it refuses to do is not doing it.
    const source = readFileSync(new URL('apps/cli/src/commands/version.ts', rootUrl), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const forbidden of [
      'child_process',
      'execSync',
      'git',
      'Date',
      'hostname',
      'os.',
      'process.env',
      'fetch',
      'cwd',
    ]) {
      expect(source, `names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('matches the CLI package manifest it claims to describe', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('apps/cli/package.json', rootUrl), 'utf8'),
    ) as {
      version: string;
      bin: Record<string, string>;
    };

    expect(manifest.version).toBe('0.0.0');
    // The executable name is the one the version output publishes.
    expect(Object.keys(manifest.bin)).toEqual([CLI_NAME]);
  });
});

describe('ctxalloc: the usage contract', () => {
  it('exits 2 with a usage envelope for an unknown command', async () => {
    const run = await cli('summarise');

    expect(run.exitCode).toBe(2);
    expect(run.stdout).toBe('');
    expect(failureOf(run).issues[0]?.code).toBe('unknown_command');
  });

  it('exits 2 when no command is given', async () => {
    const run = await cli();

    expect(run.exitCode).toBe(2);
    expect(failureOf(run).issues[0]?.code).toBe('missing_command');
  });

  it('exits 2 for a missing required option', async () => {
    const run = await cli('compile');

    expect(run.exitCode).toBe(2);
    const envelope = failureOf(run);
    expect(envelope.stage).toBe('arguments');
    expect(envelope.issues[0]?.code).toBe('missing_option');
    expect(envelope.issues[0]?.pointer).toBe('config');
  });

  it('exits 2 for an unknown option or a stray positional', async () => {
    const ws = createWorkspace();
    workspace = ws;

    const unknown = await cli('source', 'list', '--config', ws.configPath, '--verbose');
    const stray = await cli('source', 'list', '--config', ws.configPath, 'extra');

    for (const run of [unknown, stray]) {
      expect(run.exitCode).toBe(2);
      expect(failureOf(run).issues[0]?.code).toBe('invalid_arguments');
    }
  });

  it('exits 2 for an unknown source subcommand', async () => {
    const run = await cli('source', 'purge');

    expect(run.exitCode).toBe(2);
    expect(failureOf(run).issues[0]?.code).toBe('unknown_subcommand');
  });

  it('names every implemented command in its usage message', async () => {
    const message = failureOf(await cli('summarise')).issues[0]?.message ?? '';

    for (const command of ['compile', 'trace', 'eval', 'inspect-blocks', 'source', 'version']) {
      expect(message).toContain(command);
    }
    // Persistent retrieval indexing is a later phase; there is no such command.
    expect(message).not.toContain('index');
  });
});

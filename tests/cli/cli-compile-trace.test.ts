import { DatabaseSync } from 'node:sqlite';
import { SettledCompilationTraceValidator } from '@ctxalloc/compiler';
import { availableInputTokens } from '@ctxalloc/domain';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OTHER_SCOPE,
  SCOPE,
  cli,
  cliConfig,
  compilationRequest,
  createWorkspace,
  failureOf,
  policy,
  registration,
  successOf,
  type Workspace,
} from './fixtures.js';

/**
 * `ctxalloc compile` and `ctxalloc trace` over the whole real local stack
 * (DEC-042).
 *
 * Nothing here is a double. Real files on disk, the real `NodeFileSourceReader`,
 * the real `O200kBaseTokenizer`, the real `MiniSearchCandidateProvider`, the
 * real `ContextCompiler`, and two real SQLite stores. The proof that persistence
 * works is that a **separate invocation** reads back what a previous one wrote.
 */

let workspace: Workspace | undefined;

interface CompileOutput {
  readonly schemaVersion: number;
  readonly compilationId: string;
  readonly compiledContext: string;
  readonly includedBlockIds: readonly string[];
  readonly usage: { readonly compiledTokens: number; readonly availableTokens: number };
  readonly traceStored: boolean;
}

async function prepared(config?: Record<string, unknown>): Promise<Workspace> {
  const ws = createWorkspace(config ?? cliConfig());
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

async function compile(
  ws: Workspace,
  overrides: Record<string, unknown> = {},
): Promise<CompileOutput> {
  const run = await cli(
    'compile',
    '--config',
    ws.configPath,
    '--request',
    ws.write('request.json', compilationRequest(overrides)),
  );
  return successOf(run) as CompileOutput;
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

describe('ctxalloc compile: the whole local stack, from files to a persisted trace', () => {
  it('compiles from registered files through real retrieval into a real compilation', async () => {
    const ws = await prepared();
    const output = await compile(ws);

    expect(output.schemaVersion).toBe(1);
    expect(output.compilationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(output.includedBlockIds.length).toBeGreaterThan(0);
    expect(output.compiledContext.length).toBeGreaterThan(0);
    expect(output.traceStored).toBe(true);

    // The compiled context is real JSONL over the real source text.
    const lines = output.compiledContext.split('\n');
    expect(lines).toHaveLength(output.includedBlockIds.length);
    expect(lines.map((line) => (JSON.parse(line) as { blockId: string }).blockId)).toEqual(
      output.includedBlockIds,
    );
    expect(output.compiledContext).toContain('reticulator');
  });

  it('INV-BUDGET-001: the compiled context fits the available budget', async () => {
    const ws = await prepared();
    const output = await compile(ws);

    const budget = { totalTokens: 4000, reservedOutputTokens: 500 };
    const available = availableInputTokens(budget);
    // Measured with the same tokenizer the CLI composed, over the exact string.
    const measured = new O200kBaseTokenizer().countTokens(output.compiledContext);

    expect(output.usage.availableTokens).toBe(available);
    expect(output.usage.compiledTokens).toBe(measured);
    expect(measured).toBeLessThanOrEqual(available);
  });

  it('INV-DET-001: the same request compiles to the same identifier and context', async () => {
    const ws = await prepared();
    const first = await compile(ws);
    const second = await compile(ws);

    expect(second.compilationId).toBe(first.compilationId);
    expect(second.compiledContext).toBe(first.compiledContext);
    expect(second.includedBlockIds).toEqual(first.includedBlockIds);
    // Storing the identical trace a second time is a no-op, not a conflict.
    expect(second.traceStored).toBe(true);
  });

  /**
   * `traceStored: true` is a claim about the audit log, and it must be true.
   *
   * A store that decided idempotence from a subset of the row's columns would
   * answer "already stored" for a row whose scope was corrupted — and the very
   * next `ctxalloc trace` would refuse that same row. The command would then have
   * reported a stored trace that cannot be read back (INV-STORE-002).
   */
  it('INV-STORE-002: reports failure rather than traceStored when the audit row is corrupt', async () => {
    const ws = await prepared();
    const first = await compile(ws);

    // Corrupt only `scope_json`, which the first implementation never compared.
    const database = new DatabaseSync(ws.databasePath);
    database.exec("UPDATE ctxalloc_compilation_trace SET scope_json = '{ not json'");
    database.close();

    const run = await cli(
      'compile',
      '--config',
      ws.configPath,
      '--request',
      ws.write('request.json', compilationRequest()),
    );
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stdout).not.toContain('traceStored');
    expect(envelope.stage).toBe('trace-store');
    expect(envelope.issues[0]?.code).toBe('invalid_stored_record');

    // And reading it back agrees: the row really is unreadable.
    const read = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('scope.json', SCOPE),
      '--id',
      first.compilationId,
    );
    expect(read.exitCode).toBe(1);
  });

  it('publishes no corpus, no candidates, no source metadata, and no raw query', async () => {
    const ws = createWorkspace();
    workspace = ws;
    // A distinctive metadata value, so its absence from the output is a real
    // observation rather than a coincidence of wording.
    await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('r.json', registration({ metadata: { vaultTag: 'private-control-plane-marker' } })),
    );

    const run = await cli(
      'compile',
      '--config',
      ws.configPath,
      '--request',
      // A query carrying a marker that appears in no source file, so its
      // absence from the output is an observation about the envelope rather
      // than a coincidence: the corpus legitimately contains the other words.
      ws.write(
        'request.json',
        compilationRequest({ query: 'reticulator zzqx-private-query-marker' }),
      ),
    );
    const output = successOf(run) as Record<string, unknown>;

    expect(Object.keys(output).sort()).toEqual([
      'compilationId',
      'compiledContext',
      'includedBlockIds',
      'schemaVersion',
      'traceStored',
      'usage',
    ]);
    expect(Object.keys(output)).not.toContain('candidates');
    expect(Object.keys(output)).not.toContain('blocks');
    expect(Object.keys(output)).not.toContain('sourceDocuments');

    // Source *metadata* is control-plane data the compile command never emits,
    // even though the compiled context legitimately carries source *text*
    // (INV-SEC-001).
    expect(run.stdout).not.toContain('private-control-plane-marker');
    // The raw query is the caller's own text and is never echoed back.
    expect(run.stdout).not.toContain('zzqx-private-query-marker');
  });

  it('reports a compiler failure at the compilation stage without partial output', async () => {
    const ws = await prepared();
    // A rendering slice the kernel rejects: the failure happens inside
    // `ContextCompiler`, which is what makes this the compilation stage rather
    // than request validation in the application layer.
    const broken = policy();
    const run = await cli(
      'compile',
      '--config',
      ws.configPath,
      '--request',
      ws.write(
        'broken.json',
        compilationRequest({
          policy: {
            ...broken,
            rendering: {
              schemaVersion: 1,
              policyId: 'rendering',
              policyVersion: '1.0.0',
              format: 'not-a-supported-format',
            },
          },
        }),
      ),
    );

    expect(run.stdout).toBe('');
    expect(run.exitCode).toBe(1);
    expect(failureOf(run).stage).toBe('compilation');
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
        'missing.json',
        registration({
          identity: { namespace: 'vault:docs', key: 'absent.md' },
          locator: 'absent.md',
        }),
      ),
    );

    const run = await cli(
      'compile',
      '--config',
      ws.configPath,
      '--request',
      ws.write('request.json', compilationRequest()),
    );

    expect(failureOf(run).stage).toBe('source-read');
    // The absolute path of the missing file is never disclosed.
    expect(run.stderr).not.toContain(ws.sourceRoot);
  });
});

describe('ctxalloc trace: the persisted audit record, read back by a later invocation', () => {
  it('returns the exact settled trace of a previous compile', async () => {
    const ws = await prepared();
    const compiled = await compile(ws);

    const run = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('scope.json', SCOPE),
      '--id',
      compiled.compilationId,
    );
    const trace = successOf(run) as Record<string, unknown>;

    expect(trace.settled).toBe(true);
    expect(trace.compilationId).toBe(compiled.compilationId);
    expect(trace.schemaVersion).toBe(2);
    // It validates as a settled trace on the way out of the store.
    expect(() => new SettledCompilationTraceValidator().validate(trace)).not.toThrow();
  });

  it('INV-SEC-003: the persisted trace carries no context, query, or block content', async () => {
    const ws = await prepared();
    const compiled = await compile(ws);

    const run = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('scope.json', SCOPE),
      '--id',
      compiled.compilationId,
    );

    expect(run.stdout).not.toContain('compiledContext');
    expect(run.stdout).not.toContain('reticulator calibrates the allocator');
    expect(run.stdout).not.toContain('quantum reticulator');
    expect(run.stdout).not.toContain('gardener repotted');
  });

  it('INV-SEC-004: a wrong scope is not found, and discloses nothing', async () => {
    const ws = await prepared();
    const compiled = await compile(ws);

    const wrongScope = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('other.json', OTHER_SCOPE),
      '--id',
      compiled.compilationId,
    );
    const unknownId = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('scope.json', SCOPE),
      '--id',
      `sha256:${'0'.repeat(64)}`,
    );

    // Byte-identical envelopes: nothing distinguishes "exists elsewhere" from
    // "does not exist".
    expect(wrongScope.stderr).toBe(unknownId.stderr);
    expect(failureOf(wrongScope).issues[0]?.code).toBe('trace_not_found');
  });

  it('fails safely on a persisted trace that was corrupted in place', async () => {
    const ws = await prepared();
    const compiled = await compile(ws);

    // Corrupt the stored payload through direct SQL, exactly as an accident or a
    // different build would.
    const database = new DatabaseSync(ws.databasePath);
    database
      .prepare('UPDATE ctxalloc_compilation_trace SET trace_json = ? WHERE compilation_id = ?')
      .run('{ not json', compiled.compilationId);
    database.close();

    const run = await cli(
      'trace',
      '--config',
      ws.configPath,
      '--scope',
      ws.write('scope.json', SCOPE),
      '--id',
      compiled.compilationId,
    );
    const envelope = failureOf(run);

    expect(run.stdout).toBe('');
    expect(envelope.stage).toBe('trace-store');
    // The adapter's `INVALID_STORED_DATA` is translated by the application
    // layer into its own vocabulary: the CLI never republishes an adapter's
    // code as if it were the contract (INV-ADAPTER-001).
    expect(envelope.issues[0]?.code).toBe('invalid_stored_record');
    // No SQL, no path, no driver wording.
    expect(run.stderr).not.toContain(ws.databasePath);
    expect(run.stderr).not.toContain('SELECT');
  });
});

describe('INV-STORE-001: the database is a control and audit store, not a knowledge base', () => {
  it('stores no source content, no block, and no compiled context', async () => {
    const ws = await prepared();
    const compiled = await compile(ws);

    const database = new DatabaseSync(ws.databasePath);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String((row as { name: unknown }).name));

    // Exactly three tables: metadata, registrations, traces.
    expect(tables).toEqual([
      'ctxalloc_compilation_trace',
      'ctxalloc_source_registration',
      'ctxalloc_store_metadata',
    ]);

    // Every stored byte, concatenated, contains no source text and no context.
    const dump = [
      ...database.prepare('SELECT * FROM ctxalloc_source_registration').all(),
      ...database.prepare('SELECT * FROM ctxalloc_compilation_trace').all(),
    ]
      .map((row) => JSON.stringify(row))
      .join('\n');
    database.close();

    expect(dump).not.toContain('quantum reticulator');
    expect(dump).not.toContain('gardener repotted');
    expect(dump).not.toContain('reticulator calibrates the allocator');
    expect(dump).not.toContain(compiled.compiledContext.slice(0, 40));
  });

  it('records the database schema version exactly once', async () => {
    const ws = await prepared();
    // Two more invocations, each of which opens and migrates the same file.
    await compile(ws);
    await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE));

    const database = new DatabaseSync(ws.databasePath);
    const rows = database.prepare('SELECT key, value FROM ctxalloc_store_metadata').all();
    database.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'schema_version', value: '1' });
  });
});

import {
  CompileLocalContextService,
  LocalSourcePipelineError,
  PrepareLocalCorpusService,
  type PreparedLocalCorpus,
} from '@ctxalloc/application';
import type { SourceRegistration } from '@ctxalloc/ports';
import {
  FakeCandidateProvider,
  InMemoryControlStore,
  InMemorySourceReader,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SOURCE,
  MARKDOWN_SOURCE,
  OTHER_SCOPE,
  SCOPE,
  TEXT_SOURCE,
  localRequest,
  permutations,
  registration,
  serviceConfig,
} from './local-service-fixtures.js';
import { wordTokenizer } from './text-fixtures.js';

/**
 * `PrepareLocalCorpusService` (DEC-042).
 *
 * Preparation was extracted out of `CompileLocalContextService` in this phase.
 * The extraction is only correct if it changed nothing, so the central test here
 * is a **golden equality**: the corpus the standalone service prepares is
 * deep-equal to the corpus the compile service prepares from the same inputs,
 * and the compile service's own result — candidates, compiled context,
 * compilation identifier, and settled trace — is unchanged (INV-DET-001).
 */

const MARKDOWN_REGISTRATION = registration({
  sourceType: 'markdown',
  identity: { namespace: 'vault:notes', key: 'budgets.md' },
  locator: 'notes/budgets.md',
  metadata: { path: 'notes/budgets.md' },
});

const TEXT_REGISTRATION = registration({
  sourceType: 'text',
  identity: { namespace: 'vault:notes', key: 'scratch.txt' },
  locator: 'notes/scratch.txt',
});

const CONVERSATION_REGISTRATION = registration({
  sourceType: 'conversation',
  identity: { namespace: 'chat:local', key: 'thread-1' },
  locator: 'chats/thread-1.json',
});

const REGISTRATIONS = [MARKDOWN_REGISTRATION, TEXT_REGISTRATION, CONVERSATION_REGISTRATION];

const SOURCES = [
  { locator: 'notes/budgets.md', content: MARKDOWN_SOURCE },
  { locator: 'notes/scratch.txt', content: TEXT_SOURCE },
  { locator: 'chats/thread-1.json', content: CONVERSATION_SOURCE },
];

/** The preparation slice of the compile service's configuration, unchanged. */
function prepareConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const full = serviceConfig();
  return {
    schemaVersion: 1,
    markdownChunking: full.markdownChunking,
    textChunking: full.textChunking,
    ...overrides,
  };
}

function preparation(
  registrations: readonly SourceRegistration[],
  config: Record<string, unknown> = prepareConfig(),
): PrepareLocalCorpusService {
  return new PrepareLocalCorpusService(
    config,
    wordTokenizer,
    new InMemorySourceReader(SOURCES),
    new InMemoryControlStore(registrations),
  );
}

function compileService(registrations: readonly SourceRegistration[]): CompileLocalContextService {
  return new CompileLocalContextService(
    serviceConfig(),
    wordTokenizer,
    new InMemorySourceReader(SOURCES),
    new InMemoryControlStore(registrations),
    new FakeCandidateProvider(),
  );
}

async function prepare(
  registrations: readonly SourceRegistration[],
  scope: unknown = SCOPE,
): Promise<PreparedLocalCorpus> {
  return preparation(registrations).execute({ schemaVersion: 1, scope });
}

async function failure(body: () => Promise<unknown>): Promise<LocalSourcePipelineError> {
  try {
    await body();
  } catch (cause) {
    if (cause instanceof LocalSourcePipelineError) return cause;
    throw cause;
  }
  throw new Error('expected a LocalSourcePipelineError');
}

describe('PrepareLocalCorpusService: the corpus of one scope', () => {
  it('prepares an empty corpus for a scope with no registrations', async () => {
    expect(await prepare([])).toEqual({ sourceDocuments: [], blocks: [] });
  });

  it('prepares Markdown, plain text, and conversation sources', async () => {
    const corpus = await prepare(REGISTRATIONS);

    expect(corpus.sourceDocuments).toHaveLength(3);
    expect(corpus.blocks.length).toBeGreaterThan(3);
    expect(corpus.sourceDocuments.map((entry) => entry.sourceType).sort()).toEqual([
      'conversation',
      'markdown',
      'text',
    ]);
    // Block content is exact source text, unchanged by preparation.
    expect(corpus.blocks.map((block) => block.content).join('\n')).toContain(
      'The available input budget is four thousand tokens.',
    );
  });

  it('INV-DET-002: no ordering of the registrations changes the prepared corpus', async () => {
    const expected = await prepare(REGISTRATIONS);

    for (const ordering of permutations(REGISTRATIONS)) {
      expect(await prepare(ordering)).toEqual(expected);
    }
  });

  it('INV-DET-002: publishes a total canonical order', async () => {
    const corpus = await prepare(REGISTRATIONS);

    const documentIds = corpus.sourceDocuments.map((entry) => String(entry.id));
    expect([...documentIds].sort()).toEqual(documentIds);

    // Blocks are grouped by document, and each document's blocks are contiguous.
    const documents = corpus.blocks.map((block) => String(block.sourceDocumentId));
    for (const id of new Set(documents)) {
      const first = documents.indexOf(id);
      const last = documents.lastIndexOf(id);
      expect(documents.slice(first, last + 1).every((entry) => entry === id)).toBe(true);
    }
  });

  it('INV-SCOPE-004: prepares nothing from another scope', async () => {
    // The control store filters by exact scope, so a registration belonging
    // elsewhere contributes nothing to this scope's corpus.
    expect(await prepare([registration({ scope: OTHER_SCOPE })])).toEqual({
      sourceDocuments: [],
      blocks: [],
    });
  });

  it('rejects two registrations of one logical source before reading anything', async () => {
    const duplicate = { ...MARKDOWN_REGISTRATION, locator: 'notes/scratch.txt' };
    const error = await failure(() => prepare([MARKDOWN_REGISTRATION, duplicate]));

    expect(error.stage).toBe('source-registration');
    expect(error.issues[0]?.code).toBe('duplicate_registration');
  });

  it('rejects a malformed registration with an addressed issue', async () => {
    const error = await failure(() =>
      prepare([
        { ...MARKDOWN_REGISTRATION, sourceType: 'spreadsheet' } as unknown as SourceRegistration,
      ]),
    );

    expect(error.stage).toBe('source-registration');
    expect(error.issues[0]?.pointer).toBe('0.sourceType');
  });

  it('reports an unreadable source without disclosing the locator', async () => {
    const error = await failure(() =>
      prepare([{ ...MARKDOWN_REGISTRATION, locator: 'notes/absent.md' }]),
    );

    expect(error.stage).toBe('source-read');
    const message = error.issues[0]?.message ?? '';
    expect(message).toContain('vault:notes/budgets.md');
    expect(message).not.toContain('notes/absent.md');
  });

  it.each([
    ['an empty request', {}],
    ['an unsupported schema version', { schemaVersion: 2, scope: SCOPE }],
    ['a missing scope', { schemaVersion: 1 }],
    ['an unknown field', { schemaVersion: 1, scope: SCOPE, query: 'extra' }],
  ])('rejects %s at request validation', async (_label, input) => {
    const error = await failure(() => preparation([]).execute(input));
    expect(error.stage).toBe('request-validation');
  });

  it('rejects an invalid chunking policy at construction, addressed to its field', () => {
    let caught: unknown;
    try {
      preparation([], prepareConfig({ markdownChunking: { targetTokens: 80, maxTokens: 40 } }));
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(LocalSourcePipelineError);
    const error = caught as LocalSourcePipelineError;
    expect(error.stage).toBe('configuration');
    expect(error.issues.every((issue) => issue.pointer.startsWith('config.markdownChunking'))).toBe(
      true,
    );
  });

  it('rejects an unknown configuration field rather than ignoring it', () => {
    let caught: unknown;
    try {
      preparation([], prepareConfig({ compiler: {} }));
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(LocalSourcePipelineError);
    expect((caught as LocalSourcePipelineError).stage).toBe('configuration');
  });
});

describe('INV-DEP-003: preparation has exactly one implementation', () => {
  it('the standalone service prepares the same corpus the compile service does', async () => {
    const standalone = await prepare(REGISTRATIONS);
    const compiled = await compileService(REGISTRATIONS).execute(localRequest());

    // Deep equality on both halves: the extraction changed no document and no
    // block, not even a value a serializer would notice.
    expect(compiled.sourceDocuments).toEqual(standalone.sourceDocuments);
    expect(compiled.blocks).toEqual(standalone.blocks);
  });

  it('the compile service still produces a stable identifier, context, and trace', async () => {
    const expected = await compileService(REGISTRATIONS).execute(localRequest());

    for (const ordering of permutations(REGISTRATIONS)) {
      const result = await compileService(ordering).execute(localRequest());

      expect(result.compilation.compilationId).toBe(expected.compilation.compilationId);
      expect(result.compilation.compiledContext).toBe(expected.compilation.compiledContext);
      expect(result.compilation.usage).toEqual(expected.compilation.usage);
      expect(result.compilation.trace).toEqual(expected.compilation.trace);
      expect(result.candidates).toEqual(expected.candidates);
    }
  });
});

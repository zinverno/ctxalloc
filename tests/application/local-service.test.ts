import { CompileLocalContextService, LocalSourcePipelineError } from '@ctxalloc/application';
import { ContextCompilationError } from '@ctxalloc/compiler';
import type { CandidateProvider, ControlStore, SourceReader } from '@ctxalloc/ports';
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
  TEXT_SOURCE,
  localRequest,
  permutations,
  registration,
  serviceConfig,
} from './local-service-fixtures.js';
import { wordTokenizer } from './text-fixtures.js';

const REGISTRATIONS = [
  registration({
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'budgets.md' },
    locator: 'notes/budgets.md',
    metadata: { path: 'notes/budgets.md' },
  }),
  registration({
    sourceType: 'text',
    identity: { namespace: 'vault:notes', key: 'scratch.txt' },
    locator: 'notes/scratch.txt',
  }),
  registration({
    sourceType: 'conversation',
    identity: { namespace: 'chat:local', key: 'thread-1' },
    locator: 'chats/thread-1.json',
  }),
];

const SOURCES = [
  { locator: 'notes/budgets.md', content: MARKDOWN_SOURCE },
  { locator: 'notes/scratch.txt', content: TEXT_SOURCE },
  { locator: 'chats/thread-1.json', content: CONVERSATION_SOURCE },
];

function storeOf(registrations: readonly unknown[]): ControlStore {
  return new InMemoryControlStore(registrations as never);
}

function build(
  options: {
    readonly registrations?: readonly unknown[];
    readonly sources?: readonly { locator: string; content: string }[];
    readonly provider?: CandidateProvider;
    readonly config?: Record<string, unknown>;
    readonly reader?: SourceReader;
  } = {},
): CompileLocalContextService {
  return new CompileLocalContextService(
    options.config ?? serviceConfig(),
    wordTokenizer,
    options.reader ?? new InMemorySourceReader([...(options.sources ?? SOURCES)]),
    storeOf(options.registrations ?? REGISTRATIONS),
    options.provider ?? new FakeCandidateProvider(),
  );
}

async function stage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(LocalSourcePipelineError);
    return (cause as LocalSourcePipelineError).stage;
  }
  throw new Error('expected a rejection');
}

describe('CompileLocalContextService: the whole local slice', () => {
  it('reads, ingests, chunks, proposes, and compiles all three source types', async () => {
    const result = await build().execute(localRequest());

    expect(result.sourceDocuments).toHaveLength(3);
    expect(result.sourceDocuments.map((document) => document.sourceType).sort()).toEqual([
      'conversation',
      'markdown',
      'text',
    ]);
    expect(result.blocks.length).toBeGreaterThanOrEqual(4);
    expect(result.candidates).toHaveLength(result.blocks.length);
    expect(result.compilation.compiledContext.length).toBeGreaterThan(0);
    expect(result.compilation.trace.settlement).toBeDefined();
  });

  it('INV-PROV-005: every block belongs to a document the result publishes', () => {
    return build()
      .execute(localRequest())
      .then((result) => {
        const ids = new Set(result.sourceDocuments.map((document) => String(document.id)));
        for (const block of result.blocks) {
          expect(ids.has(String(block.sourceDocumentId))).toBe(true);
        }
      });
  });

  it('INV-DET-002: orders the corpus canonically, whatever order the store lists', async () => {
    const baseline = await build().execute(localRequest());

    for (const permuted of permutations(REGISTRATIONS)) {
      const result = await build({ registrations: permuted }).execute(localRequest());
      expect(result.blocks.map((block) => block.id)).toEqual(
        baseline.blocks.map((block) => block.id),
      );
      expect(result.sourceDocuments.map((document) => document.id)).toEqual(
        baseline.sourceDocuments.map((document) => document.id),
      );
      expect(result.compilation.compilationId).toBe(baseline.compilation.compilationId);
    }
  });

  it('INV-DET-001: repeats identically for an unchanged input', async () => {
    const first = await build().execute(localRequest());
    const second = await build().execute(localRequest());
    expect(second.compilation.compilationId).toBe(first.compilation.compilationId);
    expect(second.compilation.compiledContext).toBe(first.compilation.compiledContext);
    expect(second.blocks).toEqual(first.blocks);
  });

  it('changes the compilation when a source changes', async () => {
    const before = await build().execute(localRequest());
    const after = await build({
      sources: [
        { locator: 'notes/budgets.md', content: '# Budgets\n\nThe budget was raised.\n' },
        SOURCES[1]!,
        SOURCES[2]!,
      ],
    }).execute(localRequest());

    expect(after.compilation.compilationId).not.toBe(before.compilation.compilationId);
    const changed = after.sourceDocuments.find((document) => document.sourceType === 'markdown');
    const original = before.sourceDocuments.find((document) => document.sourceType === 'markdown');
    expect(changed?.contentHash).not.toBe(original?.contentHash);
    // Editing a source does not create a second logical document.
    expect(changed?.id).toBe(original?.id);
  });
});

describe('CompileLocalContextService: identity is not location', () => {
  it('DEC-028: moving a source does not change its document identity', async () => {
    const moved = REGISTRATIONS.map((entry) =>
      entry.sourceType === 'markdown' ? { ...entry, locator: 'archive/budgets.md' } : entry,
    );
    const movedSources = [
      { locator: 'archive/budgets.md', content: MARKDOWN_SOURCE },
      SOURCES[1]!,
      SOURCES[2]!,
    ];

    const before = await build().execute(localRequest());
    const after = await build({ registrations: moved, sources: movedSources }).execute(
      localRequest(),
    );

    expect(after.sourceDocuments.map((document) => document.id)).toEqual(
      before.sourceDocuments.map((document) => document.id),
    );
    expect(after.blocks.map((block) => block.id)).toEqual(before.blocks.map((block) => block.id));
    expect(after.compilation.compilationId).toBe(before.compilation.compilationId);
  });

  it('DEC-028: renaming the logical identity does change the document identity', async () => {
    const renamed = REGISTRATIONS.map((entry) =>
      entry.sourceType === 'markdown'
        ? { ...entry, identity: { namespace: 'vault:notes', key: 'renamed.md' } }
        : entry,
    );

    const before = await build().execute(localRequest());
    const after = await build({ registrations: renamed }).execute(localRequest());

    const beforeIds = new Set(before.sourceDocuments.map((document) => String(document.id)));
    const afterIds = new Set(after.sourceDocuments.map((document) => String(document.id)));
    expect([...afterIds].some((id) => !beforeIds.has(id))).toBe(true);
    expect(after.compilation.compilationId).not.toBe(before.compilation.compilationId);
  });
});

describe('CompileLocalContextService: control-plane rejections', () => {
  it('rejects two registrations of one logical source before reading anything', async () => {
    const reads: string[] = [];
    const recordingReader: SourceReader = {
      id: 'recording',
      version: '1',
      read: (request) => {
        reads.push(request.locator);
        return Promise.resolve({ content: MARKDOWN_SOURCE });
      },
    };

    const duplicated = [REGISTRATIONS[0]!, { ...REGISTRATIONS[0]!, locator: 'notes/copy.md' }];

    await expect(
      stage(build({ registrations: duplicated, reader: recordingReader }).execute(localRequest())),
    ).resolves.toBe('source-registration');
    expect(reads).toEqual([]);
  });

  it('accepts one identity per source type: the type is part of logical identity', async () => {
    const sameKey = [
      registration({
        sourceType: 'markdown',
        identity: { namespace: 'n', key: 'k' },
        locator: 'a.md',
      }),
      registration({
        sourceType: 'text',
        identity: { namespace: 'n', key: 'k' },
        locator: 'a.txt',
      }),
    ];
    const result = await build({
      registrations: sameKey,
      sources: [
        { locator: 'a.md', content: MARKDOWN_SOURCE },
        { locator: 'a.txt', content: TEXT_SOURCE },
      ],
    }).execute(localRequest());
    expect(result.sourceDocuments).toHaveLength(2);
  });

  it('INV-SCOPE-003: rejects a registration whose scope is not the request scope', async () => {
    // The fake store filters by scope, so the mismatch is injected by a store
    // that does not: the service must not trust the adapter to have filtered.
    const leakyStore: ControlStore = {
      id: 'leaky',
      version: '1',
      listSources: () =>
        Promise.resolve([registration({ scope: OTHER_SCOPE, locator: 'notes/budgets.md' })]),
    };
    const rejected = new CompileLocalContextService(
      serviceConfig(),
      wordTokenizer,
      new InMemorySourceReader([...SOURCES]),
      leakyStore,
      new FakeCandidateProvider(),
    );
    await expect(stage(rejected.execute(localRequest()))).resolves.toBe('source-registration');
  });

  it('INV-BLOCK-005: rejects a registration record that is not valid', async () => {
    // A raw store, so the record reaches the service exactly as an external
    // control plane would send it: the service is the runtime boundary here, and
    // it must not rely on an adapter having sanitized anything.
    const rawStore = (entry: unknown): ControlStore => ({
      id: 'raw',
      version: '1',
      listSources: () => Promise.resolve([entry] as never),
    });

    for (const invalid of [
      { ...REGISTRATIONS[0]!, schemaVersion: 2 },
      { ...REGISTRATIONS[0]!, sourceType: 'pdf' },
      { ...REGISTRATIONS[0]!, locator: '   ' },
      { ...REGISTRATIONS[0]!, identity: { namespace: '', key: 'k' } },
      { ...REGISTRATIONS[0]!, metadata: { when: new Date() } },
      { ...REGISTRATIONS[0]!, extra: true },
      { ...REGISTRATIONS[0]!, createdAt: '2026-02-31T00:00:00.000Z' },
      { ...REGISTRATIONS[0]!, title: 7 },
      null,
      'not a registration',
    ]) {
      const withRawStore = new CompileLocalContextService(
        serviceConfig(),
        wordTokenizer,
        new InMemorySourceReader([...SOURCES]),
        rawStore(invalid),
        new FakeCandidateProvider(),
      );
      await expect(
        stage(withRawStore.execute(localRequest())),
        JSON.stringify(invalid),
      ).resolves.toBe('source-registration');
    }
  });

  it('INV-ADAPTER-003: reports a control-store failure as a control-store stage failure', async () => {
    const failing: ControlStore = {
      id: 'failing',
      version: '1',
      listSources: () => Promise.reject(new Error('database unavailable')),
    };
    const withFailingStore = new CompileLocalContextService(
      serviceConfig(),
      wordTokenizer,
      new InMemorySourceReader([...SOURCES]),
      failing,
      new FakeCandidateProvider(),
    );
    await expect(stage(withFailingStore.execute(localRequest()))).resolves.toBe('control-store');
  });

  it('compiles nothing but fails cleanly when the scope has no sources', async () => {
    // An empty corpus is a valid state, and the compiler decides what an empty
    // candidate batch means: the service does not pre-empt that decision.
    const empty = build({ registrations: [] });
    await expect(empty.execute(localRequest())).resolves.toMatchObject({
      sourceDocuments: [],
      blocks: [],
      candidates: [],
    });
  });
});

describe('CompileLocalContextService: read and prepare failures', () => {
  it('INV-ADAPTER-003: reports an unreadable source as a source-read failure', async () => {
    await expect(stage(build({ sources: [SOURCES[0]!] }).execute(localRequest()))).resolves.toBe(
      'source-read',
    );
  });

  it('INV-ADAPTER-001: leaks no adapter error object into the issues', async () => {
    try {
      await build({ sources: [SOURCES[0]!] }).execute(localRequest());
      throw new Error('expected a rejection');
    } catch (cause) {
      const error = cause as LocalSourcePipelineError;
      expect(error.issues.length).toBeGreaterThan(0);
      // Issues must survive a JSON round trip unchanged: no Error, no cause, no
      // filesystem object.
      expect(JSON.parse(JSON.stringify(error.issues))).toEqual(error.issues);
      for (const detail of error.issues) {
        expect(Object.keys(detail).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      }
    }
  });

  it('reports a malformed conversation file as a source-ingestion failure', async () => {
    await expect(
      stage(
        build({
          sources: [SOURCES[0]!, SOURCES[1]!, { locator: 'chats/thread-1.json', content: '{' }],
        }).execute(localRequest()),
      ),
    ).resolves.toBe('source-ingestion');
  });

  it('never lets a SyntaxError escape for a malformed conversation file', async () => {
    try {
      await build({
        sources: [SOURCES[0]!, SOURCES[1]!, { locator: 'chats/thread-1.json', content: 'nope' }],
      }).execute(localRequest());
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(LocalSourcePipelineError);
      expect(cause).not.toBeInstanceOf(SyntaxError);
    }
  });

  it('INV-BLOCK-007: reports malformed UTF-16 source content as an ingestion failure', async () => {
    await expect(
      stage(
        build({
          sources: [
            { locator: 'notes/budgets.md', content: 'lone \ud800 surrogate' },
            SOURCES[1]!,
            SOURCES[2]!,
          ],
        }).execute(localRequest()),
      ),
    ).resolves.toBe('source-ingestion');
  });

  it('does not disclose source content in a pipeline issue', async () => {
    try {
      await build({
        sources: [
          SOURCES[0]!,
          SOURCES[1]!,
          {
            locator: 'chats/thread-1.json',
            content: JSON.stringify({ schemaVersion: 1, messages: [{ id: 'm1', content: '  ' }] }),
          },
        ],
      }).execute(localRequest());
      throw new Error('expected a rejection');
    } catch (cause) {
      const rendered = JSON.stringify((cause as LocalSourcePipelineError).issues);
      expect(rendered).not.toContain('Four thousand tokens');
      expect(rendered).not.toContain(MARKDOWN_SOURCE);
    }
  });
});

describe('CompileLocalContextService: the provider seam', () => {
  it('INV-ALLOC-002: preserves the provider order exactly', async () => {
    const baseline = await build().execute(localRequest());
    const reversed = [...baseline.blocks].reverse().map((block) => String(block.id));

    const result = await build({
      provider: new FakeCandidateProvider({ blockIds: reversed }),
    }).execute(localRequest());

    expect(result.candidates.map((candidate) => String(candidate.block.id))).toEqual(reversed);
  });

  it('gives the provider the whole prepared corpus and the request data', async () => {
    let seen: { blocks: number; documents: number; query: string; time: string } | null = null;
    const observing: CandidateProvider = {
      id: 'observing',
      version: '1',
      getCandidates: (request) => {
        seen = {
          blocks: request.blocks.length,
          documents: request.sourceDocuments.length,
          query: request.query,
          time: request.referenceTime,
        };
        return Promise.resolve([]);
      },
    };

    const result = await build({ provider: observing }).execute(localRequest());
    expect(seen).toEqual({
      blocks: result.blocks.length,
      documents: 3,
      query: 'What is the token budget?',
      time: '2026-06-01T12:00:00.000Z',
    });
  });

  it('INV-ADAPTER-003: reports a provider failure as a candidate-provider failure', async () => {
    const failing: CandidateProvider = {
      id: 'failing',
      version: '1',
      getCandidates: () => Promise.reject(new Error('index unavailable')),
    };
    await expect(stage(build({ provider: failing }).execute(localRequest()))).resolves.toBe(
      'candidate-provider',
    );
  });

  it('rejects a provider result that is not an array', async () => {
    const wrong = {
      id: 'wrong',
      version: '1',
      getCandidates: () => Promise.resolve({ candidates: [] } as never),
    } as unknown as CandidateProvider;
    await expect(stage(build({ provider: wrong }).execute(localRequest()))).resolves.toBe(
      'candidate-provider',
    );
  });

  it('DEC-039: rejects a rewritten corpus block at the prepared-corpus boundary', async () => {
    const forging: CandidateProvider = {
      id: 'forging',
      version: '1',
      getCandidates: (request) =>
        Promise.resolve(
          request.blocks.slice(0, 1).map((block) => ({
            schemaVersion: 1 as const,
            block: { ...block, tokenCount: block.tokenCount + 500 },
          })),
        ),
    };

    // The application proves prepared-corpus membership before the kernel is
    // reached, so a block that no longer equals the one this service prepared is
    // rejected here rather than downstream. `CandidateValidator` would also have
    // caught this particular forgery; it cannot catch every one, which is why
    // the boundary exists (see local-corpus-provenance.test.ts).
    await expect(stage(build({ provider: forging }).execute(localRequest()))).resolves.toBe(
      'candidate-provider',
    );
  });

  it('INV-DEP-003: leaves candidate schema validation to the compiler, unchanged', async () => {
    const malformed: CandidateProvider = {
      id: 'malformed',
      version: '1',
      // No inspectable block identifier, so the application boundary adds no
      // issue and the kernel keeps sole ownership of the schema rules.
      getCandidates: () => Promise.resolve([{ schemaVersion: 9 } as never]),
    };

    try {
      await build({ provider: malformed }).execute(localRequest());
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ContextCompilationError);
      expect(cause).not.toBeInstanceOf(LocalSourcePipelineError);
    }
  });
});

describe('CompileLocalContextService: strict configuration and request', () => {
  it('rejects a configuration that is not the documented shape', () => {
    for (const config of [
      null,
      {},
      serviceConfig({ schemaVersion: 2 }),
      serviceConfig({ markdownChunking: { targetTokens: 0, maxTokens: 1 } }),
      serviceConfig({ textChunking: { targetTokens: 10, maxTokens: 1 } }),
      serviceConfig({ compiler: { schemaVersion: 1, compilerId: 'x' } }),
      { ...serviceConfig(), extra: true },
    ]) {
      expect(
        () =>
          new CompileLocalContextService(
            config,
            wordTokenizer,
            new InMemorySourceReader([]),
            storeOf([]),
            new FakeCandidateProvider(),
          ),
        JSON.stringify(config),
      ).toThrow(LocalSourcePipelineError);
    }
  });

  it('rejects a dependency that does not satisfy its port', () => {
    const good = {
      reader: new InMemorySourceReader([]),
      store: storeOf([]),
      provider: new FakeCandidateProvider(),
    };
    for (const broken of [
      { ...good, reader: {} as never },
      { ...good, store: { id: 's', version: '1' } as never },
      { ...good, provider: { id: '', version: '1', getCandidates: (): never => null as never } },
    ]) {
      expect(
        () =>
          new CompileLocalContextService(
            serviceConfig(),
            wordTokenizer,
            broken.reader,
            broken.store,
            broken.provider as never,
          ),
      ).toThrow(LocalSourcePipelineError);
    }
  });

  it('INV-DET-004: requires an exact reference time and injects no clock value', async () => {
    for (const referenceTime of [undefined, '', 'now', Date.now(), '2026-06-01T12:00:00']) {
      const request = localRequest();
      if (referenceTime === undefined) delete request.referenceTime;
      else request.referenceTime = referenceTime;
      await expect(stage(build().execute(request)), String(referenceTime)).resolves.toBe(
        'request-validation',
      );
    }
  });

  it('INV-SCOPE-001: requires an explicit scope with no local default', async () => {
    const request = localRequest();
    delete request.scope;
    await expect(stage(build().execute(request))).resolves.toBe('request-validation');
  });

  it('requires an explicit budget and policy with no default', async () => {
    for (const field of ['budget', 'policy', 'id']) {
      const request = localRequest();
      delete request[field];
      await expect(stage(build().execute(request)), field).resolves.toBe('request-validation');
    }
  });

  it('rejects an unknown request field rather than stripping it', async () => {
    await expect(stage(build().execute({ ...localRequest(), extra: 1 }))).resolves.toBe(
      'request-validation',
    );
  });

  it('INV-DEP-003: lets the compiler reject an invalid policy, unchanged', async () => {
    const request = localRequest();
    (request.policy as Record<string, unknown>).ordering = {
      schemaVersion: 1,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'score-desc',
    };
    try {
      await build().execute(request);
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ContextCompilationError);
      expect((cause as ContextCompilationError).stage).toBe('request-validation');
    }
  });
});

describe('CompileLocalContextService: immutability', () => {
  it('mutates neither the registrations nor the request it is given', async () => {
    const registrations = structuredClone(REGISTRATIONS);
    const snapshot = structuredClone(registrations);
    const request = localRequest();
    const requestSnapshot = structuredClone(request);

    await build({ registrations }).execute(request);

    expect(registrations).toEqual(snapshot);
    expect(request).toEqual(requestSnapshot);
  });

  it('DEC-037: keeps the settled trace free of raw query, content, and compiled context', async () => {
    const result = await build().execute(localRequest());
    const rendered = JSON.stringify(result.compilation.trace);

    expect(rendered).not.toContain('What is the token budget?');
    expect(rendered).not.toContain('The available input budget');
    expect(rendered).not.toContain(result.compilation.compiledContext);
    expect(rendered).not.toContain('notes/budgets.md');
  });
});

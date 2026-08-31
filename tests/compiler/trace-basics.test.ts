import {
  COMPILATION_TRACE_SCHEMA_VERSION,
  CompilationTraceError,
  TraceBuilder,
  type CompilationTrace,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  TRACE_CONFIG,
  buildTrace,
  candidateOf,
  contextBlock,
  issueCodesOf,
  issuesOf,
  runPipeline,
  sourceDocument,
  trace,
  tracePolicy,
} from './trace-fixtures.js';

/**
 * The trace builder's configuration, its schema, and its privacy boundary
 * (DEC-037).
 */

const SPECS = [
  { id: 'alpha', tokens: 3, priority: 800 },
  { id: 'beta', tokens: 4, priority: 200 },
] as const;

describe('TraceBuilder configuration', () => {
  it('accepts an explicit compiler identity and version', () => {
    const built = buildTrace(runPipeline({ specs: SPECS }), {
      compilerId: 'ctxalloc-compiler',
      compilerVersion: '0.14.0',
    });
    expect(built.composition.compiler).toEqual({
      id: 'ctxalloc-compiler',
      version: '0.14.0',
    });
  });

  it('preserves exact identity strings without trimming or lowercasing', () => {
    const built = buildTrace(runPipeline({ specs: SPECS }), {
      compilerId: '  CtxAlloc Compiler  ',
      compilerVersion: '0.14.0-RC.1+Build ',
    });
    expect(built.composition.compiler).toEqual({
      id: '  CtxAlloc Compiler  ',
      version: '0.14.0-RC.1+Build ',
    });
  });

  it.each([
    ['an empty identifier', { compilerId: '', compilerVersion: '1' }],
    ['a whitespace-only identifier', { compilerId: '   ', compilerVersion: '1' }],
    ['an empty version', { compilerId: 'c', compilerVersion: '' }],
    ['a whitespace-only version', { compilerId: 'c', compilerVersion: '\t\n' }],
    ['a malformed UTF-16 identifier', { compilerId: 'c\uD800', compilerVersion: '1' }],
    ['a malformed UTF-16 version', { compilerId: 'c', compilerVersion: '\uDC00' }],
    ['a missing identifier', { compilerVersion: '1' }],
    ['a missing version', { compilerId: 'c' }],
    ['a non-string identifier', { compilerId: 1, compilerVersion: '1' }],
    ['an unknown field', { compilerId: 'c', compilerVersion: '1', gitSha: 'abc' }],
    ['no fields at all', {}],
  ])('rejects %s', (_label, config) => {
    expect(() => new TraceBuilder(config)).toThrow(CompilationTraceError);
    expect(issueCodesOf(() => new TraceBuilder(config))).toContain('invalid_config');
  });

  it('publishes a stable top-level error code and no validation-library error', () => {
    try {
      new TraceBuilder({});
    } catch (error) {
      const failure = error as CompilationTraceError;
      expect(failure.code).toBe('COMPILATION_TRACE_BUILD_FAILED');
      expect(failure.name).toBe('CompilationTraceError');
      expect(Object.keys(failure)).not.toContain('cause');
      for (const issue of failure.issues) {
        expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      }
      return;
    }
    throw new Error('expected the empty config to be rejected');
  });

  it('INV-DET-003: injects no default and discovers no compiler version', () => {
    // A configuration that omits the version is rejected rather than filled in
    // from a manifest, a git revision, or an environment variable.
    expect(issuesOf(() => new TraceBuilder({ compilerId: 'c' })).map((i) => i.pointer)).toContain(
      'compilerVersion',
    );
  });
});

describe('a basic compilation trace', () => {
  it('traces a coherent pipeline with no candidates at all', () => {
    const built = trace({ specs: [], sourceDocuments: [] });

    expect(built.groups).toEqual([]);
    expect(built.sources).toEqual([]);
    expect(built.ordering.orderedBlockIds).toEqual([]);
    expect(built.allocation.includedBlockIds).toEqual([]);
    expect(built.totals.candidateCount).toBe(0);
    expect(built.totals.candidateTokens).toBe(0);
  });

  it('publishes schema version 1 and settled false', () => {
    const built = trace({ specs: SPECS });
    expect(built.schemaVersion).toBe(1);
    expect(built.schemaVersion).toBe(COMPILATION_TRACE_SCHEMA_VERSION);
    expect(built.settled).toBe(false);
  });

  it('records the request identity, fingerprint, scope, reference time, and budget', () => {
    const built = trace({ specs: SPECS, available: 50 });

    expect(built.request.id).toBe('req-trace-1');
    expect(built.request.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.request.scope).toEqual({ tenantId: 'local', workspaceId: 'default' });
    expect(built.request.referenceTime).toBe('2026-06-01T12:00:00.000Z');
    expect(built.request.budget).toEqual({ totalTokens: 57, reservedOutputTokens: 7 });
    expect(built.request.candidateCount).toBe(2);
    expect(built.request.sourceDocumentCount).toBe(1);
  });

  it('INV-SEC-003: records the query as a hash and never as text', () => {
    const built = trace({ specs: SPECS, query: 'a very distinctive question' });

    expect(built.request.queryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(built.request)).not.toContain('query');
    expect(JSON.stringify(built)).not.toContain('a very distinctive question');
  });

  it('the query hash changes with the exact query and is domain-separated', () => {
    const first = trace({ specs: SPECS, query: 'one' }).request.queryHash;
    const second = trace({ specs: SPECS, query: 'one ' }).request.queryHash;
    const empty = trace({ specs: SPECS, query: '' }).request.queryHash;

    expect(second).not.toBe(first);
    expect(empty).not.toBe(first);
    // A different digest label means the query hash can never equal a rendered
    // context hash that happened to cover the same string.
    expect(
      trace({ specs: [], sourceDocuments: [], query: '' }).rendering.renderedContextHash,
    ).not.toBe(empty);
  });

  it('INV-TRACE-005: records the compiler, policy, tokenizer, and renderer identities', () => {
    const built = trace({ specs: SPECS });

    expect(built.composition).toEqual({
      compiler: { id: 'ctxalloc-compiler', version: '0.14.0' },
      policy: {
        compilation: { id: 'composition', version: '1.0.0' },
        scoring: { id: 'scoring', version: '1.0.0' },
        filtering: { id: 'filtering', version: '3.0.0' },
        allocation: { id: 'allocation', version: '4.0.0' },
        ordering: { id: 'ordering', version: '5.0.0' },
        rendering: { id: 'rendering', version: '6.0.0' },
      },
      tokenizer: { id: 'test:word', version: '1' },
      // The renderer's tokenizer, and only that: no stage contract carries the
      // identity that produced the validated block counts (DEC-035, DEC-037).
      tokenizerCoverage: 'rendering-attempt-only',
      renderer: { id: 'ctxalloc-jsonl', version: '1' },
    });
  });

  it('INV-STORE-004: survives a JSON round trip with deep equality', () => {
    const built = trace({ specs: SPECS });
    const roundTripped = JSON.parse(JSON.stringify(built)) as CompilationTrace;

    // `toStrictEqual` distinguishes an absent optional key from one present with
    // `undefined`, which is exactly what a persisted record must not confuse.
    expect(roundTripped).toStrictEqual(built);
  });

  it('contains no Date, Map, Set, function, class instance, or undefined member', () => {
    const built = trace({
      specs: [
        { id: 'alpha', tokens: 3, priority: 800, category: 'facts', required: true },
        { id: 'beta', tokens: 4, priority: 200 },
      ],
    });

    const inspect = (value: unknown, path: string): void => {
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((entry, index) => {
          expect(entry, `${path}[${String(index)}] is undefined`).toBeDefined();
          inspect(entry, `${path}[${String(index)}]`);
        });
        return;
      }
      if (typeof value === 'object') {
        expect(value instanceof Date, `${path} is a Date`).toBe(false);
        expect(value instanceof Map, `${path} is a Map`).toBe(false);
        expect(value instanceof Set, `${path} is a Set`).toBe(false);
        expect(value instanceof Error, `${path} is an Error`).toBe(false);
        expect(Object.getPrototypeOf(value), `${path} is a class instance`).toBe(Object.prototype);
        for (const [key, entry] of Object.entries(value)) {
          expect(entry, `${path}.${key} is undefined`).not.toBeUndefined();
          inspect(entry, `${path}.${key}`);
        }
        return;
      }
      expect(['string', 'number', 'boolean'], `${path} is a ${typeof value}`).toContain(
        typeof value,
      );
    };

    inspect(built, 'trace');
  });
});

describe('INV-SEC-003: no raw content reaches the trace', () => {
  /** Values that exist nowhere but in the inputs the trace must not copy. */
  const SECRETS = {
    content: 'sentinel-block-content-zq1',
    query: 'sentinel-query-zq2',
    sourceMetadata: 'sentinel-source-metadata-zq3',
    blockMetadata: 'sentinel-block-metadata-zq4',
    retrievalMetadata: 'sentinel-retrieval-metadata-zq5',
    sourceTitle: 'sentinel-source-title-zq6',
  } as const;

  function secretRun(): ReturnType<typeof runPipeline> {
    const block = contextBlock({
      id: 'secret-block',
      content: `${SECRETS.content} alpha beta`,
      metadata: { note: SECRETS.blockMetadata },
    });
    return runPipeline({
      query: SECRETS.query,
      policy: tracePolicy({
        scoring: {
          schemaVersion: 1,
          policyId: 'scoring',
          policyVersion: '1.0.0',
          authoredPriority: { weight: 1, min: 0, max: 1000 },
          retrieval: {
            weight: 1,
            aggregation: 'max',
            rules: [
              {
                ruleId: 'cosine',
                providerId: 'sqlite-fts5',
                providerVersion: '1.2.3',
                semantics: 'cosine-similarity',
                higherIsBetter: true,
                min: 0,
                max: 1,
              },
            ],
          },
        },
      }),
      sourceDocuments: [
        sourceDocument({ title: SECRETS.sourceTitle, metadata: { path: SECRETS.sourceMetadata } }),
      ],
      candidates: [
        {
          schemaVersion: 1,
          block,
          retrieval: {
            providerId: 'sqlite-fts5',
            providerVersion: '1.2.3',
            rank: 2,
            score: { value: 0.75, semantics: 'cosine-similarity', higherIsBetter: true },
            metadata: { snippet: SECRETS.retrievalMetadata },
          },
        },
      ],
    });
  }

  it('carries none of the sentinel secrets anywhere in the serialized trace', () => {
    const run = secretRun();
    const serialized = JSON.stringify(buildTrace(run));

    // Every sentinel is genuinely present in the inputs, so the assertion below
    // proves omission rather than absence.
    expect(run.rendered.renderedContext).toContain(SECRETS.content);
    expect(run.request.query).toBe(SECRETS.query);

    for (const [field, secret] of Object.entries(SECRETS)) {
      expect(serialized, `trace leaks ${field}`).not.toContain(secret);
    }
  });

  it('keeps the identities, hashes, and decisions an audit needs', () => {
    const built = buildTrace(secretRun());
    const group = built.groups[0];
    if (group === undefined) throw new Error('expected one group');

    expect(group.canonical.id).toBe('secret-block');
    expect(group.canonical.sourceDocumentId).toBe('doc-1');
    expect(group.canonical.normalizedContentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(group.members[0]?.retrieval).toEqual({
      providerId: 'sqlite-fts5',
      providerVersion: '1.2.3',
      rank: 2,
      score: { value: 0.75, semantics: 'cosine-similarity', higherIsBetter: true },
    });
    expect(built.rendering.renderedContextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.sources[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('declares no field that could carry content or arbitrary metadata', () => {
    const built = buildTrace(secretRun());
    const group = built.groups[0];
    if (group === undefined) throw new Error('expected one group');

    for (const forbidden of ['content', 'metadata', 'renderedContext', 'query', 'title']) {
      expect(Object.keys(group.canonical), `canonical exposes ${forbidden}`).not.toContain(
        forbidden,
      );
      expect(Object.keys(built.request), `request exposes ${forbidden}`).not.toContain(forbidden);
      expect(Object.keys(built.rendering), `rendering exposes ${forbidden}`).not.toContain(
        forbidden,
      );
      for (const source of built.sources) {
        expect(Object.keys(source), `source exposes ${forbidden}`).not.toContain(forbidden);
      }
      for (const member of group.members) {
        expect(Object.keys(member), `member exposes ${forbidden}`).not.toContain(forbidden);
        expect(
          Object.keys(member.retrieval ?? {}),
          `member retrieval exposes ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
  });
});

describe('INV-PROV-001: sources are traceable and minimal', () => {
  it('records every included canonical block with its source document', () => {
    const built = trace({
      specs: [
        { id: 'alpha', tokens: 3, priority: 800 },
        { id: 'beta', tokens: 4, priority: 200 },
      ],
    });

    for (const group of built.groups) {
      expect(group.canonical.sourceDocumentId).toBe('doc-1');
      for (const member of group.members) expect(member.sourceDocumentId).toBe('doc-1');
    }
    expect(built.sources.map((source) => source.id)).toEqual(['doc-1']);
  });

  it('INV-DET-002: orders sources by identity with code units, never by locale', () => {
    // Under a locale collation "a" sorts before "B"; by UTF-16 code unit it does
    // not, and the trace must use the project-owned comparison.
    const documents = [
      sourceDocument({ id: 'a-doc' }),
      sourceDocument({ id: 'B-doc' }),
      sourceDocument({ id: 'A-doc' }),
    ];
    const built = trace({
      specs: [],
      sourceDocuments: documents,
      policy: tracePolicy(),
    });

    expect(built.sources.map((source) => source.id)).toEqual(['A-doc', 'B-doc', 'a-doc']);
    expect(['a-doc', 'A-doc', 'B-doc']).not.toEqual(built.sources.map((source) => source.id));
  });

  it('records exactly id, source type, and content hash', () => {
    const built = trace({ specs: [] });
    const source = built.sources[0];
    if (source === undefined) throw new Error('expected one source');

    expect(Object.keys(source).sort()).toEqual(['contentHash', 'id', 'sourceType']);
    expect(source.sourceType).toBe('markdown');
  });

  it('does not depend on the registry order the caller supplied', () => {
    const documents = [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })];
    const forward = trace({ specs: [], sourceDocuments: documents });
    const reversed = trace({ specs: [], sourceDocuments: [...documents].reverse() });

    expect(reversed.sources).toStrictEqual(forward.sources);
  });
});

describe('the trace builder is reachable only through the documented contract', () => {
  it('accepts the documented build input and returns the documented trace', () => {
    const run = runPipeline({ specs: SPECS });
    const built: CompilationTrace = new TraceBuilder({ ...TRACE_CONFIG }).build({
      request: run.request,
      validated: run.validated,
      deduplicated: run.deduplicated,
      filtered: run.filtered,
      rendered: run.rendered,
    });

    expect(Object.keys(built).sort()).toEqual([
      'allocation',
      'composition',
      'groups',
      'ordering',
      'rendering',
      'request',
      'schemaVersion',
      'settled',
      'sources',
      'totals',
    ]);
  });

  it('takes no scored, allocated, or ordered field it can already reach', () => {
    const run = runPipeline({ specs: SPECS });
    expect(Object.keys(run.input).sort()).toEqual([
      'deduplicated',
      'filtered',
      'rendered',
      'request',
      'validated',
    ]);

    // The redundant evidence is reachable through the nested contracts.
    expect(run.input.filtered.scored).toBe(run.scored);
    expect(run.input.rendered.ordered).toBe(run.ordered);
    expect(run.input.rendered.ordered.allocation).toBe(run.allocated);
  });

  it('traces a request whose candidates all deduplicate into one group', () => {
    const wrapper = candidateOf({ id: 'same', tokens: 3 });
    const built = trace({ candidates: [wrapper, wrapper, wrapper] });

    expect(built.groups).toHaveLength(1);
    expect(built.groups[0]?.members).toHaveLength(3);
    expect(built.request.candidateCount).toBe(3);
  });

  it('rejects a request record the validator never produced', () => {
    // The build input is a stage contract, but a request that does not describe
    // the evidence is still refused rather than traced.
    const run = runPipeline({ specs: SPECS });
    const other = runPipeline({ specs: [{ id: 'gamma', tokens: 2 }] });

    expect(() =>
      new TraceBuilder({ ...TRACE_CONFIG }).build({ ...run.input, request: other.request }),
    ).toThrow(CompilationTraceError);
  });
});

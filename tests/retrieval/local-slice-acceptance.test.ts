import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  MiniSearchCandidateProvider,
  NodeFileSourceReader,
} from '@ctxalloc/adapters';
import { CompileLocalContextService, type LocalCompilationResult } from '@ctxalloc/application';
import { availableInputTokens } from '@ctxalloc/domain';
import type { SourceRegistration } from '@ctxalloc/ports';
import { InMemoryControlStore } from '@ctxalloc/testing';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Phase 16 local slice, driven by the first real retrieval provider
 * (DEC-041).
 *
 * Every component here is the shipping one: a real temporary directory, the real
 * `NodeFileSourceReader`, the real `O200kBaseTokenizer`, the real chunkers, the
 * real `MiniSearchCandidateProvider`, and the real `ContextCompiler`. Only the
 * control store is a test double, because no control-plane persistence exists
 * yet.
 *
 * Nothing reaches a network, a model, or a database. The Phase 16 provenance
 * boundary is **unchanged** and still the application's final trust boundary:
 * the provider being real is not a reason to trust it (DEC-039).
 */

const HANDBOOK = `# Budget handbook

The compiler receives candidate context blocks and selects a minimal sufficient
subset under a strict token budget.

## Reticulator

The quantum reticulator calibrates the allocator before every compilation run.

## Rendering

The renderer serializes every selected block as exactly one JSON line.
`;

const DISTRACTORS = `The gardener repotted the fern on a rainy afternoon.

Ferry timetables change without warning in October.

Sourdough needs a long cold proof in the refrigerator overnight.

Migrating storks pass over the valley twice a year without fail.
`;

const REGISTRATIONS: readonly SourceRegistration[] = [
  {
    schemaVersion: 1,
    scope: { tenantId: 'local', workspaceId: 'retrieval' },
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'handbook.md' },
    locator: 'handbook.md',
    title: 'Budget handbook',
    metadata: {},
  },
  {
    schemaVersion: 1,
    scope: { tenantId: 'local', workspaceId: 'retrieval' },
    sourceType: 'text',
    identity: { namespace: 'vault:docs', key: 'distractors.txt' },
    locator: 'distractors.txt',
    metadata: {},
  },
];

const SCOPE = { tenantId: 'local', workspaceId: 'retrieval' };
const OTHER_SCOPE = { tenantId: 'local', workspaceId: 'elsewhere' };
const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';
const QUERY = 'reticulator calibrates the allocator';
const MAX_CANDIDATES = 4;

function policy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'retrieval-local',
    policyVersion: '1.0.0',
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
            ruleId: 'minisearch-bm25plus',
            providerId: MINISEARCH_CANDIDATE_PROVIDER_ID,
            providerVersion: MINISEARCH_CANDIDATE_PROVIDER_VERSION,
            semantics: MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
            higherIsBetter: true,
            min: 0,
            max: 1000,
          },
        ],
      },
    },
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '1.0.0',
      minimumTotalScore: 0,
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'rendering',
      policyVersion: '1.0.0',
      format: 'jsonl-blocks',
    },
  };
}

function serviceConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compiler: {
      schemaVersion: 1,
      compilerId: 'ctxalloc-local',
      compilerVersion: '1.0.0',
      maxCorrectionSelections: 64,
    },
    markdownChunking: { targetTokens: 40, maxTokens: 80 },
    textChunking: { targetTokens: 40, maxTokens: 80 },
  };
}

function localRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'retrieval-request-1',
    scope: { ...SCOPE },
    query: QUERY,
    referenceTime: REFERENCE_TIME,
    budget: { totalTokens: 4000, reservedOutputTokens: 500 },
    policy: policy(),
    ...overrides,
  };
}

let root: string;
let tokenizer: O200kBaseTokenizer;
let result: LocalCompilationResult;

function buildService(
  registrations: readonly SourceRegistration[] = REGISTRATIONS,
  maxCandidates = MAX_CANDIDATES,
): CompileLocalContextService {
  return new CompileLocalContextService(
    serviceConfig(),
    tokenizer,
    new NodeFileSourceReader({ rootDirectory: root, maxBytes: 1_000_000 }),
    new InMemoryControlStore(registrations),
    new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates }),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxalloc-retrieval-'));
  await writeFile(join(root, 'handbook.md'), HANDBOOK, 'utf8');
  await writeFile(join(root, 'distractors.txt'), DISTRACTORS, 'utf8');
  tokenizer = new O200kBaseTokenizer();
  result = await buildService().execute(localRequest());
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('Phase 18 local acceptance: real sources through real retrieval to a real compilation', () => {
  it('compiles successfully from files on disk', () => {
    expect(result.compilation.compiledContext).toBeTypeOf('string');
    expect(result.compilation.includedBlocks.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBeGreaterThan(4);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('proposes only blocks of the prepared corpus', () => {
    const prepared = new Set(result.blocks.map((entry) => entry.id));
    for (const candidate of result.candidates) expect(prepared.has(candidate.block.id)).toBe(true);
  });

  it('DEC-039: every proposed block is structurally identical to the prepared block', () => {
    // This is the guarantee the Phase 16 provenance boundary enforces, restated
    // as an observation: the service accepted this batch, so every block matched
    // its prepared counterpart in every field.
    const prepared = new Map(result.blocks.map((entry) => [entry.id, JSON.stringify(entry)]));
    for (const candidate of result.candidates) {
      expect(JSON.stringify(candidate.block)).toBe(prepared.get(candidate.block.id));
    }
  });

  it('ranks the lexically relevant block first, above every distractor', () => {
    // The query's rare terms decide the top of the ranking. A distractor can
    // still appear far below it on a shared common word — this retriever applies
    // no stop-word list, and pretending otherwise would be a claim the library
    // does not support — so the assertion is about rank, not about presence.
    const [first, ...rest] = result.candidates;
    expect(first?.block.content).toContain('reticulator');
    const topScore = first?.retrieval?.score?.value ?? 0;
    for (const candidate of rest) {
      expect(candidate.block.content).not.toContain('reticulator');
      expect(candidate.retrieval?.score?.value ?? 0).toBeLessThan(topScore);
    }
  });

  it('carries truthful retrieval evidence on every candidate', () => {
    result.candidates.forEach((candidate, index) => {
      expect(candidate.retrieval?.providerId).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
      expect(candidate.retrieval?.providerVersion).toBe(MINISEARCH_CANDIDATE_PROVIDER_VERSION);
      expect(candidate.retrieval?.score?.semantics).toBe(MINISEARCH_RETRIEVAL_SCORE_SEMANTICS);
      expect(candidate.retrieval?.score?.higherIsBetter).toBe(true);
      expect(Number.isFinite(candidate.retrieval?.score?.value)).toBe(true);
      expect(candidate.retrieval?.rank).toBe(index);
    });
  });

  it('enforces maxCandidates as a retrieval bound', async () => {
    expect(result.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    const bounded = await buildService(REGISTRATIONS, 1).execute(localRequest());
    expect(bounded.candidates).toHaveLength(1);
    expect(bounded.candidates[0]?.block.id).toBe(result.candidates[0]?.block.id);
  });

  it('INV-BUDGET-001: the compiled context fits the available budget', () => {
    const available = availableInputTokens({ totalTokens: 4000, reservedOutputTokens: 500 });
    expect(result.compilation.usage.compiledTokens).toBeLessThanOrEqual(available);
    expect(result.compilation.usage.availableTokens).toBe(available);
  });

  it('INV-DET-001: two runs over the same sources produce an identical compilation', async () => {
    const again = await buildService().execute(localRequest());
    expect(again.compilation.compilationId).toEqual(result.compilation.compilationId);
    expect(JSON.stringify(again.candidates)).toBe(JSON.stringify(result.candidates));
    expect(JSON.stringify(again.compilation)).toBe(JSON.stringify(result.compilation));
  });

  it('INV-DET-002: registration order does not change the retrieval result', async () => {
    const reversed = await buildService([...REGISTRATIONS].reverse()).execute(localRequest());
    expect(JSON.stringify(reversed.blocks)).toBe(JSON.stringify(result.blocks));
    expect(JSON.stringify(reversed.candidates)).toBe(JSON.stringify(result.candidates));
  });

  it('INV-SCOPE-005: a request for another scope reaches no block of this one', async () => {
    // The control store answers a different scope with no registrations, so the
    // prepared corpus is empty and retrieval has nothing to search. Not one
    // block of this workspace can reach that request, and the provider proposes
    // nothing rather than falling back to some other corpus.
    const other = await buildService().execute(
      localRequest({ id: 'other-scope', scope: { ...OTHER_SCOPE } }),
    );
    expect(other.blocks).toEqual([]);
    expect(other.candidates).toEqual([]);
    expect(other.compilation.includedBlocks).toEqual([]);
  });

  it('INV-SEC-003: the settled trace carries no query, no content, and no retrieval metadata', () => {
    const trace = JSON.stringify(result.compilation.trace);
    expect(trace).not.toContain(QUERY);
    expect(trace).not.toContain('reticulator');
    expect(trace).not.toContain('sourdough');
    expect(trace).not.toContain('storks');
    expect(trace).not.toContain('Budget handbook');

    // Trace privacy is unchanged by Phase 18. The trace records provider
    // identity, rank, and score *because* INV-SCORE-001 requires the score
    // components that affected allocation to be visible — a provider score that
    // moved a decision and left no record would be an unexplained decision. What
    // it still carries is no arbitrary provider metadata, and this provider
    // publishes none to carry.
    expect(trace).toContain(MINISEARCH_CANDIDATE_PROVIDER_ID);
    expect(trace).toContain(MINISEARCH_RETRIEVAL_SCORE_SEMANTICS);
    expect(trace).not.toContain('"metadata"');
  });

  it('INV-ADAPTER-004: the provider leaves no artefact in the source directory', async () => {
    // The index is in memory. There is no database file, no cache directory, and
    // no lock file to clean up, so there is nothing to leak between runs.
    const entries = await readdir(root);
    expect(entries.sort()).toEqual(['distractors.txt', 'handbook.md']);
  });

  it('does not mutate the prepared corpus it published', async () => {
    const before = JSON.stringify(result.blocks);
    await buildService().execute(localRequest());
    expect(JSON.stringify(result.blocks)).toBe(before);
  });
});

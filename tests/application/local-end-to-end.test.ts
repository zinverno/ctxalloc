import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSourceReader } from '@ctxalloc/adapters';
import { CompileLocalContextService, type LocalCompilationResult } from '@ctxalloc/application';
import { availableInputTokens } from '@ctxalloc/domain';
import type { SourceRegistration } from '@ctxalloc/ports';
import { FakeCandidateProvider, InMemoryControlStore } from '@ctxalloc/testing';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SCOPE,
  localRequest,
  permutations,
  registration,
  serviceConfig,
} from './local-service-fixtures.js';

/**
 * The real local vertical slice, end to end (DEC-039).
 *
 * Every component here is the shipping one: a real temporary directory, the real
 * `NodeFileSourceReader`, the real `O200kBaseTokenizer`, the real chunkers, and
 * the real `ContextCompiler`. Only the control store and the candidate provider
 * are test doubles, because no control-plane persistence and no retrieval backend
 * exist yet.
 *
 * Nothing reaches a network, a model, or a database.
 */

const README = `# CtxAlloc budgets

The compiler receives candidate context blocks and selects a minimal sufficient
subset under a strict token budget.

## Rendering

The final rendered context is tokenized before success is returned.
`;

const NOTES = `A scratch note about traces.

Every validated candidate finishes as exactly one final decision.

A third paragraph mentioning scope isolation and provenance.
`;

const CONVERSATION = JSON.stringify(
  {
    schemaVersion: 1,
    messages: [
      { id: 'msg-1', content: 'How many tokens are available for input?' },
      {
        id: 'msg-2',
        content: 'Four thousand total, minus five hundred reserved for the output.',
      },
    ],
  },
  null,
  2,
);

const REGISTRATIONS: readonly SourceRegistration[] = [
  registration({
    sourceType: 'markdown',
    identity: { namespace: 'vault:docs', key: 'README.md' },
    locator: 'README.md',
    title: 'CtxAlloc budgets',
    metadata: { path: 'README.md' },
  }),
  registration({
    sourceType: 'text',
    identity: { namespace: 'vault:docs', key: 'notes.txt' },
    locator: 'notes.txt',
  }),
  registration({
    sourceType: 'conversation',
    identity: { namespace: 'chat:local', key: 'conversation-1' },
    locator: 'conversation.json',
  }),
];

let root: string;
let tokenizer: O200kBaseTokenizer;

function buildService(
  registrations: readonly SourceRegistration[] = REGISTRATIONS,
): CompileLocalContextService {
  return new CompileLocalContextService(
    serviceConfig(),
    tokenizer,
    new NodeFileSourceReader({ rootDirectory: root, maxBytes: 1_000_000 }),
    new InMemoryControlStore(registrations),
    new FakeCandidateProvider(),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ctxalloc-e2e-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'README.md'), README, 'utf8');
  await writeFile(join(root, 'notes.txt'), NOTES, 'utf8');
  await writeFile(join(root, 'conversation.json'), CONVERSATION, 'utf8');
  tokenizer = new O200kBaseTokenizer();
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

describe('local vertical slice: real files, real tokenizer, real compiler', () => {
  let result: LocalCompilationResult;

  beforeAll(async () => {
    result = await buildService().execute(localRequest());
  });

  it('reads all three registered source types from disk', () => {
    expect(result.sourceDocuments).toHaveLength(3);
    expect(result.sourceDocuments.map((document) => document.sourceType).sort()).toEqual([
      'conversation',
      'markdown',
      'text',
    ]);
    expect(result.blocks.length).toBeGreaterThanOrEqual(5);
  });

  it('INV-BLOCK-006: every text-range block reconstructs its exact source slice', () => {
    const contents = new Map<string, string>([
      [documentIdFor('markdown'), README],
      [documentIdFor('text'), NOTES],
    ]);

    let checked = 0;
    for (const block of result.blocks) {
      const location = block.sourceLocation;
      if (location?.kind !== 'text-range') continue;
      const source = contents.get(String(block.sourceDocumentId));
      expect(source, `no source for ${String(block.sourceDocumentId)}`).toBeDefined();
      if (source === undefined) continue;

      expect(location.startOffset).toBeGreaterThanOrEqual(0);
      expect(location.startOffset).toBeLessThanOrEqual(location.endOffset);
      expect(location.endOffset).toBeLessThanOrEqual(source.length);
      expect(block.content).toBe(source.slice(location.startOffset, location.endOffset));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('INV-PROV-002: every conversation block resolves to exactly one real message', () => {
    const messages = (JSON.parse(CONVERSATION) as { messages: { id: string; content: string }[] })
      .messages;

    const conversationBlocks = result.blocks.filter(
      (block) => block.sourceLocation?.kind === 'conversation-message',
    );
    expect(conversationBlocks).toHaveLength(messages.length);

    for (const block of conversationBlocks) {
      const location = block.sourceLocation;
      if (location?.kind !== 'conversation-message') continue;
      const matches = messages.filter((message) => message.id === location.messageId);
      expect(matches).toHaveLength(1);
      expect(messages[location.messageIndex ?? -1]?.id).toBe(location.messageId);
      expect(block.content).toBe(matches[0]?.content);
    }
  });

  it('INV-BLOCK-003: every block token count is the real tokenizer count of its content', () => {
    for (const block of result.blocks) {
      expect(block.tokenCount).toBe(tokenizer.countTokens(block.content));
    }
  });

  it('DEC-038: the compiler proves validation-and-rendering tokenizer coverage', () => {
    expect(result.compilation.trace.composition.tokenizerCoverage).toBe('validation-and-rendering');
    expect(result.compilation.trace.settled).toBe(true);
    expect(result.compilation.trace.composition.tokenizer).toMatchObject({
      id: tokenizer.id,
      version: tokenizer.version,
    });
  });

  it('INV-BUDGET-002: the compiled tokens are the tokenizer count of the compiled context', () => {
    expect(tokenizer.countTokens(result.compilation.compiledContext)).toBe(
      result.compilation.usage.compiledTokens,
    );
  });

  it('INV-BUDGET-001: the compiled context never exceeds the available budget', () => {
    const available = availableInputTokens({ totalTokens: 4000, reservedOutputTokens: 500 });
    expect(result.compilation.usage.availableTokens).toBe(available);
    expect(result.compilation.usage.compiledTokens).toBeLessThanOrEqual(available);
    expect(result.compilation.usage.unusedTokens).toBe(
      available - result.compilation.usage.compiledTokens,
    );
  });

  it('INV-TRACE-006: the result carries a settled trace that reconciles with the selection', () => {
    const trace = result.compilation.trace;
    expect(trace.settlement).toBeDefined();
    expect(trace.settlement.rendering.compiledTokens).toBe(result.compilation.usage.compiledTokens);
    expect(trace.settlement.usage.availableInputTokens).toBe(
      result.compilation.usage.availableTokens,
    );
    expect(trace.settlement.usage.unusedTokens).toBe(result.compilation.usage.unusedTokens);
    expect(trace.settlement.decisions.length).toBeGreaterThan(0);

    const included = trace.settlement.decisions.filter(
      (decision) => decision.disposition === 'included',
    );
    expect(included).toHaveLength(result.compilation.includedBlocks.length);
  });

  it('every included block came from a source document the result publishes', () => {
    const ids = new Set(result.sourceDocuments.map((document) => String(document.id)));
    for (const block of result.compilation.includedBlocks) {
      expect(ids.has(String(block.sourceDocumentId))).toBe(true);
    }
  });

  function documentIdFor(sourceType: string): string {
    const document = result.sourceDocuments.find((entry) => entry.sourceType === sourceType);
    if (document === undefined) throw new Error(`no ${sourceType} document`);
    return String(document.id);
  }
});

describe('local vertical slice: determinism against the real filesystem', () => {
  it('INV-DET-001: repeats identically for an unchanged working tree', async () => {
    const first = await buildService().execute(localRequest());
    const second = await buildService().execute(localRequest());

    expect(second.compilation.compilationId).toBe(first.compilation.compilationId);
    expect(second.compilation.compiledContext).toBe(first.compilation.compiledContext);
    expect(second.blocks.map((block) => block.id)).toEqual(first.blocks.map((block) => block.id));
  });

  it('INV-DET-002: registration order never changes the compilation identifier', async () => {
    const baseline = await buildService().execute(localRequest());

    for (const permuted of permutations(REGISTRATIONS)) {
      const result = await buildService(permuted).execute(localRequest());
      expect(result.compilation.compilationId).toBe(baseline.compilation.compilationId);
      expect(result.blocks.map((block) => block.id)).toEqual(
        baseline.blocks.map((block) => block.id),
      );
    }
  });

  it('an edited file changes the source hash, its blocks, and the compilation identifier', async () => {
    const before = await buildService().execute(localRequest());
    try {
      await writeFile(join(root, 'notes.txt'), `${NOTES}\nA fourth paragraph was added.\n`, 'utf8');
      const after = await buildService().execute(localRequest());

      const textDocument = (result: LocalCompilationResult): { id: string; hash: string } => {
        const document = result.sourceDocuments.find((entry) => entry.sourceType === 'text');
        if (document === undefined) throw new Error('no text document');
        return { id: String(document.id), hash: String(document.contentHash) };
      };

      // The logical source did not move or change identity, so its document id
      // is unchanged while its content hash and its blocks are not.
      expect(textDocument(after).id).toBe(textDocument(before).id);
      expect(textDocument(after).hash).not.toBe(textDocument(before).hash);
      expect(after.blocks.map((block) => block.id)).not.toEqual(
        before.blocks.map((block) => block.id),
      );
      expect(after.compilation.compilationId).not.toBe(before.compilation.compilationId);
    } finally {
      await writeFile(join(root, 'notes.txt'), NOTES, 'utf8');
    }
  });

  it('INV-SCOPE-004: compiles nothing for a scope with no registered sources', async () => {
    const other = await buildService().execute(
      localRequest({ scope: { ...SCOPE, workspaceId: 'empty' } }),
    );
    expect(other.sourceDocuments).toEqual([]);
    expect(other.blocks).toEqual([]);
    expect(other.candidates).toEqual([]);
  });
});

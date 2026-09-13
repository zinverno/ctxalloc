import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tokenizer } from '@ctxalloc/ports';
import { parseSettings, parseTasks, parseAnnotations } from '../../benchmarks/dogfood/schema.js';
import { prepare } from '../../benchmarks/dogfood/prepare.js';

/** Toy software fixtures only. These strings/judgments are never human dogfood evidence. */
export async function toy(tokenizer: Tokenizer) {
  const root = mkdtempSync(join(tmpdir(), 'ctxalloc-dogfood-test-')),
    base = join(root, 'pilot'),
    snapshot = join(base, 'snapshot');
  mkdirSync(snapshot, { recursive: true });
  const content = {
    markdown: '# alpha\n\nalpha proof.\n',
    text: 'alpha reference.\n\nbeta detail.\n',
    conversation: JSON.stringify({
      schemaVersion: 1,
      messages: [
        { id: 'm1', content: 'Speaker A: alpha recorded.' },
        { id: 'm2', content: 'Speaker B: beta acknowledged.' },
      ],
    }),
  };
  writeFileSync(join(snapshot, 'doc.md'), content.markdown);
  writeFileSync(join(snapshot, 'note.txt'), content.text);
  writeFileSync(join(snapshot, 'history.json'), content.conversation);
  const settings = parseSettings({
    schemaVersion: 1,
    experimentId: 'toy-only',
    sourceApprovalReference: 'test-created-public-toy-files',
    scope: { tenantId: 'toy', workspaceId: 'software-test' },
    snapshotRoot: 'snapshot',
    readerMaxBytes: 10000,
    markdownChunking: { targetTokens: 8, maxTokens: 32 },
    textChunking: { targetTokens: 8, maxTokens: 32 },
    availableTokens: 2000,
    reservedOutputTokens: 100,
    maxCandidates: 100,
    referenceTime: '2026-09-01T00:00:00.000Z',
    collectionRule: 'SOFTWARE TEST ONLY',
    languages: ['en'],
    toolResultsAvailable: false,
    sources: [
      {
        id: 'doc',
        locator: 'doc.md',
        sourceType: 'markdown',
        origin: 'project-documentation',
        language: 'en',
        available: true,
      },
      {
        id: 'note',
        locator: 'note.txt',
        sourceType: 'text',
        origin: 'developer-reference',
        language: 'en',
        available: true,
      },
      {
        id: 'history',
        locator: 'history.json',
        sourceType: 'conversation',
        origin: 'conversation-history',
        language: 'en',
        available: true,
      },
    ],
  });
  const tasks = parseTasks({
    schemaVersion: 1,
    collectionRecord: 'Software test, not sampled tasks',
    tasks: [
      {
        id: 'toy-task',
        query: 'alpha',
        language: 'en',
        strata: ['project-documentation', 'developer-reference', 'conversation-history'],
        runtime: [],
      },
    ],
  });
  const prepared = await prepare(settings, base, tokenizer, root);
  const useful = prepared.corpus.blocks.map((block, index) => ({
    id: `e${index}`,
    sourceId: prepared.sources.find((s) => s.documentId === block.sourceDocumentId)!.id,
    location: block.sourceLocation!,
    quote: block.content,
  }));
  const annotations = parseAnnotations({
    schemaVersion: 1,
    process: {
      kind: 'toy-software-test',
      author: 'software test',
      method: 'Synthetic unit assertions; never independent human evidence',
      independentOfRetrieval: false,
      approvedForEvaluation: false,
      approvalReference: null,
    },
    tasks: [
      {
        taskId: 'toy-task',
        answerability: 'answerable',
        scopeReviewed: true,
        useful,
        irrelevantBlockIds: [],
        facts: useful.map((e, i) => ({
          id: `f${i}`,
          statement: 'Toy assertion only',
          required: true,
          critical: i === 0,
          alternatives: [[e.id]],
        })),
      },
    ],
  });
  const paths = {
    settings: join(base, 'settings.json'),
    tasks: join(base, 'tasks.json'),
    annotations: join(base, 'annotations.json'),
  };
  writeFileSync(paths.settings, JSON.stringify(settings));
  writeFileSync(paths.tasks, JSON.stringify(tasks));
  writeFileSync(paths.annotations, JSON.stringify(annotations));
  return { root, base, snapshot, content, settings, tasks, annotations, prepared, paths };
}

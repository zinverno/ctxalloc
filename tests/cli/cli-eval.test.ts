import { readFileSync } from 'node:fs';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateBlock,
  compilationRequest,
  contextBlock,
  evaluationCase,
  runConfig,
  sourceDocument,
} from '../evaluation/evaluation-fixtures.js';
import { cli, createWorkspace, failureOf, successOf, type Workspace } from './fixtures.js';

/**
 * `ctxalloc eval` (DEC-042).
 *
 * The command makes the existing harness runnable; it redesigns nothing. What
 * these tests pin is the composition: the real tokenizer, the real compiler, the
 * real harness, a real monotonic clock — and **no model provider anywhere**.
 */

const rootUrl = new URL('../../', import.meta.url);
const tokenizer = new O200kBaseTokenizer();

let workspace: Workspace | undefined;

/** One case whose token counts were produced by the tokenizer the CLI composes. */
function realCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const relevant = contextBlock(
    'block:relevant',
    'The quantum reticulator calibrates the allocator before every compilation run.',
    tokenizer,
    { priority: 900 },
  );
  const distractor = contextBlock(
    'block:distractor',
    'The gardener repotted the fern on a rainy afternoon.',
    tokenizer,
    { priority: 100 },
  );

  return {
    ...evaluationCase({
      id: 'cli-case-1',
      request: compilationRequest({
        id: 'cli-eval-request',
        query: 'What calibrates the allocator?',
        candidates: [candidateBlock(relevant), candidateBlock(distractor)],
        documents: [sourceDocument('doc:main', 'main')],
        totalTokens: 400,
        reservedOutputTokens: 100,
      }),
      relevantBlockIds: ['block:relevant'],
      irrelevantBlockIds: ['block:distractor'],
    }),
    ...overrides,
  };
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

async function evaluate(
  runConfigOverrides: Record<string, unknown> = {},
  evaluationCaseValue: Record<string, unknown> = realCase(),
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ws = createWorkspace();
  workspace = ws;
  return cli(
    'eval',
    '--config',
    ws.configPath,
    '--run-config',
    ws.write('run-config.json', runConfig(runConfigOverrides)),
    '--case',
    ws.write('case.json', evaluationCaseValue),
  );
}

describe('ctxalloc eval: the harness, runnable and offline', () => {
  it('runs a model-disabled case and returns an evaluation report', async () => {
    const report = successOf(await evaluate()) as {
      schemaVersion: number;
      runId: string;
      counts: { cases: number };
      cases: readonly { caseId: string }[];
    };

    expect(report.schemaVersion).toBeTypeOf('number');
    expect(report.runId).toBe('run-1');
    expect(report.counts.cases).toBe(1);
    expect(report.cases.map((entry) => entry.caseId)).toEqual(['cli-case-1']);
  });

  it('publishes an EvaluationReport only: no context, query, or answer', async () => {
    const run = await evaluate();

    expect(run.stdout).not.toContain('quantum reticulator');
    expect(run.stdout).not.toContain('gardener repotted');
    expect(run.stdout).not.toContain('What calibrates the allocator?');
    expect(run.stdout).not.toContain('compiledContext');
    expect(run.stdout).not.toContain('outputText');
  });

  it('INV-DET-001: the same case and run configuration produce the same report', async () => {
    const first = await evaluate();
    workspace?.dispose();
    workspace = undefined;
    const second = await evaluate();

    // Wall-clock latencies are excluded, and so is the report hash that covers
    // them. Everything the harness derives from the compilation itself — the
    // compilation identifier, the token metrics, the preservation metrics, the
    // determinism verdict — is identical (INV-DET-001, INV-EVAL-005).
    const strip = (text: string): unknown => {
      const report = JSON.parse(text) as Record<string, unknown> & {
        cases: Record<string, unknown>[];
      };
      delete report.latency;
      delete report.reportHash;
      for (const entry of report.cases) {
        delete entry.compilationLatencyMilliseconds;
        delete entry.compiledRequestLatencyMilliseconds;
      }
      return report;
    };
    expect(strip(second.stdout)).toEqual(strip(first.stdout));
  });

  it('rejects a run configuration that enables model execution', async () => {
    const run = await evaluate({ modelExecution: 'full-baseline-and-compiled' });
    const envelope = failureOf(run);

    expect(run.stdout).toBe('');
    expect(envelope.stage).toBe('evaluation');
    expect(envelope.issues[0]?.code).toBe('model_provider_required');
  });

  it('reports a malformed case safely', async () => {
    const run = await evaluate({}, { ...realCase(), datasetSplit: 'production' });
    const envelope = failureOf(run);

    expect(run.stdout).toBe('');
    expect(envelope.stage).toBe('evaluation');
    expect(envelope.issues.length).toBeGreaterThan(0);
    // No case content reaches the envelope.
    expect(run.stderr).not.toContain('quantum reticulator');
  });

  it('reports a malformed run configuration safely', async () => {
    const run = await evaluate({ determinismRepeats: 0 });

    expect(run.stdout).toBe('');
    expect(failureOf(run).stage).toBe('evaluation');
  });
});

describe('INV-DEP-002: no invocation of ctxalloc eval can call a model', () => {
  it('constructs no model provider and names no model SDK', () => {
    const source = readFileSync(new URL('apps/cli/src/commands/evaluate.ts', rootUrl), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const forbidden of [
      'AnthropicModelProvider',
      'ModelProvider',
      'apiKey',
      'process.env',
      'fetch',
    ]) {
      expect(source, `names ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('persists no evaluation report', async () => {
    const run = await evaluate();
    expect(run.exitCode).toBe(0);

    // `eval` needs the config for its compiler slice, but writes nothing: the
    // database is never even created, because no store is composed (DEC-042).
    const { existsSync } = await import('node:fs');
    expect(existsSync(workspace?.databasePath ?? '')).toBe(false);
  });
});

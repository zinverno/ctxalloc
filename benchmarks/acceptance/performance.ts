import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextCompiler } from '@ctxalloc/compiler';
import {
  CompileAndPersistLocalContextService,
  CompileLocalContextService,
  CompilationTracePersistenceService,
  LocalSourceRegistryService,
} from '@ctxalloc/application';
import {
  MiniSearchCandidateProvider,
  NodeFileSourceReader,
  SQLiteControlStore,
  SQLiteTraceStore,
  SystemMonotonicClock,
} from '@ctxalloc/adapters';
import type { EvaluationCase } from '@ctxalloc/evaluation';
import type { Tokenizer } from '@ctxalloc/ports';
import { benchmarkCompilerConfig } from '../evaluation/v1/fixtures.js';

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1];
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: sorted.at(-1),
  };
}
/** Diagnostic timings only. These are separate operations, never harness model/request latency. */
export async function measurePerformance(
  root: string,
  tokenizer: Tokenizer,
  entry: EvaluationCase,
) {
  const warmupIterations = 5;
  const iterations = 20;
  const clock = new SystemMonotonicClock();
  const compiler = new ContextCompiler(benchmarkCompilerConfig(), tokenizer);
  const compilerSamples: number[] = [];
  for (let i = 0; i < warmupIterations + iterations; i += 1) {
    const start = clock.nowMilliseconds();
    compiler.compile(entry.compilationRequest);
    const elapsed = clock.nowMilliseconds() - start;
    if (i >= warmupIterations) compilerSamples.push(elapsed);
  }
  const workspace = mkdtempSync(join(tmpdir(), 'ctxalloc-perf-'));
  const sources = join(workspace, 'sources');
  mkdirSync(sources);
  writeFileSync(
    join(sources, 'handbook.md'),
    readFileSync(join(root, 'examples/api/sources/handbook.md')),
  );
  const config = JSON.parse(readFileSync(join(root, 'examples/api/config.json'), 'utf8')) as {
    localCompile: unknown;
    candidateProvider: unknown;
    maxSourceBytes: number;
  };
  const registration: unknown = JSON.parse(
    readFileSync(join(root, 'examples/api/registration.json'), 'utf8'),
  );
  const request: unknown = JSON.parse(
    readFileSync(join(root, 'examples/api/request.json'), 'utf8'),
  );
  const control = new SQLiteControlStore({
    schemaVersion: 1,
    databasePath: join(workspace, 'state.sqlite'),
  });
  const traces = new SQLiteTraceStore({
    schemaVersion: 1,
    databasePath: join(workspace, 'state.sqlite'),
  });
  try {
    await new LocalSourceRegistryService(control, control).execute({
      schemaVersion: 1,
      operation: 'register',
      registration,
    });
    const local = new CompileLocalContextService(
      config.localCompile,
      tokenizer,
      new NodeFileSourceReader({ rootDirectory: sources, maxBytes: config.maxSourceBytes }),
      control,
      new MiniSearchCandidateProvider(config.candidateProvider),
    );
    const service = new CompileAndPersistLocalContextService(
      local,
      new CompilationTracePersistenceService(traces),
    );
    const localSamples: number[] = [];
    let candidates = 0;
    let corpusBlocks = 0;
    for (let i = 0; i < warmupIterations + iterations; i += 1) {
      const start = clock.nowMilliseconds();
      const result = await service.execute(request);
      const elapsed = clock.nowMilliseconds() - start;
      candidates = result.candidates.length;
      corpusBlocks = result.blocks.length;
      if (i >= warmupIterations) localSamples.push(elapsed);
    }
    return {
      state: 'MEASURED',
      ciTimingGate: false,
      warmupIterations,
      iterations,
      clock: { id: clock.id, version: clock.version },
      units: 'milliseconds',
      compilerOnly: {
        datasetId: 'ctxalloc-eval-v1',
        caseId: entry.id,
        candidateCount: entry.compilationRequest.candidates.length,
        tracePersistenceIncluded: false,
        latency: distribution(compilerSamples),
        targetP95: 500,
      },
      localRetrievalAndCompile: {
        datasetId: 'public-api-handbook',
        corpusBlockCount: corpusBlocks,
        candidateCount: candidates,
        sourceReadAndPreparationIncluded: true,
        tracePersistenceIncluded: true,
        traceWriteMode: 'first write in warm-up, idempotent writes in measured iterations',
        latency: distribution(localSamples),
        targetP95: 2500,
      },
    };
  } finally {
    control.close();
    traces.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  MiniSearchCandidateProvider,
} from '@ctxalloc/adapters';
import type { CandidateBlock } from '@ctxalloc/domain';
import {
  EvaluationHarness,
  validateEvaluationCase,
  type EvaluationCaseDetails,
} from '@ctxalloc/evaluation';
import { FakeMonotonicClock } from '@ctxalloc/testing';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RETRIEVAL_REFERENCE_TIME,
  RETRIEVAL_SCOPE,
} from '../../benchmarks/retrieval/v1/fixtures.js';
import { retrievalCorpusV1, retrievalDocumentsV1 } from '../../benchmarks/retrieval/v1/index.js';

/**
 * Retrieval-backed evaluation is a **composition**, not a harness feature
 * (DEC-041).
 *
 * ```text
 * versioned retrieval corpus
 *   -> MiniSearchCandidateProvider
 *   -> CandidateBlock[]
 *   -> an exact CompilationRequest
 *   -> the existing EvaluationHarness
 * ```
 *
 * `EvaluationHarness` still evaluates an explicit `CompilationRequest` and calls
 * no provider of its own. Teaching it to retrieve would make one component own
 * both the measurement and half of what is measured, and a case would stop being
 * static data (INV-DEP-003).
 *
 * No model runs and no network is touched: the run config disables model
 * execution, and the clock is a scripted double.
 */

const QUERY = 'deterministic token budget allocation';
const MAX_CANDIDATES = 6;

const tokenizer = new O200kBaseTokenizer();

function clock(): FakeMonotonicClock {
  return new FakeMonotonicClock(Array.from({ length: 500 }, (_, index) => index * 7));
}

function compilerConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compilerId: 'ctxalloc-retrieval-eval',
    compilerVersion: '1.0.0',
    maxCorrectionSelections: 128,
  };
}

function policy(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'retrieval-eval',
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

function runConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'retrieval-backed-1',
    executedAt: RETRIEVAL_REFERENCE_TIME,
    datasetId: 'ctxalloc-retrieval-v1',
    datasetVersion: '1',
    referenceEnvironment: 'unit-test',
    systemPrompt: 'You answer only from the supplied context.',
    maxOutputTokens: 256,
    temperature: 0,
    // No model call, so no network and no credential is involved anywhere here.
    modelExecution: 'disabled',
    determinismRepeats: 3,
    severeQualityLossThreshold: 0.05,
  };
}

/** The real provider's candidate batch for this query over the versioned corpus. */
async function retrieve(): Promise<readonly CandidateBlock[]> {
  const provider = new MiniSearchCandidateProvider({
    schemaVersion: 1,
    maxCandidates: MAX_CANDIDATES,
  });
  return provider.getCandidates({
    scope: RETRIEVAL_SCOPE,
    query: QUERY,
    referenceTime: RETRIEVAL_REFERENCE_TIME,
    sourceDocuments: retrievalDocumentsV1(),
    blocks: retrievalCorpusV1(tokenizer),
  });
}

/** The exact `CompilationRequest` built from a real retrieval batch. */
function requestFor(candidates: readonly CandidateBlock[]): Record<string, unknown> {
  return {
    id: 'retrieval-backed-request',
    schemaVersion: 1,
    scope: RETRIEVAL_SCOPE,
    query: QUERY,
    referenceTime: RETRIEVAL_REFERENCE_TIME,
    candidates,
    sourceDocuments: retrievalDocumentsV1(),
    budget: { totalTokens: 400, reservedOutputTokens: 100 },
    policy: policy(),
  };
}

function caseFor(candidates: readonly CandidateBlock[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'rc-eval-01-retrieval-backed',
    datasetSplit: 'development',
    compilationRequest: requestFor(candidates),
    requiredBlockIds: [],
    requiredFacts: [],
    relevantBlockIds: ['blk-03-allocation'],
    // Derived from the batch retrieval actually produced, because an annotation
    // naming a block the case does not contain is a broken answer key. Every
    // other retrieved block merely shares a term with the query; only
    // `blk-03-allocation` states the thing the query asks about.
    irrelevantBlockIds: candidates
      .map((candidate) => candidate.block.id)
      .filter((id) => id !== 'blk-03-allocation'),
    answerCriteria: [],
    tags: ['retrieval-backed'],
  };
}

/**
 * The block identifiers of a compiled context, read through the renderer's
 * documented v1 record contract.
 *
 * `ContextRenderer` v1 emits one canonical JSON record per line, each carrying a
 * `blockId` (DEC-035). Parsing that is how a test learns what was actually
 * compiled; `compiledContext` exists on `EvaluationCaseDetails` for exactly this
 * kind of inspection and is deliberately absent from the published report, so
 * nothing here weakens report privacy.
 */
function compiledBlockIds(compiledContext: string | undefined): readonly string[] {
  if (compiledContext === undefined || compiledContext.length === 0) return [];
  return compiledContext.split('\n').map((line) => {
    const record = JSON.parse(line) as { blockId?: unknown };
    if (typeof record.blockId !== 'string') {
      throw new Error('a rendered record carried no string blockId');
    }
    return record.blockId;
  });
}

let candidates: readonly CandidateBlock[];
let details: EvaluationCaseDetails;

beforeAll(async () => {
  candidates = await retrieve();
  const harness = new EvaluationHarness(compilerConfig(), tokenizer, clock());
  details = await harness.runCaseDetailed(runConfig(), caseFor(candidates));
});

describe('Phase 18: the real provider materializes a Phase 17 candidate batch', () => {
  it('1. the candidate batch is produced by the real provider', () => {
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const candidate of candidates) {
      expect(candidate.retrieval?.providerId).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
    }
  });

  it('2. the constructed case is an exact, valid CompilationRequest', () => {
    const validated = validateEvaluationCase(caseFor(candidates));
    expect(validated.compilationRequest.query).toBe(QUERY);
    expect(validated.compilationRequest.candidates).toHaveLength(candidates.length);
  });

  it('3. the harness runs it with the model disabled', () => {
    expect(details.result.compilation).toBe('succeeded');
    expect(details.result.model.state).toBe('disabled');
    expect(details.baselineAnswer).toBeUndefined();
    expect(details.compiledAnswer).toBeUndefined();
  });

  it('4. the full-context baseline is built from the retrieval candidate batch', () => {
    const fullContext = details.result.baselines?.fullContext;
    expect(fullContext?.applicable).toBe(true);
    if (fullContext?.applicable === true) {
      expect(fullContext.includedCandidateCount).toBe(candidates.length);
      expect(fullContext.contextTokens).toBeGreaterThan(0);
    }
  });

  it('5. the top-k baseline is applicable, not incomparable-retrieval-evidence', () => {
    // Every wrapper agrees on provider, version, metric, and direction, which is
    // exactly the comparability contract the Phase 17 baseline requires. A
    // single-provider result must never report itself incomparable.
    const topK = details.result.baselines?.topK;
    expect(topK?.applicable).toBe(true);
    expect(topK).not.toHaveProperty('reason');
  });

  it('6. the top-k ordering corresponds to the provider ranking', () => {
    // The baseline orders by the score contract the evidence declares, and the
    // provider already returned its results in that order, so the ranking the
    // baseline derives is the ranking the provider committed to.
    const byScore = [...candidates].sort(
      (left, right) =>
        (right.retrieval?.score?.value ?? 0) - (left.retrieval?.score?.value ?? 0) ||
        (left.block.id < right.block.id ? -1 : left.block.id > right.block.id ? 1 : 0),
    );
    expect(byScore.map((candidate) => candidate.block.id)).toEqual(
      candidates.map((candidate) => candidate.block.id),
    );
    expect(candidates.map((candidate) => candidate.retrieval?.rank)).toEqual(
      candidates.map((_candidate, index) => index),
    );
  });

  it('7. every block the compiler included came from the real retrieval batch', () => {
    // The compiled context is parsed rather than substring-searched. A
    // `proposed.has(id)` check over ids taken from `proposed` is true by
    // construction and proves nothing; reading the rendered records is what
    // actually shows which blocks were compiled.
    const includedBlockIds = compiledBlockIds(details.compiledContext);
    const proposed = new Set(candidates.map((candidate) => String(candidate.block.id)));

    expect(includedBlockIds.length).toBeGreaterThan(0);
    for (const id of includedBlockIds) {
      expect(proposed.has(id), `compiled block ${id} was not proposed by retrieval`).toBe(true);
    }
    expect(details.result.compilationId).toBeTypeOf('string');
    expect(details.result.usage?.budgetViolation).toBe(false);
  });

  it('7b. a corpus block the provider did not propose cannot appear in the compiled context', () => {
    // The corpus is much larger than the batch, and every block the provider
    // left out must be unreachable — the compiler selects from candidates, never
    // from the corpus behind them.
    const proposed = new Set(candidates.map((candidate) => String(candidate.block.id)));
    const omitted = retrievalCorpusV1(tokenizer)
      .map((entry) => String(entry.id))
      .filter((id) => !proposed.has(id));

    expect(omitted.length).toBeGreaterThan(0);
    const includedBlockIds = new Set(compiledBlockIds(details.compiledContext));
    for (const id of omitted) {
      expect(includedBlockIds.has(id), `omitted block ${id} reached the compiled context`).toBe(
        false,
      );
    }
  });

  it('7c. the request the harness compiled carried exactly the provider batch', () => {
    const validated = validateEvaluationCase(caseFor(candidates));
    expect(validated.compilationRequest.candidates.map((candidate) => candidate.block.id)).toEqual(
      candidates.map((candidate) => candidate.block.id),
    );
    for (const candidate of validated.compilationRequest.candidates) {
      expect(candidate.retrieval?.providerId).toBe(MINISEARCH_CANDIDATE_PROVIDER_ID);
      expect(candidate.retrieval?.providerVersion).toBe(MINISEARCH_CANDIDATE_PROVIDER_VERSION);
    }
  });

  it('8. token metrics keep Phase 17 semantics', () => {
    const tokens = details.result.tokens;
    const fullContext = details.result.baselines?.fullContext;
    expect(tokens).toBeDefined();
    if (tokens !== undefined && fullContext?.applicable === true) {
      // `baselineInputTokens` is the full-context baseline's own count, and the
      // reduction is their exact difference. Nothing here redefines either.
      expect(tokens.baselineInputTokens).toBe(fullContext.contextTokens);
      expect(tokens.tokenReduction).toBe(tokens.baselineInputTokens - tokens.compiledTokens);
    }
  });

  it('9. preservation metrics are published for the retrieval-backed case', () => {
    const preservation = details.result.preservation;
    expect(preservation).toBeDefined();
    expect(preservation?.relevantBlockRecall).toBeTypeOf('number');
    expect(preservation?.irrelevantExclusionRate).toBeTypeOf('number');
  });

  it('10. INV-EVAL-005: the compilation is deterministic across repeats', () => {
    expect(details.result.determinism?.matched).toBe(true);
    expect(details.result.determinism?.executions).toBe(3);
  });

  it('11. INV-SEC-001: the published result carries no query and no context', () => {
    // The raw strings exist only on `EvaluationCaseDetails`. The result — the
    // thing a suite report is built from — must contain neither.
    const published = JSON.stringify(details.result);
    expect(published).not.toContain(QUERY);
    expect(published).not.toContain('reticulator');
    expect(published).not.toContain('Компилятор');
    expect(published).not.toContain(details.compiledContext ?? ' never');
  });

  it('12. no retrieval metric leaks into the compilation result', () => {
    // Recall and reciprocal rank are retrieval diagnostics. A compilation result
    // that carried them would be publishing a number the compiler never computed.
    const published = JSON.stringify(details.result);
    for (const forbidden of ['recallAtK', 'reciprocalRank', 'retrievedBlockIds']) {
      expect(published).not.toContain(forbidden);
    }
  });
});

describe('the harness itself performs no retrieval', () => {
  const source = readFileSync(
    new URL('../../packages/evaluation/src/evaluation-harness.ts', import.meta.url),
    'utf8',
  );

  it('names no candidate provider and no retrieval adapter', () => {
    for (const forbidden of [
      'CandidateProvider',
      'MiniSearchCandidateProvider',
      '@ctxalloc/adapters',
      'minisearch',
      'getCandidates',
    ]) {
      expect(source, `the harness names ${forbidden}`).not.toContain(forbidden);
    }
  });
});

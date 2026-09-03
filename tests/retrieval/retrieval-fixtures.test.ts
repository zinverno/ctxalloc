import { MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import { CandidateBlockSchema, ContextBlockSchema } from '@ctxalloc/domain';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_REFERENCE_TIME,
  RETRIEVAL_SCOPE,
} from '../../benchmarks/retrieval/v1/fixtures.js';
import {
  measureRetrievalCase,
  recallAtK,
  reciprocalRank,
  retrievalCorpusFor,
  retrievalCorpusV1,
  retrievalDocumentsV1,
  retrievalSuiteV1,
  summarizeRetrievalRun,
  type RetrievalCase,
  type RetrievalCaseMetrics,
} from '../../benchmarks/retrieval/v1/index.js';

/**
 * The versioned retrieval dataset, run against the real provider (DEC-041).
 *
 * The numbers this suite produces are **diagnostic evidence**, not an acceptance
 * gate. They establish what the first real lexical retriever does on a corpus a
 * reader can inspect; turning them into a product guarantee would freeze
 * whatever this corpus happens to contain (METRICS 18).
 */

const tokenizer = new O200kBaseTokenizer();

async function runCase(entry: RetrievalCase): Promise<RetrievalCaseMetrics> {
  const provider = new MiniSearchCandidateProvider({
    schemaVersion: 1,
    maxCandidates: entry.k,
  });
  const candidates = await provider.getCandidates({
    scope: RETRIEVAL_SCOPE,
    query: entry.query,
    referenceTime: RETRIEVAL_REFERENCE_TIME,
    sourceDocuments: retrievalDocumentsV1(),
    blocks: retrievalCorpusFor(entry.corpus, tokenizer),
  });
  return measureRetrievalCase(
    entry,
    candidates.map((candidate) => candidate.block.id),
  );
}

describe('retrieval dataset v1: structure', () => {
  it('loads deterministically', () => {
    expect(JSON.stringify(retrievalSuiteV1())).toBe(JSON.stringify(retrievalSuiteV1()));
    expect(JSON.stringify(retrievalCorpusV1(tokenizer))).toBe(
      JSON.stringify(retrievalCorpusV1(new O200kBaseTokenizer())),
    );
  });

  it('covers every required category once, with no duplicate case identifier', () => {
    const ids = retrievalSuiteV1().map((entry) => entry.id);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    expect(ids).toEqual([
      'rc-01-rare-term',
      'rc-02-technical-identifier',
      'rc-03-multi-word-technical',
      'rc-04-russian',
      'rc-05-english',
      'rc-06-mixed-language',
      'rc-07-distractor-heavy',
      'rc-08-shared-term',
      'rc-09-duplicate-content',
      'rc-10-no-match',
      'rc-11-punctuation-code',
      'rc-12-not-shortest-or-longest',
      'rc-13-equal-score-tie',
    ]);
  });

  it('names only block identifiers its own corpus contains', () => {
    // An expectation naming a block the corpus does not hold is a broken answer
    // key, and a measurement against a broken answer key means nothing.
    for (const entry of retrievalSuiteV1()) {
      const present = new Set(retrievalCorpusFor(entry.corpus, tokenizer).map((b) => String(b.id)));
      for (const id of [...entry.relevantBlockIds, ...(entry.expectedOrder ?? [])]) {
        expect(present.has(id), `${entry.id} names ${id}`).toBe(true);
      }
      // An ordered expectation must list exactly the blocks it claims are relevant.
      if (entry.expectedOrder !== undefined) {
        expect(new Set(entry.expectedOrder)).toEqual(new Set(entry.relevantBlockIds));
      }
    }
  });

  it('builds corpora of valid domain blocks with derived hashes and token counts', () => {
    for (const name of ['main', 'duplicate', 'tie'] as const) {
      for (const entry of retrievalCorpusFor(name, tokenizer)) {
        expect(() => ContextBlockSchema.parse(entry)).not.toThrow();
        expect(entry.tokenCount).toBe(tokenizer.countTokens(entry.content));
      }
    }
  });

  it('keeps identifiers unique inside each corpus', () => {
    for (const name of ['main', 'duplicate', 'tie'] as const) {
      const ids = retrievalCorpusFor(name, tokenizer).map((entry) => entry.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('retrieval dataset v1: metric helpers are exact', () => {
  it('computes recall@k over the first k results only', () => {
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(0.5);
    expect(recallAtK(['b'], ['a', 'c'], 5)).toBe(0);
    expect(recallAtK(['a', 'a'], ['a'], 5)).toBe(1);
  });

  it('computes reciprocal rank over one-based ranks', () => {
    expect(reciprocalRank(['a', 'b'], ['a'])).toBe(1);
    expect(reciprocalRank(['a', 'b'], ['b'])).toBe(0.5);
    expect(reciprocalRank(['a', 'b', 'c'], ['c'])).toBeCloseTo(1 / 3, 12);
    // Zero means the relevant block was not retrieved — a real measurement.
    expect(reciprocalRank(['a'], ['z'])).toBe(0);
  });

  it('refuses to compute either metric without a relevance set', () => {
    // Recall has no denominator and reciprocal rank has no "first relevant
    // result". The earlier convention answered 1 and 0 respectively, which is
    // internally inconsistent and makes an aggregate describe the convention
    // rather than the retriever (DEC-041).
    expect(() => recallAtK([], [], 5)).toThrow();
    expect(() => recallAtK(['x'], [], 5)).toThrow();
    expect(() => reciprocalRank([], [])).toThrow();
    expect(() => reciprocalRank(['x'], [])).toThrow();
  });

  it('measures a no-match case by its empty-result expectation instead', () => {
    const noMatch = retrievalSuiteV1().find((entry) => entry.id === 'rc-10-no-match');
    const satisfied = measureRetrievalCase(noMatch as RetrievalCase, []);
    expect(satisfied.kind).toBe('no-match');
    if (satisfied.kind === 'no-match') {
      expect(satisfied.expectedEmptyResult).toBe(true);
      expect(satisfied.emptyResultSatisfied).toBe(true);
    }
    // The union carries no recall or reciprocal rank at all, so a consumer
    // cannot read a metric that was never measured.
    expect(satisfied).not.toHaveProperty('recallAtK');
    expect(satisfied).not.toHaveProperty('reciprocalRank');

    const violated = measureRetrievalCase(noMatch as RetrievalCase, ['blk-01-reticulator']);
    expect(violated.kind === 'no-match' && violated.emptyResultSatisfied).toBe(false);
  });

  it('aggregates relevance cases only, and counts no-match cases separately', () => {
    const summary = summarizeRetrievalRun([
      { caseId: 'a', kind: 'relevance', recallAtK: 1, reciprocalRank: 1, retrievedBlockIds: ['x'] },
      {
        caseId: 'b',
        kind: 'relevance',
        recallAtK: 0.5,
        reciprocalRank: 0.5,
        retrievedBlockIds: ['y'],
      },
      {
        caseId: 'c',
        kind: 'no-match',
        expectedEmptyResult: true,
        emptyResultSatisfied: true,
        retrievedBlockIds: [],
      },
    ]);
    // The no-match case contributes to neither mean. Under the old convention it
    // would have dragged the mean reciprocal rank from 0.75 to 0.5.
    expect(summary.relevanceCaseCount).toBe(2);
    expect(summary.meanRecallAtK).toBe(0.75);
    expect(summary.meanReciprocalRank).toBe(0.75);
    expect(summary.noMatchCaseCount).toBe(1);
    expect(summary.noMatchSatisfiedCount).toBe(1);
  });

  it('reports null rather than a fabricated mean when no relevance case ran', () => {
    const summary = summarizeRetrievalRun([
      {
        caseId: 'c',
        kind: 'no-match',
        expectedEmptyResult: true,
        emptyResultSatisfied: true,
        retrievedBlockIds: [],
      },
    ]);
    expect(summary.meanRecallAtK).toBeNull();
    expect(summary.meanReciprocalRank).toBeNull();
  });
});

describe('retrieval dataset v1: the real provider over every case', () => {
  const relevanceCases = retrievalSuiteV1().filter((entry) => entry.relevantBlockIds.length > 0);

  it.each(relevanceCases.map((entry) => [entry.id, entry] as const))(
    '%s finds every relevant block within k',
    async (_id, entry) => {
      const metrics = await runCase(entry);
      expect(metrics.kind).toBe('relevance');
      if (metrics.kind === 'relevance') expect(metrics.recallAtK).toBe(1);
    },
  );

  it.each(relevanceCases.map((entry) => [entry.id, entry] as const))(
    '%s ranks a relevant block first',
    async (_id, entry) => {
      const metrics = await runCase(entry);
      if (metrics.kind === 'relevance') expect(metrics.reciprocalRank).toBe(1);
    },
  );

  it('publishes a summary that separates relevance cases from the no-match case', async () => {
    const summary = summarizeRetrievalRun(await Promise.all(retrievalSuiteV1().map(runCase)));
    // Twelve relevance-bearing cases and one no-match case: the aggregate
    // describes retrieval quality, and the no-match case is reported beside it
    // rather than averaged into it.
    expect(summary.relevanceCaseCount).toBe(12);
    expect(summary.meanRecallAtK).toBe(1);
    expect(summary.meanReciprocalRank).toBe(1);
    expect(summary.noMatchCaseCount).toBe(1);
    expect(summary.noMatchSatisfiedCount).toBe(1);
  });

  it.each(
    retrievalSuiteV1()
      .filter((entry) => entry.expectedOrder !== undefined)
      .map((entry) => [entry.id, entry] as const),
  )('%s returns exactly the expected ordered result', async (_id, entry) => {
    expect((await runCase(entry)).retrievedBlockIds).toEqual(entry.expectedOrder);
  });

  it('rerunning the whole suite yields identical rankings', async () => {
    const first = await Promise.all(retrievalSuiteV1().map(runCase));
    const second = await Promise.all(retrievalSuiteV1().map(runCase));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('the no-match case invents no candidate', async () => {
    const entry = retrievalSuiteV1().find((candidate) => candidate.id === 'rc-10-no-match');
    expect(entry).toBeDefined();
    const metrics = await runCase(entry as RetrievalCase);
    expect(metrics.retrievedBlockIds).toEqual([]);
    expect(metrics.kind).toBe('no-match');
    if (metrics.kind === 'no-match') expect(metrics.emptyResultSatisfied).toBe(true);
  });

  it('the equal-score case is decided by the identifier tie-break alone', async () => {
    const entry = retrievalSuiteV1().find((candidate) => candidate.id === 'rc-13-equal-score-tie');
    const provider = new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates: 5 });
    const blocks = retrievalCorpusFor('tie', tokenizer);
    const got = await provider.getCandidates({
      scope: RETRIEVAL_SCOPE,
      query: (entry as RetrievalCase).query,
      referenceTime: RETRIEVAL_REFERENCE_TIME,
      sourceDocuments: retrievalDocumentsV1(),
      blocks,
    });
    expect(new Set(got.map((candidate) => candidate.retrieval?.score?.value)).size).toBe(1);
    expect(got.map((candidate) => candidate.block.id)).toEqual([
      'blk-tie-a',
      'blk-tie-b',
      'blk-tie-c',
    ]);
  });

  it('the length-independence case targets a block that is neither shortest nor longest', () => {
    const lengths = retrievalCorpusV1(tokenizer).map((entry) => ({
      id: entry.id,
      length: entry.content.length,
    }));
    const target = lengths.find((entry) => entry.id === 'blk-08-budget-note');
    const shortest = Math.min(...lengths.map((entry) => entry.length));
    const longest = Math.max(...lengths.map((entry) => entry.length));
    expect(target?.length).toBeGreaterThan(shortest);
    expect(target?.length).toBeLessThan(longest);
  });

  it('every returned wrapper is a valid CandidateBlock naming a corpus block', async () => {
    for (const entry of retrievalSuiteV1()) {
      const present = new Set(retrievalCorpusFor(entry.corpus, tokenizer).map((b) => String(b.id)));
      const provider = new MiniSearchCandidateProvider({
        schemaVersion: 1,
        maxCandidates: entry.k,
      });
      const got = await provider.getCandidates({
        scope: RETRIEVAL_SCOPE,
        query: entry.query,
        referenceTime: RETRIEVAL_REFERENCE_TIME,
        sourceDocuments: retrievalDocumentsV1(),
        blocks: retrievalCorpusFor(entry.corpus, tokenizer),
      });
      expect(got.length).toBeLessThanOrEqual(entry.k);
      for (const candidate of got) {
        expect(() => CandidateBlockSchema.parse(candidate)).not.toThrow();
        expect(present.has(candidate.block.id)).toBe(true);
      }
    }
  });
});

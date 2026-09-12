import {
  MiniSearchCandidateProvider,
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
} from '@ctxalloc/adapters';
import type { Tokenizer } from '@ctxalloc/ports';
import { SCOPE, REFERENCE_TIME, blockId, hash, prepareDocument, type Dataset } from './data.js';
import { correlation, distribution, effectiveness, ratio } from './metrics.js';

export const NATIVE = {
  providerId: MINISEARCH_CANDIDATE_PROVIDER_ID,
  providerVersion: MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  semantics: MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  higherIsBetter: true,
} as const;

/** No calibration/profile/compiler import: the first observation is native retrieval only. */
export async function observe(dataset: Dataset, tokenizer: Tokenizer) {
  const documents = dataset.documents.map((d) => prepareDocument(d, tokenizer));
  const allBlocks = documents.flatMap((d) => d.blocks);
  const allSources = documents.map((d) => d.sourceDocument);
  const rows = [];
  for (const [index, query] of dataset.queries.entries()) {
    const prepared = documents[dataset.documents.findIndex((d) => d.id === query.documentId)]!;
    const provider = new MiniSearchCandidateProvider({
      schemaVersion: 1,
      maxCandidates: Math.max(1, allBlocks.length),
    });
    const input = {
      query: query.query,
      referenceTime: REFERENCE_TIME,
      scope: SCOPE,
      blocks: prepared.blocks,
      sourceDocuments: [prepared.sourceDocument],
    };
    const candidates = await provider.getCandidates(input);
    const repeated = await provider.getCandidates(input);
    const permuted = await provider.getCandidates({
      ...input,
      blocks: [...input.blocks].reverse(),
    });
    const doubled = await provider.getCandidates({
      ...input,
      query: `${query.query} ${query.query}`,
    });
    const expanded = await provider.getCandidates({
      ...input,
      blocks: allBlocks,
      sourceDocuments: allSources,
    });
    const positive = query.useful.map(blockId);
    const negative = query.irrelevant.map(blockId);
    const native = candidates.map((c) => ({
      blockId: c.block.id,
      contentHash: c.block.normalizedContentHash,
      sourceType: c.block.sourceType,
      score: c.retrieval!.score!.value,
      rank: c.retrieval!.rank!,
      label: positive.includes(c.block.id)
        ? 'useful'
        : negative.includes(c.block.id)
          ? 'irrelevant'
          : 'unjudged',
    }));
    const retrieved = new Set(candidates.map((c) => String(c.block.id)));
    const paired = (other: typeof candidates) =>
      native.map((c) => {
        const match = other.find((o) => o.block.id === c.blockId);
        return {
          blockId: c.blockId,
          scoreRatio: match ? match.retrieval!.score!.value / c.score : null,
          rankDelta: match ? match.retrieval!.rank! - c.rank : null,
        };
      });
    const summary = {
      queryId: `q${String(index + 1).padStart(3, '0')}`,
      queryHash: hash(query.query),
      queryWords: query.query.trim().split(/\s+/u).length,
      documentHash: hash(query.documentId),
      sourceType: prepared.sourceDocument.sourceType,
      corpusBlocks: prepared.blocks.length,
      candidateCount: candidates.length,
      usefulness: effectiveness(retrieved, positive, negative),
      answerability: query.answerability,
      annotatedUsefulCount: positive.length,
      usefulFactsPresent: ratio(
        query.facts.filter((f) => f.blockIds.some((id) => retrieved.has(blockId(id)))).length,
        query.facts.length,
      ),
      sourceUnavailableEvidence: query.facts.filter((f) => !f.blockIds.length).length,
      completeRetrievalMiss: positive.length > 0 && !positive.some((id) => retrieved.has(id)),
      noAnnotatedUsefulCandidate: !positive.some((id) => retrieved.has(id)),
      atK: [1, 3, 5, 10, 20].map((k) => ({
        k,
        ...effectiveness(new Set(native.slice(0, k).map((c) => c.blockId)), positive, negative),
      })),
      scores: Object.fromEntries(
        ['useful', 'irrelevant', 'unjudged'].map((label) => [
          label,
          distribution(native.filter((c) => c.label === label).map((c) => c.score)),
        ]),
      ),
      ranks: Object.fromEntries(
        ['useful', 'irrelevant', 'unjudged'].map((label) => [
          label,
          distribution(native.filter((c) => c.label === label).map((c) => c.rank)),
        ]),
      ),
      native,
      checks: {
        repeatedExactly: JSON.stringify(candidates) === JSON.stringify(repeated),
        permutationStable: JSON.stringify(candidates) === JSON.stringify(permuted),
      },
      probes: {
        doubledQuery: paired(doubled),
        expandedCorpusBlocks: allBlocks.length,
        expandedCorpus: paired(expanded),
      },
    };
    const permutationDetails = {
      sameRanks:
        JSON.stringify(candidates.map((c) => c.block.id)) ===
        JSON.stringify(permuted.map((c) => c.block.id)),
      changedScores: candidates.filter(
        (c) =>
          c.retrieval!.score!.value !==
          permuted.find((p) => p.block.id === c.block.id)?.retrieval?.score?.value,
      ).length,
      maxAbsoluteScoreDelta: Math.max(
        0,
        ...candidates.map((c) =>
          Math.abs(
            c.retrieval!.score!.value -
              permuted.find((p) => p.block.id === c.block.id)!.retrieval!.score!.value,
          ),
        ),
      ),
    };
    rows.push({ query, prepared, candidates, summary, permutationDetails });
  }
  return rows;
}
export type Observation = Awaited<ReturnType<typeof observe>>;
export function rawReport(dataset: Dataset, rows: Observation) {
  const all = rows.flatMap((r) => r.summary.native);
  return {
    schemaVersion: 1,
    phase: '22A',
    purpose: 'DEVELOPMENT ONLY',
    mode: 'raw-native-retrieval',
    datasetHash: hash(JSON.stringify(dataset)),
    native: NATIVE,
    scoreRange: '(0, +infinity), finite; no cross-query comparability guaranteed',
    retrievalCap: 'entire supplied corpus; @k reports additionally expose truncation risk',
    modelExecution: 'disabled',
    compilerExecuted: false,
    profileSelected: false,
    productValidation: 'NOT_EVALUATED',
    heldOutValidation: 'NOT_EVALUATED',
    labeling:
      'Human-selected evidence is useful; unmarked passages are unjudged, never inferred negatives',
    precisionDefinition:
      'Bounds over all candidates; judged-only precision is selection-biased when negative labels are absent',
    counts: {
      queries: rows.length,
      documents: dataset.documents.length,
      corpusBlocks: dataset.documents.reduce((n, d) => n + d.blocks.length, 0),
      candidates: all.length,
      useful: all.filter((c) => c.label === 'useful').length,
      irrelevant: all.filter((c) => c.label === 'irrelevant').length,
      unjudged: all.filter((c) => c.label === 'unjudged').length,
      completeRetrievalMisses: rows.filter((r) => r.summary.completeRetrievalMiss).length,
      unanswerableQueries: rows.filter((r) => r.query.answerability === 'unanswerable').length,
    },
    usefulRetrievalRecall: ratio(
      all.filter((c) => c.label === 'useful').length,
      rows.reduce((n, r) => n + r.query.useful.length, 0),
    ),
    scoreDistributions: Object.fromEntries(
      ['useful', 'irrelevant', 'unjudged'].map((label) => [
        label,
        distribution(all.filter((c) => c.label === label).map((c) => c.score)),
      ]),
    ),
    rankDistributions: Object.fromEntries(
      ['useful', 'irrelevant', 'unjudged'].map((label) => [
        label,
        distribution(all.filter((c) => c.label === label).map((c) => c.rank)),
      ]),
    ),
    queryLengthVsTopScorePearson: correlation(
      rows.flatMap((r) =>
        r.summary.native[0] ? [[r.summary.queryWords, r.summary.native[0].score] as const] : [],
      ),
    ),
    queryLengthCorrelationInterpretation:
      'Descriptive only; question topics and corpus statistics are confounded',
    probes: Object.fromEntries(
      (['doubledQuery', 'expandedCorpus'] as const).map((p) => [
        p,
        {
          scoreRatio: distribution(
            rows.flatMap((r) =>
              r.summary.probes[p].flatMap((v) => (v.scoreRatio === null ? [] : [v.scoreRatio])),
            ),
          ),
          absoluteRankDelta: distribution(
            rows.flatMap((r) =>
              r.summary.probes[p].flatMap((v) =>
                v.rankDelta === null ? [] : [Math.abs(v.rankDelta)],
              ),
            ),
          ),
        },
      ]),
    ),
    contractChecks: rows.every((r) => Object.values(r.summary.checks).every(Boolean))
      ? 'PASS'
      : 'FAIL',
    queries: rows.map((r) => r.summary),
  };
}

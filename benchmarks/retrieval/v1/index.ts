import type { ContextBlock, SourceDocument } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { RETRIEVAL_SCOPE, retrievalBlock, retrievalDocument } from './fixtures.js';

/**
 * The v1 CtxAlloc retrieval dataset (DEC-041).
 *
 * It is a **transparent fixture corpus with expected lexical outcomes**, not a
 * second evaluation framework. Every case is small enough to check by eye: which
 * blocks a lexical retriever must find for a query, and — where the query
 * justifies it — in exactly which order.
 *
 * Expectations are about **lexical retrieval**, never about compiler selection.
 * A block named relevant here is a block whose text the query matches; whether a
 * compilation would include it is a budget, policy, and allocation question this
 * dataset does not ask and must not be read as answering.
 *
 * No case claims semantic quality. A lexical retriever finds words, so a
 * paraphrase with no shared term is a legitimate miss rather than a defect, and
 * the no-match case exists to pin exactly that (METRICS 18).
 *
 * Nothing here is tuned against the adapter's current output. A case whose
 * expectation the provider does not meet is a finding, not a fixture to adjust.
 */

/* -------------------------------------------------------------------------- */
/* Corpus                                                                      */
/* -------------------------------------------------------------------------- */

/** The four logical sources the main corpus is prepared from. */
export function retrievalDocumentsV1(): readonly SourceDocument[] {
  return [
    retrievalDocument('doc:handbook', 'handbook'),
    retrievalDocument('doc:runbook', 'runbook'),
    retrievalDocument('doc:notes-ru', 'notes-ru'),
    retrievalDocument('doc:code', 'code'),
  ];
}

/**
 * The main corpus: six blocks a query is meant to find, and nine distractors.
 *
 * The distractors are the point of the dataset rather than padding. A retriever
 * that returns everything scores perfectly on recall over a corpus of six
 * relevant blocks, so the corpus is deliberately dominated by text that shares
 * no term with any case query.
 *
 * Several blocks carry a heading path, an authored priority, a category, a
 * required flag, or timestamps. Retrieval v1 ranks on none of them.
 */
export function retrievalCorpusV1(tokenizer: Tokenizer): readonly ContextBlock[] {
  const block = (
    id: string,
    documentId: string,
    content: string,
    options: Parameters<typeof retrievalBlock>[4] = {},
  ): ContextBlock => retrievalBlock(id, documentId, content, tokenizer, options);

  return [
    // 1. A rare term that occurs exactly once in the whole corpus.
    block(
      'blk-01-reticulator',
      'doc:handbook',
      'The quantum reticulator calibrates the allocator before every compilation run.',
      { headingPath: ['Handbook', 'Calibration'], priority: 10 },
    ),
    // 2. An exact technical identifier, alongside a shared ordinary term.
    block(
      'blk-02-invariant-id',
      'doc:handbook',
      'The identifier INV-BUDGET-001 names the hard budget guarantee of the compiler.',
      { category: 'reference', priority: 900 },
    ),
    // 3. A multi-word technical phrase, and a second occurrence of "budget".
    block(
      'blk-03-allocation',
      'doc:runbook',
      'Deterministic token budget allocation resolves required blocks before optional blocks.',
      { required: true, createdAt: '2026-01-01T00:00:00.000Z' },
    ),
    // 4. Russian only.
    block(
      'blk-04-russian',
      'doc:notes-ru',
      'Компилятор распределяет бюджет токенов детерминированно и записывает трассировку решений.',
    ),
    // 5. English only.
    block(
      'blk-05-english',
      'doc:handbook',
      'The renderer serializes every selected block as exactly one JSON line.',
      { updatedAt: '2026-05-01T00:00:00.000Z' },
    ),
    // 6. Russian prose carrying English technical identifiers.
    block(
      'blk-06-mixed',
      'doc:notes-ru',
      'Трассировка компиляции содержит providerId и providerVersion для каждого кандидата.',
    ),
    // 7. A punctuation-heavy code fragment.
    block(
      'blk-07-code',
      'doc:code',
      'Call ctx_alloc::allocate(budget) once per request and inspect the returned trace.',
    ),
    // 8. A third occurrence of "budget", in a block that is neither the shortest
    //    nor the longest of the three — the length-independence case.
    block(
      'blk-08-budget-note',
      'doc:runbook',
      'A budget reserve is subtracted before anything is selected.',
    ),

    // Distractors. None of them shares a term with any case query.
    block('blk-20-noise', 'doc:notes-ru', 'Помидоры в теплице созревают к середине июля.'),
    block('blk-21-noise', 'doc:handbook', 'The gardener repotted the fern on a rainy afternoon.'),
    block('blk-22-noise', 'doc:handbook', 'Sourdough needs a long cold proof in the refrigerator.'),
    block('blk-23-noise', 'doc:runbook', 'Ferry timetables change without warning in October.'),
    block('blk-24-noise', 'doc:runbook', 'The cellist tuned quietly behind the closed curtain.'),
    block('blk-25-noise', 'doc:code', 'Repaint the fence before the first frost arrives.'),
    block('blk-26-noise', 'doc:code', 'Свежий хлеб пахнет лучше всего ранним утром.'),
    block('blk-27-noise', 'doc:handbook', 'Migrating storks pass over the valley twice a year.'),
    block('blk-28-noise', 'doc:notes-ru', 'Велосипед стоит под навесом с прошлой осени.'),
  ];
}

/**
 * Two blocks with different identifiers and byte-identical content.
 *
 * A retriever must keep both addressable: they are one text in two places, and
 * deciding what to do with that pair belongs to `CandidateDeduplicator`, not to
 * retrieval (DEC-031).
 */
export function retrievalDuplicateCorpusV1(tokenizer: Tokenizer): readonly ContextBlock[] {
  const shared = 'The reticulator entry is recorded verbatim in both places.';
  return [
    retrievalBlock('blk-dup-b', 'doc:handbook', shared, tokenizer),
    retrievalBlock('blk-dup-a', 'doc:handbook', shared, tokenizer),
    retrievalBlock('blk-dup-other', 'doc:handbook', 'An unrelated line about ferries.', tokenizer),
  ];
}

/**
 * Three blocks whose text differs but which score identically for one query.
 *
 * Each contains the query term exactly once and the same number of terms
 * overall, so BM25+ gives them one score and only the adapter's own tie-break
 * decides their order (INV-DET-005).
 */
export function retrievalTieCorpusV1(tokenizer: Tokenizer): readonly ContextBlock[] {
  return [
    retrievalBlock('blk-tie-c', 'doc:handbook', 'gamma delta epsilon reticulator', tokenizer),
    retrievalBlock('blk-tie-a', 'doc:handbook', 'alpha beta zeta reticulator', tokenizer),
    retrievalBlock('blk-tie-b', 'doc:handbook', 'eta theta iota reticulator', tokenizer),
  ];
}

/* -------------------------------------------------------------------------- */
/* Cases                                                                       */
/* -------------------------------------------------------------------------- */

/** Which corpus a case is measured over. */
export type RetrievalCorpusName = 'main' | 'duplicate' | 'tie';

/**
 * One retrieval expectation.
 *
 * `relevantBlockIds` is an unordered set: the case asserts *these blocks must be
 * found within k*, which is what recall@k and reciprocal rank measure.
 *
 * `expectedOrder` is present only where the query justifies an exact ordered
 * claim — a deterministic tie, a duplicate pair, or a query with a single hit.
 * Demanding an exact order everywhere would turn incidental BM25+ arithmetic
 * into a frozen expectation, and the first corpus edit would break cases that
 * are not actually wrong.
 *
 * An **empty** `relevantBlockIds` marks a no-match case. Such a case asserts that
 * the provider proposes nothing, and it is deliberately not a recall or
 * reciprocal-rank observation: those are relevance metrics, and this case has no
 * relevance set for them to be computed over (DEC-041).
 */
export interface RetrievalCase {
  readonly id: string;
  readonly corpus: RetrievalCorpusName;
  readonly query: string;
  /** The retrieval bound the case is run under, and the k of recall@k. */
  readonly k: number;
  readonly relevantBlockIds: readonly string[];
  readonly expectedOrder?: readonly string[];
  readonly note: string;
}

/** Every case in the suite, in dataset order. */
export function retrievalSuiteV1(): readonly RetrievalCase[] {
  return [
    {
      id: 'rc-01-rare-term',
      corpus: 'main',
      query: 'reticulator',
      k: 5,
      relevantBlockIds: ['blk-01-reticulator'],
      expectedOrder: ['blk-01-reticulator'],
      note: 'A term occurring exactly once in the corpus returns exactly that block.',
    },
    {
      id: 'rc-02-technical-identifier',
      corpus: 'main',
      query: 'INV-BUDGET-001',
      k: 5,
      relevantBlockIds: ['blk-02-invariant-id'],
      note: 'The identifier splits on punctuation into INV, BUDGET, and 001; the identifier block must still rank first, well above the blocks that merely share "budget".',
    },
    {
      id: 'rc-03-multi-word-technical',
      corpus: 'main',
      query: 'deterministic token budget allocation',
      k: 5,
      relevantBlockIds: ['blk-03-allocation'],
      note: 'Four query terms; only one block carries all of them.',
    },
    {
      id: 'rc-04-russian',
      corpus: 'main',
      query: 'записывает трассировку решений',
      k: 5,
      relevantBlockIds: ['blk-04-russian'],
      note: 'Cyrillic terms tokenize and match without any CtxAlloc normalization.',
    },
    {
      id: 'rc-05-english',
      corpus: 'main',
      query: 'renderer serializes',
      k: 5,
      relevantBlockIds: ['blk-05-english'],
      expectedOrder: ['blk-05-english'],
      note: 'Two English terms shared by exactly one block.',
    },
    {
      id: 'rc-06-mixed-language',
      corpus: 'main',
      query: 'providerVersion кандидата',
      k: 5,
      relevantBlockIds: ['blk-06-mixed'],
      expectedOrder: ['blk-06-mixed'],
      note: 'A Cyrillic word and an English camel-case identifier in one query.',
    },
    {
      id: 'rc-07-distractor-heavy',
      corpus: 'main',
      query: 'reticulator calibrates',
      k: 3,
      relevantBlockIds: ['blk-01-reticulator'],
      expectedOrder: ['blk-01-reticulator'],
      note: 'Nine distractors dominate the corpus and none of them may be returned.',
    },
    {
      id: 'rc-08-shared-term',
      corpus: 'main',
      query: 'budget',
      k: 5,
      relevantBlockIds: [
        'blk-02-invariant-id',
        'blk-03-allocation',
        'blk-07-code',
        'blk-08-budget-note',
      ],
      note: 'One term carried by four blocks — including the code fragment, where it appears as a call argument. All four must be found, in any order.',
    },
    {
      id: 'rc-09-duplicate-content',
      corpus: 'duplicate',
      query: 'reticulator',
      k: 5,
      relevantBlockIds: ['blk-dup-a', 'blk-dup-b'],
      expectedOrder: ['blk-dup-a', 'blk-dup-b'],
      note: 'Identical content under two identifiers stays two addressable results, tied and ordered by identifier.',
    },
    {
      id: 'rc-10-no-match',
      corpus: 'main',
      query: 'xylophone bathysphere',
      k: 5,
      // An empty relevance set is the case's whole point, and it is why this
      // case is measured by an empty-result expectation rather than by recall or
      // reciprocal rank: neither is defined without a relevant block.
      relevantBlockIds: [],
      expectedOrder: [],
      note: 'No shared term means no candidate. A lexical retriever must not invent one, and this case is not a recall or reciprocal-rank observation.',
    },
    {
      id: 'rc-11-punctuation-code',
      corpus: 'main',
      query: 'ctx_alloc::allocate',
      k: 5,
      relevantBlockIds: ['blk-07-code'],
      expectedOrder: ['blk-07-code'],
      note: 'A code token splits on its punctuation and still resolves to the code block.',
    },
    {
      id: 'rc-12-not-shortest-or-longest',
      corpus: 'main',
      query: 'reserve subtracted',
      k: 5,
      relevantBlockIds: ['blk-08-budget-note'],
      expectedOrder: ['blk-08-budget-note'],
      note: 'The relevant block is neither the shortest nor the longest in the corpus.',
    },
    {
      id: 'rc-13-equal-score-tie',
      corpus: 'tie',
      query: 'reticulator',
      k: 5,
      relevantBlockIds: ['blk-tie-a', 'blk-tie-b', 'blk-tie-c'],
      expectedOrder: ['blk-tie-a', 'blk-tie-b', 'blk-tie-c'],
      note: 'Three equal scores, ordered only by block identifier over UTF-16 code units.',
    },
  ];
}

/** The corpus one case is measured over. */
export function retrievalCorpusFor(
  name: RetrievalCorpusName,
  tokenizer: Tokenizer,
): readonly ContextBlock[] {
  if (name === 'duplicate') return retrievalDuplicateCorpusV1(tokenizer);
  if (name === 'tie') return retrievalTieCorpusV1(tokenizer);
  return retrievalCorpusV1(tokenizer);
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One case's measured retrieval outcome.
 *
 * The shape follows the case, because **recall and reciprocal rank are
 * relevance-retrieval metrics and a case with no relevant block has neither**.
 * With an empty relevance set there is no denominator for recall and no "first
 * relevant result" to rank. Publishing `1` for recall while publishing `0` for
 * reciprocal rank — the earlier convention — is internally inconsistent, and it
 * makes an aggregate depend on which arbitrary fill-in value was chosen rather
 * than on retrieval quality.
 *
 * A no-match case is still valuable. It just tests a **different property**: that
 * a lexical retriever proposes nothing when nothing shares a term, rather than
 * inventing a candidate. That property gets its own explicit field and stays out
 * of the relevance aggregates entirely.
 *
 * The two shapes are a discriminated union so a consumer cannot read a metric
 * that was never measured (DEC-041).
 */
export type RetrievalCaseMetrics =
  | {
      readonly caseId: string;
      readonly kind: 'relevance';
      /** How many of the relevant blocks appear in the first k results. */
      readonly recallAtK: number;
      /** `1 / rank` of the first relevant result over one-based ranks. */
      readonly reciprocalRank: number;
      readonly retrievedBlockIds: readonly string[];
    }
  | {
      readonly caseId: string;
      readonly kind: 'no-match';
      /** The case asserts the provider proposes nothing at all. */
      readonly expectedEmptyResult: true;
      /** Whether it did. */
      readonly emptyResultSatisfied: boolean;
      readonly retrievedBlockIds: readonly string[];
    };

/**
 * The fraction of relevant blocks appearing in the first `k` results.
 *
 * Defined only for a non-empty relevance set; a caller that passes an empty one
 * is asking a question recall cannot answer, and it fails rather than returning a
 * convention. Duplicate identifiers in either list are collapsed, so a repeated
 * identifier cannot inflate the numerator past the denominator.
 */
export function recallAtK(
  retrievedBlockIds: readonly string[],
  relevantBlockIds: readonly string[],
  k: number,
): number {
  const relevant = new Set(relevantBlockIds);
  if (relevant.size === 0) {
    throw new Error('recallAtK is undefined for a case with no relevant block');
  }
  const found = new Set(retrievedBlockIds.slice(0, k).filter((id) => relevant.has(id)));
  return found.size / relevant.size;
}

/**
 * `1 / rank` of the first relevant result over one-based ranks, or `0` when the
 * results contain none.
 *
 * `0` here means *the relevant block was not retrieved*, which is a real
 * measurement. It is not the same as "there was nothing to retrieve": an empty
 * relevance set fails, exactly as it does for recall.
 */
export function reciprocalRank(
  retrievedBlockIds: readonly string[],
  relevantBlockIds: readonly string[],
): number {
  const relevant = new Set(relevantBlockIds);
  if (relevant.size === 0) {
    throw new Error('reciprocalRank is undefined for a case with no relevant block');
  }
  for (const [index, id] of retrievedBlockIds.entries()) {
    if (relevant.has(id)) return 1 / (index + 1);
  }
  return 0;
}

/** The outcome for one case, in whichever shape the case's relevance set implies. */
export function measureRetrievalCase(
  entry: RetrievalCase,
  retrievedBlockIds: readonly string[],
): RetrievalCaseMetrics {
  if (entry.relevantBlockIds.length === 0) {
    return {
      caseId: entry.id,
      kind: 'no-match',
      expectedEmptyResult: true,
      emptyResultSatisfied: retrievedBlockIds.length === 0,
      retrievedBlockIds: [...retrievedBlockIds],
    };
  }
  return {
    caseId: entry.id,
    kind: 'relevance',
    recallAtK: recallAtK(retrievedBlockIds, entry.relevantBlockIds, entry.k),
    reciprocalRank: reciprocalRank(retrievedBlockIds, entry.relevantBlockIds),
    retrievedBlockIds: [...retrievedBlockIds],
  };
}

/**
 * The diagnostic summary of a whole suite run.
 *
 * Relevance-bearing cases and no-match cases are counted and reported
 * **separately**, and no aggregate mixes them: averaging a metric a case never
 * had is how a suite summary starts describing its own conventions instead of
 * the retriever (METRICS 16).
 */
export interface RetrievalSuiteSummary {
  readonly relevanceCaseCount: number;
  /** Mean recall@k over relevance-bearing cases only. `null` when there are none. */
  readonly meanRecallAtK: number | null;
  /** Mean reciprocal rank over relevance-bearing cases only. `null` when there are none. */
  readonly meanReciprocalRank: number | null;
  readonly noMatchCaseCount: number;
  /** How many no-match cases the provider answered with no candidate at all. */
  readonly noMatchSatisfiedCount: number;
}

export function summarizeRetrievalRun(
  measurements: readonly RetrievalCaseMetrics[],
): RetrievalSuiteSummary {
  const relevance = measurements.filter((entry) => entry.kind === 'relevance');
  const noMatch = measurements.filter((entry) => entry.kind === 'no-match');
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;

  return {
    relevanceCaseCount: relevance.length,
    meanRecallAtK: mean(relevance.map((entry) => entry.recallAtK)),
    meanReciprocalRank: mean(relevance.map((entry) => entry.reciprocalRank)),
    noMatchCaseCount: noMatch.length,
    noMatchSatisfiedCount: noMatch.filter((entry) => entry.emptyResultSatisfied).length,
  };
}

/** The scope every main-corpus case is retrieved under. */
export { RETRIEVAL_SCOPE };

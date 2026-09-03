import { CANDIDATE_BLOCK_SCHEMA_VERSION, findLoneSurrogate } from '@ctxalloc/domain';
import type { CandidateBlock, ContextBlock } from '@ctxalloc/domain';
import type { CandidateProvider, CandidateProviderRequest } from '@ctxalloc/ports';
import MiniSearch from 'minisearch';

/**
 * The first real `CandidateProvider`: offline lexical retrieval over the exact
 * prepared corpus (DEC-041).
 *
 * It answers one question — *which of these exact blocks match this query
 * lexically, and how strongly?* — and refuses everything else. It reads no file,
 * opens no database, reaches no network, loads no model, computes no embedding,
 * expands no query, reranks nothing, and keeps nothing between calls. It is
 * retrieval, not compilation: it proposes candidates and never scores, filters,
 * budgets, orders, or selects (INV-ALLOC-002, INV-DEP-002).
 *
 * Three properties are load-bearing.
 *
 * **One prepared block is one retrieval record.** Every supplied
 * `ContextBlock` becomes exactly one indexed document whose identifier is
 * `String(block.id)` and whose only searchable text is `block.content`. The
 * adapter re-chunks nothing, overlaps nothing, rewrites nothing, and
 * concatenates no title, heading, path, or metadata into the indexed text. Every
 * returned candidate wraps the **exact request block value**, carried by
 * reference — never a snippet, a reconstruction, or a library-owned document
 * (INV-ADAPTER-002, INV-PROV-001).
 *
 * **The corpus is exactly what the request carries.** The index is built per
 * call, in memory, from `request.blocks` and from nothing else: no cache
 * directory, no home-directory collection, no working-directory scan, and no
 * index left over from a previous request. Two scopes with lexically identical
 * blocks cannot reach each other, because neither call can see the other's
 * corpus (INV-SCOPE-005, INV-DET-002).
 *
 * **Only lexical relevance ranks.** `createdAt`, `updatedAt`,
 * `attributes.priority`, `attributes.required`, `attributes.category`,
 * `headingPath`, block metadata, source metadata, source title, source type, and
 * `referenceTime` take no part in ranking. They are compiler and application
 * concerns, and a provider that boosted on one would be making an allocation
 * decision under another name (INV-ALLOC-002, INV-DET-004).
 *
 * The library stays behind this file: no MiniSearch type, option object, index
 * handle, or search result reaches a public declaration, and every library throw
 * becomes a project-owned {@link MiniSearchCandidateProviderError}
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */

/** Stable identifier of this provider implementation and its retrieval mode. */
export const MINISEARCH_CANDIDATE_PROVIDER_ID = 'ctxalloc-minisearch-bm25';

/** The exact pinned retrieval library this provider's scores come from. */
export const MINISEARCH_LIBRARY_NAME = 'minisearch';

/**
 * The exact pinned library version.
 *
 * It is part of retrieval provenance rather than packaging trivia: the score a
 * result carries is produced by this version's BM25+ implementation, its
 * parameters, and its tokenizer, so a different version is a different metric
 * even under the same name. It is declared here as a literal and never read from
 * `package.json` at runtime — an adapter that discovered its own version would
 * have to open a file to know who it is, and its identity would then depend on
 * the shape of an installation (INV-DET-003). A regression test keeps this
 * literal equal to the manifest pin.
 */
export const MINISEARCH_LIBRARY_VERSION = '7.2.0';

/**
 * Stable version of this provider's retrieval semantics.
 *
 * It binds the CtxAlloc adapter revision to the exact library version, because
 * both can change what a score means. A consumer matches on this exact string:
 * `CandidateScorer` will not normalize a score whose `providerVersion` no rule
 * covers, which is precisely the protection wanted when the library moves
 * (INV-SCORE-002).
 */
export const MINISEARCH_CANDIDATE_PROVIDER_VERSION = `1+minisearch@${MINISEARCH_LIBRARY_VERSION}`;

/**
 * What this provider's raw score actually is.
 *
 * MiniSearch computes a BM25+ score per matched query term over the indexed
 * field and returns their sum **multiplied by the number of matched query
 * terms**. That product is the published value, and this string names it rather
 * than calling it "BM25" or "relevance": it is neither plain BM25 nor a
 * similarity, it is unbounded above, its scale moves with corpus statistics, and
 * it is comparable only among results of one query over one corpus.
 *
 * Nothing is invented, clamped, inverted, rescaled, or mapped into `[0, 1]` —
 * mapping it would publish a number the library never produced under a name that
 * suggests a bounded metric (INV-SCORE-002, INV-PROV-003).
 */
export const MINISEARCH_RETRIEVAL_SCORE_SEMANTICS =
  'minisearch-bm25plus-sum-times-matched-query-terms';

/** Higher scores mean stronger lexical match, so the direction is truthful. */
export const MINISEARCH_RETRIEVAL_SCORE_HIGHER_IS_BETTER = true;

/** Current schema version of {@link MiniSearchCandidateProviderConfig} (INV-STORE-004). */
export const MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION = 1;

/**
 * Explicit provider configuration.
 *
 * It is deliberately tiny. There is no embedding model, reranker,
 * query-expansion model, semantic weight, hybrid weight, endpoint, API key,
 * index path, or scratch directory, because this provider performs none of those
 * things and a field that configured one would advertise behavior that does not
 * exist. There is no fuzzy or prefix option either: v1 is plain term relevance,
 * and turning on expansion would quietly change what a score means (DEC-041).
 *
 * `maxCandidates` is a **retrieval bound**, not a token budget. It caps how many
 * wrappers are proposed, chosen strictly by lexical rank. The provider never
 * reads the token budget, never inspects `tokenCount`, never computes a compiler
 * score, and never keeps retrieving to fill a budget: allocation is downstream
 * and belongs to `BudgetAllocator` alone (INV-ALLOC-002).
 *
 * The constructor takes `unknown` and validates this shape itself, because
 * configuration routinely arrives from a file, an environment, or another
 * language, where a compile-time type proves nothing (INV-BLOCK-005). The
 * interface stays exported for callers that do build one in TypeScript.
 */
export interface MiniSearchCandidateProviderConfig {
  readonly schemaVersion: typeof MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION;
  /** Hard upper bound on how many candidates one call may propose. */
  readonly maxCandidates: number;
}

/** Machine-readable categories of a lexical retrieval failure (INV-TRACE-002). */
export type MiniSearchCandidateProviderErrorCode =
  | 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG'
  | 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST'
  | 'MINISEARCH_CANDIDATE_PROVIDER_DUPLICATE_BLOCK_ID'
  | 'MINISEARCH_CANDIDATE_PROVIDER_INDEX_FAILED'
  | 'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED'
  | 'MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK'
  | 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE';

/**
 * The single error this adapter raises.
 *
 * It carries a stable code and, where one exists, the exact block identifier at
 * fault — a project-owned value the caller already holds. It deliberately
 * carries no raw query, no block content, no source content, no library error,
 * no library result payload, no stack from the dependency, and no path: a
 * retrieval failure must not become the thing that discloses the corpus
 * (INV-SEC-001, INV-ADAPTER-001).
 *
 * There is no cleanup failure code, because there is nothing to clean up: the
 * index is an in-memory value that becomes garbage when the call returns.
 */
export class MiniSearchCandidateProviderError extends Error {
  readonly code: MiniSearchCandidateProviderErrorCode;
  /** The exact block identifier at fault, or the empty string when there is none. */
  readonly blockId: string;

  constructor(code: MiniSearchCandidateProviderErrorCode, message: string, blockId = '') {
    super(message);
    this.name = 'MiniSearchCandidateProviderError';
    this.code = code;
    this.blockId = blockId;
  }
}

/** The complete set of configuration fields. Anything else is rejected. */
const CONFIG_KEYS: readonly string[] = ['maxCandidates', 'schemaVersion'];

/** The complete set of request fields the port declares. Anything else is rejected. */
const REQUEST_KEYS: readonly string[] = [
  'blocks',
  'query',
  'referenceTime',
  'scope',
  'sourceDocuments',
];

/** The one indexed field. Nothing else about a block is searchable. */
const INDEXED_FIELD = 'content';

/**
 * One minimal retrieval document.
 *
 * The library receives this and never the `ContextBlock`. A retrieval library
 * that held the live block could mutate its content, its attributes, or its
 * `tokenCount` in place, and `readonly` stops nothing at run time — so the two
 * strings the index actually needs are copied out and the block itself stays
 * untouched (INV-ADAPTER-004, INV-ALLOC-004).
 */
interface RetrievalDocument {
  readonly id: string;
  readonly content: string;
}

/**
 * Compares two strings by UTF-16 code unit.
 *
 * `localeCompare` is deliberately not used: its result depends on the machine's
 * locale data, which would let one tie resolve differently on a developer's
 * laptop and in a container (INV-DET-001).
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function invalidRequest(message: string, blockId = ''): MiniSearchCandidateProviderError {
  return new MiniSearchCandidateProviderError(
    'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    message,
    blockId,
  );
}

/** Reads one own data property without invoking an accessor or a prototype value. */
function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return undefined;
  return descriptor.value;
}

/**
 * Checks the request for exactly the structure this adapter depends on.
 *
 * This is **not** candidate or domain validation. `CandidateValidator` owns the
 * `CandidateBlock` schema, the scope rule, the hash rule, and the token-count
 * rule, and restating any of them here would create a second owner of one truth
 * (INV-DEP-003). What is checked is only what would otherwise reach the
 * dependency as a raw type error: the request is an object with the port's own
 * fields, the query is a well-formed UTF-16 string, the two collections are
 * arrays, and the scope is structurally present.
 *
 * Malformed UTF-16 is rejected rather than searched. A lone surrogate has no
 * UTF-8 encoding, so a query containing one describes text no corpus can hold
 * (INV-BLOCK-007).
 */
function validateRequest(request: unknown): CandidateProviderRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw invalidRequest('MiniSearchCandidateProvider request must be an object.');
  }

  const unknownKeys = Object.keys(request)
    .filter((key) => !REQUEST_KEYS.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw invalidRequest(
      `MiniSearchCandidateProvider request has unknown field(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const query = ownDataProperty(request, 'query');
  if (typeof query !== 'string') {
    throw invalidRequest('MiniSearchCandidateProvider request query must be a string.');
  }
  if (findLoneSurrogate(query) !== null) {
    throw invalidRequest('MiniSearchCandidateProvider request query must be well-formed UTF-16.');
  }

  const blocks = ownDataProperty(request, 'blocks');
  if (!Array.isArray(blocks)) {
    throw invalidRequest('MiniSearchCandidateProvider request blocks must be an array.');
  }
  const sourceDocuments = ownDataProperty(request, 'sourceDocuments');
  if (!Array.isArray(sourceDocuments)) {
    throw invalidRequest('MiniSearchCandidateProvider request sourceDocuments must be an array.');
  }

  const scope = ownDataProperty(request, 'scope');
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) {
    throw invalidRequest('MiniSearchCandidateProvider request scope must be an object.');
  }
  for (const field of ['tenantId', 'workspaceId'] as const) {
    const value = ownDataProperty(scope, field);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw invalidRequest(
        `MiniSearchCandidateProvider request scope ${field} must not be empty or whitespace-only.`,
      );
    }
  }

  return request as CandidateProviderRequest;
}

export class MiniSearchCandidateProvider implements CandidateProvider {
  readonly id = MINISEARCH_CANDIDATE_PROVIDER_ID;
  readonly version = MINISEARCH_CANDIDATE_PROVIDER_VERSION;

  readonly #maxCandidates: number;

  /**
   * Validates the configuration strictly: exactly the two documented fields, no
   * unknown field, no default, no coercion, and no environment fallback.
   *
   * An unknown field is rejected rather than ignored. Accepting one means a
   * misspelled `maxCandidate` leaves the provider with a bound the caller
   * believes they configured but never set, and a future field would be
   * swallowed by an older build instead of failing visibly (INV-BLOCK-005).
   *
   * @throws {MiniSearchCandidateProviderError} when the configuration is not usable.
   */
  constructor(config: unknown) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        'MiniSearchCandidateProvider configuration must be an object.',
      );
    }

    const unknownKeys = Object.keys(config)
      .filter((key) => !CONFIG_KEYS.includes(key))
      .sort();
    if (unknownKeys.length > 0) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        `MiniSearchCandidateProvider configuration has unknown field(s): ${unknownKeys.join(', ')}.`,
      );
    }

    const { schemaVersion, maxCandidates } = config as Partial<MiniSearchCandidateProviderConfig>;

    if (schemaVersion !== MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        `MiniSearchCandidateProvider configuration schemaVersion must be exactly ${String(
          MINISEARCH_CANDIDATE_PROVIDER_CONFIG_SCHEMA_VERSION,
        )}.`,
      );
    }
    // A zero bound would make the provider silently propose nothing while
    // looking configured; a fraction or an unsafe integer is not a count.
    if (
      typeof maxCandidates !== 'number' ||
      !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1
    ) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        'MiniSearchCandidateProvider configuration maxCandidates must be a positive safe integer.',
      );
    }

    this.#maxCandidates = maxCandidates;
  }

  /**
   * Ranks the request corpus lexically against the request query.
   *
   * The whole call is a pure function of the configuration, the query, and the
   * exact blocks: it reads no clock, no random value, no environment variable,
   * no file, and no previous index, and `referenceTime` is passed nowhere near
   * the ranking (INV-DET-001, INV-DET-003, INV-DET-004).
   *
   * **An empty corpus and a blank query both return `[]` before the library is
   * touched.** `LocalCompilationRequest` permits a blank query, so a provider
   * that failed on one would break a request the public contract accepts; and
   * proposing nothing is the truthful answer to *what matches this?* when
   * nothing was asked or nothing was given. Neither path constructs an index,
   * loads anything, or writes anywhere. This is an adapter contract about the
   * whole call, not text normalization: the query is never trimmed, lowercased,
   * or Unicode-normalized before a search that does happen.
   *
   * The method is `async` so that **every** failure is a rejected promise. The
   * work it does is synchronous, but the port declares a `Promise`, and a caller
   * who only attaches a `catch` would otherwise miss a synchronous throw from a
   * malformed request — an adapter failure that escapes the shape the contract
   * promised is not an explicit failure (INV-ADAPTER-003).
   *
   * @throws {MiniSearchCandidateProviderError} for every failure, including a library throw.
   */
  async getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]> {
    const validated = validateRequest(request);

    if (validated.blocks.length === 0 || validated.query.trim().length === 0) {
      return [];
    }

    const corpus = documentsOf(validated.blocks);
    const index = buildIndex(corpus.documents);
    const results = search(index, validated.query);

    return this.#wrap(results, corpus.byId);
  }

  /**
   * Resolves every result to its request block, orders them, truncates to the
   * bound, and wraps the exact blocks.
   *
   * **Resolution happens before ordering and before truncation.** Every result
   * the library returned is looked up, so an identifier the corpus does not
   * contain fails the call even when it would have fallen outside the bound.
   * Checking only the survivors would let a fabricated identifier pass whenever
   * it ranked low, and a fabricated block is exactly the failure this boundary
   * exists to prevent (INV-PROV-001, INV-ADAPTER-003).
   *
   * Ordering is imposed here rather than inherited. MiniSearch sorts by score
   * descending, but equal scores keep the order the documents were added in, so
   * the same corpus in a different array order would return tied results in a
   * different order. The explicit final tie-break on the block identifier makes
   * the ranking a total order that depends on nothing but the blocks themselves
   * (INV-DET-002, INV-DET-005). Input array position is deliberately not a
   * tie-break at any level.
   *
   * `rank` is **zero-based** and equals the position in the returned array, so a
   * consumer reading the evidence and a consumer reading the order see one
   * ranking. The schema imposes no convention, so this one is stated rather than
   * assumed.
   */
  #wrap(
    results: readonly ScoredResult[],
    byId: ReadonlyMap<string, ContextBlock>,
  ): readonly CandidateBlock[] {
    const resolved = results.map((result) => {
      const block = byId.get(result.id);
      if (block === undefined) {
        throw new MiniSearchCandidateProviderError(
          'MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK',
          'MiniSearchCandidateProvider received a result identifier that the request corpus does not contain.',
          result.id,
        );
      }
      return { id: result.id, score: result.score, block };
    });

    resolved.sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id));

    // The block is carried by reference, unchanged. Nothing is copied, rebuilt,
    // or recomputed, so content, hash, token count, attributes, and metadata are
    // byte-identical to what the request supplied.
    //
    // The evidence carries no `metadata` at all. A provider-side identifier
    // would duplicate `block.id`, a snippet or a matched-term list would copy
    // corpus content into a value that travels toward a trace, and a dependency
    // debug payload is not a machine-readable fact about the search. The search
    // mode is already named by `providerId`, `providerVersion`, and `semantics`
    // (INV-SEC-003).
    return resolved.slice(0, this.#maxCandidates).map((entry, rank) => ({
      schemaVersion: CANDIDATE_BLOCK_SCHEMA_VERSION,
      block: entry.block,
      retrieval: {
        providerId: MINISEARCH_CANDIDATE_PROVIDER_ID,
        providerVersion: MINISEARCH_CANDIDATE_PROVIDER_VERSION,
        rank,
        score: {
          value: entry.score,
          semantics: MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
          higherIsBetter: MINISEARCH_RETRIEVAL_SCORE_HIGHER_IS_BETTER,
        },
      },
    }));
  }
}

/**
 * The exact minimal documents to index, and the map back to the request blocks.
 *
 * The map is the whole provenance mechanism: a result identifier is resolved
 * through it to the original block value, so no library-owned document can
 * become a candidate.
 *
 * A duplicate identifier is **rejected**, never overwritten. A prepared corpus
 * has unique identifiers, but this provider is public and a silent overwrite
 * would turn two distinct blocks into one and lose the other without a word
 * (INV-BLOCK-002, INV-ADAPTER-003).
 */
function documentsOf(blocks: readonly ContextBlock[]): {
  readonly documents: readonly RetrievalDocument[];
  readonly byId: ReadonlyMap<string, ContextBlock>;
} {
  const byId = new Map<string, ContextBlock>();
  const documents: RetrievalDocument[] = [];

  for (const block of blocks) {
    const id = ownDataProperty(block, 'id');
    if (typeof id !== 'string' || id.length === 0) {
      throw invalidRequest(
        'MiniSearchCandidateProvider request blocks must each carry a non-empty string id.',
      );
    }
    const content = ownDataProperty(block, 'content');
    if (typeof content !== 'string') {
      throw invalidRequest(
        'MiniSearchCandidateProvider request blocks must each carry string content.',
        id,
      );
    }
    if (byId.has(id)) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_DUPLICATE_BLOCK_ID',
        'MiniSearchCandidateProvider request blocks must have unique identifiers.',
        id,
      );
    }
    byId.set(id, block);
    // Exactly the block's own content, with no CtxAlloc normalization: no
    // lowercasing, no whitespace collapsing, no Markdown stripping, no Unicode
    // normalization, and no heading, title, path, or metadata prefix. The
    // library applies its own documented tokenization and case folding, which
    // DEC-041 records as the retrieval field contract.
    documents.push({ id, content });
  }

  return { documents, byId };
}

/**
 * Builds one in-memory index over exactly these documents.
 *
 * `idField` is the block identifier and `fields` is the single content field, so
 * one CtxAlloc block is one retrieval record with the project-owned identifier
 * intact (INV-ADAPTER-002). `storeFields` is empty: the index keeps no copy of
 * anything a result would carry back, because the block is resolved from the map
 * instead.
 *
 * A library throw becomes a project-owned failure. Nothing about the dependency
 * — its class, its message, its stack — escapes (INV-ADAPTER-001).
 */
function buildIndex(documents: readonly RetrievalDocument[]): MiniSearch<RetrievalDocument> {
  try {
    const index = new MiniSearch<RetrievalDocument>({
      idField: 'id',
      fields: [INDEXED_FIELD],
      storeFields: [],
    });
    index.addAll([...documents]);
    return index;
  } catch {
    throw new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_INDEX_FAILED',
      'MiniSearchCandidateProvider could not index the request corpus.',
    );
  }
}

/** One validated library result: an identifier from this corpus and a finite score. */
interface ScoredResult {
  readonly id: string;
  readonly score: number;
}

/**
 * Runs the plain lexical query and validates every result before it is used.
 *
 * **The search mode is v1 and explicit.** Prefix expansion and fuzzy matching
 * are both off — they are MiniSearch's defaults, and they are named here so a
 * future default change cannot quietly turn this provider into an approximate
 * matcher. No boost, no field weighting, no filter, no combination operator, and
 * no BM25 parameter override: the score is the library's documented default
 * BM25+ behavior, which is what {@link MINISEARCH_RETRIEVAL_SCORE_SEMANTICS}
 * names.
 *
 * The result array is library output, so it is data rather than something to
 * trust: an identifier that is not a string and a score that is not a finite
 * number are rejected explicitly rather than coerced, because either would
 * travel into a trace as a measurement (INV-SCORE-004, INV-ADAPTER-003).
 */
function search(index: MiniSearch<RetrievalDocument>, query: string): readonly ScoredResult[] {
  let raw: unknown;
  try {
    raw = index.search(query, { prefix: false, fuzzy: false });
  } catch {
    throw new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED',
      'MiniSearchCandidateProvider could not execute the lexical search.',
    );
  }

  if (!Array.isArray(raw)) {
    throw new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED',
      'MiniSearchCandidateProvider received a search result that is not an array.',
    );
  }

  return raw.map((entry): ScoredResult => {
    const id = ownDataProperty(entry, 'id');
    if (typeof id !== 'string' || id.length === 0) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK',
        'MiniSearchCandidateProvider received a search result with no usable block identifier.',
      );
    }
    const score = ownDataProperty(entry, 'score');
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE',
        'MiniSearchCandidateProvider received a search result whose score is not a finite number.',
        id,
      );
    }
    return { id, score };
  });
}

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
 * **The search mode is explicit.** Terms are combined with **OR**, matching is
 * exact — no prefix expansion, no fuzzy matching — one field is indexed, and the
 * BM25+ parameters are the pinned library defaults restated in this file. Each of
 * those is also MiniSearch 7.2.0's default, so stating them changes no score;
 * they are stated because a mode assembled from library defaults is stable only
 * until the library changes one.
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

/**
 * Stable identifier of this provider implementation and its retrieval mode.
 *
 * It says `bm25plus`, not `bm25`, because that is what the library computes. The
 * identifier is matched exactly by a scoring policy's normalization rule, so a
 * name that overstated the metric would invite a rule written for plain BM25 to
 * claim a contract it does not describe. The full detail lives in
 * {@link MINISEARCH_RETRIEVAL_SCORE_SEMANTICS}; the identifier only has to be
 * truthful, not exhaustive.
 */
export const MINISEARCH_CANDIDATE_PROVIDER_ID = 'ctxalloc-minisearch-bm25plus';

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
 * terms**. Terms are combined with OR, so a block matching more of them scores
 * higher on both factors. That product is the published value, and this string
 * names it rather
 * than calling it "BM25" or "relevance": it is neither plain BM25 nor a
 * similarity, it is unbounded above, its scale moves with corpus statistics, and
 * it is comparable only among results of one query over one corpus.
 *
 * Nothing is invented, clamped, inverted, rescaled, or mapped into `[0, 1]` —
 * mapping it would publish a number the library never produced under a name that
 * suggests a bounded metric (INV-SCORE-002, INV-PROV-003).
 *
 * Every published value is **strictly greater than zero**. BM25+ adds a positive
 * floor per matched term, and a document matching no term is omitted from the
 * results rather than returned scoring zero, so a zero or negative value is
 * malformed output for this contract rather than a weak match. The adapter
 * rejects one instead of publishing it.
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
 * exist. There is no fuzzy, prefix, term-combination, or BM25-tuning option
 * either: v1 is exact term relevance combined with OR, fixed by the adapter, and
 * making any of it configurable would let one deployment's score mean something
 * different from another's under one `providerVersion` (DEC-041).
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
 * fault. `blockId` is **only ever a value read from the caller's own request
 * corpus** — never a string the dependency produced. An identifier a search
 * result carries that the request corpus does not contain is by definition not a
 * project-owned block identifier, and on malformed or hostile library output it
 * could be arbitrary attacker-influenced data; publishing it here would put
 * dependency-controlled content into a public field documented as
 * caller-owned. Such failures therefore leave `blockId` empty, and the raw
 * identifier is copied nowhere at all — not into the message, the code, the
 * blockId, or any other field (DEC-041).
 *
 * It deliberately carries no raw query, no block content, no source content, no
 * library error, no library result payload, no stack from the dependency, and no
 * path: a retrieval failure must not become the thing that discloses the corpus
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

/* -------------------------------------------------------------------------- */
/* Guarded inspection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Adapter-side inspection is **total**: no runtime exception escapes it.
 *
 * Everything this adapter looks at is untrusted at run time — the configuration,
 * the request, its blocks, and the dependency's own search output. Any of them
 * may be a `Proxy` whose `ownKeys` or `getOwnPropertyDescriptor` trap throws, or
 * an object whose properties are throwing accessors. A bare `Object.keys`,
 * destructuring, or descriptor read would then let a raw `TypeError` — or a
 * message the inspected value chose — escape as this adapter's failure, which is
 * exactly what the Phase 16 and Phase 17 boundaries established must not happen
 * (INV-ADAPTER-001, INV-ADAPTER-003, INV-SEC-001).
 *
 * A **revoked** `Proxy` is the sharpest case: it is `typeof "object"` and not
 * `null`, so it reaches every structural check here, and it refuses *every*
 * reflective operation — including `Array.isArray`, which looks passive but
 * unwraps a proxy to reach its target.
 *
 * Every reflective operation therefore goes through one of the helpers below,
 * each of which reports failure as data. A reflective failure becomes a
 * project-owned error whose code names *where* it happened — configuration,
 * request, or dependency result — and whose message is fixed. Nothing the
 * inspected value said is ever copied.
 *
 * **No accessor is ever invoked, and no `get` trap is ever used.** An own
 * accessor is reported rather than read, and an array's spine is snapshotted
 * through own data descriptors rather than through `value.length` and
 * `value[index]` — both of which are property *gets* that run a `Proxy` trap or
 * an installed getter. Catching what such code throws is not enough: by then it
 * has already run, and a getter that does *not* throw can mutate state, answer
 * differently on each read, or merely observe that it was consulted. Every field
 * this adapter needs is plain data, so nothing is lost by refusing to run code
 * for it.
 */

/** One guarded property read: present data, deliberately-absent, or reflection failed. */
type Inspected =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' };

const ABSENT: Inspected = { kind: 'absent' };
const FAILED: Inspected = { kind: 'failed' };

/**
 * Reads one own **data** property without invoking an accessor.
 *
 * A missing property and an own accessor both report `absent`, because neither
 * yields a value this adapter is willing to read. A throwing trap reports
 * `failed`, so the caller can raise the right project-owned code rather than
 * letting the trap's own error escape.
 */
function tryOwnDataProperty(value: unknown, key: string): Inspected {
  if (typeof value !== 'object' || value === null) return ABSENT;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return FAILED;
  }
  if (descriptor === undefined || !('value' in descriptor)) return ABSENT;
  return { kind: 'value', value: descriptor.value };
}

/**
 * Whether `value` is an array, or `null` when even that cannot be determined.
 *
 * `Array.isArray` looks passive and almost always is, but the specification's
 * `IsArray` unwraps a `Proxy` to reach its target, and on a **revoked** proxy
 * that throws:
 *
 * ```text
 * const { proxy, revoke } = Proxy.revocable([], {});
 * revoke();
 * Array.isArray(proxy);
 * // TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
 * ```
 *
 * On Node 22 this holds for an **object-target** revoked proxy too, so it is not
 * a quirk of array-backed ones. A revoked proxy is an ordinary value for a caller
 * to hold — it is `typeof "object"` and not `null` — so it reaches every one of
 * this adapter's structural checks, and an unguarded call there would let a raw
 * `TypeError`, with the engine's own wording, escape as this adapter's failure.
 *
 * The question is answered **only** this way. Probing the value some other way to
 * decide whether it is an array would mean inspecting a value that has already
 * refused to be inspected.
 */
function tryIsArray(value: unknown): boolean | null {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

/** Own enumerable string keys, or `null` when the `ownKeys` trap threw. */
function tryOwnEnumerableKeys(value: object): readonly string[] | null {
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

/**
 * A defensive copy of an array's spine read **through own data descriptors
 * only**, or `null` when it cannot be read that way.
 *
 * `Array.isArray` is also true of a `Proxy` around an array, and an ordinary
 * array can carry an accessor at an index. So `value.length` and `value[index]`
 * are both property *gets*: on a `Proxy` each runs the `get` trap, and on an
 * array with an installed getter the element read runs that getter. Wrapping
 * those reads in a `try` makes a *thrown* failure project-owned, but by then the
 * untrusted code has already run — and a getter that does not throw is worse
 * than one that does. It can mutate external state, return a different value
 * each time it is consulted, or observe that it was read at all.
 *
 * Every read here therefore goes through `Object.getOwnPropertyDescriptor`,
 * which reports an accessor without invoking it. The array is unreadable — and
 * the whole request or result is rejected — when its `length` is not an own data
 * property holding a non-negative safe integer, when any index carries an
 * accessor, or when any descriptor lookup throws.
 *
 * A **hole** (an index with no own descriptor at all) copies `undefined`, which
 * the ordinary validation downstream then rejects for not being a block or a
 * result. That keeps sparseness a deterministic data problem rather than a
 * second reflective failure mode.
 *
 * Every later iteration walks the plain snapshot, so the untrusted value is
 * touched exactly once, reflectively.
 */
function tryReadArrayItems(value: unknown): readonly unknown[] | null {
  // A revoked proxy cannot even be asked whether it is an array, and that is an
  // unreadable array rather than a different kind of failure.
  if (tryIsArray(value) !== true) return null;

  const lengthDescriptor = tryOwnDataProperty(value, 'length');
  if (lengthDescriptor.kind !== 'value') return null;
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;

  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const element = tryOwnDataProperty(value, String(index));
    // An accessor reports `absent` rather than being invoked, and it is not
    // treated as a hole: a value that installed a getter where data belongs is
    // rejected outright rather than quietly read as `undefined`.
    if (element.kind === 'failed') return null;
    if (element.kind === 'absent' && hasOwnAccessor(value, String(index))) return null;
    items.push(element.kind === 'value' ? element.value : undefined);
  }
  return items;
}

/**
 * Whether `key` is an own **accessor** on `value`.
 *
 * Used only to tell an accessor apart from a genuine hole after
 * `tryOwnDataProperty` has already reported `absent`. It reads a descriptor and
 * never invokes anything; a throwing trap answers `false`, and the caller has
 * already decided what an unreadable descriptor means.
 */
function hasOwnAccessor(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && !('value' in descriptor);
  } catch {
    return false;
  }
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
/** One guarded read that fails the request when reflection throws. */
function requestField(value: unknown, key: string, label: string): unknown {
  const inspected = tryOwnDataProperty(value, key);
  if (inspected.kind === 'failed') {
    throw invalidRequest(`MiniSearchCandidateProvider could not inspect the request ${label}.`);
  }
  return inspected.kind === 'value' ? inspected.value : undefined;
}

/**
 * The validated request, and the exact query and corpus this call will use.
 *
 * The two values are returned rather than re-read later. Reading a property of
 * an untrusted object twice would let a `Proxy` answer differently each time, so
 * everything downstream works from what was inspected here once.
 */
interface ValidatedRequest {
  readonly query: string;
  readonly blocks: readonly unknown[];
}

function validateRequest(request: unknown): ValidatedRequest {
  if (typeof request !== 'object' || request === null || tryIsArray(request) !== false) {
    throw invalidRequest('MiniSearchCandidateProvider request must be an object.');
  }

  const keys = tryOwnEnumerableKeys(request);
  if (keys === null) {
    throw invalidRequest('MiniSearchCandidateProvider could not inspect the request fields.');
  }
  const unknownKeys = keys.filter((key) => !REQUEST_KEYS.includes(key)).sort();
  if (unknownKeys.length > 0) {
    throw invalidRequest(
      `MiniSearchCandidateProvider request has unknown field(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const query = requestField(request, 'query', 'query');
  if (typeof query !== 'string') {
    throw invalidRequest('MiniSearchCandidateProvider request query must be a string.');
  }
  if (findLoneSurrogate(query) !== null) {
    throw invalidRequest('MiniSearchCandidateProvider request query must be well-formed UTF-16.');
  }

  const blocks = tryReadArrayItems(requestField(request, 'blocks', 'blocks'));
  if (blocks === null) {
    throw invalidRequest('MiniSearchCandidateProvider request blocks must be a readable array.');
  }
  const sourceDocuments = requestField(request, 'sourceDocuments', 'sourceDocuments');
  if (tryIsArray(sourceDocuments) !== true) {
    throw invalidRequest('MiniSearchCandidateProvider request sourceDocuments must be an array.');
  }

  const scope = requestField(request, 'scope', 'scope');
  if (typeof scope !== 'object' || scope === null || tryIsArray(scope) !== false) {
    throw invalidRequest('MiniSearchCandidateProvider request scope must be an object.');
  }
  for (const field of ['tenantId', 'workspaceId'] as const) {
    const value = requestField(scope, field, `scope ${field}`);
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw invalidRequest(
        `MiniSearchCandidateProvider request scope ${field} must not be empty or whitespace-only.`,
      );
    }
  }

  return { query, blocks };
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
    if (typeof config !== 'object' || config === null || tryIsArray(config) !== false) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        'MiniSearchCandidateProvider configuration must be an object.',
      );
    }

    const keys = tryOwnEnumerableKeys(config);
    if (keys === null) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        'MiniSearchCandidateProvider could not inspect the configuration fields.',
      );
    }
    const unknownKeys = keys.filter((key) => !CONFIG_KEYS.includes(key)).sort();
    if (unknownKeys.length > 0) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
        `MiniSearchCandidateProvider configuration has unknown field(s): ${unknownKeys.join(', ')}.`,
      );
    }

    // Guarded reads rather than destructuring: destructuring would invoke a
    // getter, and a configuration object is untrusted at run time.
    const read = (key: string): unknown => {
      const inspected = tryOwnDataProperty(config, key);
      if (inspected.kind === 'failed') {
        throw new MiniSearchCandidateProviderError(
          'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
          `MiniSearchCandidateProvider could not inspect the configuration field ${key}.`,
        );
      }
      return inspected.kind === 'value' ? inspected.value : undefined;
    };
    const schemaVersion = read('schemaVersion');
    const maxCandidates = read('maxCandidates');

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

    // Results are resolved against the request corpus inside `search`, so
    // nothing downstream — including any public error — can carry an identifier
    // the dependency invented.
    return this.#wrap(search(index, validated.query, corpus.byId));
  }

  /**
   * Orders the resolved results, truncates to the bound, and wraps the exact
   * blocks.
   *
   * Every result reaching here has already been resolved to a request block by
   * `search`, so this method cannot encounter — or report — an identifier the
   * corpus does not contain.
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
  #wrap(resolved: ResolvedResult[]): readonly CandidateBlock[] {
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
function documentsOf(blocks: readonly unknown[]): {
  readonly documents: readonly RetrievalDocument[];
  readonly byId: ReadonlyMap<string, ContextBlock>;
} {
  const byId = new Map<string, ContextBlock>();
  const documents: RetrievalDocument[] = [];

  for (const block of blocks) {
    const inspectedId = tryOwnDataProperty(block, 'id');
    if (inspectedId.kind === 'failed') {
      throw invalidRequest(
        'MiniSearchCandidateProvider could not inspect the id of a request block.',
      );
    }
    const id = inspectedId.kind === 'value' ? inspectedId.value : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      throw invalidRequest(
        'MiniSearchCandidateProvider request blocks must each carry a non-empty string id.',
      );
    }
    const inspectedContent = tryOwnDataProperty(block, 'content');
    if (inspectedContent.kind === 'failed') {
      // The identifier is already a value read from the caller's own corpus, so
      // reporting it here discloses nothing the caller does not hold.
      throw invalidRequest(
        'MiniSearchCandidateProvider could not inspect the content of a request block.',
        id,
      );
    }
    const content = inspectedContent.kind === 'value' ? inspectedContent.value : undefined;
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
    byId.set(id, block as ContextBlock);
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

/** One search result already resolved to the request block it names. */
interface ResolvedResult {
  readonly id: string;
  readonly score: number;
  readonly block: ContextBlock;
}

/**
 * The exact search options this provider uses, stated rather than inherited.
 *
 * Every one of these is also MiniSearch 7.2.0's own default, so passing them
 * changes no score and no ranking — a golden test proves the results are
 * identical to the implicit form. They are written out because Phase 18 promises
 * a **stable, explicit retrieval mode**, and a mode assembled from library
 * defaults is only stable until the library changes one (DEC-041).
 *
 * * `combineWith: 'OR'` — a multi-term query matches a block containing *any*
 *   term, and a block containing more of them simply scores higher. The earlier
 *   claim that this provider used "no combination operator" was false: one was
 *   always in effect, silently inherited. AND is deliberately not used; it would
 *   make a longer query retrieve strictly less, which is not what a relevance
 *   ranking is for.
 * * `prefix: false`, `fuzzy: false` — exact terms only. Either would turn this
 *   into an approximate matcher and change what a score means.
 * * `bm25` — the pinned 7.2.0 defaults, restated so the metric named by
 *   {@link MINISEARCH_RETRIEVAL_SCORE_SEMANTICS} is fixed by this file and not
 *   only by the dependency pin.
 *
 * No boost, no field weighting, no filter: one field, exact `block.content`.
 */
const SEARCH_OPTIONS = {
  combineWith: 'OR',
  prefix: false,
  fuzzy: false,
  bm25: { k: 1.2, b: 0.7, d: 0.5 },
} as const;

/**
 * Runs the plain lexical query and resolves every result to a request block.
 *
 * **Resolution happens here, before any public error can carry an identifier.**
 * The result array is library output: on malformed or hostile output an
 * identifier could be arbitrary data, and it is by definition not a project-owned
 * block identifier unless the request corpus contains it. So an unknown or
 * unreadable identifier fails with an empty `blockId` and is copied nowhere,
 * while a score problem can name its block only because the identifier has
 * already been proved to come from the caller's own corpus (DEC-041,
 * INV-SEC-001, INV-PROV-001).
 *
 * Nothing is coerced. An identifier that is not a string and a score that is not
 * a finite number are rejected explicitly, because either would travel into a
 * trace as a measurement (INV-SCORE-004, INV-ADAPTER-003).
 */
function search(
  index: MiniSearch<RetrievalDocument>,
  query: string,
  byId: ReadonlyMap<string, ContextBlock>,
): ResolvedResult[] {
  let raw: unknown;
  try {
    raw = index.search(query, SEARCH_OPTIONS);
  } catch {
    throw new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED',
      'MiniSearchCandidateProvider could not execute the lexical search.',
    );
  }

  const items = tryReadArrayItems(raw);
  if (items === null) {
    throw new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED',
      'MiniSearchCandidateProvider received a search result that is not a readable array.',
    );
  }

  const unknownResult = (): MiniSearchCandidateProviderError =>
    new MiniSearchCandidateProviderError(
      'MINISEARCH_CANDIDATE_PROVIDER_UNKNOWN_RESULT_BLOCK',
      'MiniSearchCandidateProvider received a search result that does not identify a block of the request corpus.',
    );

  return items.map((entry): ResolvedResult => {
    const inspectedId = tryOwnDataProperty(entry, 'id');
    if (inspectedId.kind === 'failed') {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED',
        'MiniSearchCandidateProvider could not inspect a search result.',
      );
    }
    const id = inspectedId.kind === 'value' ? inspectedId.value : undefined;
    if (typeof id !== 'string' || id.length === 0) throw unknownResult();

    // The identifier becomes reportable only once the corpus vouches for it.
    const block = byId.get(id);
    if (block === undefined) throw unknownResult();

    const inspectedScore = tryOwnDataProperty(entry, 'score');
    if (inspectedScore.kind === 'failed') {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE',
        'MiniSearchCandidateProvider could not inspect the score of a search result.',
        id,
      );
    }
    const score = inspectedScore.kind === 'value' ? inspectedScore.value : undefined;
    // Strictly positive, because that is what this provider's contract asserts.
    // BM25+ adds a positive floor per matched term, and a document matching no
    // term is omitted from the results rather than returned scoring zero — so a
    // zero, a negative, or a `-0` is malformed output for *this* contract, not a
    // weak match. Publishing one would put a value under
    // `MINISEARCH_RETRIEVAL_SCORE_SEMANTICS` that the named metric cannot
    // produce. Nothing is clamped, absolute-valued, coerced, or quietly dropped
    // (INV-SCORE-004, INV-ADAPTER-003).
    //
    // There is no upper bound: the metric is unbounded above, and inventing a
    // ceiling would be the same category of untruth in the other direction.
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) {
      throw new MiniSearchCandidateProviderError(
        'MINISEARCH_CANDIDATE_PROVIDER_INVALID_RETRIEVAL_SCORE',
        'MiniSearchCandidateProvider received a search result whose score is not a finite value above zero.',
        id,
      );
    }
    return { id, score, block };
  });
}

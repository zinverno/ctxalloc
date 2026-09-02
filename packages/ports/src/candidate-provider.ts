import type {
  CandidateBlock,
  ContextBlock,
  Scope,
  SourceDocument,
  Timestamp,
} from '@ctxalloc/domain';

/**
 * Candidate provider port.
 *
 * Retrieval proposes; the compiler selects (ARCHITECTURE section 8). This port
 * is the seam between those two responsibilities, and it exists so the compiler
 * never learns which system produced a candidate (INV-DEP-002).
 *
 * Only project-owned domain types appear here: no query object, index handle,
 * embedding vector, database cursor, or provider response type reaches a
 * consumer (INV-ADAPTER-001).
 */

/**
 * Everything a provider is given for one request.
 *
 * `sourceDocuments` and `blocks` carry the **prepared corpus explicitly**
 * because this phase has no persistent retrieval index. A provider that owned an
 * index would query it; a provider that does not is handed exactly the corpus
 * the application prepared, so the contract stays the same shape for both.
 *
 * `referenceTime` is supplied rather than read, exactly as the compiler requires
 * of itself: a provider that consulted the clock would make one request's answer
 * depend on when it ran (INV-DET-004).
 */
export interface CandidateProviderRequest {
  readonly scope: Scope;
  readonly query: string;
  readonly referenceTime: Timestamp;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly blocks: readonly ContextBlock[];
}

/**
 * Proposes candidate wrappers for one request.
 *
 * A provider wraps blocks and may attach its own retrieval evidence — its
 * identity, its rank, and its own score with its own declared semantics. It must
 * not compute compiler utility, apply a policy threshold, enforce a budget,
 * decide final inclusion, decide final order, mutate a block, rewrite content,
 * or restate a `tokenCount`. Every one of those belongs to a compiler stage, and
 * a provider that performed one would become a second selection system
 * (INV-ALLOC-002, INV-DEP-003).
 *
 * Candidate order is **provider-owned**. It is the provider's own ranking, and a
 * consumer must neither re-sort it nor read it as an instruction: the compiler
 * derives canonical order from scores and source position, never from arrival
 * position (INV-DET-002).
 *
 * A provider **proposes from the corpus it was given**. Two different guarantees
 * check that, at two different layers, and neither subsumes the other:
 *
 * * `CandidateValidator` proves *source-document validity* — the block names a
 *   source in the request registry, agrees with it on scope and type, and
 *   carries a hash and a token count consistent with its own content;
 * * the consumer that assembled the corpus proves *prepared-corpus membership* —
 *   the block is one it actually prepared. The kernel cannot: it never receives
 *   the corpus, only the candidates and the source registry (DEC-039).
 *
 * A block that satisfies the first and fails the second is content the provider
 * invented, and it must be rejected rather than compiled (INV-PROV-001).
 *
 * The corpus a provider receives may be an isolated copy. Mutating it is not a
 * way to change what is compiled, and a mutated block returned as a candidate is
 * rejected (INV-ADAPTER-004).
 *
 * An empty result means *this provider found nothing*. A failure must be
 * explicit and project-owned, never an empty successful result
 * (INV-ADAPTER-003).
 */
export interface CandidateProvider {
  /** Stable identifier of the provider implementation. */
  readonly id: string;

  /** Stable version of the provider implementation and its retrieval semantics. */
  readonly version: string;

  getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]>;
}

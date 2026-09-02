import {
  CANDIDATE_BLOCK_SCHEMA_VERSION,
  type CandidateBlock,
  type CandidateRetrieval,
} from '@ctxalloc/domain';
import type { CandidateProvider, CandidateProviderRequest } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link CandidateProvider} port.
 *
 * The fake performs **no retrieval**. It does not read the query, does not
 * compare text, does not compute a similarity, does not rank, and does not
 * invent a relevance score. It wraps the blocks a test names — or, by default,
 * every block in the prepared corpus — in the order the test names them.
 *
 * That restraint is the point. A fake that scored candidates would be product
 * retrieval logic living in the test package, and every test built on it would
 * be measuring an implementation nothing ships (INV-DEP-003). Retrieval evidence
 * is supplied by the test, exactly, or it is absent.
 *
 * It reads no index, database, network resource, clock, or random value
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'fake-candidate-provider';
const DEFAULT_VERSION = '1';

/** Explicit provider behavior for one test. */
export interface FakeCandidateProviderOptions {
  readonly id?: string;
  readonly version?: string;

  /**
   * Block identifiers to propose, in exactly this order.
   *
   * When absent, every block of the prepared corpus is proposed once, in the
   * order the corpus arrived. When present, an identifier the corpus does not
   * contain is an explicit failure rather than a silently skipped entry
   * (INV-ADAPTER-003).
   */
  readonly blockIds?: readonly string[];

  /**
   * Additional wrappers appended after the selection, for deduplication tests.
   *
   * Two wrappers around one block is a legitimate provider result — the same
   * block found by two queries, or reported twice by one index — and the
   * deduplicator, not the provider, decides what to do with the pair (DEC-031).
   */
  readonly repeatBlockIds?: readonly string[];

  /**
   * Exact retrieval evidence per block identifier.
   *
   * The value is carried verbatim onto every wrapper for that block. Nothing is
   * generated: a block with no configured evidence gets a wrapper with no
   * `retrieval` field at all, rather than a fabricated rank or score
   * (INV-SCORE-002).
   */
  readonly retrieval?: Readonly<Record<string, CandidateRetrieval>>;
}

/** Rejected {@link FakeCandidateProvider} configuration or request. */
export class FakeCandidateProviderError extends Error {
  readonly code = 'FAKE_CANDIDATE_PROVIDER_UNKNOWN_BLOCK';
  /** The exact block identifier that was requested. */
  readonly blockId: string;

  constructor(message: string, blockId: string) {
    super(message);
    this.name = 'FakeCandidateProviderError';
    this.blockId = blockId;
  }
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new FakeCandidateProviderError(
      `FakeCandidateProvider ${field} must not be empty or whitespace-only.`,
      '',
    );
  }
  return value;
}

export class FakeCandidateProvider implements CandidateProvider {
  readonly id: string;
  readonly version: string;

  readonly #blockIds: readonly string[] | null;
  readonly #repeatBlockIds: readonly string[];
  readonly #retrieval: ReadonlyMap<string, CandidateRetrieval>;

  constructor(options: FakeCandidateProviderOptions = {}) {
    this.id = requireNonBlank(options.id ?? DEFAULT_ID, 'id');
    this.version = requireNonBlank(options.version ?? DEFAULT_VERSION, 'version');
    // Copied, so a later mutation of the caller's arrays cannot change behavior.
    this.#blockIds = options.blockIds === undefined ? null : [...options.blockIds];
    this.#repeatBlockIds = options.repeatBlockIds === undefined ? [] : [...options.repeatBlockIds];
    this.#retrieval = new Map(Object.entries(options.retrieval ?? {}));
  }

  /**
   * Wraps the requested blocks.
   *
   * Blocks are carried **by reference**, never copied or rewritten: a provider
   * that reconstructed a block could change its content, hash, or token count,
   * and the whole contract is that it may not (INV-ADAPTER-002).
   */
  getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]> {
    const byId = new Map(request.blocks.map((block) => [String(block.id), block]));
    const selected = this.#blockIds ?? request.blocks.map((block) => String(block.id));

    const wrappers: CandidateBlock[] = [];
    for (const blockId of [...selected, ...this.#repeatBlockIds]) {
      const block = byId.get(blockId);
      if (block === undefined) {
        return Promise.reject(
          new FakeCandidateProviderError(
            `FakeCandidateProvider was asked for block ${JSON.stringify(blockId)}, which the prepared corpus does not contain.`,
            blockId,
          ),
        );
      }
      const retrieval = this.#retrieval.get(blockId);
      wrappers.push({
        schemaVersion: CANDIDATE_BLOCK_SCHEMA_VERSION,
        block,
        ...(retrieval !== undefined ? { retrieval } : {}),
      });
    }
    return Promise.resolve(wrappers);
  }
}

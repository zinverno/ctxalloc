import {
  BudgetAllocator,
  type AllocatedCandidateSet,
  type ScoredCandidateSet,
} from '@ctxalloc/compiler';
import { candidate, issueCodesOf, issuesOf, permutations, score } from './scoring-fixtures.js';

/**
 * Shared fixtures for the deterministic budget allocation tests.
 *
 * Every batch is built through `CandidateValidator`, `CandidateDeduplicator`, and
 * `CandidateScorer`, so the allocator is exercised against a genuinely produced
 * stage contract rather than a hand-assembled structure that might not survive
 * the earlier stages (DEC-033).
 *
 * Token counts and scores are both controlled exactly: content is generated with
 * a chosen number of whitespace-separated words, which the word tokenizer of the
 * shared fixtures counts one-for-one, and the scoring policy normalizes authored
 * priority over `[0, 1000]` with weight `1`, so a candidate with priority `p`
 * scores exactly `p / 1000`.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export { candidate, issueCodesOf, issuesOf, permutations };

/** The scoring policy every allocation test uses: score is authored priority. */
export const ALLOCATION_SCORING_POLICY = {
  schemaVersion: 1,
  policyId: 'scoring',
  policyVersion: '1.0.0',
  authoredPriority: { weight: 1, min: 0, max: 1000 },
} as const;

/** The smallest valid allocation policy: an identity and the v1 strategy. */
export function allocationPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'allocation',
    policyVersion: '1.0.0',
    optionalSelection: 'score-desc-greedy',
    ...overrides,
  };
}

/** A budget whose `availableInputTokens` is exactly `available`. */
export function budget(available: number, overrides: Record<string, unknown> = {}): unknown {
  return { totalTokens: available + 7, reservedOutputTokens: 7, ...overrides };
}

/** Content of exactly `tokens` words, unique per block so nothing deduplicates. */
export function contentOf(id: string, tokens: number): string {
  return [id, ...Array.from({ length: tokens - 1 }, (_, index) => `w${String(index)}`)].join(' ');
}

export interface CandidateSpec {
  readonly id: string;
  /** Exact `tokenCount` of the canonical block; at least one word is required. */
  readonly tokens?: number;
  /** Exact content, for the rare test that needs two blocks to deduplicate. */
  readonly content?: string;
  /** Authored priority, which the fixture scoring policy turns into the score. */
  readonly priority?: number;
  readonly category?: string;
  readonly required?: boolean;
}

/** One candidate wrapper whose token count, score, category, and class are exact. */
export function candidateOf(spec: CandidateSpec): Record<string, unknown> {
  const content = spec.content ?? contentOf(spec.id, spec.tokens ?? 1);
  return candidate({
    id: spec.id,
    content,
    attributes: {
      ...(spec.required === undefined ? {} : { required: spec.required }),
      ...(spec.priority === undefined ? {} : { priority: spec.priority }),
      ...(spec.category === undefined ? {} : { category: spec.category }),
    },
  });
}

export function scoreSpecs(specs: readonly CandidateSpec[]): ScoredCandidateSet {
  return score(specs.map(candidateOf), { ...ALLOCATION_SCORING_POLICY });
}

/** Validates, deduplicates, scores, and allocates one batch in one call. */
export function allocate(
  specs: readonly CandidateSpec[],
  options: {
    readonly available?: number;
    readonly budget?: unknown;
    readonly policy?: Record<string, unknown>;
  } = {},
): AllocatedCandidateSet {
  const allocator = new BudgetAllocator(options.policy ?? allocationPolicy());
  return allocator.allocate(
    scoreSpecs(specs),
    'budget' in options ? options.budget : budget(options.available ?? 1000),
  );
}

/** Included block identifiers, in allocation chronology. */
export function includedIds(result: AllocatedCandidateSet): readonly string[] {
  return result.included.map((decision) => decision.candidate.candidate.canonicalBlock.id);
}

/** Excluded block identifiers, in optional traversal order. */
export function excludedIds(result: AllocatedCandidateSet): readonly string[] {
  return result.excluded.map((decision) => decision.candidate.candidate.canonicalBlock.id);
}

/** Every decision as `blockId -> reason`, sorted by block identifier. */
export function reasonsOf(result: AllocatedCandidateSet): Record<string, string> {
  const entries = [...result.included, ...result.excluded].map(
    (decision) =>
      [decision.candidate.candidate.canonicalBlock.id, decision.reason] as readonly [
        string,
        string,
      ],
  );
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A scored set with its candidates and source registry reversed. */
export function reversedSet(set: ScoredCandidateSet): ScoredCandidateSet {
  return {
    ...set,
    sourceDocuments: [...set.sourceDocuments].reverse(),
    candidates: [...set.candidates].reverse(),
  };
}

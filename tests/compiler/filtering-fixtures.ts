import {
  CandidateFilter,
  type CandidateFilteringDecision,
  type FilteredCandidateSet,
  type ScoredCandidateSet,
} from '@ctxalloc/compiler';
import {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  candidateOf,
  contentOf,
  includedIds,
  issueCodesOf,
  issuesOf,
  omit,
  permutations,
  reversedSet,
  scoreSpecs,
  type CandidateSpec,
} from './allocation-fixtures.js';

/**
 * Shared fixtures for the deterministic policy filtering tests.
 *
 * Every batch is built through `CandidateValidator`, `CandidateDeduplicator`, and
 * `CandidateScorer`, so the filter is exercised against a genuinely produced
 * stage contract rather than a hand-assembled structure that might not survive
 * the earlier stages (DEC-036).
 *
 * Scores are controlled exactly: the shared allocation scoring policy normalizes
 * authored priority over `[0, 1000]` with weight `1`, so a candidate with
 * priority `p` scores exactly `p / 1000`.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  candidateOf,
  contentOf,
  includedIds,
  issueCodesOf,
  issuesOf,
  omit,
  permutations,
  reversedSet,
  scoreSpecs,
  type CandidateSpec,
};

/** The smallest valid filtering policy: an identity and no threshold at all. */
export function filteringPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, policyId: 'filtering', policyVersion: '1.0.0', ...overrides };
}

/** Validates, deduplicates, scores, and filters one batch in one call. */
export function filter(
  specs: readonly CandidateSpec[],
  options: { readonly policy?: Record<string, unknown> } = {},
): FilteredCandidateSet {
  return new CandidateFilter(options.policy ?? filteringPolicy()).filter(scoreSpecs(specs));
}

/** Eligible block identifiers, in the order the filter published them. */
export function eligibleIds(result: FilteredCandidateSet): readonly string[] {
  return result.eligible.candidates.map((scored) => scored.candidate.canonicalBlock.id);
}

/** Every scored block identifier, in the order the scorer ranked them. */
export function scoredIds(set: ScoredCandidateSet): readonly string[] {
  return set.candidates.map((scored) => scored.candidate.canonicalBlock.id);
}

/** Decision block identifiers, in the order the filter published them. */
export function decisionIds(result: FilteredCandidateSet): readonly string[] {
  return result.decisions.map((decision) => decision.candidate.candidate.canonicalBlock.id);
}

/** Every decision as `blockId -> reason`, sorted by block identifier. */
export function reasonsOf(result: FilteredCandidateSet): Record<string, string> {
  const entries = result.decisions.map(
    (decision) =>
      [decision.candidate.candidate.canonicalBlock.id, decision.reason] as readonly [
        string,
        string,
      ],
  );
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The one decision addressing `blockId`, for evidence assertions. */
export function decisionFor(
  result: FilteredCandidateSet,
  blockId: string,
): CandidateFilteringDecision {
  const found = result.decisions.filter(
    (decision) => decision.candidate.candidate.canonicalBlock.id === blockId,
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected exactly one decision for ${blockId}, found ${String(found.length)}`);
  }
  return found[0];
}

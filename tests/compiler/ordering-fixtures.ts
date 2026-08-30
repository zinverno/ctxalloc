import {
  ContextOrderer,
  type AllocatedCandidateSet,
  type OrderedCandidateSet,
} from '@ctxalloc/compiler';
import {
  allocate,
  allocationPolicy,
  candidate,
  issueCodesOf,
  issuesOf,
  permutations,
  scoreSpecs,
  type CandidateSpec,
} from './allocation-fixtures.js';
import { sourceDocument } from './fixtures.js';

/**
 * Shared fixtures for the deterministic context ordering tests.
 *
 * Every batch is built through `CandidateValidator`, `CandidateDeduplicator`,
 * `CandidateScorer`, and `BudgetAllocator`, so the orderer is exercised against a
 * genuinely produced stage contract rather than a hand-assembled structure that
 * might not survive the earlier stages (DEC-034).
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export {
  allocate,
  allocationPolicy,
  candidate,
  issueCodesOf,
  issuesOf,
  permutations,
  scoreSpecs,
  sourceDocument,
  type CandidateSpec,
};

/** The smallest valid ordering policy: an identity and the v1 strategy. */
export function orderingPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'ordering',
    policyVersion: '1.0.0',
    strategy: 'source-document-then-location',
    ...overrides,
  };
}

export function order(
  allocation: AllocatedCandidateSet,
  policy: Record<string, unknown> = orderingPolicy(),
): OrderedCandidateSet {
  return new ContextOrderer(policy).order(allocation);
}

/** Block identifiers in render order. */
export function orderedIds(result: OrderedCandidateSet): readonly string[] {
  return result.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock.id);
}

/** Allocates and orders one batch in one call, returning render order. */
export function renderOrderOf(
  specs: readonly CandidateSpec[],
  options: Parameters<typeof allocate>[1] = {},
): readonly string[] {
  return orderedIds(order(allocate(specs, { available: 1000, ...options })));
}

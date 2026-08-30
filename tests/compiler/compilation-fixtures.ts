import {
  BudgetAllocator,
  CandidateFilter,
  CandidateScorer,
  ContextOrderer,
} from '@ctxalloc/compiler';

/**
 * Shared fixtures for the compilation policy and compilation request tests.
 *
 * The valid policy carries a different version on every slice, so a test can
 * prove that the parent identity and the nested identities stay independent
 * (DEC-036).
 *
 * Each invalid slice is rejected by a rule the owning stage enforces, not by a
 * rule restated here: the composed validator must reach exactly those rules.
 */

export { BudgetAllocator, CandidateFilter, CandidateScorer, ContextOrderer };

/** A complete, valid five-slice policy. */
export function compilationPolicy(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'composition',
    policyVersion: '1.0.0',
    scoring: {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '2.0.0',
      authoredPriority: { weight: 1, min: 0, max: 1000 },
    },
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '3.0.0',
      minimumTotalScore: 0.25,
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'allocation',
      policyVersion: '4.0.0',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'ordering',
      policyVersion: '5.0.0',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'rendering',
      policyVersion: '6.0.0',
      format: 'jsonl-blocks',
    },
    ...overrides,
  };
}

export const SLICES = ['scoring', 'filtering', 'allocation', 'ordering', 'rendering'] as const;

/** One known invalid value per slice, owned by the stage that rejects it. */
export const INVALID_SLICE: Record<(typeof SLICES)[number], Record<string, unknown>> = {
  // Two rules owning one provider contract: a scorer-owned duplicate rule.
  scoring: {
    schemaVersion: 1,
    policyId: 'scoring',
    policyVersion: '2.0.0',
    authoredPriority: { weight: 1, min: 1000, max: 0 },
  },
  // A negative threshold: a filter-owned rule.
  filtering: {
    schemaVersion: 1,
    policyId: 'filtering',
    policyVersion: '3.0.0',
    minimumTotalScore: -1,
  },
  // A constraint declaring neither bound: an allocator-owned rule.
  allocation: {
    schemaVersion: 1,
    policyId: 'allocation',
    policyVersion: '4.0.0',
    optionalSelection: 'score-desc-greedy',
    categoryConstraints: [{ category: 'facts' }],
  },
  // A strategy that is not the one value of schema version 1.
  ordering: {
    schemaVersion: 1,
    policyId: 'ordering',
    policyVersion: '5.0.0',
    strategy: 'score-desc',
  },
  // A format that is not the one value of schema version 1.
  rendering: {
    schemaVersion: 1,
    policyId: 'rendering',
    policyVersion: '6.0.0',
    format: 'markdown',
  },
};

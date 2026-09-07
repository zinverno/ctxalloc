import type { ContextBlockId, Scope } from '@ctxalloc/domain';

/** Caller-owned group applicability, never inferred from candidate metadata (DEC-044). */
export interface CandidateApplicability {
  readonly scope: Scope;
  readonly exclusions: readonly {
    readonly blockId: ContextBlockId;
    readonly reason: 'inapplicable' | 'superseded';
  }[];
}

export interface ApplicabilityExclusionEvidence {
  readonly reason: 'FILTERED_INAPPLICABLE' | 'FILTERED_SUPERSEDED';
  readonly declaredBlockIds: readonly ContextBlockId[];
}

export type CandidateApplicabilityIssueCode =
  | 'applicability_scope_mismatch'
  | 'missing_applicability_target'
  | 'conflicting_applicability_declarations'
  | 'required_applicability_conflict';

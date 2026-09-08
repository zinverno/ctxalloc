import type { Scope, ValidationIssue } from '@ctxalloc/domain';

/** DEC-045: this order is the scorer's arithmetic/component order. */
export const SCORING_EVIDENCE_COMPONENTS = [
  'retrieval',
  'authoredPriority',
  'sourcePriority',
  'categoryPriority',
  'recency',
] as const;
export type ScoringEvidenceComponent = (typeof SCORING_EVIDENCE_COMPONENTS)[number];
export type EvidenceCompletenessState = 'complete' | 'incomplete';
export interface RetrievalEvidenceContract {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
}
export interface EvidenceCompletenessDeclaration {
  readonly scope: Scope;
  readonly completeness: readonly {
    readonly component: ScoringEvidenceComponent;
    readonly state: EvidenceCompletenessState;
  }[];
}
export interface CandidateEvidenceObservation {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly components: readonly {
    readonly component: ScoringEvidenceComponent;
    readonly configured: boolean;
    readonly present: boolean;
    readonly completeness: EvidenceCompletenessState | null;
  }[];
  readonly ignoredRetrieval: readonly (RetrievalEvidenceContract & {
    readonly blockId: string;
    readonly rawValue: number;
  })[];
}
export class CandidateEvidenceError extends Error {
  readonly code = 'CANDIDATE_EVIDENCE_INVALID';
  constructor(readonly issues: readonly ValidationIssue[]) {
    super('Candidate evidence is incompatible with the declared policy.');
    this.name = 'CandidateEvidenceError';
  }
}

/**
 * Public contract of the CtxAlloc compiler kernel.
 *
 * The kernel owns candidate validation, deduplication, scoring, budget
 * allocation, ordering, rendering, and trace construction. It receives
 * candidates and returns compiled context: it never searches an index, reads a
 * file, calls a model, or touches a database (INV-DEP-002).
 *
 * Five stages exist. `CandidateValidator` validates one candidate batch
 * strictly, all or nothing, and is the runtime trust boundary of the kernel
 * (DEC-030). `CandidateDeduplicator` then collapses exact duplicate content into
 * groups, choosing an existing canonical block and preserving every candidate
 * wrapper as evidence (DEC-031). `CandidateScorer` then normalizes the explicitly
 * configured signals of each group into transparent score components and returns
 * a stable ranking (DEC-032). `BudgetAllocator` then resolves required blocks
 * first, enforces exact category block-count constraints, and selects optional
 * blocks under the available block-content budget (DEC-033). `ContextOrderer`
 * then puts that selection into source order for the renderer, changing no
 * decision (DEC-034).
 *
 * Allocation is not the final budget guarantee. INV-BUDGET-002 makes the rendered
 * string the source of truth, and the renderer does not exist yet, so
 * `BudgetAllocator` publishes provisional block-content metrics plus a
 * deterministic eviction order for the future render-correction loop, and never
 * a final `compiledTokens` or `unusedTokens`.
 *
 * Policy filtering, rendering, trace construction, and compiler orchestration
 * are later phases and are deliberately absent, as is the candidate provider
 * port, which belongs outside the kernel entirely.
 */

export {
  BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION,
  BudgetAllocationError,
  BudgetAllocator,
  type AllocatedCandidateSet,
  type AllocationDecisionReason,
  type BudgetAllocationIssueCode,
  type BudgetAllocationPolicy,
  type CategoryAllocationConstraint,
  type ExcludedCandidateDecision,
  type IncludedCandidateDecision,
} from './budget-allocator.js';
export {
  CandidateDeduplicator,
  type CanonicalSelectionReason,
  type DeduplicatedCandidate,
  type DeduplicatedCandidateMember,
  type DeduplicatedCandidateSet,
  type DuplicateMatchReason,
} from './candidate-deduplicator.js';
export {
  CANDIDATE_SCORING_POLICY_SCHEMA_VERSION,
  CandidateScorer,
  CandidateScoringError,
  type AuthoredPriorityScoreComponent,
  type AuthoredPriorityScoreEvidence,
  type AuthoredPriorityScoringPolicy,
  type CandidateScore,
  type CandidateScoringIssueCode,
  type CandidateScoringPolicy,
  type CategoryPriorityRule,
  type CategoryPriorityScoreComponent,
  type CategoryPriorityScoreEvidence,
  type CategoryPriorityScoringPolicy,
  type PolicyValueSource,
  type RecencyScoreComponent,
  type RecencyScoreEvidence,
  type RecencyScoringPolicy,
  type RecencyTimestampField,
  type RecencyValueSource,
  type RetrievalNormalizationRule,
  type RetrievalScoreComponent,
  type RetrievalScoreEvidence,
  type RetrievalScoringPolicy,
  type ScoreAggregation,
  type ScoredCandidate,
  type ScoredCandidateSet,
  type SourcePriorityRule,
  type SourcePriorityScoreComponent,
  type SourcePriorityScoreEvidence,
  type SourcePriorityScoringPolicy,
} from './candidate-scorer.js';
export {
  CONTEXT_ORDERING_POLICY_SCHEMA_VERSION,
  ContextOrderer,
  ContextOrderingError,
  type ContextOrderingIssueCode,
  type ContextOrderingPolicy,
  type OrderedCandidateSet,
} from './context-orderer.js';
export {
  CandidateValidationError,
  CandidateValidator,
  type CandidateValidationInput,
  type CandidateValidationIssueCode,
  type ValidatedCandidateSet,
} from './candidate-validator.js';

/**
 * Public contract of the CtxAlloc compiler kernel.
 *
 * The kernel owns candidate validation, deduplication, scoring, budget
 * allocation, ordering, rendering, and trace construction. It receives
 * candidates and returns compiled context: it never searches an index, reads a
 * file, calls a model, or touches a database (INV-DEP-002).
 *
 * The implemented execution topology is defined by component names, not by
 * ordinal positions (DEC-036):
 *
 * ```text
 * CompilationRequest validation
 *   -> CandidateValidator
 *   -> CandidateDeduplicator
 *   -> CandidateScorer
 *   -> CandidateFilter
 *   -> BudgetAllocator
 *   -> ContextOrderer
 *   -> ContextRenderer
 *   -> TraceBuilder
 * ```
 *
 * `CompilationRequestValidator` proves a request is a well-formed record and
 * that its `CompilationPolicy` composes five valid stage slices; it is
 * structural, and it does not replace the trust boundary below it (DEC-036).
 * `CandidateValidator` validates one candidate batch strictly, all or nothing,
 * and is the runtime trust boundary of the kernel (DEC-030).
 * `CandidateDeduplicator` collapses exact duplicate content into groups,
 * choosing an existing canonical block and preserving every candidate wrapper as
 * evidence (DEC-031). `CandidateScorer` normalizes the explicitly configured
 * signals of each group into transparent score components and returns a stable
 * ranking (DEC-032). `CandidateFilter` decides which scored optional candidates
 * are eligible for allocation under policy, bypassing required blocks entirely
 * (DEC-036). `BudgetAllocator` resolves required blocks first, enforces exact
 * category block-count constraints, and selects optional blocks under the
 * available block-content budget (DEC-033). `ContextOrderer` puts that selection
 * into source order for the renderer, changing no decision (DEC-034).
 * `ContextRenderer` serializes that order as boundary-safe JSONL and tokenizes
 * the exact string it produced (DEC-035). `TraceBuilder` observes that evidence
 * and projects it into one serializable, privacy-minimized `CompilationTrace`,
 * changing no decision (DEC-037).
 *
 * Filtering establishes eligibility; it does not select. Required resolution,
 * category constraints, the token budget, eviction, and final inclusion all
 * remain the allocator's, over the eligible candidates it is given
 * (INV-ALLOC-002).
 *
 * Rendering measures; it does not correct. INV-BUDGET-002 makes the rendered
 * string the source of truth, and `ContextRenderer` is the only stage that
 * tokenizes one — but a `RenderedContextAttempt` may exceed the budget and simply
 * report `fitsAvailableInputBudget: false`. Consuming the eviction order,
 * re-ordering, re-rendering, and proving final infeasibility belong to
 * `ContextCompiler`, not to the stage that measured.
 *
 * Tracing observes; it does not settle. `TraceBuilder` receives evidence the
 * components already produced, verifies it belongs to one coherent pipeline, and
 * copies it into a versioned snapshot — so every trace it builds is an
 * `UnsettledCompilationTrace`, and none may be attached to a successful
 * `CompilationResult` (INV-TRACE-006). `fingerprintCompilationRequest` identifies
 * the exact validated request value and is deliberately **not** a compilation
 * identifier: the composition inputs it excludes are bound by `CompilationId`
 * instead (DEC-036, DEC-037, DEC-038).
 *
 * `ContextCompiler` composes the stages and closes the kernel (DEC-038). It owns
 * one configured `Tokenizer` and injects that same object into
 * `CandidateValidator` and into every rendered measurement, which is what makes
 * `tokenizerCoverage: 'validation-and-rendering'` provable. It settles the
 * rendered budget by evicting the allocator's declared safe surplus along
 * `optionalEvictionOrder`, and, when the protected hard-constraint base is itself
 * the problem, by an explicitly bounded deterministic search over policy-valid
 * category-minimum bases — measuring one exact complete rendered string for every
 * selection it decides. It returns a `CompilationResult` carrying the final
 * string, the final blocks in render order, exact usage, a deterministic
 * `CompilationId`, and a `SettledCompilationTrace`.
 *
 * The compiler kernel is complete; the product is not. Retrieval, `SourceReader`,
 * persistence, the CLI, the HTTP API, model execution, and the evaluation harness
 * remain later phases, as does the candidate provider port, which belongs outside
 * the kernel entirely.
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
  CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION,
  CandidateFilter,
  CandidateFilteringError,
  type CandidateFilteringDecision,
  type CandidateFilteringDecisionReason,
  type CandidateFilteringIssueCode,
  type CandidateFilteringPolicy,
  type FilteredCandidateDecision,
  type FilteredCandidateSet,
  type PolicyEligibleCandidateDecision,
  type RequiredEligibleCandidateDecision,
} from './candidate-filter.js';
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
  CONTEXT_RENDERER_ID,
  CONTEXT_RENDERER_VERSION,
  CONTEXT_RENDERING_POLICY_SCHEMA_VERSION,
  ContextRenderer,
  ContextRenderingError,
  type ContextRenderingIssueCode,
  type ContextRenderingPolicy,
  type RenderedContextAttempt,
} from './context-renderer.js';
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
export {
  COMPILATION_TRACE_SCHEMA_VERSION,
  CompilationTraceError,
  TraceBuilder,
  type CompilationTrace,
  type CompilationTraceAllocation,
  type CompilationTraceAllocationDecision,
  type CompilationTraceBase,
  type CompilationTraceBuildInput,
  type CompilationTraceCanonicalBlock,
  type CompilationTraceComposition,
  type CompilationTraceDisposition,
  type CompilationTraceExcludedDecision,
  type CompilationTraceFallbackPhase,
  type CompilationTraceFallbackSearch,
  type CompilationTraceFilteredDecision,
  type CompilationTraceFilteringDecision,
  type CompilationTraceFinalDecision,
  type CompilationTraceFinalDisposition,
  type CompilationTraceFinalExcludedDecision,
  type CompilationTraceFinalFilteredDecision,
  type CompilationTraceFinalIncludedDecision,
  type CompilationTraceGroup,
  type CompilationTraceIncludedDecision,
  type CompilationTraceIssueCode,
  type CompilationTraceMember,
  type CompilationTraceOrdering,
  type CompilationTracePolicyEligibleDecision,
  type CompilationTracePolicyIdentities,
  type CompilationTraceRendering,
  type CompilationTraceRequest,
  type CompilationTraceRequiredEligibleDecision,
  type CompilationTraceRetrieval,
  type CompilationTraceRetrievalScore,
  type CompilationTraceSettlement,
  type CompilationTraceSettlementOrdering,
  type CompilationTraceSettlementRendering,
  type CompilationTraceSettlementUsage,
  type CompilationTraceSource,
  type CompilationTraceTokenizerCoverage,
  type CompilationTraceTotals,
  type SettledCompilationTrace,
  type SettledCompilationTraceComposition,
  type TraceBuilderConfig,
  type TraceIdentity,
  type UnsettledCompilationTrace,
  type UnsettledCompilationTraceComposition,
} from './compilation-trace.js';
export {
  COMPILATION_RESULT_SCHEMA_VERSION,
  CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION,
  ContextCompilationError,
  ContextCompiler,
  RENDER_AWARE_CORRECTION_STRATEGY,
  RENDER_AWARE_CORRECTION_VERSION,
  type CompilationResult,
  type CompilationResultUsage,
  type ContextCompilationIssueCode,
  type ContextCompilationStage,
  type ContextCompilerConfig,
} from './context-compiler.js';
export { COMPILATION_ID_VERSION, type CompilationId } from './compilation-id.js';
export {
  COMPILATION_POLICY_SCHEMA_VERSION,
  CompilationPolicyError,
  CompilationPolicyValidator,
  type CompilationPolicy,
  type CompilationPolicyIssueCode,
} from './compilation-policy.js';
export {
  COMPILATION_REQUEST_SCHEMA_VERSION,
  CompilationRequestError,
  CompilationRequestValidator,
  type CompilationRequest,
  type CompilationRequestIssueCode,
} from './compilation-request.js';
export {
  COMPILATION_REQUEST_FINGERPRINT_VERSION,
  fingerprintCompilationRequest,
  type CompilationRequestFingerprint,
} from './request-fingerprint.js';

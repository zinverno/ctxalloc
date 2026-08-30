/**
 * Public contract of the CtxAlloc compiler kernel.
 *
 * The kernel owns candidate validation, deduplication, scoring, budget
 * allocation, ordering, rendering, and trace construction. It receives
 * candidates and returns compiled context: it never searches an index, reads a
 * file, calls a model, or touches a database (INV-DEP-002).
 *
 * Two stages exist. `CandidateValidator` validates one candidate batch strictly,
 * all or nothing, and is the runtime trust boundary of the kernel (DEC-030).
 * `CandidateDeduplicator` then collapses exact duplicate content into groups,
 * choosing an existing canonical block and preserving every candidate wrapper as
 * evidence (DEC-031).
 *
 * Policy filtering, scoring, allocation, ordering, rendering, trace
 * construction, and compiler orchestration are later phases and are deliberately
 * absent, as is the candidate provider port, which belongs outside the kernel
 * entirely.
 */

export {
  CandidateDeduplicator,
  type CanonicalSelectionReason,
  type DeduplicatedCandidate,
  type DeduplicatedCandidateMember,
  type DeduplicatedCandidateSet,
  type DuplicateMatchReason,
} from './candidate-deduplicator.js';
export {
  CandidateValidationError,
  CandidateValidator,
  type CandidateValidationInput,
  type CandidateValidationIssueCode,
  type ValidatedCandidateSet,
} from './candidate-validator.js';

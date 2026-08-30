/**
 * Public contract of the CtxAlloc compiler kernel.
 *
 * The kernel owns candidate validation, deduplication, scoring, budget
 * allocation, ordering, rendering, and trace construction. It receives
 * candidates and returns compiled context: it never searches an index, reads a
 * file, calls a model, or touches a database (INV-DEP-002).
 *
 * Only the first stage exists. `CandidateValidator` validates one candidate
 * batch strictly, all or nothing, before any policy stage can rely on it
 * (DEC-030).
 *
 * Deduplication, scoring, allocation, ordering, rendering, trace construction,
 * and compiler orchestration are later phases and are deliberately absent, as is
 * the candidate provider port, which belongs outside the kernel entirely.
 */

export {
  CandidateValidationError,
  CandidateValidator,
  type CandidateValidationInput,
  type CandidateValidationIssueCode,
  type ValidatedCandidateSet,
} from './candidate-validator.js';

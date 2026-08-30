import {
  CandidateBlockSchema,
  ScopeSchema,
  SourceDocumentSchema,
  TimestampSchema,
  TokenBudgetSchema,
  findLoneSurrogate,
  safeParse,
  type CandidateBlock,
  type Scope,
  type SourceDocument,
  type Timestamp,
  type TokenBudget,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import {
  parseCompilationPolicy,
  type CompilationPolicy,
  type CompilationPolicyIssueCode,
} from './compilation-policy.js';
import { pointerFor, type IssuePath } from './validation-issues.js';

/**
 * The compilation request (DEC-036, ARCHITECTURE 5.5).
 *
 * `CompilationRequest` is the complete, self-contained input of one compilation:
 * who is asking (`scope`), what they asked (`query`), when the request is
 * measured against (`referenceTime`), what may be selected (`candidates`,
 * `sourceDocuments`), how much may be spent (`budget`), and under which rules
 * (`policy`). Everything a deterministic compilation needs is in the record, so
 * the same request compiled twice cannot differ (INV-DET-001).
 *
 * Validation here is **structural**. It proves the request is a well-formed
 * record of well-formed domain values; it does not prove the batch is
 * trustworthy. `CandidateValidator` remains the semantic and cross-record trust
 * boundary: stale token counts, wrong content hashes, duplicate source
 * identifiers, cross-scope candidates, missing or mismatched sources,
 * incompatible source locations, and conflicting block identifiers are all its
 * to reject (DEC-030). A request may therefore pass this validator and still be
 * rejected by the validator that follows it, and that is the intended division
 * (INV-DEP-003).
 *
 * The record is data. Validating it runs no stage, reads no clock, generates no
 * identifier, and compiles nothing.
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of `CompilationRequest` (INV-STORE-004). */
export const COMPILATION_REQUEST_SCHEMA_VERSION = 1;

/**
 * One complete compilation request.
 *
 * `referenceTime` is required. Recency scoring needs an instant to measure
 * against, and the compiler is forbidden to read the clock, so the instant must
 * arrive with the request: `CandidateScorer.score(batch, request.referenceTime)`
 * is the whole of the future flow (INV-DET-004). No default is injected — a
 * missing reference time is a rejected request, never `Date.now()`.
 *
 * `id` is caller-supplied and preserved exactly. Nothing here generates a UUID
 * or any other random or time-derived identifier: a kernel that invented request
 * identities would produce a different record for the same input on every run
 * (INV-DET-003).
 */
export interface CompilationRequest {
  readonly id: string;
  readonly schemaVersion: typeof COMPILATION_REQUEST_SCHEMA_VERSION;
  readonly scope: Scope;
  readonly query: string;
  readonly referenceTime: Timestamp;
  readonly candidates: readonly CandidateBlock[];
  readonly sourceDocuments: readonly SourceDocument[];
  readonly budget: TokenBudget;
  readonly policy: CompilationPolicy;
}

/**
 * Machine-readable categories of a request problem (INV-TRACE-002).
 *
 * `invalid_request` addresses the request record itself. A nested policy problem
 * keeps the focused code the policy validator gave it, so the slice that owns
 * the rule stays identifiable after composition.
 */
export type CompilationRequestIssueCode = 'invalid_request' | CompilationPolicyIssueCode;

/**
 * The single error this validator raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or nested
 * `CompilationPolicyError` object escapes this boundary: a policy failure is
 * re-addressed as issues under the `policy` pointer, never re-thrown or attached
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class CompilationRequestError extends Error {
  readonly code = 'COMPILATION_REQUEST_INVALID';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Compilation request is invalid: ${summary}`);
    this.name = 'CompilationRequestError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Request schema                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own request identifier: non-blank, well-formed UTF-16, preserved
 * exactly.
 *
 * Blankness is checked with `trim`, and the supplied value is never trimmed,
 * lowercased, or canonicalized: a request identifier is an opaque value the
 * caller owns, and a rewritten one would stop matching the caller's own records
 * (INV-ADAPTER-002).
 */
const requestId = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * The query, carried verbatim.
 *
 * An empty query is valid, and so is a whitespace-only or multi-line one: a
 * caller may compile standing context with no question at all, and deciding that
 * a blank query is meaningless is the caller's judgement, not the kernel's. The
 * value is never trimmed, collapsed, normalized, lowercased, or truncated, and
 * this stage never reads it — `CandidateFilter` and every other kernel stage are
 * forbidden from consulting it, because retrieval already answered the query and
 * the compiler must not become a second retrieval system (INV-DEP-002).
 *
 * Only malformed UTF-16 is rejected, which is a corrupted string rather than a
 * deliberate query (INV-BLOCK-007).
 */
const query = z
  .string()
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * The policy is checked here only for being present and being an object; its
 * rules belong to `CompilationPolicyValidator`.
 */
const policySlot = z.looseObject({});

/**
 * The runtime boundary of the request.
 *
 * A request may have been persisted, transported over HTTP, rebuilt by hand, or
 * assembled by an adapter, so compile-time types prove nothing here
 * (INV-BLOCK-005). Unknown top-level fields are rejected rather than stripped,
 * nothing is coerced, and no default is injected: no reserve is guessed into the
 * budget, no scope is assumed, no reference time is read from a clock, and no
 * identifier is generated.
 *
 * `candidates` and `sourceDocuments` are validated with the existing domain
 * schemas and nothing more. The relationships between them — that a block's
 * source is in the registry, that the registry has no repeated identifier, that
 * every candidate is in the request scope, that a token count matches its
 * content — are cross-record rules `CandidateValidator` owns, and duplicating
 * them here would create a second place for one truth to drift (INV-DEP-003).
 */
const CompilationRequestShapeSchema = z.strictObject({
  id: requestId,
  schemaVersion: z.literal(COMPILATION_REQUEST_SCHEMA_VERSION),
  scope: ScopeSchema,
  query,
  referenceTime: TimestampSchema,
  candidates: z.array(CandidateBlockSchema),
  sourceDocuments: z.array(SourceDocumentSchema),
  budget: TokenBudgetSchema,
  policy: policySlot,
});

/* -------------------------------------------------------------------------- */
/* Validator                                                                   */
/* -------------------------------------------------------------------------- */

export class CompilationRequestValidator {
  /**
   * Validates one compilation request, all or nothing.
   *
   * A malformed request shape short-circuits: when the record itself is not a
   * request, its policy is not validated, because reporting policy rules for a
   * shape that is not a request could only guess what the caller meant. This
   * mirrors how `CandidateValidator` reports schema issues alone before running
   * cross-record rules.
   *
   * Once the shape holds, the policy is validated by the validator that owns it,
   * and every problem it found is re-addressed under the `policy` pointer with
   * its focused slice code intact — `policy.scoring.weight`, not a nested error
   * object.
   *
   * Everything is preserved exactly. The query keeps its whitespace and line
   * breaks, the identifier keeps its exact spelling, the reference time keeps its
   * exact instant, and an omitted optional budget reserve stays omitted rather
   * than becoming a zero the caller never configured. The supplied input is
   * treated as immutable and is never mutated, reordered, or written back to.
   *
   * @throws {CompilationRequestError} when the request is not valid.
   */
  validate(input: unknown): CompilationRequest {
    const shape = safeParse(CompilationRequestShapeSchema, input);
    if (!shape.ok) {
      throw new CompilationRequestError(
        shape.issues.map((issue) => ({
          ...issue,
          code: 'invalid_request' satisfies CompilationRequestIssueCode,
        })),
      );
    }

    const policy = parseCompilationPolicy(shape.value.policy);
    if (!policy.ok) {
      throw new CompilationRequestError(policy.issues.map(underPolicy));
    }

    return {
      id: shape.value.id,
      schemaVersion: shape.value.schemaVersion,
      scope: shape.value.scope,
      query: shape.value.query,
      referenceTime: shape.value.referenceTime,
      candidates: shape.value.candidates,
      sourceDocuments: shape.value.sourceDocuments,
      budget: shape.value.budget,
      policy: policy.value,
    };
  }
}

/**
 * Re-addresses one policy issue under the request's `policy` field.
 *
 * The nested path is prefixed rather than replaced, so a slice problem keeps the
 * exact location the policy validator gave it, and the pointer is re-rendered
 * through the shared helper so it is spelled like every other compiler pointer
 * (INV-DEP-003).
 */
function underPolicy(issue: ValidationIssue): ValidationIssue {
  const path: IssuePath = ['policy', ...issue.path];
  return { code: issue.code, path, pointer: pointerFor(path), message: issue.message };
}

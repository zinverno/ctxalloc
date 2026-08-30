import {
  findLoneSurrogate,
  safeParse,
  type ValidationIssue,
  type ValidationResult,
} from '@ctxalloc/domain';
import { z } from 'zod';
import { parseBudgetAllocationPolicy, type BudgetAllocationPolicy } from './budget-allocator.js';
import {
  parseCandidateFilteringPolicy,
  type CandidateFilteringPolicy,
} from './candidate-filter.js';
import { parseCandidateScoringPolicy, type CandidateScoringPolicy } from './candidate-scorer.js';
import { parseContextOrderingPolicy, type ContextOrderingPolicy } from './context-orderer.js';
import { parseContextRenderingPolicy, type ContextRenderingPolicy } from './context-renderer.js';
import { pointerFor, type IssuePath } from './validation-issues.js';

/**
 * The broad versioned compilation policy (DEC-036, ARCHITECTURE 5.6).
 *
 * `CompilationPolicy` composes the narrow policy slices the compiler stages
 * already own — scoring, filtering, allocation, ordering, rendering — into one
 * versioned record a caller can supply, store, and quote in a future trace.
 *
 * It is **data, not orchestration**. It holds no `CandidateScorer`,
 * `CandidateFilter`, `BudgetAllocator`, `ContextOrderer`, or `ContextRenderer`
 * instance, owns no tokenizer, runs no stage, and decides nothing. Composing the
 * stages remains the future `ContextCompiler`'s work; this record only states
 * what that composition would be configured with.
 *
 * Its validator is a runtime boundary and nothing more. It generates no
 * identifier, version, hash, or fingerprint, injects no default, and coerces
 * nothing (INV-DET-003).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of `CompilationPolicy` (INV-STORE-004). */
export const COMPILATION_POLICY_SCHEMA_VERSION = 1;

/**
 * One complete compilation policy: an identity and the five stage slices.
 *
 * All five slices are **required** in schema version 1. None is defaulted,
 * because every one of them changes what gets compiled, and a policy that
 * silently inherited a filtering, ordering, or rendering rule nobody wrote would
 * make two callers who supplied identical configuration disagree about what they
 * had asked for. A compilation that filters nothing is expressed by an explicit
 * filtering slice with `minimumTotalScore` absent — a stated no-op, not a
 * missing key.
 *
 * `policyId` and `policyVersion` identify the **composition**. They are
 * independent of the nested identities and need not equal any of them: a team
 * that revises only its rendering slice publishes a new parent version while the
 * scoring slice keeps its own. Nothing here derives one identity from another,
 * and no identity is generated (INV-DET-003, INV-TRACE-005).
 */
export interface CompilationPolicy {
  readonly schemaVersion: typeof COMPILATION_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scoring: CandidateScoringPolicy;
  readonly filtering: CandidateFilteringPolicy;
  readonly allocation: BudgetAllocationPolicy;
  readonly ordering: ContextOrderingPolicy;
  readonly rendering: ContextRenderingPolicy;
}

/**
 * Machine-readable categories of a compilation policy problem (INV-TRACE-002).
 *
 * `invalid_policy` addresses the composition itself: its schema version, its
 * identity, an unknown top-level field, or a slice that is not an object at all.
 * The five focused codes address one named slice, so a consumer can route a
 * failure to the stage that owns the rule without parsing a pointer.
 */
export type CompilationPolicyIssueCode =
  | 'invalid_policy'
  | 'invalid_scoring_policy'
  | 'invalid_filtering_policy'
  | 'invalid_allocation_policy'
  | 'invalid_ordering_policy'
  | 'invalid_rendering_policy';

/**
 * The single error this validator raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or nested stage error
 * object escapes this boundary: a nested failure is re-addressed as issues under
 * its slice pointer, never re-thrown or attached (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 */
export class CompilationPolicyError extends Error {
  readonly code = 'COMPILATION_POLICY_INVALID';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Compilation policy is invalid: ${summary}`);
    this.name = 'CompilationPolicyError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Wrapper schema                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A policy string is configuration, not content: it is validated and never
 * rewritten.
 *
 * No trimming, lowercasing, or canonicalization is applied. Malformed UTF-16 is
 * rejected with the shared domain helper, exactly as every narrow slice policy
 * rejects it (INV-BLOCK-007).
 */
const policyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * A slice is checked here only for being present and being an object.
 *
 * Its contents are deliberately opaque at this level: reproducing the nested
 * schemas here would put one rule under two owners and let the two drift
 * (INV-DEP-003). The stage that enforces a slice validates it, through the same
 * helper its own constructor uses.
 */
const policySlice = z.looseObject({});

/**
 * The runtime boundary of the composition itself.
 *
 * A policy is external configuration: it may have been read from a file, sent
 * over HTTP, or assembled by hand, so compile-time types prove nothing about it
 * (INV-BLOCK-005). Unknown top-level fields are rejected rather than stripped,
 * nothing is coerced, and no slice is defaulted.
 */
const CompilationPolicyWrapperSchema = z.strictObject({
  schemaVersion: z.literal(COMPILATION_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  scoring: policySlice,
  filtering: policySlice,
  allocation: policySlice,
  ordering: policySlice,
  rendering: policySlice,
});

/* -------------------------------------------------------------------------- */
/* Nested delegation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Re-addresses one nested issue under the slice that produced it.
 *
 * The nested path is prefixed rather than replaced, so a problem keeps the exact
 * location the owning stage gave it and gains only the slice it belongs to. The
 * pointer is re-rendered through the shared helper, so a composed pointer is
 * spelled the way every other compiler pointer is spelled (INV-DEP-003).
 */
function underSlice(
  slice: string,
  code: CompilationPolicyIssueCode,
  issue: ValidationIssue,
): ValidationIssue {
  const path: IssuePath = [slice, ...issue.path];
  return { code, path, pointer: pointerFor(path), message: issue.message };
}

/** One slice, its focused issue code, and the stage-owned parser that decides it. */
interface SliceContract<TPolicy> {
  readonly slice: string;
  readonly code: CompilationPolicyIssueCode;
  readonly parse: (value: unknown) => ValidationResult<TPolicy>;
}

/**
 * Collects the problems of one slice, or its validated value.
 *
 * The result is discriminated rather than a value plus a possibly empty issue
 * list, so a caller cannot read a value the delegate never produced.
 */
function validateSlice<TPolicy>(
  contract: SliceContract<TPolicy>,
  value: unknown,
  issues: ValidationIssue[],
): TPolicy | undefined {
  const parsed = contract.parse(value);
  if (parsed.ok) return parsed.value;
  for (const issue of parsed.issues) issues.push(underSlice(contract.slice, contract.code, issue));
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Validator                                                                   */
/* -------------------------------------------------------------------------- */

export class CompilationPolicyValidator {
  /**
   * Validates one complete compilation policy, all or nothing.
   *
   * A malformed wrapper short-circuits: when the composition's own schema
   * version, identity, or slice presence is wrong, the nested slices are not
   * validated, because reporting rules for a shape that is not a compilation
   * policy could only guess which slice the caller meant. This mirrors how every
   * compiler stage reports schema issues alone before running rules that read
   * fields the schema has not established.
   *
   * Once the wrapper holds, all five slices are validated and every problem in
   * all of them is collected before failing, in the fixed order scoring,
   * filtering, allocation, ordering, rendering. The order is the pipeline's own
   * and does not depend on property insertion order, so identical invalid
   * configuration always produces byte-identical issues (INV-DET-001,
   * INV-DET-002).
   *
   * Nested validation is delegated to the stage that owns each rule, through the
   * same helper that stage's constructor uses, so this validator can neither
   * accept a slice a stage would reject nor reject one a stage would accept
   * (INV-DEP-003).
   *
   * Exact values are preserved. Nothing is trimmed, normalized, reordered, or
   * regenerated, and the parent identity is never derived from a nested one.
   *
   * @throws {CompilationPolicyError} when the policy is not valid.
   */
  validate(input: unknown): CompilationPolicy {
    const wrapper = safeParse(CompilationPolicyWrapperSchema, input);
    if (!wrapper.ok) {
      throw new CompilationPolicyError(
        wrapper.issues.map((issue) => ({
          ...issue,
          code: 'invalid_policy' satisfies CompilationPolicyIssueCode,
        })),
      );
    }

    const issues: ValidationIssue[] = [];
    const scoring = validateSlice(
      { slice: 'scoring', code: 'invalid_scoring_policy', parse: parseCandidateScoringPolicy },
      wrapper.value.scoring,
      issues,
    );
    const filtering = validateSlice(
      {
        slice: 'filtering',
        code: 'invalid_filtering_policy',
        parse: parseCandidateFilteringPolicy,
      },
      wrapper.value.filtering,
      issues,
    );
    const allocation = validateSlice(
      {
        slice: 'allocation',
        code: 'invalid_allocation_policy',
        parse: parseBudgetAllocationPolicy,
      },
      wrapper.value.allocation,
      issues,
    );
    const ordering = validateSlice(
      { slice: 'ordering', code: 'invalid_ordering_policy', parse: parseContextOrderingPolicy },
      wrapper.value.ordering,
      issues,
    );
    const rendering = validateSlice(
      { slice: 'rendering', code: 'invalid_rendering_policy', parse: parseContextRenderingPolicy },
      wrapper.value.rendering,
      issues,
    );

    if (
      issues.length > 0 ||
      scoring === undefined ||
      filtering === undefined ||
      allocation === undefined ||
      ordering === undefined ||
      rendering === undefined
    ) {
      throw new CompilationPolicyError(issues);
    }

    return {
      schemaVersion: wrapper.value.schemaVersion,
      policyId: wrapper.value.policyId,
      policyVersion: wrapper.value.policyVersion,
      scoring,
      filtering,
      allocation,
      ordering,
      rendering,
    };
  }
}

/**
 * Validates one compilation policy and returns it, or the structured issues that
 * rejected it.
 *
 * The helper exists so that `CompilationRequestValidator` reports a nested policy
 * failure as issues under its own `policy` pointer instead of catching an error
 * and re-deriving its meaning. It is internal to the compiler kernel: the package
 * entry point never re-exports it, and no public declaration names it
 * (INV-ADAPTER-001).
 */
export function parseCompilationPolicy(input: unknown): ValidationResult<CompilationPolicy> {
  try {
    return { ok: true, value: new CompilationPolicyValidator().validate(input) };
  } catch (error) {
    if (error instanceof CompilationPolicyError) return { ok: false, issues: error.issues };
    throw error;
  }
}

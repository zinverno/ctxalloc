import {
  TokenBudgetSchema,
  availableInputTokens,
  findLoneSurrogate,
  safeParse,
  type ContextBlockId,
  type Scope,
  type SourceDocument,
  type Timestamp,
  type TokenBudget,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import type { ScoredCandidate, ScoredCandidateSet } from './candidate-scorer.js';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * Deterministic budget allocation (DEC-033).
 *
 * `BudgetAllocator` is the fourth stage of the compiler kernel. It turns a
 * `ScoredCandidateSet`, an explicit `TokenBudget`, and one narrow versioned
 * `BudgetAllocationPolicy` into an `AllocatedCandidateSet`: required candidates
 * are resolved first, exact category block-count constraints are enforced,
 * optional candidates are selected under the available block-content budget, and
 * every candidate leaves with exactly one machine-readable decision.
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model, no retrieval provider, no tokenizer, and no renderer
 * (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002).
 *
 * **This stage is not the final budget guarantee.** INV-BUDGET-002 makes the
 * final rendered string the source of truth, and rendering does not exist yet:
 * source labels, separators, wrappers, emitted metadata, and fixed prefixes are
 * unwritten, so their tokens cannot be counted here. What this stage proves is
 * exact and narrower:
 *
 * ```text
 * sum(included canonicalBlock.tokenCount) <= availableInputTokens
 * ```
 *
 * It never claims `compiledTokens <= availableInputTokens` for a context nobody
 * has rendered, and it therefore publishes `selectedBlockContentTokens` and
 * `unallocatedBlockContentTokens` rather than `compiledTokens` and
 * `unusedTokens`. A later renderer plus orchestration loop will render, tokenize
 * the complete string, evict optional blocks along `optionalEvictionOrder` when
 * the result overruns, render again, and fail when required content plus hard
 * category constraints plus rendering overhead still cannot fit. That loop is
 * not implemented here.
 *
 * One thing is already definitive before rendering: block content that alone
 * exceeds the available ceiling can never fit once overhead is added. Required
 * block content over the ceiling therefore fails immediately (INV-BUDGET-004).
 * The converse does not hold — required content that fits here is not proof that
 * the rendered required context will fit.
 *
 * What it deliberately does not do: it does not retrieve candidates, revalidate
 * them, re-count tokens, re-hash content, revalidate scope, deduplicate,
 * rescore, filter by policy, trim or rewrite content, order for rendering,
 * render, tokenize, build a trace, or persist anything.
 */

/* -------------------------------------------------------------------------- */
/* Public contract: policy                                                     */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link BudgetAllocationPolicy} (INV-STORE-004). */
export const BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION = 1;

/**
 * One hard constraint on how many blocks of one exact category may be selected.
 *
 * The unit is **blocks, not tokens**. `minBlocks` guarantees at least that many
 * independently selectable canonical blocks of the category are included;
 * `maxBlocks` forbids more than that many. Schema version 1 defines no token
 * quota, no percentage share, and no byte or character quota: the active
 * documents required category minimums and maximums without ever stating their
 * unit, and DEC-033 resolves that ambiguity as counts, because a count is
 * decidable exactly and efficiently while a token quota with a hard minimum is a
 * subset-sum problem this stage deliberately does not solve.
 *
 * At least one bound must be present; a constraint carrying neither would
 * constrain nothing while looking like configuration. Both may be present and
 * may be equal, and either may be `0`.
 */
export interface CategoryAllocationConstraint {
  readonly category: string;
  readonly minBlocks?: number | undefined;
  readonly maxBlocks?: number | undefined;
}

/**
 * One narrow versioned allocation policy, owned by this compiler stage.
 *
 * This is deliberately not the broad future `CompilationPolicy` of
 * ARCHITECTURE 5.6, which also covers filtering, ordering, and rendering. Only
 * the allocation slice exists, because only the allocation stage exists. A later
 * `CompilationPolicy` may contain or reference this object, alongside
 * `CandidateScoringPolicy` and future filtering, ordering, and rendering
 * policies, without changing what `BudgetAllocator` means by it.
 *
 * `optionalSelection` names the strategy explicitly rather than leaving it
 * implicit, so a future strategy is a policy value with its own schema version
 * rather than a silent behavior change. Schema version 1 supports exactly one:
 * `score-desc-greedy`.
 *
 * The optional member is declared as "absent or explicitly `undefined`" because
 * a policy is external configuration parsed at a runtime boundary, and a caller
 * that spells an unused component as `undefined` describes the same policy as
 * one that omits the key.
 */
export interface BudgetAllocationPolicy {
  readonly schemaVersion: typeof BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly optionalSelection: 'score-desc-greedy';
  readonly categoryConstraints?: readonly CategoryAllocationConstraint[] | undefined;
}

/* -------------------------------------------------------------------------- */
/* Public contract: decisions                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable reason for one allocation decision (INV-TRACE-002).
 *
 * A free-text explanation is never the primary contract: a later trace must be
 * able to report why a block was included or excluded without re-deriving
 * meaning from a message.
 */
export type AllocationDecisionReason =
  | 'INCLUDED_REQUIRED'
  | 'INCLUDED_CATEGORY_MINIMUM'
  | 'INCLUDED_SCORE_ORDER'
  | 'EXCLUDED_CATEGORY_MAXIMUM'
  | 'EXCLUDED_BUDGET_EXHAUSTED';

/**
 * One candidate the allocator selected, with the budget transition it caused.
 *
 * `contentTokens` is the canonical block's own exact token count, never a
 * rendered cost. `remainingBefore` and `remainingAfter` are block-content budget
 * remainders around this inclusion and always differ by exactly
 * `contentTokens`.
 */
export interface IncludedCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'included';
  readonly reason: AllocationDecisionReason;
  readonly contentTokens: number;
  readonly remainingBefore: number;
  readonly remainingAfter: number;
}

/**
 * One candidate the allocator did not select, with the budget it left untouched.
 *
 * An exclusion never spends budget, so a single `remainingTokens` records the
 * unchanged remainder rather than a before-and-after pair.
 */
export interface ExcludedCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'excluded';
  readonly reason: AllocationDecisionReason;
  readonly contentTokens: number;
  readonly remainingTokens: number;
}

/**
 * The allocated batch: an ephemeral compiler-stage result, never persisted.
 *
 * It carries no schema version for that reason: `schemaVersion` marks persisted
 * domain records so an unsupported stored shape fails clearly (INV-STORE-004),
 * and this structure is produced and consumed inside one compilation.
 *
 * `selectedBlockContentTokens` is the exact sum of the included canonical blocks'
 * token counts and **is not** `compiledTokens`; `unallocatedBlockContentTokens`
 * is what remains of the block-content ceiling and **is not** the final
 * `unusedTokens` of INV-BUDGET-006. Both become inputs to the future renderer,
 * not answers about it.
 *
 * `included` reflects allocation chronology — required blocks, then category
 * minimums, then score-ordered optional blocks — and is **not** final render
 * order. `ContextOrderer` owns that in a later phase.
 */
export interface AllocatedCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];

  readonly scoringPolicyId: string;
  readonly scoringPolicyVersion: string;
  readonly allocationPolicyId: string;
  readonly allocationPolicyVersion: string;
  readonly referenceTime: Timestamp;

  readonly tokenBudget: TokenBudget;
  readonly availableInputTokens: number;

  readonly selectedBlockContentTokens: number;
  readonly unallocatedBlockContentTokens: number;

  readonly included: readonly IncludedCandidateDecision[];
  readonly excluded: readonly ExcludedCandidateDecision[];

  readonly optionalEvictionOrder: readonly ContextBlockId[];
}

/* -------------------------------------------------------------------------- */
/* Public contract: failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable categories of a budget allocation problem.
 *
 * Every issue carries one of these instead of a free-text explanation, so a
 * later compiler trace can report an allocation failure without re-deriving
 * meaning from a message (INV-TRACE-002).
 */
export type BudgetAllocationIssueCode =
  | 'invalid_policy'
  | 'duplicate_category_constraint'
  | 'invalid_budget'
  | 'required_content_exceeds_budget'
  | 'required_category_maximum_exceeded'
  | 'category_minimum_unreachable'
  | 'category_minimums_exceed_content_budget'
  | 'invalid_allocation_result';

/**
 * The single error this component raises, for construction and for allocation
 * alike.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, provider error, or
 * implementation exception escapes this boundary (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 */
export class BudgetAllocationError extends Error {
  readonly code = 'BUDGET_ALLOCATION_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Budget allocation failed: ${summary}`);
    this.name = 'BudgetAllocationError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue construction                                                          */
/* -------------------------------------------------------------------------- */

function issue(code: BudgetAllocationIssueCode, path: IssuePath, message: string): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/**
 * Addresses one category constraint by its exact category rather than by array
 * position, so a permuted policy produces a byte-identical issue set
 * (INV-DET-002, INV-ALLOC-005).
 */
function categoryPath(category: string, ...rest: IssuePath): IssuePath {
  return ['categoryConstraints', category, ...rest];
}

/** Addresses one candidate group by its stable canonical block identifier. */
function candidatePath(canonicalBlockId: string, ...rest: IssuePath): IssuePath {
  return ['candidates', canonicalBlockId, ...rest];
}

/* -------------------------------------------------------------------------- */
/* Policy schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A policy string is configuration, not content: it is validated and never
 * rewritten.
 *
 * No trimming, lowercasing, or canonicalization is applied. Malformed UTF-16 is
 * rejected with the shared domain helper, exactly as the scoring policy rejects
 * it (INV-BLOCK-007).
 */
const policyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * A category key is matched by exact string equality, so any string a
 * `ContextBlock` may legitimately carry must be configurable — including an empty
 * one, which `ContextBlockSchema` allows. Only malformed UTF-16 is rejected,
 * because such a value could never equal a well-formed block category and
 * signals a corrupted configuration rather than a deliberate key.
 */
const categoryString = z
  .string()
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/** A block count: a finite non-negative safe integer, never coerced. */
const blockCount = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0, {
  message: 'must be a safe integer greater than or equal to 0',
});

const CategoryAllocationConstraintSchema = z
  .strictObject({
    category: categoryString,
    minBlocks: blockCount.optional(),
    maxBlocks: blockCount.optional(),
  })
  .refine(
    (constraint) => constraint.minBlocks !== undefined || constraint.maxBlocks !== undefined,
    {
      message: 'must declare minBlocks, maxBlocks, or both',
    },
  )
  .refine(
    (constraint) =>
      constraint.minBlocks === undefined ||
      constraint.maxBlocks === undefined ||
      constraint.minBlocks <= constraint.maxBlocks,
    { message: 'minBlocks must not exceed maxBlocks' },
  );

const BudgetAllocationPolicySchema = z.strictObject({
  schemaVersion: z.literal(BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  // The one strategy of schema version 1. A future strategy is a new accepted
  // value under a new schema version, never a silent change of this one.
  optionalSelection: z.literal('score-desc-greedy'),
  categoryConstraints: z.array(CategoryAllocationConstraintSchema).optional(),
});

/**
 * Rejects two constraints owning the same exact category.
 *
 * Resolving a repeat by first or last write would make the order of a
 * caller-owned array significant, so two policies describing the same rules in a
 * different order could allocate differently (INV-DET-002).
 */
function detectDuplicateCategories(policy: BudgetAllocationPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, number>();
  (policy.categoryConstraints ?? []).forEach((constraint, index) => {
    const first = seen.get(constraint.category);
    if (first === undefined) {
      seen.set(constraint.category, index);
      return;
    }
    issues.push(
      issue(
        'duplicate_category_constraint',
        ['categoryConstraints', index, 'category'],
        `category ${quote(constraint.category)} is already declared at categoryConstraints[${String(first)}]`,
      ),
    );
  });
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Budget schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The runtime boundary for the budget this stage accepts.
 *
 * The budget is request configuration rather than a stage contract, so it is
 * validated here — with the existing `TokenBudgetSchema` and nothing else. Its
 * arithmetic rules are not restated, no reserve is defaulted or injected, and no
 * hidden rendering reserve is added: an omitted reserve means the caller
 * reserved nothing for it (INV-BUDGET-001, INV-BUDGET-005).
 *
 * The value is wrapped so that reported issue paths address `budget` rather than
 * the bare field names of a value the caller passed positionally.
 */
const BudgetSchema = z.strictObject({ budget: TokenBudgetSchema });

/* -------------------------------------------------------------------------- */
/* Internal candidate view                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One deduplicated, scored group reduced to the four facts allocation may read.
 *
 * The allocator consumes `score.total` for optional ranking and the canonical
 * block's required flag, category, token count, and identifier for the
 * allocation rules. It never reads raw retrieval values, score component
 * evidence, timestamps, authored priority, source priority, or recency, which
 * keeps `CandidateScorer` the sole owner of score composition.
 */
interface AllocationCandidate {
  readonly scored: ScoredCandidate;
  readonly id: ContextBlockId;
  readonly contentTokens: number;
  readonly required: boolean;
  readonly category: string | undefined;
  readonly total: number;
}

/**
 * The Phase 10 cost of one group is the canonical block's own token count.
 *
 * Phase 8 chose the exact canonical `ContextBlock` later stages carry, and
 * Phase 7 already proved that count matches that block's exact content under the
 * configured tokenizer. Member counts are not summed or averaged, no retrieval
 * wrapper is counted, and nothing is re-counted here.
 */
function viewOf(scored: ScoredCandidate): AllocationCandidate {
  const block = scored.candidate.canonicalBlock;
  return {
    scored,
    id: block.id,
    contentTokens: block.tokenCount,
    // Required status is read from the canonical block alone. Phase 8 already
    // guarantees a group holding any required block gets a required canonical
    // block, so no duplicate member is consulted (INV-DEDUP-002).
    required: block.attributes.required === true,
    category: block.attributes.category,
    total: scored.score.total,
  };
}

/* -------------------------------------------------------------------------- */
/* Comparators                                                                 */
/* -------------------------------------------------------------------------- */

/** A total order over numbers, used only to compose the comparators below. */
function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Required traversal: stable block identifier ascending (INV-DET-005). */
function compareRequired(a: AllocationCandidate, b: AllocationCandidate): number {
  return compareCodeUnits(a.id, b.id);
}

/**
 * Hard-minimum selection: token count ascending, then score descending, then
 * block identifier ascending.
 *
 * Token cost comes first on purpose. Exactly K additional blocks of the category
 * must be selected, so taking the K cheapest produces the minimum possible
 * content-token cost of satisfying that count. Score decides only among
 * equal-cost candidates.
 */
function compareMinimumCost(a: AllocationCandidate, b: AllocationCandidate): number {
  return (
    compareNumbers(a.contentTokens, b.contentTokens) ||
    compareNumbers(b.total, a.total) ||
    compareCodeUnits(a.id, b.id)
  );
}

/** Optional selection: score descending, then block identifier ascending. */
function compareScoreOrder(a: AllocationCandidate, b: AllocationCandidate): number {
  return compareNumbers(b.total, a.total) || compareCodeUnits(a.id, b.id);
}

/**
 * Eviction: score ascending, then block identifier descending.
 *
 * This is the exact reverse of the v1 utility preference, so the surplus the
 * allocator valued least is the first thing a later render-correction loop gives
 * back.
 */
function compareEviction(a: AllocationCandidate, b: AllocationCandidate): number {
  return compareNumbers(a.total, b.total) || compareCodeUnits(b.id, a.id);
}

/* -------------------------------------------------------------------------- */
/* Allocator                                                                   */
/* -------------------------------------------------------------------------- */

/** Mutable bookkeeping of one allocation run. */
interface AllocationState {
  remaining: number;
  readonly included: IncludedCandidateDecision[];
  readonly excluded: ExcludedCandidateDecision[];
  readonly selectedByCategory: Map<string, number>;
}

export class BudgetAllocator {
  readonly #policy: BudgetAllocationPolicy;
  readonly #minBlocks: ReadonlyMap<string, number>;
  readonly #maxBlocks: ReadonlyMap<string, number>;

  /**
   * Validates the allocation policy and compiles its category lookups.
   *
   * The lookups are built only after validation has proved every category
   * unique, so no constraint can be shadowed and no array order can decide which
   * constraint applies (INV-DET-002). The caller's array is never sorted,
   * rewritten, or mutated.
   *
   * @throws {BudgetAllocationError} when the policy is not valid.
   */
  constructor(policy: unknown) {
    const parsed = safeParse(BudgetAllocationPolicySchema, policy);
    if (!parsed.ok) {
      // A policy whose shape is unsupported gets schema issues only: the
      // duplicate-category rule below reads a field the schema has not
      // established, so running it over unparsed configuration could only guess.
      throw new BudgetAllocationError(
        parsed.issues.map((parsedIssue) => ({ ...parsedIssue, code: 'invalid_policy' })),
      );
    }

    const validated: BudgetAllocationPolicy = parsed.value;
    const duplicates = detectDuplicateCategories(validated);
    if (duplicates.length > 0) throw new BudgetAllocationError(duplicates);

    this.#policy = validated;
    const constraints = validated.categoryConstraints ?? [];
    this.#minBlocks = new Map(
      constraints.flatMap((constraint) =>
        constraint.minBlocks === undefined ? [] : [[constraint.category, constraint.minBlocks]],
      ),
    );
    this.#maxBlocks = new Map(
      constraints.flatMap((constraint) =>
        constraint.maxBlocks === undefined ? [] : [[constraint.category, constraint.maxBlocks]],
      ),
    );
  }

  /**
   * Allocates one scored batch under one budget, all or nothing.
   *
   * `budget` is validated with the existing `TokenBudgetSchema` and its ceiling
   * comes from the existing `availableInputTokens()`. Nothing about the model
   * context window is guessed, no reserve is injected, and no rendering reserve
   * is hidden inside the ceiling.
   *
   * The order of work is fixed and deterministic:
   *
   * 1. validate the budget;
   * 2. reject category count impossibilities — required blocks over a category
   *    maximum, and category minimums no set of candidates could reach;
   * 3. allocate every required block, failing when block content alone exceeds
   *    the ceiling (INV-BUDGET-004);
   * 4. reserve the minimum-cost blocks that satisfy every category minimum,
   *    failing when that complete union cannot fit;
   * 5. select the remaining optional candidates by score descending, skipping a
   *    candidate whose category is already at its maximum and continuing past
   *    one that does not fit;
   * 6. precompute the deterministic optional eviction order for the future
   *    render-correction loop.
   *
   * The supplied set and everything reachable from it are treated as immutable.
   * No group, block, attribute, metadata object, source document, score, or
   * array is mutated, and the result reuses those records by reference
   * (INV-ALLOC-004). The supplied budget object is not mutated either.
   *
   * Every scored candidate appears exactly once across `included` and `excluded`
   * (INV-TRACE-001). On any failure no partial `AllocatedCandidateSet` is
   * returned: nothing is trimmed, no required block is dropped, and no
   * constraint is relaxed.
   *
   * @throws {BudgetAllocationError} when the budget or the allocation is not valid.
   */
  allocate(input: ScoredCandidateSet, budget: unknown): AllocatedCandidateSet {
    const parsedBudget = safeParse(BudgetSchema, { budget });
    if (!parsedBudget.ok) {
      throw new BudgetAllocationError(
        parsedBudget.issues.map((parsedIssue) => ({ ...parsedIssue, code: 'invalid_budget' })),
      );
    }
    const validatedBudget: TokenBudget = parsedBudget.value.budget;
    const available = availableInputTokens(validatedBudget);

    // Traversal order is canonical, so every later comparator resolves its
    // remaining ties the same way whatever order the caller supplied. The
    // canonical block's serialization completes the order for a caller that
    // bypassed the pipeline and supplied two groups with one canonical ID.
    const candidates: readonly AllocationCandidate[] = [...input.candidates]
      .sort(
        (a, b) =>
          compareCodeUnits(a.candidate.canonicalBlock.id, b.candidate.canonicalBlock.id) ||
          compareCodeUnits(
            canonicalJson(a.candidate.canonicalBlock),
            canonicalJson(b.candidate.canonicalBlock),
          ),
      )
      .map(viewOf);

    const required = candidates.filter((entry) => entry.required);
    const optional = candidates.filter((entry) => !entry.required);

    const countIssues = this.#detectCategoryCountFailures(required, optional);
    if (countIssues.length > 0) throw new BudgetAllocationError(countIssues);

    const state: AllocationState = {
      remaining: available,
      included: [],
      excluded: [],
      selectedByCategory: new Map(),
    };

    this.#allocateRequired(required, state, available);
    const reserved = this.#allocateCategoryMinimums(required, optional, state, available);
    this.#allocateOptional(
      optional.filter((entry) => !reserved.has(entry)),
      state,
    );

    const selected = available - state.remaining;
    const result: AllocatedCandidateSet = {
      scope: input.scope,
      // The same validated records, in a normalized order. The array is copied
      // before sorting, so the caller's registry is never reordered in place,
      // and this stage does not depend on the previous one having sorted it.
      sourceDocuments: [...input.sourceDocuments].sort((a, b) => compareCodeUnits(a.id, b.id)),
      scoringPolicyId: input.policyId,
      scoringPolicyVersion: input.policyVersion,
      allocationPolicyId: this.#policy.policyId,
      allocationPolicyVersion: this.#policy.policyVersion,
      referenceTime: input.referenceTime,
      tokenBudget: validatedBudget,
      availableInputTokens: available,
      selectedBlockContentTokens: selected,
      unallocatedBlockContentTokens: state.remaining,
      included: state.included,
      excluded: state.excluded,
      optionalEvictionOrder: this.#evictionOrder(state),
    };

    const reconciliation = reconcile(result, candidates, available);
    if (reconciliation.length > 0) throw new BudgetAllocationError(reconciliation);
    return result;
  }

  /**
   * Collects every category count impossibility before any budget is spent.
   *
   * Both rules are pure counting and do not depend on the budget, so they are
   * decided first and reported together: a caller whose policy cannot be
   * satisfied by any budget learns the whole set at once rather than one
   * constraint per call. Constraints are traversed in category order, so the
   * issue set never depends on the order the policy declared them.
   */
  #detectCategoryCountFailures(
    required: readonly AllocationCandidate[],
    optional: readonly AllocationCandidate[],
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    for (const category of this.#constrainedCategories()) {
      const requiredCount = required.filter((entry) => entry.category === category).length;
      const optionalCount = optional.filter((entry) => entry.category === category).length;

      // A required block is never removed to satisfy a maximum. Silently
      // dropping one would violate INV-BUDGET-003 and INV-ALLOC-001 in order to
      // satisfy INV-ALLOC-003, so the conflict is reported instead
      // (INV-ALLOC-003).
      const maxBlocks = this.#maxBlocks.get(category);
      if (maxBlocks !== undefined && requiredCount > maxBlocks) {
        issues.push(
          issue(
            'required_category_maximum_exceeded',
            categoryPath(category, 'maxBlocks'),
            `category ${quote(category)} allows at most ${String(maxBlocks)} block(s) but the batch declares ${String(requiredCount)} required block(s), which must not be removed`,
          ),
        );
      }

      // Required blocks count toward a minimum, so only the shortfall must come
      // from optional candidates.
      const minBlocks = this.#minBlocks.get(category);
      if (minBlocks === undefined) continue;
      const needed = Math.max(0, minBlocks - requiredCount);
      if (optionalCount < needed) {
        issues.push(
          issue(
            'category_minimum_unreachable',
            categoryPath(category, 'minBlocks'),
            `category ${quote(category)} requires at least ${String(minBlocks)} block(s) and the batch supplies ${String(requiredCount)} required and ${String(optionalCount)} optional candidate(s) of that category`,
          ),
        );
      }
    }
    return issues;
  }

  /**
   * Includes every required block, in block-identifier order, or fails.
   *
   * Cost is subtracted one block at a time rather than summed and compared,
   * because summing several counts near `Number.MAX_SAFE_INTEGER` can lose
   * precision and silently accept an impossible allocation. Each subtraction
   * stays inside the safe range, so the check is exact for every accepted batch.
   *
   * A required block that does not fit fails the whole allocation: no other
   * required block is dropped, no fallback to optional handling happens, and no
   * content is truncated (INV-BUDGET-003, INV-BUDGET-004). Traversal is by block
   * identifier, so which block is named as the witness cannot depend on input
   * order.
   */
  #allocateRequired(
    required: readonly AllocationCandidate[],
    state: AllocationState,
    available: number,
  ): void {
    for (const entry of [...required].sort(compareRequired)) {
      if (entry.contentTokens > state.remaining) {
        throw new BudgetAllocationError([
          issue(
            'required_content_exceeds_budget',
            candidatePath(entry.id, 'tokenCount'),
            `required block content does not fit: block ${quote(entry.id)} costs ${String(entry.contentTokens)} token(s) with ${String(state.remaining)} of ${String(available)} available block-content token(s) left after the required blocks with smaller identifiers`,
          ),
        ]);
      }
      this.#include(entry, 'INCLUDED_REQUIRED', state);
    }
  }

  /**
   * Reserves the cheapest blocks that satisfy every category minimum, or fails.
   *
   * Each category's selection is computed in full **before** anything is
   * subtracted from the shared remainder, so no category's feasibility depends
   * on the order the categories happen to be processed in.
   *
   * The chosen union is the minimum-content-cost set among all selections
   * satisfying the count minimums: each canonical block has at most one exact
   * category, so the per-category choices are disjoint, and taking the K
   * cheapest candidates of each category minimizes each disjoint part
   * independently. If that union does not fit, no other selection satisfying the
   * same minimums fits either, which makes the failure a real block-content
   * infeasibility rather than an artifact of greedy traversal.
   *
   * @returns the candidates reserved here, which the general optional pass skips.
   */
  #allocateCategoryMinimums(
    required: readonly AllocationCandidate[],
    optional: readonly AllocationCandidate[],
    state: AllocationState,
    available: number,
  ): ReadonlySet<AllocationCandidate> {
    const union: { readonly category: string; readonly entry: AllocationCandidate }[] = [];
    for (const category of this.#constrainedCategories()) {
      const minBlocks = this.#minBlocks.get(category);
      if (minBlocks === undefined) continue;
      const requiredCount = required.filter((entry) => entry.category === category).length;
      const needed = Math.max(0, minBlocks - requiredCount);
      if (needed === 0) continue;

      const picks = optional
        .filter((entry) => entry.category === category)
        .sort(compareMinimumCost)
        .slice(0, needed);
      for (const entry of picks) union.push({ category, entry });
    }

    // Categories are already traversed in code-unit order and each category's
    // picks are already in minimum-cost order, so the union is ordered by
    // category, token count, score, and identifier without a second sort.
    const reserved = new Set<AllocationCandidate>();
    for (const { entry } of union) {
      if (entry.contentTokens > state.remaining) {
        throw new BudgetAllocationError([
          issue(
            'category_minimums_exceed_content_budget',
            ['categoryConstraints'],
            `the minimum-cost selection satisfying every category minimum needs more block-content tokens than the ${String(state.remaining)} of ${String(available)} left after required allocation: ${String(union.length)} block(s) are needed and block ${quote(entry.id)} costing ${String(entry.contentTokens)} token(s) does not fit`,
          ),
        ]);
      }
      this.#include(entry, 'INCLUDED_CATEGORY_MINIMUM', state);
      reserved.add(entry);
    }
    return reserved;
  }

  /**
   * Selects the remaining optional candidates by `score-desc-greedy`.
   *
   * Candidates are considered by score descending, then by block identifier
   * ascending. The caller's array order is not trusted even though Phase 9
   * already ranks its output: the ordering rule of this stage is applied here so
   * that a set assembled by hand allocates exactly like one that came through the
   * pipeline (INV-ALLOC-005).
   *
   * A category maximum is checked before the budget, so a blocked candidate
   * spends nothing and the tokens stay available to the next candidate. A
   * candidate that does not fit is excluded and traversal continues, so a large
   * high-score candidate never stops smaller lower-score ones from being
   * considered.
   *
   * This is deliberately not knapsack, dynamic programming, integer programming,
   * beam search, total-utility maximization, or score-per-token: no score is
   * divided by a token count, no token cost is subtracted from a score, and no
   * lower-score candidate is preferred for a better ratio (DEC-033).
   */
  #allocateOptional(optional: readonly AllocationCandidate[], state: AllocationState): void {
    for (const entry of [...optional].sort(compareScoreOrder)) {
      const maxBlocks =
        entry.category === undefined ? undefined : this.#maxBlocks.get(entry.category);
      if (maxBlocks !== undefined && this.#selectedCount(entry.category, state) >= maxBlocks) {
        state.excluded.push({
          candidate: entry.scored,
          decision: 'excluded',
          reason: 'EXCLUDED_CATEGORY_MAXIMUM',
          contentTokens: entry.contentTokens,
          remainingTokens: state.remaining,
        });
        continue;
      }

      if (entry.contentTokens > state.remaining) {
        state.excluded.push({
          candidate: entry.scored,
          decision: 'excluded',
          reason: 'EXCLUDED_BUDGET_EXHAUSTED',
          contentTokens: entry.contentTokens,
          remainingTokens: state.remaining,
        });
        continue;
      }

      this.#include(entry, 'INCLUDED_SCORE_ORDER', state);
    }
  }

  /**
   * Precomputes the order in which a future render-correction loop may remove
   * optional blocks (INV-ALLOC-006).
   *
   * Required blocks never appear: they are not evictable at any point
   * (INV-BUDGET-003). Optional inclusions are considered in reverse utility
   * order — score ascending, then identifier descending — against a simulated
   * category count, and a candidate enters the order only when removing it would
   * leave its category at or above `minBlocks`.
   *
   * A maximum restricts inclusion, not removal, so it never protects a block
   * here. A block first included to satisfy a minimum may still become evictable
   * once later selections created surplus in its category, and a block that is
   * protected simply keeps its place in the allocation.
   *
   * Applying the whole order therefore leaves every configured minimum satisfied
   * and every required block present. If rendering still does not fit after that,
   * the future orchestration must fail rather than break either guarantee.
   */
  #evictionOrder(state: AllocationState): readonly ContextBlockId[] {
    const counts = new Map(state.selectedByCategory);
    const order: ContextBlockId[] = [];
    const optional = state.included
      .filter((decision) => decision.reason !== 'INCLUDED_REQUIRED')
      .map((decision) => viewOf(decision.candidate))
      .sort(compareEviction);

    for (const entry of optional) {
      const minBlocks =
        entry.category === undefined ? undefined : this.#minBlocks.get(entry.category);
      if (minBlocks !== undefined && entry.category !== undefined) {
        const count = counts.get(entry.category) ?? 0;
        if (count - 1 < minBlocks) continue;
        counts.set(entry.category, count - 1);
      }
      order.push(entry.id);
    }
    return order;
  }

  /** Every configured category, in code-unit order (INV-DET-002). */
  #constrainedCategories(): readonly string[] {
    return [...new Set([...this.#minBlocks.keys(), ...this.#maxBlocks.keys()])].sort(
      compareCodeUnits,
    );
  }

  #selectedCount(category: string | undefined, state: AllocationState): number {
    if (category === undefined) return 0;
    return state.selectedByCategory.get(category) ?? 0;
  }

  /** Records one inclusion and its exact budget transition. */
  #include(
    entry: AllocationCandidate,
    reason: AllocationDecisionReason,
    state: AllocationState,
  ): void {
    const remainingBefore = state.remaining;
    state.remaining = remainingBefore - entry.contentTokens;
    state.included.push({
      candidate: entry.scored,
      decision: 'included',
      reason,
      contentTokens: entry.contentTokens,
      remainingBefore,
      remainingAfter: state.remaining,
    });
    if (entry.category !== undefined) {
      state.selectedByCategory.set(entry.category, this.#selectedCount(entry.category, state) + 1);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Result reconciliation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Proves the assembled result satisfies the properties this stage publishes.
 *
 * The checks are a defence against a future edit rather than a validation of
 * caller input: a decision-accounting or budget-accounting defect must fail
 * loudly instead of returning an allocation whose numbers a later trace could
 * not reconcile (INV-TRACE-001, INV-TRACE-003). Nothing here changes a decision
 * — an observation that altered the allocation would break INV-TRACE-006.
 *
 * The sum is accumulated rather than compared against a precomputed total, and
 * every partial sum is bounded by `availableInputTokens`, so the addition is
 * exact.
 */
function reconcile(
  result: AllocatedCandidateSet,
  candidates: readonly AllocationCandidate[],
  available: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const outstanding = new Map<ScoredCandidate, number>();
  for (const entry of candidates) {
    outstanding.set(entry.scored, (outstanding.get(entry.scored) ?? 0) + 1);
  }
  let unmatched = 0;
  for (const decision of [...result.included, ...result.excluded]) {
    const pending = outstanding.get(decision.candidate) ?? 0;
    if (pending === 0) unmatched += 1;
    else outstanding.set(decision.candidate, pending - 1);
  }
  const undecided = [...outstanding.values()].reduce((total, pending) => total + pending, 0);
  const decisionCount = result.included.length + result.excluded.length;

  if (decisionCount !== candidates.length || unmatched > 0 || undecided > 0) {
    issues.push(
      issue(
        'invalid_allocation_result',
        ['included'],
        `every candidate must have exactly one decision: ${String(candidates.length)} candidate(s) produced ${String(decisionCount)} decision(s), ${String(undecided)} undecided and ${String(unmatched)} unrecognized`,
      ),
    );
  }

  let selected = 0;
  for (const decision of result.included) selected += decision.contentTokens;
  if (selected !== result.selectedBlockContentTokens) {
    issues.push(
      issue(
        'invalid_allocation_result',
        ['selectedBlockContentTokens'],
        `must equal the exact sum of the included block token counts, calculated ${String(selected)} against ${String(result.selectedBlockContentTokens)}`,
      ),
    );
  }
  if (result.selectedBlockContentTokens > available) {
    issues.push(
      issue(
        'invalid_allocation_result',
        ['selectedBlockContentTokens'],
        `must not exceed the ${String(available)} available block-content token(s), calculated ${String(result.selectedBlockContentTokens)}`,
      ),
    );
  }
  if (result.unallocatedBlockContentTokens !== available - result.selectedBlockContentTokens) {
    issues.push(
      issue(
        'invalid_allocation_result',
        ['unallocatedBlockContentTokens'],
        `must equal availableInputTokens minus selectedBlockContentTokens, calculated ${String(result.unallocatedBlockContentTokens)}`,
      ),
    );
  }
  return issues;
}

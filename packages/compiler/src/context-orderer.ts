import {
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type ValidationIssue,
  type ValidationResult,
} from '@ctxalloc/domain';
import { z } from 'zod';
import type { AllocatedCandidateSet, IncludedCandidateDecision } from './budget-allocator.js';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';

/**
 * Deterministic context ordering (DEC-034).
 *
 * `ContextOrderer` runs after `BudgetAllocator` and before `ContextRenderer`. It
 * turns an `AllocatedCandidateSet` and one narrow versioned
 * `ContextOrderingPolicy` into an `OrderedCandidateSet`: the same included
 * decisions, in the order the renderer must lay them out.
 *
 * It exists because allocation chronology is not render order. Phase 10 returns
 * its inclusions as required blocks, then category minimums, then score-selected
 * optional blocks — the order in which the budget was spent, which says nothing
 * about how the content should read. Leaving the renderer to sort for itself
 * would make presentation an implicit side effect of whichever array order
 * reached it (INV-RENDER-001).
 *
 * Order here means source coherence, not importance. Blocks are grouped by their
 * source document and, inside each document, put back into the order they occur
 * in that source: character offsets for text, message chronology for
 * conversations. A reader gets the source's own sequence rather than a ranking.
 *
 * Four sequences now exist across the kernel — the Phase 9 score ranking, the
 * Phase 10 allocation chronology, `optionalEvictionOrder`, and this render
 * order. They are distinct *semantic* sequences, not disjoint ones: this order
 * and the allocation chronology hold the same decisions, so each is literally a
 * permutation of the other, and `optionalEvictionOrder` holds a subset of these
 * block identifiers. What distinguishes them is that their ordering rules answer
 * different questions, so none may be inferred or derived from another.
 *
 * **It changes no decision.** Nothing is included, excluded, evicted, re-scored,
 * deduplicated, trimmed, or rewritten, and no block is cloned or synthesized:
 * `orderedIncluded` holds exactly the objects of `allocation.included`, by
 * reference, permuted (INV-ALLOC-002, INV-ALLOC-004, INV-TRACE-001).
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model, no retrieval provider, no tokenizer, and no renderer
 * (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). It measures no rendering
 * overhead and produces no compiled string: the final rendered budget stays
 * future work (INV-BUDGET-002).
 */

/* -------------------------------------------------------------------------- */
/* Public contract: policy                                                     */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link ContextOrderingPolicy} (INV-STORE-004). */
export const CONTEXT_ORDERING_POLICY_SCHEMA_VERSION = 1;

/**
 * One narrow versioned ordering policy, owned by this compiler stage.
 *
 * This is deliberately not the broad future `CompilationPolicy` of
 * ARCHITECTURE 5.6, for the same reason `CandidateScoringPolicy` and
 * `BudgetAllocationPolicy` are not: only the ordering slice exists, because only
 * the ordering stage exists.
 *
 * `strategy` names the rule explicitly rather than leaving it implicit, so a
 * future strategy — interleaving several sources, grouping by category, placing
 * required content first — arrives as a policy value under a new schema version
 * rather than as a silent change of what this one means.
 */
export interface ContextOrderingPolicy {
  readonly schemaVersion: typeof CONTEXT_ORDERING_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly strategy: 'source-document-then-location';
}

/* -------------------------------------------------------------------------- */
/* Public contract: result                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ordered batch: an ephemeral compiler-stage result, never persisted.
 *
 * It carries no schema version for that reason: `schemaVersion` marks persisted
 * domain records so an unsupported stored shape fails clearly (INV-STORE-004),
 * and this structure is produced and consumed inside one compilation.
 *
 * The allocation is nested rather than flattened. Every Phase 10 fact — the
 * scope, the source registry, both policy identities, the budget, the
 * block-content metrics, the excluded decisions with their reasons, and the
 * eviction order — stays reachable, unchanged, and stated once. Copying those
 * fields into a second stage type would create two places for one truth to
 * drift (INV-DEP-003).
 *
 * The one new fact is `orderedIncluded`.
 */
export interface OrderedCandidateSet {
  readonly allocation: AllocatedCandidateSet;
  readonly orderingPolicyId: string;
  readonly orderingPolicyVersion: string;

  /**
   * The included decisions in render order.
   *
   * Exactly the objects of `allocation.included`, by reference, permuted: every
   * one appears once, no excluded decision appears, and no reason is changed.
   *
   * Array position is the whole of the ordering contract. No index, rank, or
   * position field is written onto a block or a decision, because a block's
   * position is a property of one compilation rather than of the block
   * (DEC-026), and a stored index could disagree with the array holding it.
   *
   * This is not `allocation.optionalEvictionOrder`. By block identity that order
   * is a subset of this sequence — the currently included optional blocks that
   * are safely evictable — but it answers a different question, what may be
   * given back if rendering overruns, and its relative order comes from eviction
   * policy rather than from source position. Neither sequence may be derived
   * from the other.
   */
  readonly orderedIncluded: readonly IncludedCandidateDecision[];
}

/* -------------------------------------------------------------------------- */
/* Public contract: failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable categories of a context ordering problem.
 *
 * There is one. Ordering consumes a stage contract the earlier stages have
 * already proved, and its own runtime boundary is the policy, so a valid policy
 * and a well-formed allocation cannot fail here: sorting a copy of an array can
 * neither lose nor invent an element, which is why this stage needs no
 * reconciliation code of its own.
 */
export type ContextOrderingIssueCode = 'invalid_policy';

/**
 * The single error this component raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or implementation exception
 * escapes this boundary (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class ContextOrderingError extends Error {
  readonly code = 'CONTEXT_ORDERING_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Context ordering failed: ${summary}`);
    this.name = 'ContextOrderingError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Policy schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A policy string is configuration, not content: it is validated and never
 * rewritten.
 *
 * No trimming, lowercasing, or canonicalization is applied. Malformed UTF-16 is
 * rejected with the shared domain helper, exactly as the scoring and allocation
 * policies reject it (INV-BLOCK-007).
 */
const policyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const ContextOrderingPolicySchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_ORDERING_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  // The one strategy of schema version 1. A future strategy is a new accepted
  // value under a new schema version, never a silent change of this one.
  strategy: z.literal('source-document-then-location'),
});

/**
 * Validates one ordering policy and returns it, or the structured issues that
 * rejected it.
 *
 * The helper exists so that the broad `CompilationPolicy` validates its ordering
 * slice through exactly the rules this stage enforces, rather than through a
 * second copy of them that could drift (INV-DEP-003). The stage constructor uses
 * the same helper, so the two paths cannot diverge. It is internal to the
 * compiler kernel: the package entry point never re-exports it, and no public
 * declaration names it (INV-ADAPTER-001).
 */
export function parseContextOrderingPolicy(
  policy: unknown,
): ValidationResult<ContextOrderingPolicy> {
  const parsed = safeParse(ContextOrderingPolicySchema, policy);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({
        ...issue,
        code: 'invalid_policy' satisfies ContextOrderingIssueCode,
      })),
    };
  }
  return { ok: true, value: parsed.value };
}

/* -------------------------------------------------------------------------- */
/* Location ordering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Rank of a location kind, for the defensive case of two kinds inside one
 * source document.
 *
 * `CandidateValidator` already enforces that a block's location kind matches its
 * source type, so a batch that came through the pipeline cannot mix kinds under
 * one source. This stage does not revalidate that — it is not a second validator
 * — but its comparator still has to be total, because a hand-assembled internal
 * input must produce one deterministic order rather than depend on sort
 * stability.
 */
const LOCATION_KIND_RANK = { 'text-range': 0, 'conversation-message': 1 } as const;

/** A total order over numbers, used only to compose the comparators below. */
function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two blocks by position inside their shared source document.
 *
 * A located block always precedes an unlocated one. Position is never inferred
 * for a block that does not state it: content, heading path, timestamps, and
 * input order are all ignored, so an unlocated block falls to the end of its
 * source and is ordered by identifier alone (INV-PROV-002).
 */
function compareLocation(a: ContextBlock, b: ContextBlock): number {
  const left = a.sourceLocation;
  const right = b.sourceLocation;
  if (left === undefined || right === undefined) {
    if (left === right) return 0;
    return left === undefined ? 1 : -1;
  }

  const kindRank = compareNumbers(LOCATION_KIND_RANK[left.kind], LOCATION_KIND_RANK[right.kind]);
  if (kindRank !== 0) return kindRank;

  if (left.kind === 'text-range' && right.kind === 'text-range') {
    // Offsets are the chronology of a text source: they say exactly where the
    // block sat in the original content, and they alone decide position here.
    //
    // `startLine` and `endLine` deliberately take no part. They are optional
    // redundant provenance that offsets already establish, and any rule using
    // them fails: comparing them only when both blocks carry one is not
    // transitive, and ranking presence would order by which producer happened to
    // record line metadata rather than by position.
    //
    // The non-transitivity is not hypothetical. With identical offsets, `a`
    // (lines 2-2), `b` (no lines), and `c` (lines 1-1) gave `a < b` and `b < c`
    // by identifier while `c < a` by line, a cycle that makes `Array.sort` an
    // implementation detail rather than a contract (INV-DET-001, INV-DET-005).
    // Ignoring the fields is the only v1 rule that is a genuine total order and
    // keeps optional metadata completeness from changing the layout.
    return (
      compareNumbers(left.startOffset, right.startOffset) ||
      compareNumbers(left.endOffset, right.endOffset)
    );
  }

  if (left.kind === 'conversation-message' && right.kind === 'conversation-message') {
    // `messageIndex` is the conversation's chronology; a message that states one
    // precedes a message that does not, because guessing where an unindexed
    // message belongs would reorder a conversation on no evidence.
    const leftIndex = left.messageIndex;
    const rightIndex = right.messageIndex;
    if (leftIndex === undefined || rightIndex === undefined) {
      if (leftIndex !== rightIndex) return leftIndex === undefined ? 1 : -1;
      // Neither states chronology. The identifier is a deterministic fallback
      // and nothing more: it is compared by code unit, never parsed for a
      // timestamp, sequence number, or embedded ordering (INV-DET-002).
      return compareCodeUnits(left.messageId, right.messageId);
    }
    return (
      compareNumbers(leftIndex, rightIndex) || compareCodeUnits(left.messageId, right.messageId)
    );
  }

  return 0;
}

/**
 * The complete v1 order: source document, then position in that document, then
 * the stable block identifier.
 *
 * Only canonical block fields participate. Score, required status, allocation
 * reason, category, timestamps, heading path, retrieval and provider data,
 * source metadata, duplicate members, and input array position are all
 * deliberately absent: this stage answers "where does this content belong in the
 * reading order", not "how useful is it", which allocation already settled.
 *
 * Grouping by `sourceDocumentId` keeps one document's blocks contiguous. The
 * identifier is opaque, so its ascending order is a stable grouping key rather
 * than a claim about which document matters more; ranking documents would need a
 * policy that does not exist.
 *
 * The canonical serialization is the last resort, for a hand-assembled input
 * that carries one block identifier on two different records. It never runs for
 * a batch that came through `CandidateValidator`, which rejects exactly that
 * (DEC-030), and it exists so the result is a total order instead of a
 * sort-stability artifact (INV-DET-005).
 */
function compareBlocks(a: ContextBlock, b: ContextBlock): number {
  return (
    compareCodeUnits(a.sourceDocumentId, b.sourceDocumentId) ||
    compareLocation(a, b) ||
    compareCodeUnits(a.id, b.id) ||
    compareCodeUnits(canonicalJson(a), canonicalJson(b))
  );
}

/* -------------------------------------------------------------------------- */
/* Orderer                                                                     */
/* -------------------------------------------------------------------------- */

export class ContextOrderer {
  readonly #policy: ContextOrderingPolicy;

  /**
   * Validates the ordering policy.
   *
   * @throws {ContextOrderingError} when the policy is not valid.
   */
  constructor(policy: unknown) {
    const parsed = parseContextOrderingPolicy(policy);
    if (!parsed.ok) throw new ContextOrderingError(parsed.issues);
    this.#policy = parsed.value;
  }

  /**
   * Orders one allocated batch for rendering.
   *
   * The allocation is a stage contract the earlier stages have already proved,
   * so nothing in it is revalidated, re-counted, re-hashed, or repaired. The
   * supplied set and everything reachable from it are treated as immutable: no
   * decision, block, attribute, metadata object, source document, score, or
   * array is mutated, and `allocation` is returned by reference
   * (INV-ALLOC-004).
   *
   * The result is a permutation of `allocation.included` by construction — a
   * copy of that array, sorted — so every included decision appears exactly
   * once, no excluded decision can appear, and no reason can change
   * (INV-TRACE-001). `optionalEvictionOrder` is carried through untouched; it
   * answers a different question and is not render order.
   */
  order(input: AllocatedCandidateSet): OrderedCandidateSet {
    const orderedIncluded: readonly IncludedCandidateDecision[] = [...input.included].sort((a, b) =>
      compareBlocks(a.candidate.candidate.canonicalBlock, b.candidate.candidate.canonicalBlock),
    );

    return {
      allocation: input,
      orderingPolicyId: this.#policy.policyId,
      orderingPolicyVersion: this.#policy.policyVersion,
      orderedIncluded,
    };
  }
}

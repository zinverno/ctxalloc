import {
  ContextBlockIdSchema,
  ScopeSchema,
  findLoneSurrogate,
  safeParse,
  scopesEqual,
  type ContextBlockId,
  type ValidationIssue,
  type ValidationResult,
} from '@ctxalloc/domain';
import { z } from 'zod';
import type { ScoredCandidate, ScoredCandidateSet } from './candidate-scorer.js';
import type {
  CandidateApplicability,
  CandidateApplicabilityIssueCode,
  ApplicabilityExclusionEvidence,
} from './candidate-applicability.js';

/**
 * Deterministic policy filtering (DEC-036).
 *
 * `CandidateFilter` runs between `CandidateScorer` and `BudgetAllocator`. It
 * turns a `ScoredCandidateSet` into a `FilteredCandidateSet`: every scored
 * candidate receives exactly one eligibility decision, and the candidates that
 * remain eligible are published as a `ScoredCandidateSet` the existing
 * `BudgetAllocator` consumes unchanged.
 *
 * It answers one question: **may this scored optional candidate participate in
 * allocation under policy?** It does not answer which eligible candidates fit —
 * required resolution, category constraints, the token budget, eviction, and
 * final inclusion all remain the allocator's (INV-ALLOC-002, INV-ALLOC-006).
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model, no retrieval provider, and no tokenizer (INV-DET-001,
 * INV-DET-003, INV-DET-004, INV-DEP-002). Its only injected dependency is an
 * explicit versioned filtering policy.
 *
 * Version 1 reads exactly three things: `score.total`, `canonicalBlock.attributes.required`,
 * and its own validated policy. Provider identity, rank, raw provider score,
 * source metadata, source type, category, authored priority, timestamps,
 * `tokenCount`, the token budget, the rendered cost, and the query are all
 * deliberately unreachable from version 1. Every one of them either already fed
 * `CandidateScorer` or belongs to a later stage, and reading one again would put
 * one signal under two owners (INV-DEP-003).
 *
 * It is also not an access-control boundary. Scope isolation stays with request
 * validation and `CandidateValidator`, which reject a cross-scope candidate
 * outright rather than scoring one and then declining to allocate it
 * (INV-SCOPE-003, INV-SCOPE-004, INV-SEC-004).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of `CandidateFilteringPolicy` (INV-STORE-004). */
export const CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION = 1;
/** Opt-in scoped applicability declarations; legacy schema 1 remains unchanged. */
export const APPLICABILITY_FILTERING_POLICY_SCHEMA_VERSION = 2;

/**
 * The complete filtering language of schema version 1: one optional minimum
 * total score.
 *
 * Nothing else is expressible, and the omissions are the decision. Filtering
 * runs after exact deduplication, so the unit it sees is a duplicate group whose
 * members may come from different source documents, carry different categories,
 * and arrive from different providers. "Exclude source X" or "exclude category
 * Y" has no single meaning over such a group, and inventing one silently would
 * make the surviving copy of one piece of content depend on which wrapper the
 * filter happened to inspect (DEC-031, DEC-036).
 *
 * Source, category, recency, authored priority, and retrieval relevance already
 * have one owner: they are configured signals of `CandidateScoringPolicy` and
 * they reach this stage already normalized into `score.total`. Version 1
 * consumes that group-level result and nothing else. A hard exclusion language
 * was deferred in version 1. Opt-in schema 2 now defines the narrow group-wide
 * applicability contract in DEC-044, without interpreting those scoring signals.
 */
interface FilteringPolicyBase {
  readonly policyId: string;
  readonly policyVersion: string;
  /**
   * The inclusive lower bound an optional candidate's `score.total` must reach.
   *
   * Absent means no threshold: every scored candidate stays eligible. The value
   * is policy-relative utility, not a probability — `CandidateScore.total` is a
   * weighted sum whose weights need not sum to one — so a threshold is
   * meaningful only against the scoring policy it is paired with (INV-SCORE-001).
   */
  readonly minimumTotalScore?: number | undefined;
}

/** The original score-only policy remains a distinct closed schema. */
export interface LegacyCandidateFilteringPolicy extends FilteringPolicyBase {
  readonly schemaVersion: typeof CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION;
}

/** DEC-044: explicit applicability is separate from numerical admission. */
export interface ApplicabilityCandidateFilteringPolicy extends FilteringPolicyBase {
  readonly schemaVersion: typeof APPLICABILITY_FILTERING_POLICY_SCHEMA_VERSION;
  readonly applicability: CandidateApplicability;
}

export type CandidateFilteringPolicy =
  LegacyCandidateFilteringPolicy | ApplicabilityCandidateFilteringPolicy;

/**
 * Machine-readable reason for one filtering decision (INV-TRACE-002).
 *
 * `ELIGIBLE_REQUIRED` — the canonical block declares `required: true`, so the
 * threshold never applied.
 * `ELIGIBLE_POLICY` — an optional candidate the policy admits, either because no
 * threshold is configured or because its total reached the configured one.
 * `FILTERED_SCORE_BELOW_MINIMUM` — an optional candidate whose total is strictly
 * below the configured minimum.
 */
export type CandidateFilteringDecisionReason =
  | 'ELIGIBLE_REQUIRED'
  | 'ELIGIBLE_POLICY'
  | 'FILTERED_SCORE_BELOW_MINIMUM'
  | ApplicabilityExclusionEvidence['reason'];

/**
 * A required candidate, admitted without consulting its score.
 *
 * It carries no `scoreTotal` and no `minimumTotalScore`, because neither took
 * part in the decision: required blocks are a separate allocation class, not a
 * large score, and publishing the numbers here would suggest a comparison this
 * stage deliberately never made (INV-SCORE-003, INV-BUDGET-003). The score stays
 * reachable through `candidate.score`.
 */
export interface RequiredEligibleCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'eligible';
  readonly reason: 'ELIGIBLE_REQUIRED';
}

/**
 * An optional candidate the policy admits, with the exact evidence that admitted
 * it.
 *
 * `minimumTotalScore` is present exactly when the policy configured one, so a
 * consumer can tell a candidate that passed a threshold apart from one that
 * faced no threshold at all, without re-reading the policy.
 */
export interface PolicyEligibleCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'eligible';
  readonly reason: 'ELIGIBLE_POLICY';
  readonly scoreTotal: number;
  readonly minimumTotalScore?: number;
}

/** An optional candidate the threshold excluded, with both exact operands. */
export interface FilteredCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'filtered';
  readonly reason: 'FILTERED_SCORE_BELOW_MINIMUM';
  readonly scoreTotal: number;
  readonly minimumTotalScore: number;
}

/**
 * The one decision every scored candidate receives (INV-TRACE-001).
 *
 * The union is discriminated on `decision` and on `reason` together, so an
 * impossible combination — a filtered candidate claiming `ELIGIBLE_REQUIRED`, a
 * required candidate carrying a threshold it never faced, a filtered decision
 * with no minimum to be below — cannot be constructed.
 */
export interface ApplicabilityFilteredCandidateDecision extends ApplicabilityExclusionEvidence {
  readonly candidate: ScoredCandidate;
  readonly decision: 'filtered';
}

export type CandidateFilteringDecision =
  | RequiredEligibleCandidateDecision
  | PolicyEligibleCandidateDecision
  | FilteredCandidateDecision
  | ApplicabilityFilteredCandidateDecision;

/**
 * The filtered batch: an ephemeral compiler-stage result, never persisted, so it
 * carries no schema version (INV-STORE-004).
 *
 * `scored` is the complete input, carried by reference, and `eligible` is the
 * subset that may proceed. Every input candidate therefore stays reachable
 * through `scored` and appears in exactly one `decisions` entry, whether or not
 * it survived (INV-TRACE-001).
 *
 * `eligible` is a `ScoredCandidateSet` rather than a new stage type on purpose:
 * `BudgetAllocator` consumes it directly, with no change to its API. Its scope,
 * source registry, scoring policy identity and version, and reference time are
 * the input's own values; only `candidates` differs.
 */
export interface FilteredCandidateSet {
  readonly scored: ScoredCandidateSet;
  readonly filteringPolicyId: string;
  readonly filteringPolicyVersion: string;
  readonly eligible: ScoredCandidateSet;
  readonly decisions: readonly CandidateFilteringDecision[];
}

/**
 * Machine-readable categories of a filtering problem.
 *
 * Version 2 also rejects invalid scoped applicability assertions before decisions.
 * Version 1 can fail in one way only: the injected policy is not a valid
 * `CandidateFilteringPolicy`. Version-1 filtering of a valid batch
 * cannot fail — it reads two already-validated values and compares numbers.
 */
export type CandidateFilteringIssueCode = 'invalid_policy' | CandidateApplicabilityIssueCode;

/**
 * The single error this component raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or implementation exception
 * escapes this boundary (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class CandidateFilteringError extends Error {
  readonly code = 'CANDIDATE_FILTERING_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Candidate filtering failed: ${summary}`);
    this.name = 'CandidateFilteringError';
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
 * rejected with the shared domain helper, exactly as the scoring, allocation,
 * ordering, and rendering policies reject it (INV-BLOCK-007).
 */
const policyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * The runtime boundary of this stage.
 *
 * A policy is external configuration: it may have been read from a file, sent
 * over HTTP, or assembled by hand, so compile-time types prove nothing about it
 * (INV-BLOCK-005). Unknown fields are rejected rather than stripped, nothing is
 * coerced, and no default is injected — in particular no default threshold, so
 * "no minimum" is always something a policy stated by omission rather than
 * something this stage invented.
 *
 * A negative minimum is rejected. `CandidateScore.total` is a sum of
 * non-negative weighted contributions, so it is never below zero, and a negative
 * threshold could only ever be a no-op written by someone who believed it did
 * something.
 */
const LegacyFilteringPolicySchema = z.strictObject({
  schemaVersion: z.literal(CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  minimumTotalScore: z
    .number()
    .refine((value) => Number.isFinite(value) && value >= 0, {
      message: 'must be a finite number greater than or equal to 0',
    })
    .optional(),
});

/** Internal schema: callers enter through the filtering policy validator. */
const CandidateApplicabilitySchema = z.strictObject({
  scope: ScopeSchema,
  exclusions: z
    .array(
      z.strictObject({
        blockId: ContextBlockIdSchema,
        reason: z.enum(['inapplicable', 'superseded']),
      }),
    )
    .superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.blockId))
          ctx.addIssue({
            code: 'custom',
            path: [index, 'blockId'],
            message: 'must not repeat an exclusion target',
          });
        seen.add(entry.blockId);
      });
    }),
});

const CandidateFilteringPolicySchema = z.discriminatedUnion('schemaVersion', [
  LegacyFilteringPolicySchema,
  LegacyFilteringPolicySchema.extend({
    schemaVersion: z.literal(APPLICABILITY_FILTERING_POLICY_SCHEMA_VERSION),
    applicability: CandidateApplicabilitySchema,
  }),
]);

/**
 * Validates one filtering policy and returns it, or the structured issues that
 * rejected it.
 *
 * The helper exists so that the broad `CompilationPolicy` validates its
 * filtering slice through exactly the rules this stage enforces, rather than
 * through a second copy of them that could drift (INV-DEP-003). It is internal
 * to the compiler kernel: the package entry point never re-exports it, and no
 * public declaration names it (INV-ADAPTER-001).
 */
export function parseCandidateFilteringPolicy(
  policy: unknown,
): ValidationResult<CandidateFilteringPolicy> {
  const parsed = safeParse(CandidateFilteringPolicySchema, policy);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: parsed.issues.map((issue) => ({
        ...issue,
        code: 'invalid_policy' satisfies CandidateFilteringIssueCode,
      })),
    };
  }
  return { ok: true, value: parsed.value };
}

function applicabilityIssue(
  code: CandidateApplicabilityIssueCode,
  message: string,
): ValidationIssue {
  return { code, path: ['applicability'], pointer: 'applicability', message };
}

/**
 * Resolve group assertions after full candidate validation and exact deduplication.
 * No member disappears, no required flag is rewritten, and no replacement graph
 * is traversed. Reject the complete batch on ambiguity before issuing decisions.
 */
function resolveApplicability(
  policy: CandidateApplicability,
  input: ScoredCandidateSet,
): ValidationResult<ReadonlyMap<string, ApplicabilityExclusionEvidence>> {
  if (!scopesEqual(policy.scope, input.scope))
    return {
      ok: false,
      issues: [
        applicabilityIssue(
          'applicability_scope_mismatch',
          'applicability scope must equal the request scope',
        ),
      ],
    };
  const groups = new Map<string, { id: ContextBlockId; required: boolean }>();
  for (const group of input.candidates) {
    const summary = {
      id: group.candidate.canonicalBlock.id,
      required: group.candidate.members.some(
        (member) => member.candidate.block.attributes.required === true,
      ),
    };
    for (const member of group.candidate.members) groups.set(member.candidate.block.id, summary);
  }
  // These arrays are owned here. Append once per declaration instead of copying
  // the entire growing group for each member of a large duplicate set.
  const resolved = new Map<
    string,
    { reason: ApplicabilityExclusionEvidence['reason']; declaredBlockIds: ContextBlockId[] }
  >();
  const issues: ValidationIssue[] = [];
  // Sort only the owned traversal; policy and scored order remain untouched.
  const entries = [...policy.exclusions].sort((a, b) =>
    a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0,
  );
  for (const entry of entries) {
    const group = groups.get(entry.blockId);
    if (group === undefined) {
      issues.push(
        applicabilityIssue(
          'missing_applicability_target',
          'every exclusion target must belong to the validated candidate batch',
        ),
      );
      continue;
    }
    if (group.required) {
      issues.push(
        applicabilityIssue(
          'required_applicability_conflict',
          'an applicability exclusion must not address a group with a required member',
        ),
      );
      continue;
    }
    const id = group.id;
    const reason =
      entry.reason === 'inapplicable' ? 'FILTERED_INAPPLICABLE' : 'FILTERED_SUPERSEDED';
    const previous = resolved.get(id);
    if (previous !== undefined && previous.reason !== reason) {
      issues.push(
        applicabilityIssue(
          'conflicting_applicability_declarations',
          'one duplicate group must not receive different applicability reasons',
        ),
      );
      continue;
    }
    if (previous === undefined) resolved.set(id, { reason, declaredBlockIds: [entry.blockId] });
    else previous.declaredBlockIds.push(entry.blockId);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: resolved };
}

/* -------------------------------------------------------------------------- */
/* Filter                                                                      */
/* -------------------------------------------------------------------------- */

export class CandidateFilter {
  readonly #policy: CandidateFilteringPolicy;

  /**
   * Validates the filtering policy.
   *
   * @throws {CandidateFilteringError} when the policy is not valid.
   */
  constructor(policy: unknown) {
    const parsed = parseCandidateFilteringPolicy(policy);
    if (!parsed.ok) throw new CandidateFilteringError(parsed.issues);
    this.#policy = parsed.value;
  }

  /**
   * Decides eligibility for one scored batch.
   *
   * The scored set is a stage contract the earlier stages have already proved,
   * so nothing in it is revalidated, re-counted, re-hashed, re-scored, or
   * repaired. The supplied set and everything reachable from it are treated as
   * immutable: no group, block, attribute, metadata object, retrieval record,
   * source document, score, or array is mutated, the input is returned as
   * `scored` by reference, and every surviving `ScoredCandidate` is reused by
   * reference rather than copied (INV-ALLOC-004).
   *
   * This is a stable filter, not a re-ranker. `CandidateScorer` owns the ranking
   * (DEC-032), so the survivors keep their relative input order and `decisions`
   * follows the input order too: nothing is sorted here, and the scorer's
   * comparator is not duplicated (INV-DET-002, INV-DET-005).
   *
   * Version 1 cannot fail here. Version 2 rejects inconsistent applicability
   * assertions before producing any result (DEC-044).
   */
  filter(input: ScoredCandidateSet): FilteredCandidateSet {
    const applicability =
      this.#policy.schemaVersion === APPLICABILITY_FILTERING_POLICY_SCHEMA_VERSION
        ? resolveApplicability(this.#policy.applicability, input)
        : { ok: true as const, value: new Map<string, ApplicabilityExclusionEvidence>() };
    if (!applicability.ok) throw new CandidateFilteringError(applicability.issues);
    const decisions: readonly CandidateFilteringDecision[] = input.candidates.map((candidate) => {
      const exclusion = applicability.value.get(candidate.candidate.canonicalBlock.id);
      return exclusion === undefined
        ? this.#decide(candidate)
        : { candidate, decision: 'filtered', ...exclusion };
    });
    const eligible: readonly ScoredCandidate[] = decisions
      .filter((decision) => decision.decision === 'eligible')
      .map((decision) => decision.candidate);

    return {
      scored: input,
      filteringPolicyId: this.#policy.policyId,
      filteringPolicyVersion: this.#policy.policyVersion,
      // Every field but `candidates` is restated from the input rather than
      // spread, so a future field added to `ScoredCandidateSet` becomes a
      // compile error here instead of being carried across a stage boundary
      // nobody re-examined.
      eligible: {
        scope: input.scope,
        sourceDocuments: input.sourceDocuments,
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        referenceTime: input.referenceTime,
        candidates: eligible,
      },
      decisions,
    };
  }

  /**
   * Decides one candidate.
   *
   * Required status is checked first and unconditionally. A required block that
   * scored exactly zero under a threshold of one thousand stays eligible: it is
   * a separate allocation class, and a policy threshold is not permitted to
   * remove it, fail it, or silently raise its score (INV-BUDGET-003,
   * INV-SCORE-003). Whether the required content actually fits remains the
   * allocator's question (INV-BUDGET-004).
   *
   * The comparison itself is `>=` on the exact `score.total`, with no rounding,
   * clamping, normalization, probability interpretation, or score-per-token
   * arithmetic. Equality survives: a candidate that reaches the minimum has met
   * it.
   */
  #decide(candidate: ScoredCandidate): CandidateFilteringDecision {
    if (candidate.candidate.canonicalBlock.attributes.required === true) {
      return { candidate, decision: 'eligible', reason: 'ELIGIBLE_REQUIRED' };
    }

    const scoreTotal = candidate.score.total;
    const minimumTotalScore = this.#policy.minimumTotalScore;
    if (minimumTotalScore === undefined) {
      return { candidate, decision: 'eligible', reason: 'ELIGIBLE_POLICY', scoreTotal };
    }
    if (scoreTotal >= minimumTotalScore) {
      return {
        candidate,
        decision: 'eligible',
        reason: 'ELIGIBLE_POLICY',
        scoreTotal,
        minimumTotalScore,
      };
    }
    return {
      candidate,
      decision: 'filtered',
      reason: 'FILTERED_SCORE_BELOW_MINIMUM',
      scoreTotal,
      minimumTotalScore,
    };
  }
}

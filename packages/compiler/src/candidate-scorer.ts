import {
  SourceDocumentIdSchema,
  TimestampSchema,
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type ContextBlockId,
  type Scope,
  type SourceDocument,
  type SourceDocumentId,
  type Timestamp,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import type { DeduplicatedCandidate, DeduplicatedCandidateSet } from './candidate-deduplicator.js';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * Deterministic candidate scoring (DEC-032).
 *
 * `CandidateScorer` is the third stage of the compiler kernel. It turns a
 * `DeduplicatedCandidateSet` into a `ScoredCandidateSet`: every duplicate group
 * receives one transparent `CandidateScore` built from explicitly configured
 * signals, and the groups are returned in a stable ranking order for the future
 * `BudgetAllocator`.
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model, no retrieval provider, and no tokenizer (INV-DET-001,
 * INV-DET-003, INV-DET-004, INV-DEP-002). Its only injected dependency is an
 * explicit versioned scoring policy, and time reaches it only as an explicit
 * `referenceTime` argument.
 *
 * What it deliberately does not do: it does not retrieve candidates, revalidate
 * them, re-count tokens, re-hash content, deduplicate them, filter them by
 * policy, read a token budget, decide inclusion or exclusion, evict anything,
 * resolve required blocks, order for rendering, render, or build a trace. Every
 * deduplicated candidate that enters appears exactly once in the result unless
 * scoring fails as a whole.
 *
 * The score is an input to allocation, not an inclusion decision, and it is a
 * policy-relative utility rather than a probability: weights need not sum to one,
 * so a total is comparable only against other totals produced in the same run by
 * the same `policyId` and `policyVersion`.
 */

/* -------------------------------------------------------------------------- */
/* Public contract: policy                                                     */
/* -------------------------------------------------------------------------- */

/** Current schema version of `CandidateScoringPolicy`. */
export const CANDIDATE_SCORING_POLICY_SCHEMA_VERSION = 1;

/**
 * How one provider's raw score is mapped onto the comparable `[0, 1]` scale.
 *
 * A rule owns exactly one provider contract, identified by the tuple
 * `providerId`, `providerVersion`, `semantics`, `higherIsBetter`. Raw values from
 * two different contracts are never comparable — a cosine similarity rises with
 * relevance while a vector distance falls, a BM25 score has its own unbounded
 * positive scale, and a provider version may redefine any of them — so a raw
 * value participates in scoring only when a rule states its meaning
 * (INV-SCORE-002).
 *
 * `min` and `max` are the inclusive bounds of the provider's documented range.
 * They are fixed policy input and are never inferred from the candidates in the
 * batch: a batch-relative range would make one candidate's score change when an
 * unrelated candidate is added or removed, which would make compilation depend
 * on retrieval result composition (INV-DET-001).
 */
export interface RetrievalNormalizationRule {
  readonly ruleId: string;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
  readonly min: number;
  readonly max: number;
}

/** The retrieval relevance component of the scoring policy. */
export interface RetrievalScoringPolicy {
  readonly weight: number;
  readonly aggregation: ScoreAggregation;
  readonly rules: readonly RetrievalNormalizationRule[];
}

/**
 * The authored-priority component of the scoring policy.
 *
 * `ContextBlock.attributes.priority` is query-independent authored data that
 * DEC-030 deliberately left without a semantic range. This component is where
 * that range is stated, and it is stated per policy: the inclusive safe-integer
 * interval `[min, max]` the authors of the content actually use.
 */
export interface AuthoredPriorityScoringPolicy {
  readonly weight: number;
  readonly min: number;
  readonly max: number;
}

/** One exact `SourceDocument.id` to normalized-value rule. */
export interface SourcePriorityRule {
  readonly sourceDocumentId: SourceDocumentId;
  readonly value: number;
}

/** The source-priority component of the scoring policy. */
export interface SourcePriorityScoringPolicy {
  readonly weight: number;
  readonly defaultValue: number;
  readonly bySourceDocumentId: readonly SourcePriorityRule[];
}

/** One exact `ContextBlock.attributes.category` to normalized-value rule. */
export interface CategoryPriorityRule {
  readonly category: string;
  readonly value: number;
}

/** The category-priority component of the scoring policy. */
export interface CategoryPriorityScoringPolicy {
  readonly weight: number;
  readonly defaultValue: number;
  readonly byCategory: readonly CategoryPriorityRule[];
}

/**
 * The recency component of the scoring policy.
 *
 * `maxAgeSeconds` is the age at which a block's recency value reaches zero.
 * `missingValue` is the explicit normalized value of a block that carries no
 * timestamp at all, so absent time data has a stated meaning rather than an
 * assumed one.
 */
export interface RecencyScoringPolicy {
  readonly weight: number;
  readonly maxAgeSeconds: number;
  readonly missingValue: number;
}

/**
 * One narrow versioned scoring policy, owned by this compiler stage.
 *
 * This is deliberately not the broad future `CompilationPolicy` described in
 * ARCHITECTURE 5.6, which also covers filtering, allocation, ordering, and
 * rendering. Only the scoring slice exists, because only the scoring stage
 * exists; a later `CompilationPolicy` may contain or reference this object
 * without changing what `CandidateScorer` means by it.
 *
 * Every component is optional. A policy that configures none of them is valid
 * and gives every candidate a total of exactly `0`, which leaves the stable block
 * identifier deciding the output order.
 *
 * The optional members are declared as "absent or explicitly `undefined`"
 * because a policy is external configuration parsed at a runtime boundary, and a
 * caller that spells an unused component as `undefined` describes the same
 * policy as one that omits the key.
 */
export interface CandidateScoringPolicy {
  readonly schemaVersion: typeof CANDIDATE_SCORING_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly retrieval?: RetrievalScoringPolicy | undefined;
  readonly authoredPriority?: AuthoredPriorityScoringPolicy | undefined;
  readonly sourcePriority?: SourcePriorityScoringPolicy | undefined;
  readonly categoryPriority?: CategoryPriorityScoringPolicy | undefined;
  readonly recency?: RecencyScoringPolicy | undefined;
}

/* -------------------------------------------------------------------------- */
/* Public contract: score components                                           */
/* -------------------------------------------------------------------------- */

/**
 * How one component combines the evidence of a duplicate group.
 *
 * `max` is the only rule in schema version 1. Phase 8 preserves every duplicate
 * wrapper as evidence, so a group can hold the same content many times over;
 * summing, averaging, or counting that evidence would turn "retrieved twice" into
 * "twice as useful", which it is not. The strongest normalized signal in the
 * group is the group's signal.
 */
export type ScoreAggregation = 'max';

/** Whether a policy lookup found an exact rule or fell back to the policy default. */
export type PolicyValueSource = 'configured' | 'policy-default';

/** Whether a block's recency came from its own timestamp or from the policy. */
export type RecencyValueSource = 'timestamp' | 'policy-missing-value';

/** Which timestamp field supplied a block's recency evidence. */
export type RecencyTimestampField = 'updatedAt' | 'createdAt';

/**
 * One normalized provider score, with the raw value and the rule that mapped it.
 *
 * The wrapper itself is not repeated here: `DeduplicatedCandidate.members` still
 * holds every `CandidateBlock` whole, so evidence carries identity rather than a
 * second copy of the record (INV-DEDUP-003).
 */
export interface RetrievalScoreEvidence {
  readonly blockId: ContextBlockId;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
  readonly rawValue: number;
  readonly normalizedValue: number;
  readonly ruleId: string;
}

/** The retrieval relevance component of one candidate's score. */
export interface RetrievalScoreComponent {
  readonly normalizedValue: number;
  readonly weight: number;
  readonly contribution: number;
  readonly aggregation: ScoreAggregation;
  readonly evidence: readonly RetrievalScoreEvidence[];
}

/** One distinct block's authored priority and its normalized value. */
export interface AuthoredPriorityScoreEvidence {
  readonly blockId: ContextBlockId;
  readonly priority: number;
  readonly normalizedValue: number;
}

/** The authored-priority component of one candidate's score. */
export interface AuthoredPriorityScoreComponent {
  readonly normalizedValue: number;
  readonly weight: number;
  readonly contribution: number;
  readonly aggregation: ScoreAggregation;
  readonly min: number;
  readonly max: number;
  readonly evidence: readonly AuthoredPriorityScoreEvidence[];
}

/** One distinct block's source and the policy value that source resolved to. */
export interface SourcePriorityScoreEvidence {
  readonly blockId: ContextBlockId;
  readonly sourceDocumentId: SourceDocumentId;
  readonly value: number;
  readonly valueSource: PolicyValueSource;
}

/** The source-priority component of one candidate's score. */
export interface SourcePriorityScoreComponent {
  readonly normalizedValue: number;
  readonly weight: number;
  readonly contribution: number;
  readonly aggregation: ScoreAggregation;
  readonly defaultValue: number;
  readonly evidence: readonly SourcePriorityScoreEvidence[];
}

/**
 * One distinct block's category and the policy value that category resolved to.
 *
 * `category` is absent when the block declares none, which is different from a
 * block that declares a category the policy does not configure. Both resolve to
 * the policy default, and the evidence keeps them distinguishable.
 */
export interface CategoryPriorityScoreEvidence {
  readonly blockId: ContextBlockId;
  readonly category?: string;
  readonly value: number;
  readonly valueSource: PolicyValueSource;
}

/** The category-priority component of one candidate's score. */
export interface CategoryPriorityScoreComponent {
  readonly normalizedValue: number;
  readonly weight: number;
  readonly contribution: number;
  readonly aggregation: ScoreAggregation;
  readonly defaultValue: number;
  readonly evidence: readonly CategoryPriorityScoreEvidence[];
}

/**
 * One distinct block's age relative to the supplied reference time.
 *
 * `timestamp`, `timestampField`, and `ageSeconds` are absent exactly when the
 * block carries neither `updatedAt` nor `createdAt`; `valueSource` then reports
 * that the policy's `missingValue` decided the result.
 */
export interface RecencyScoreEvidence {
  readonly blockId: ContextBlockId;
  readonly timestamp?: Timestamp;
  readonly timestampField?: RecencyTimestampField;
  readonly ageSeconds?: number;
  readonly normalizedValue: number;
  readonly valueSource: RecencyValueSource;
}

/** The recency component of one candidate's score. */
export interface RecencyScoreComponent {
  readonly normalizedValue: number;
  readonly weight: number;
  readonly contribution: number;
  readonly aggregation: ScoreAggregation;
  readonly maxAgeSeconds: number;
  readonly missingValue: number;
  readonly evidence: readonly RecencyScoreEvidence[];
}

/**
 * The complete score of one deduplicated candidate.
 *
 * A component is present exactly when the policy configures it. `total` is the
 * arithmetic sum of the present components' contributions, taken in the fixed
 * order retrieval, authored priority, source priority, category priority,
 * recency, so the value never depends on object iteration order (INV-DET-002).
 *
 * There is no required component and no required boost. Required blocks are a
 * separate allocation class that the future allocator resolves before optional
 * ones; representing that as a large number would make it a tie-break that a
 * high enough score could win (INV-SCORE-003).
 */
export interface CandidateScore {
  readonly total: number;
  readonly retrieval?: RetrievalScoreComponent;
  readonly authoredPriority?: AuthoredPriorityScoreComponent;
  readonly sourcePriority?: SourcePriorityScoreComponent;
  readonly categoryPriority?: CategoryPriorityScoreComponent;
  readonly recency?: RecencyScoreComponent;
}

/** One deduplicated candidate together with its score. */
export interface ScoredCandidate {
  readonly candidate: DeduplicatedCandidate;
  readonly score: CandidateScore;
}

/**
 * The scored batch: an ephemeral compiler-stage result, never persisted.
 *
 * It carries no schema version for that reason: `schemaVersion` marks persisted
 * domain records so an unsupported stored shape fails clearly (INV-STORE-004),
 * and this structure is produced and consumed inside one compilation.
 *
 * `policyId`, `policyVersion`, and `referenceTime` are copied verbatim from
 * validated input so that a later trace can state exactly which policy and which
 * instant produced these numbers (INV-TRACE-005).
 */
export interface ScoredCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly referenceTime: Timestamp;
  readonly candidates: readonly ScoredCandidate[];
}

/**
 * Machine-readable categories of a candidate scoring problem.
 *
 * Every issue carries one of these instead of a free-text explanation, so a
 * later compiler trace can report a scoring failure without re-deriving meaning
 * from a message (INV-TRACE-002).
 */
export type CandidateScoringIssueCode =
  | 'invalid_policy'
  | 'duplicate_policy_rule'
  | 'duplicate_source_priority'
  | 'duplicate_category_priority'
  | 'invalid_reference_time'
  | 'retrieval_score_rule_not_found'
  | 'retrieval_score_out_of_range'
  | 'authored_priority_out_of_range'
  | 'non_finite_score_result';

/**
 * The single error this component raises, for construction and for scoring
 * alike.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, timestamp parsing error,
 * provider error, or implementation exception escapes this boundary
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class CandidateScoringError extends Error {
  readonly code = 'CANDIDATE_SCORING_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Candidate scoring failed: ${summary}`);
    this.name = 'CandidateScoringError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue construction                                                          */
/* -------------------------------------------------------------------------- */

function issue(code: CandidateScoringIssueCode, path: IssuePath, message: string): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/**
 * Addresses one candidate group and, optionally, something inside it.
 *
 * Groups and blocks are addressed by their stable identifiers rather than by
 * array position, so a permuted input produces a byte-identical issue set
 * (INV-DET-002, INV-ALLOC-005). `path` stays the machine-readable location;
 * `pointer` is its rendering.
 */
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
 * No trimming, lowercasing, or canonicalization is applied, because a provider
 * identity is an opaque value the provider owns and a rewritten one would stop
 * matching the retrieval data it is supposed to describe. Malformed UTF-16 is
 * rejected with the shared domain helper, exactly as `CandidateBlock` rejects it
 * on the retrieval side (INV-BLOCK-007).
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

/** A weight scales a normalized value; it is not itself normalized. */
const weight = z.number().refine((value) => Number.isFinite(value) && value >= 0, {
  message: 'must be a finite number greater than or equal to 0',
});

/** Any value the policy states directly on the normalized scale. */
const normalizedValue = z
  .number()
  .refine((value) => Number.isFinite(value) && value >= 0 && value <= 1, {
    message: 'must be a finite number in [0, 1]',
  });

const finiteNumber = z
  .number()
  .refine((value) => Number.isFinite(value), { message: 'must be a finite number' });

const safeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value), { message: 'must be a safe integer' });

const RetrievalNormalizationRuleSchema = z
  .strictObject({
    ruleId: policyString,
    providerId: policyString,
    providerVersion: policyString,
    semantics: policyString,
    higherIsBetter: z.boolean(),
    min: finiteNumber,
    max: finiteNumber,
  })
  .refine((rule) => rule.min < rule.max, {
    message: 'must be strictly less than max',
    path: ['min'],
  });

const RetrievalScoringPolicySchema = z.strictObject({
  weight,
  // Only `max` exists in schema version 1. The field is required rather than
  // defaulted, so a policy states its aggregation instead of inheriting one, and
  // a future rule cannot silently change the meaning of an existing policy.
  aggregation: z.literal('max'),
  rules: z.array(RetrievalNormalizationRuleSchema),
});

const AuthoredPriorityScoringPolicySchema = z
  .strictObject({ weight, min: safeInteger, max: safeInteger })
  .refine((component) => component.min < component.max, {
    message: 'must be strictly less than max',
    path: ['min'],
  });

const SourcePriorityScoringPolicySchema = z.strictObject({
  weight,
  defaultValue: normalizedValue,
  bySourceDocumentId: z.array(
    z.strictObject({ sourceDocumentId: SourceDocumentIdSchema, value: normalizedValue }),
  ),
});

const CategoryPriorityScoringPolicySchema = z.strictObject({
  weight,
  defaultValue: normalizedValue,
  byCategory: z.array(z.strictObject({ category: categoryString, value: normalizedValue })),
});

const RecencyScoringPolicySchema = z.strictObject({
  weight,
  maxAgeSeconds: z.number().refine((value) => Number.isSafeInteger(value) && value > 0, {
    message: 'must be a positive safe integer',
  }),
  missingValue: normalizedValue,
});

/**
 * The runtime boundary of this stage.
 *
 * A policy is external configuration: it may have been read from a file, sent
 * over HTTP, or assembled by hand, so compile-time types prove nothing about it
 * (INV-BLOCK-005). Unknown fields are rejected rather than stripped, nothing is
 * coerced, and no default is injected: an unsupported or future policy shape must
 * be a visible failure, not a silently reinterpreted one.
 */
const CandidateScoringPolicySchema = z.strictObject({
  schemaVersion: z.literal(CANDIDATE_SCORING_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  retrieval: RetrievalScoringPolicySchema.optional(),
  authoredPriority: AuthoredPriorityScoringPolicySchema.optional(),
  sourcePriority: SourcePriorityScoringPolicySchema.optional(),
  categoryPriority: CategoryPriorityScoringPolicySchema.optional(),
  recency: RecencyScoringPolicySchema.optional(),
});

/* -------------------------------------------------------------------------- */
/* Policy compilation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The exact contract one retrieval rule owns.
 *
 * The key is a canonical serialization of the tuple rather than a joined string,
 * so a separator character inside a provider identity cannot make two different
 * contracts collide.
 */
function retrievalContractKey(
  providerId: string,
  providerVersion: string,
  semantics: string,
  higherIsBetter: boolean,
): string {
  return canonicalJson([providerId, providerVersion, semantics, higherIsBetter]);
}

/**
 * Rejects a policy whose lookups would be ambiguous.
 *
 * Resolving a repeated key by first or last write would make the order of a
 * caller-owned array significant, so two policies that describe the same rules in
 * a different order could score differently (INV-DET-002). The arrays themselves
 * are never sorted or rewritten; only the compiled lookups are derived from them.
 */
function detectPolicyDuplicates(policy: CandidateScoringPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const { retrieval, sourcePriority, categoryPriority } = policy;
  if (retrieval !== undefined) {
    const ruleIds = new Map<string, number>();
    const contracts = new Map<string, number>();
    retrieval.rules.forEach((rule, index) => {
      const firstRuleId = ruleIds.get(rule.ruleId);
      if (firstRuleId === undefined) {
        ruleIds.set(rule.ruleId, index);
      } else {
        issues.push(
          issue(
            'duplicate_policy_rule',
            ['retrieval', 'rules', index, 'ruleId'],
            `rule ID ${quote(rule.ruleId)} is already declared at retrieval.rules[${String(firstRuleId)}]`,
          ),
        );
      }

      const contract = retrievalContractKey(
        rule.providerId,
        rule.providerVersion,
        rule.semantics,
        rule.higherIsBetter,
      );
      const firstContract = contracts.get(contract);
      if (firstContract === undefined) {
        contracts.set(contract, index);
      } else {
        issues.push(
          issue(
            'duplicate_policy_rule',
            ['retrieval', 'rules', index],
            `the retrieval contract (providerId ${quote(rule.providerId)}, providerVersion ${quote(rule.providerVersion)}, semantics ${quote(rule.semantics)}, higherIsBetter ${String(rule.higherIsBetter)}) is already owned by retrieval.rules[${String(firstContract)}]`,
          ),
        );
      }
    });
  }

  if (sourcePriority !== undefined) {
    const seen = new Map<string, number>();
    sourcePriority.bySourceDocumentId.forEach((rule, index) => {
      const first = seen.get(rule.sourceDocumentId);
      if (first === undefined) {
        seen.set(rule.sourceDocumentId, index);
      } else {
        issues.push(
          issue(
            'duplicate_source_priority',
            ['sourcePriority', 'bySourceDocumentId', index, 'sourceDocumentId'],
            `source document ID ${quote(rule.sourceDocumentId)} is already declared at sourcePriority.bySourceDocumentId[${String(first)}]`,
          ),
        );
      }
    });
  }

  if (categoryPriority !== undefined) {
    const seen = new Map<string, number>();
    categoryPriority.byCategory.forEach((rule, index) => {
      const first = seen.get(rule.category);
      if (first === undefined) {
        seen.set(rule.category, index);
      } else {
        issues.push(
          issue(
            'duplicate_category_priority',
            ['categoryPriority', 'byCategory', index, 'category'],
            `category ${quote(rule.category)} is already declared at categoryPriority.byCategory[${String(first)}]`,
          ),
        );
      }
    });
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Timestamps                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The runtime boundary for the one time value this stage accepts.
 *
 * The reference time is wrapped in a record so that a rejected value is
 * addressed as `referenceTime` by the same path machinery every other issue
 * uses, and so that the parsed value keeps the domain's branded `Timestamp`
 * type rather than widening to a plain string.
 */
const ReferenceTimeSchema = z.strictObject({ referenceTime: TimestampSchema });

const ISO_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * Converts one validated ISO 8601 UTC timestamp into epoch seconds.
 *
 * The result depends only on the supplied string. `Date.UTC` is transient
 * arithmetic over parsed components, exactly as the domain's own timestamp
 * validation uses it: no clock is read, no `Date` instance is retained, and none
 * is exposed (INV-DET-004).
 *
 * `Date.parse` is deliberately not used. The ECMAScript Date Time String Format
 * fixes only three fractional digits, so an engine's handling of the further
 * digits `TimestampSchema` accepts is implementation-defined, and a compiler
 * decision must not differ between runtimes.
 *
 * The whole-second value is an exact multiple of 1000 milliseconds, so the
 * division is exact for every instant the schema admits, and any sub-second part
 * is added as a fraction below one.
 */
function epochSecondsOf(timestamp: string): number {
  const match = ISO_UTC_TIMESTAMP.exec(timestamp);
  const [year, month, day, hour, minute, second] = [
    match?.[1],
    match?.[2],
    match?.[3],
    match?.[4],
    match?.[5],
    match?.[6],
  ];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    // Unreachable: every timestamp reaching this function has already been
    // parsed by `TimestampSchema`, on the reference time here and on every block
    // timestamp in `CandidateValidator` (DEC-030).
    throw new Error('unreachable: a validated timestamp always matches the ISO UTC pattern');
  }

  const milliseconds = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const fraction = match?.[7];
  return milliseconds / 1000 + (fraction === undefined ? 0 : Number(`0.${fraction}`));
}

/* -------------------------------------------------------------------------- */
/* Numeric rules                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Maps negative zero onto positive zero.
 *
 * `-0` compares equal to `0` but serializes, prints, and deep-equals differently,
 * so publishing one would make two runs that computed the same value look
 * different (INV-DET-001). Every number this stage publishes passes through here.
 */
function canonicalNumber(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * The strongest normalized signal in a group, or zero when there is none.
 *
 * Every value reaching this function is normalized to `[0, 1]`, so a zero seed
 * can never win over real evidence, and a configured component with no usable
 * evidence contributes exactly zero.
 */
function maxNormalized(values: readonly number[]): number {
  let maximum = 0;
  for (const value of values) {
    if (value > maximum) maximum = value;
  }
  return canonicalNumber(maximum);
}

/**
 * Maps one finite value onto `[0, 1]` across a strictly ordered finite range.
 *
 * The caller has already proved `min < max` and `min <= raw <= max`, so the
 * result is mathematically in `[0, 1]`. Reaching it in double precision needs
 * one extra step, because `max - min` can overflow even when `min`, `max`, and
 * `raw` are all finite.
 *
 * The plain formula is wrong rather than merely imprecise in that case. For
 * `[-MAX_VALUE, MAX_VALUE]` and `raw = 0` the span becomes `Infinity`, the
 * numerator stays `MAX_VALUE`, and the quotient is exactly `0` — a finite,
 * confidently published, mathematically wrong answer of `0` where `0.5` is
 * correct. A finiteness check cannot catch that, because `0` is finite.
 *
 * Dividing every operand by the largest magnitude involved first keeps the
 * ratio identical while bringing the span back inside the double range: the
 * scaled bounds land in `[-1, 1]`, so the scaled span is at most `2`. The scale
 * is positive because `min < max` forces at least one non-zero bound, and the
 * scaled span cannot underflow to zero because an overflowing span is itself
 * larger than `MAX_VALUE`.
 *
 * Ordinary ranges take the direct path and are bit-for-bit unchanged. No value
 * is clamped, rounded, or formatted through a string (DEC-032).
 */
function normalizeInRange(
  rawValue: number,
  min: number,
  max: number,
  higherIsBetter: boolean,
): number {
  const span = max - min;
  if (Number.isFinite(span)) {
    return higherIsBetter ? (rawValue - min) / span : (max - rawValue) / span;
  }

  const scale = Math.max(Math.abs(min), Math.abs(max), Math.abs(rawValue));
  const scaledMin = min / scale;
  const scaledMax = max / scale;
  const scaledRaw = rawValue / scale;
  const scaledSpan = scaledMax - scaledMin;
  return higherIsBetter
    ? (scaledRaw - scaledMin) / scaledSpan
    : (scaledMax - scaledRaw) / scaledSpan;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareBooleans(a: boolean, b: boolean): number {
  return compareNumbers(Number(a), Number(b));
}

/* -------------------------------------------------------------------------- */
/* Group evidence                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The distinct `ContextBlock` records of one duplicate group, in stable order.
 *
 * A group may hold one block many times over: Phase 8 preserves every wrapper,
 * and one provider can return one block repeatedly while another returns it
 * again. A query-independent authored value must be counted once per block, not
 * once per wrapper, or duplicate retrieval would inflate authored, source,
 * category, and recency evidence alike.
 *
 * The canonical block is included even if no member happens to carry it. Phase 8
 * always selects it from the group's own members, so that case does not arise in
 * the pipeline; a stage contract is not a runtime boundary, and ignoring the
 * block the group is named after would be a silent hole.
 */
function distinctBlocksOf(group: DeduplicatedCandidate): readonly ContextBlock[] {
  const byId = new Map<string, ContextBlock>();
  for (const member of group.members) {
    const { block } = member.candidate;
    if (!byId.has(block.id)) byId.set(block.id, block);
  }
  if (!byId.has(group.canonicalBlock.id)) byId.set(group.canonicalBlock.id, group.canonicalBlock);
  return [...byId.values()].sort((a, b) => compareCodeUnits(a.id, b.id));
}

/** One member's retrieval score, lifted out of its wrapper for ordering. */
interface RetrievalEntry {
  readonly blockId: ContextBlockId;
  readonly providerId: string;
  readonly providerVersion: string;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
  readonly rawValue: number;
  /** Canonical serialization of the whole wrapper, the final tie-breaker. */
  readonly wrapperKey: string;
}

/**
 * Every scored retrieval record in one group, in stable order.
 *
 * A member with no retrieval data, or with retrieval data carrying no score,
 * contributes no relevance evidence: a rank is the provider's own position and a
 * provider identity is not a measurement, so neither is treated as relevance
 * (INV-PROV-003).
 *
 * The order depends only on the records themselves, never on member position, so
 * a permuted input yields the same evidence array and the same issue set
 * (INV-DET-002, INV-DET-005).
 */
function scoredRetrievalsOf(group: DeduplicatedCandidate): readonly RetrievalEntry[] {
  const entries: RetrievalEntry[] = [];
  for (const member of group.members) {
    const { retrieval } = member.candidate;
    if (retrieval?.score === undefined) continue;
    entries.push({
      blockId: member.candidate.block.id,
      providerId: retrieval.providerId,
      providerVersion: retrieval.providerVersion,
      semantics: retrieval.score.semantics,
      higherIsBetter: retrieval.score.higherIsBetter,
      rawValue: retrieval.score.value,
      wrapperKey: canonicalJson(member.candidate),
    });
  }

  return entries.sort(
    (a, b) =>
      compareCodeUnits(a.blockId, b.blockId) ||
      compareCodeUnits(a.providerId, b.providerId) ||
      compareCodeUnits(a.providerVersion, b.providerVersion) ||
      compareCodeUnits(a.semantics, b.semantics) ||
      compareBooleans(a.higherIsBetter, b.higherIsBetter) ||
      compareNumbers(a.rawValue, b.rawValue) ||
      compareCodeUnits(a.wrapperKey, b.wrapperKey),
  );
}

/* -------------------------------------------------------------------------- */
/* Scorer                                                                      */
/* -------------------------------------------------------------------------- */

/** One component's normalized value, ready to be weighted. */
interface ComponentResult<TComponent> {
  readonly component: TComponent;
  readonly contribution: number;
}

export class CandidateScorer {
  readonly #policy: CandidateScoringPolicy;
  readonly #retrievalRules: ReadonlyMap<string, RetrievalNormalizationRule>;
  readonly #sourcePriorityValues: ReadonlyMap<string, number>;
  readonly #categoryPriorityValues: ReadonlyMap<string, number>;

  /**
   * Validates the scoring policy and compiles its lookups.
   *
   * The lookups are built only after validation has proved every key unique, so
   * no rule can be shadowed and no array order can decide which rule applies
   * (INV-DET-002).
   *
   * @throws {CandidateScoringError} when the policy is not valid.
   */
  constructor(policy: unknown) {
    const parsed = safeParse(CandidateScoringPolicySchema, policy);
    if (!parsed.ok) {
      // A policy whose shape is unsupported gets schema issues only: the
      // duplicate-key rules below read fields the schema has not established, so
      // running them over unparsed configuration could only guess.
      throw new CandidateScoringError(
        parsed.issues.map((parsedIssue) => ({ ...parsedIssue, code: 'invalid_policy' })),
      );
    }

    const validated: CandidateScoringPolicy = parsed.value;
    const duplicates = detectPolicyDuplicates(validated);
    if (duplicates.length > 0) throw new CandidateScoringError(duplicates);

    this.#policy = validated;
    this.#retrievalRules = new Map(
      (validated.retrieval?.rules ?? []).map((rule) => [
        retrievalContractKey(
          rule.providerId,
          rule.providerVersion,
          rule.semantics,
          rule.higherIsBetter,
        ),
        rule,
      ]),
    );
    this.#sourcePriorityValues = new Map(
      (validated.sourcePriority?.bySourceDocumentId ?? []).map((rule) => [
        rule.sourceDocumentId,
        rule.value,
      ]),
    );
    this.#categoryPriorityValues = new Map(
      (validated.categoryPriority?.byCategory ?? []).map((rule) => [rule.category, rule.value]),
    );
  }

  /**
   * Scores one deduplicated batch, all or nothing.
   *
   * `referenceTime` is the only time input. It is validated with the project
   * `Timestamp` contract before anything reads it, and an invalid value fails
   * immediately, because every recency value and the returned `referenceTime`
   * field would otherwise describe an instant that does not exist.
   *
   * Once the policy and the reference time are valid, every safely discoverable
   * scoring problem in the batch is collected before failing, so one call reports
   * the whole batch rather than its first defect. On any problem no partial
   * result is returned: nothing is clamped, repaired, or dropped, and no
   * candidate is scored on repaired data.
   *
   * The supplied set and everything reachable from it are treated as immutable.
   * No group, block, attribute, metadata object, retrieval record, source
   * document, or array is mutated, and the result reuses those records by
   * reference (INV-ALLOC-004).
   *
   * Every candidate that enters appears exactly once in the result. This stage
   * excludes nothing: a zero score, a missing category, a low source priority,
   * old content, absent retrieval data, a poor provider rank, and a negative
   * authored priority are all scored, never filtered (INV-ALLOC-002).
   *
   * @throws {CandidateScoringError} when the reference time or the batch is not valid.
   */
  score(input: DeduplicatedCandidateSet, referenceTime: unknown): ScoredCandidateSet {
    const parsedTime = safeParse(ReferenceTimeSchema, { referenceTime });
    if (!parsedTime.ok) {
      throw new CandidateScoringError(
        parsedTime.issues.map((parsedIssue) => ({
          ...parsedIssue,
          code: 'invalid_reference_time',
        })),
      );
    }
    const validatedTime: Timestamp = parsedTime.value.referenceTime;
    const referenceEpochSeconds = epochSecondsOf(validatedTime);

    // Traversal order is canonical, so the collected issues and the evidence
    // arrays never depend on the order the previous stage happened to produce.
    // The canonical block's serialization completes the order for a caller that
    // bypassed the pipeline and supplied two groups with one canonical ID.
    const groups = [...input.candidates].sort(
      (a, b) =>
        compareCodeUnits(a.canonicalBlock.id, b.canonicalBlock.id) ||
        compareCodeUnits(canonicalJson(a.canonicalBlock), canonicalJson(b.canonicalBlock)),
    );

    const issues: ValidationIssue[] = [];
    const scored: ScoredCandidate[] = groups.map((group) => ({
      candidate: group,
      score: this.#scoreGroup(group, referenceEpochSeconds, issues),
    }));

    if (issues.length > 0) throw new CandidateScoringError(issues);

    // Ranking is by total descending, then by the stable block identifier
    // ascending (INV-DET-005). Required status deliberately plays no part: it is
    // an allocation class the future allocator resolves separately, not a
    // position in a utility ranking (INV-SCORE-003, INV-ALLOC-001). The sort is
    // stable over the canonical traversal order above, so the result is a total
    // order even for two groups that tie on both keys.
    const candidates: readonly ScoredCandidate[] = scored.sort(
      (a, b) =>
        compareNumbers(b.score.total, a.score.total) ||
        compareCodeUnits(a.candidate.canonicalBlock.id, b.candidate.canonicalBlock.id),
    );

    return {
      scope: input.scope,
      // The same validated records, in a normalized order. The array is copied
      // before sorting, so the caller's registry is never reordered in place.
      sourceDocuments: [...input.sourceDocuments].sort((a, b) => compareCodeUnits(a.id, b.id)),
      policyId: this.#policy.policyId,
      policyVersion: this.#policy.policyVersion,
      referenceTime: validatedTime,
      candidates,
    };
  }

  /**
   * Builds one candidate's complete score.
   *
   * Components are evaluated and summed in one fixed order — retrieval, authored
   * priority, source priority, category priority, recency — rather than by
   * iterating an object, so the floating-point total is reproducible and never
   * depends on property insertion order (INV-DET-002).
   */
  #scoreGroup(
    group: DeduplicatedCandidate,
    referenceEpochSeconds: number,
    issues: ValidationIssue[],
  ): CandidateScore {
    const canonicalId = group.canonicalBlock.id;
    const blocks = distinctBlocksOf(group);

    const retrieval = this.#scoreRetrieval(group, issues);
    const authoredPriority = this.#scoreAuthoredPriority(canonicalId, blocks, issues);
    const sourcePriority = this.#scoreSourcePriority(blocks);
    const categoryPriority = this.#scoreCategoryPriority(blocks);
    const recency = this.#scoreRecency(blocks, referenceEpochSeconds);

    let total = 0;
    for (const [name, result] of [
      ['retrieval', retrieval],
      ['authoredPriority', authoredPriority],
      ['sourcePriority', sourcePriority],
      ['categoryPriority', categoryPriority],
      ['recency', recency],
    ] as const) {
      if (result === undefined) continue;
      if (!Number.isFinite(result.contribution)) {
        issues.push(
          issue(
            'non_finite_score_result',
            candidatePath(canonicalId, 'score', name, 'contribution'),
            `must be a finite number, calculated ${String(result.contribution)}`,
          ),
        );
        continue;
      }
      total += result.contribution;
    }

    if (!Number.isFinite(total)) {
      issues.push(
        issue(
          'non_finite_score_result',
          candidatePath(canonicalId, 'score', 'total'),
          `must be a finite number, calculated ${String(total)}`,
        ),
      );
    }

    return {
      // A non-finite total has already been recorded as an issue, so the batch
      // is rejected and this placeholder never reaches a caller. It exists only
      // because the components are still assembled before the collected issues
      // are raised.
      total: Number.isFinite(total) ? canonicalNumber(total) : 0,
      ...(retrieval === undefined ? {} : { retrieval: retrieval.component }),
      ...(authoredPriority === undefined ? {} : { authoredPriority: authoredPriority.component }),
      ...(sourcePriority === undefined ? {} : { sourcePriority: sourcePriority.component }),
      ...(categoryPriority === undefined ? {} : { categoryPriority: categoryPriority.component }),
      ...(recency === undefined ? {} : { recency: recency.component }),
    };
  }

  /**
   * Normalizes every configured retrieval score in the group and aggregates them.
   *
   * A raw value participates only when the policy owns an exact rule for its
   * provider, provider version, semantics, and direction. A scored record with no
   * such rule is a failure, not a zero and not a silent drop: treating it as zero
   * would state that the provider found the block irrelevant, and dropping it
   * would hide a policy that no longer covers the retrieval actually in use
   * (INV-SCORE-002, INV-SCORE-004). That holds whether the policy configures no
   * matching rule or no retrieval component at all.
   *
   * Aggregation is `max` over the normalized evidence, so repeating one wrapper
   * twenty times leaves the value exactly where one wrapper left it, and a group
   * that also holds nineteen weaker signals still scores by its strongest.
   */
  #scoreRetrieval(
    group: DeduplicatedCandidate,
    issues: ValidationIssue[],
  ): ComponentResult<RetrievalScoreComponent> | undefined {
    const policy = this.#policy.retrieval;

    // The scored records are inspected even when no retrieval component is
    // configured. An absent component states that this policy weighs no
    // relevance signal; it does not license discarding a provider measurement
    // the batch actually carries. Returning early here would make an
    // identity-only policy the one way to smuggle a scored candidate past the
    // contract every other policy has to satisfy, and the rule lookup below
    // already reports it correctly: `#retrievalRules` is empty in that case, so
    // every scored record is uncovered (DEC-032).
    const canonicalId = group.canonicalBlock.id;
    const evidence: RetrievalScoreEvidence[] = [];

    for (const entry of scoredRetrievalsOf(group)) {
      const at = (...rest: IssuePath): IssuePath =>
        candidatePath(canonicalId, 'members', entry.blockId, 'retrieval', 'score', ...rest);
      const rule = this.#retrievalRules.get(
        retrievalContractKey(
          entry.providerId,
          entry.providerVersion,
          entry.semantics,
          entry.higherIsBetter,
        ),
      );
      if (rule === undefined) {
        issues.push(
          issue(
            'retrieval_score_rule_not_found',
            at(),
            `no retrieval normalization rule is configured for providerId ${quote(entry.providerId)}, providerVersion ${quote(entry.providerVersion)}, semantics ${quote(entry.semantics)}, higherIsBetter ${String(entry.higherIsBetter)}`,
          ),
        );
        continue;
      }

      if (entry.rawValue < rule.min || entry.rawValue > rule.max) {
        issues.push(
          issue(
            'retrieval_score_out_of_range',
            at('value'),
            `must be within the inclusive range [${String(rule.min)}, ${String(rule.max)}] declared by retrieval rule ${quote(rule.ruleId)}, received ${String(entry.rawValue)}`,
          ),
        );
        continue;
      }

      const normalized = normalizeInRange(entry.rawValue, rule.min, rule.max, rule.higherIsBetter);

      // `normalizeInRange` is total over the values that reach it, so this is a
      // backstop rather than an expected path. It stays because a published
      // score feeds every downstream allocation decision, and a non-finite one
      // must fail loudly rather than propagate (INV-SCORE-004).
      if (!Number.isFinite(normalized)) {
        issues.push(
          issue(
            'non_finite_score_result',
            at('value'),
            `normalizing ${String(entry.rawValue)} over the range [${String(rule.min)}, ${String(rule.max)}] declared by retrieval rule ${quote(rule.ruleId)} produced ${String(normalized)}`,
          ),
        );
        continue;
      }

      evidence.push({
        blockId: entry.blockId,
        providerId: entry.providerId,
        providerVersion: entry.providerVersion,
        semantics: entry.semantics,
        higherIsBetter: entry.higherIsBetter,
        rawValue: canonicalNumber(entry.rawValue),
        normalizedValue: canonicalNumber(normalized),
        ruleId: rule.ruleId,
      });
    }

    // No component is published for a policy that configures none: an absent
    // component means the score has no retrieval term, not a term worth zero.
    // Any scored record has already been reported as uncovered above.
    if (policy === undefined) return undefined;

    const normalizedValue = maxNormalized(evidence.map((record) => record.normalizedValue));
    const contribution = canonicalNumber(normalizedValue * policy.weight);
    return {
      component: {
        normalizedValue,
        weight: canonicalNumber(policy.weight),
        contribution,
        aggregation: policy.aggregation,
        evidence,
      },
      contribution,
    };
  }

  /**
   * Normalizes the authored priority of every distinct block in the group.
   *
   * A block that declares no priority contributes no evidence rather than a
   * fabricated midpoint, and a value outside the policy range is a failure rather
   * than a clamped one: clamping would silently reinterpret authored data the
   * policy says it does not describe.
   *
   * `attributes.required` is never read here. Required status is an allocation
   * class, not a priority (INV-SCORE-003).
   */
  #scoreAuthoredPriority(
    canonicalId: string,
    blocks: readonly ContextBlock[],
    issues: ValidationIssue[],
  ): ComponentResult<AuthoredPriorityScoreComponent> | undefined {
    const policy = this.#policy.authoredPriority;
    if (policy === undefined) return undefined;

    const evidence: AuthoredPriorityScoreEvidence[] = [];
    for (const block of blocks) {
      const priority = block.attributes.priority;
      if (priority === undefined) continue;
      if (priority < policy.min || priority > policy.max) {
        issues.push(
          issue(
            'authored_priority_out_of_range',
            candidatePath(canonicalId, 'blocks', block.id, 'attributes', 'priority'),
            `must be within the inclusive range [${String(policy.min)}, ${String(policy.max)}] declared by the authoredPriority scoring policy, received ${String(priority)}`,
          ),
        );
        continue;
      }
      evidence.push({
        blockId: block.id,
        priority: canonicalNumber(priority),
        normalizedValue: canonicalNumber((priority - policy.min) / (policy.max - policy.min)),
      });
    }

    const normalizedValue = maxNormalized(evidence.map((record) => record.normalizedValue));
    const contribution = canonicalNumber(normalizedValue * policy.weight);
    return {
      component: {
        normalizedValue,
        weight: canonicalNumber(policy.weight),
        contribution,
        aggregation: 'max',
        min: policy.min,
        max: policy.max,
        evidence,
      },
      contribution,
    };
  }

  /**
   * Resolves each distinct block's source document against the policy.
   *
   * The lookup is by exact `SourceDocument.id` only. Nothing is inferred from a
   * source type, a path, arbitrary `SourceDocument.metadata`, or which block
   * Phase 8 made canonical: source metadata is untrusted content and must not
   * become compiler policy (INV-SEC-001), and letting the canonical choice decide
   * a score would make deduplication a scoring rule.
   */
  #scoreSourcePriority(
    blocks: readonly ContextBlock[],
  ): ComponentResult<SourcePriorityScoreComponent> | undefined {
    const policy = this.#policy.sourcePriority;
    if (policy === undefined) return undefined;

    const evidence: SourcePriorityScoreEvidence[] = blocks.map((block) => {
      const configured = this.#sourcePriorityValues.get(block.sourceDocumentId);
      return {
        blockId: block.id,
        sourceDocumentId: block.sourceDocumentId,
        value: canonicalNumber(configured ?? policy.defaultValue),
        valueSource: configured === undefined ? 'policy-default' : 'configured',
      };
    });

    const normalizedValue = maxNormalized(evidence.map((record) => record.value));
    const contribution = canonicalNumber(normalizedValue * policy.weight);
    return {
      component: {
        normalizedValue,
        weight: canonicalNumber(policy.weight),
        contribution,
        aggregation: 'max',
        defaultValue: canonicalNumber(policy.defaultValue),
        evidence,
      },
      contribution,
    };
  }

  /**
   * Resolves each distinct block's category against the policy.
   *
   * Matching is exact string equality. Nothing is lowercased, trimmed, tokenized,
   * prefix-matched, pattern-matched, or read as a hierarchy in schema version 1:
   * every one of those is a policy decision that would have to be versioned and
   * tested on its own, and an implicit hierarchy would silently give one category
   * the value of another.
   */
  #scoreCategoryPriority(
    blocks: readonly ContextBlock[],
  ): ComponentResult<CategoryPriorityScoreComponent> | undefined {
    const policy = this.#policy.categoryPriority;
    if (policy === undefined) return undefined;

    const evidence: CategoryPriorityScoreEvidence[] = blocks.map((block) => {
      const { category } = block.attributes;
      const configured =
        category === undefined ? undefined : this.#categoryPriorityValues.get(category);
      return {
        blockId: block.id,
        ...(category === undefined ? {} : { category }),
        value: canonicalNumber(configured ?? policy.defaultValue),
        valueSource: configured === undefined ? 'policy-default' : 'configured',
      };
    });

    const normalizedValue = maxNormalized(evidence.map((record) => record.value));
    const contribution = canonicalNumber(normalizedValue * policy.weight);
    return {
      component: {
        normalizedValue,
        weight: canonicalNumber(policy.weight),
        contribution,
        aggregation: 'max',
        defaultValue: canonicalNumber(policy.defaultValue),
        evidence,
      },
      contribution,
    };
  }

  /**
   * Ages each distinct block against the supplied reference time.
   *
   * `updatedAt` wins over `createdAt` because it describes the content the block
   * currently holds. A block with neither takes the policy's explicit
   * `missingValue`; no `SourceDocument` timestamp is read as a hidden fallback,
   * because a document's own timestamp describes the document, not the block.
   *
   * A future timestamp clamps to age zero rather than producing a value above
   * one: a clock skew upstream must not let a block outrank a genuinely current
   * one.
   */
  #scoreRecency(
    blocks: readonly ContextBlock[],
    referenceEpochSeconds: number,
  ): ComponentResult<RecencyScoreComponent> | undefined {
    const policy = this.#policy.recency;
    if (policy === undefined) return undefined;

    const evidence: RecencyScoreEvidence[] = blocks.map((block) => {
      const timestamp = block.updatedAt ?? block.createdAt;
      if (timestamp === undefined) {
        return {
          blockId: block.id,
          normalizedValue: canonicalNumber(policy.missingValue),
          valueSource: 'policy-missing-value',
        };
      }
      const field: RecencyTimestampField =
        block.updatedAt === undefined ? 'createdAt' : 'updatedAt';
      const ageSeconds = Math.max(0, referenceEpochSeconds - epochSecondsOf(timestamp));
      return {
        blockId: block.id,
        timestamp,
        timestampField: field,
        ageSeconds: canonicalNumber(ageSeconds),
        normalizedValue: canonicalNumber(Math.max(0, 1 - ageSeconds / policy.maxAgeSeconds)),
        valueSource: 'timestamp',
      };
    });

    const normalizedValue = maxNormalized(evidence.map((record) => record.normalizedValue));
    const contribution = canonicalNumber(normalizedValue * policy.weight);
    return {
      component: {
        normalizedValue,
        weight: canonicalNumber(policy.weight),
        contribution,
        aggregation: 'max',
        maxAgeSeconds: policy.maxAgeSeconds,
        missingValue: canonicalNumber(policy.missingValue),
        evidence,
      },
      contribution,
    };
  }
}

import {
  CompilationRequestError,
  CompilationRequestValidator,
  type CompilationRequest,
} from '@ctxalloc/compiler';
import { findLoneSurrogate, safeParse, type ValidationIssue } from '@ctxalloc/domain';
import { z } from 'zod';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';

/**
 * The evaluation case, schema version 1 (DEC-040, METRICS 4).
 *
 * A case is one benchmark question with its answer key: the exact compilation to
 * run, the blocks and facts a correct compilation must preserve, the blocks it
 * should leave out, and — when a model is executed — the deterministic rules the
 * answer is scored against.
 *
 * **The compiler request is embedded whole.** METRICS 4 sketched a case with its
 * own `scope`, `query`, `candidates`, `sourceDocuments`, and `budget` fields.
 * That sketch predates the final contract and is missing `referenceTime` and
 * `policy` outright, so a case built from it could not be compiled at all. It is
 * corrected here rather than reproduced: `compilationRequest` is the exact
 * `CompilationRequest` the compiler validates, so a benchmark case cannot drift
 * from the compiler's own contract and no second, partial request schema exists
 * to keep in step (INV-DEP-003).
 *
 * The two identifiers are separate on purpose. `id` is dataset identity — what a
 * report row is called and how cases are ordered. `compilationRequest.id` is the
 * caller's request identity, which participates in the compilation fingerprint.
 * Forcing them to be equal would make renaming a benchmark case change the
 * compilation it describes.
 *
 * Nothing here is defaulted or coerced. An annotation the case does not state is
 * a metric with no denominator, reported as absent — never as zero, and never as
 * a perfect score (METRICS 9.1).
 */

/** Current schema version of {@link EvaluationCase} (INV-STORE-004). */
export const EVALUATION_CASE_SCHEMA_VERSION = 1;

/** Which split a case belongs to (METRICS 5). */
export type EvaluationDatasetSplit = 'development' | 'validation' | 'regression';

/** Importance of one required fact, and the weight it carries (METRICS 9.3). */
export type EvaluationFactImportance = 'critical' | 'major' | 'minor';

/**
 * Fixed weights for {@link EvaluationFactImportance}, part of schema v1.
 *
 * They are frozen by DEC-040 rather than configurable per run. A weight that
 * moved between runs would make two weighted-coverage numbers incomparable
 * while still printing them under one name.
 */
export const EVALUATION_FACT_WEIGHTS: Readonly<Record<EvaluationFactImportance, number>> =
  Object.freeze({
    critical: 3,
    major: 2,
    minor: 1,
  });

/**
 * One fact the compiled context must still support.
 *
 * **Evidence is OR across groups, AND inside a group.** The METRICS draft
 * modelled evidence as one flat `sourceBlockIds` list, which cannot tell two
 * different situations apart: *either of these two blocks proves the fact* and
 * *these two blocks together prove it*. Both occur in a real benchmark — the
 * second is the whole point of the distributed-facts category — and a flat list
 * silently scores one of them wrong. The shape is corrected before publication
 * rather than after.
 *
 * `acceptableEvidence` is documentation for whoever reads or maintains the case.
 * It is **not** a matching rule: v1 does not search the compiled context or the
 * model's answer for these strings, because substring search over rendered
 * context is a different measurement wearing this one's name (METRICS 9.3).
 */
export interface EvaluationRequiredFact {
  readonly id: string;
  readonly description: string;
  readonly importance: EvaluationFactImportance;

  /**
   * Alternative evidence sets. The fact is preserved when **every** block of at
   * least **one** group is in the final included set.
   */
  readonly evidenceBlockGroups: readonly (readonly string[])[];

  /** Human-readable evidence notes. Never used as a matching rule in v1. */
  readonly acceptableEvidence: readonly string[];
}

/**
 * One deterministic rule an answer is scored against (METRICS 12.1).
 *
 * v1 is rule-based only. LLM-as-judge is deferred: it would make the benchmark's
 * own measurement depend on a model's output, and a quality regression could
 * then be the judge changing its mind rather than the context getting worse
 * (METRICS 12.3).
 *
 * There is no regular expression, no stemming, no fuzzy matching, and no
 * normalization. Each criterion is binary — it earns its whole `weight` or
 * nothing.
 */
export type AnswerCriterion =
  | {
      readonly kind: 'exact';
      readonly id: string;
      readonly weight: number;
      readonly expected: string;
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: 'contains-all';
      readonly id: string;
      readonly weight: number;
      readonly expected: readonly string[];
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: 'contains-any';
      readonly id: string;
      readonly weight: number;
      readonly expected: readonly string[];
      readonly caseSensitive: boolean;
    }
  | {
      readonly kind: 'not-contains';
      readonly id: string;
      readonly weight: number;
      readonly forbidden: readonly string[];
      readonly caseSensitive: boolean;
    };

/**
 * The compilation failure a case expects (METRICS 13.2).
 *
 * A case passes when compilation fails with a `ContextCompilationError` whose
 * stage matches exactly and at least one of whose issues carries the exact
 * code. Additional issues are allowed: a request can be wrong in more than one
 * way, and requiring an exact issue set would make the case brittle against a
 * validator that legitimately reports more.
 */
export interface ExpectedCompilationFailure {
  readonly stage: string;
  readonly issueCode: string;
}

/** One benchmark case. */
export interface EvaluationCase {
  readonly schemaVersion: typeof EVALUATION_CASE_SCHEMA_VERSION;

  readonly id: string;
  readonly datasetSplit: EvaluationDatasetSplit;

  /** The exact request the compiler is given, embedded whole. */
  readonly compilationRequest: CompilationRequest;

  readonly requiredBlockIds: readonly string[];
  readonly requiredFacts: readonly EvaluationRequiredFact[];
  readonly relevantBlockIds: readonly string[];
  readonly irrelevantBlockIds: readonly string[];

  readonly expectedCompilationFailure?: ExpectedCompilationFailure;

  readonly answerCriteria: readonly AnswerCriterion[];

  readonly tags: readonly string[];
}

/** Machine-readable categories of a rejected case (INV-TRACE-002). */
export type EvaluationCaseIssueCode =
  | 'invalid_case'
  | 'invalid_compilation_request'
  | 'duplicate_fact_id'
  | 'duplicate_criterion_id'
  | 'duplicate_evidence_block'
  | 'duplicate_evidence_group'
  | 'unknown_block_id'
  | 'duplicate_annotation_block_id'
  | 'conflicting_annotation';

/**
 * The single error case validation raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * zod error object, `DomainValidationError`, or nested `CompilationRequestError`
 * escapes: a request failure is re-addressed under the `compilationRequest`
 * pointer, keeping its own focused code (INV-ADAPTER-001, INV-ADAPTER-003).
 *
 * No message quotes case content: a benchmark case carries source text, and an
 * error is not a place to reprint it (INV-SEC-001).
 */
export class EvaluationCaseValidationError extends Error {
  readonly code = 'EVALUATION_CASE_INVALID';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Evaluation case is invalid: ${summary}`);
    this.name = 'EvaluationCaseValidationError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue construction                                                          */
/* -------------------------------------------------------------------------- */

type IssuePath = readonly (string | number)[];

function pointerFor(path: IssuePath): string {
  return path.reduce<string>((pointer, segment) => {
    if (typeof segment === 'number') return `${pointer}[${String(segment)}]`;
    return pointer.length === 0 ? segment : `${pointer}.${segment}`;
  }, '');
}

function issue(code: EvaluationCaseIssueCode, path: IssuePath, message: string): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/* -------------------------------------------------------------------------- */
/* Field schemas                                                               */
/* -------------------------------------------------------------------------- */

/** A non-blank, well-formed UTF-16 identity, preserved exactly. */
const identity = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const positiveWeight = z.number().refine((value) => Number.isSafeInteger(value) && value >= 1, {
  message: 'must be a safe integer greater than or equal to 1',
});

const nonBlankStrings = z.array(identity).min(1);

const AnswerCriterionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('exact'),
    id: identity,
    weight: positiveWeight,
    expected: identity,
    caseSensitive: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('contains-all'),
    id: identity,
    weight: positiveWeight,
    expected: nonBlankStrings,
    caseSensitive: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('contains-any'),
    id: identity,
    weight: positiveWeight,
    expected: nonBlankStrings,
    caseSensitive: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('not-contains'),
    id: identity,
    weight: positiveWeight,
    forbidden: nonBlankStrings,
    caseSensitive: z.boolean(),
  }),
]);

const RequiredFactSchema = z.strictObject({
  id: identity,
  description: identity,
  importance: z.enum(['critical', 'major', 'minor']),
  evidenceBlockGroups: z.array(z.array(identity).min(1)).min(1),
  acceptableEvidence: z.array(identity),
});

/**
 * The structural boundary of a case.
 *
 * `compilationRequest` is only checked here for being an object; the compiler's
 * own validator owns its rules, and duplicating them would create a second place
 * for one truth to drift (INV-DEP-003).
 */
const EvaluationCaseShapeSchema = z.strictObject({
  schemaVersion: z.literal(EVALUATION_CASE_SCHEMA_VERSION),
  id: identity,
  datasetSplit: z.enum(['development', 'validation', 'regression']),
  compilationRequest: z.looseObject({}),
  requiredBlockIds: z.array(identity),
  requiredFacts: z.array(RequiredFactSchema),
  relevantBlockIds: z.array(identity),
  irrelevantBlockIds: z.array(identity),
  expectedCompilationFailure: z.strictObject({ stage: identity, issueCode: identity }).optional(),
  answerCriteria: z.array(AnswerCriterionSchema),
  tags: z.array(identity),
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validates one case strictly, all or nothing.
 *
 * Three things are proved, in order: the record's shape, the embedded
 * compilation request through the compiler's own validator, and the
 * cross-references between the annotations and the candidate corpus. An
 * annotation naming a block the case does not contain is a broken answer key,
 * and a benchmark run against a broken answer key reports a number that means
 * nothing (INV-BLOCK-005).
 *
 * @throws {EvaluationCaseValidationError} when the case is not usable.
 */
export function validateEvaluationCase(input: unknown): EvaluationCase {
  const parsed = safeParse(EvaluationCaseShapeSchema, input);
  if (!parsed.ok) {
    throw new EvaluationCaseValidationError(
      parsed.issues.map((detail) => ({ ...detail, code: 'invalid_case' })),
    );
  }
  const shape = parsed.value;

  let compilationRequest: CompilationRequest;
  try {
    compilationRequest = new CompilationRequestValidator().validate(shape.compilationRequest);
  } catch (cause) {
    if (!(cause instanceof CompilationRequestError)) throw cause;
    throw new EvaluationCaseValidationError(
      cause.issues.map((detail) => {
        const path: IssuePath = ['compilationRequest', ...detail.path];
        return {
          code: 'invalid_compilation_request',
          path,
          pointer: pointerFor(path),
          message: detail.message,
        };
      }),
    );
  }

  const issues = [
    ...validateFacts(shape.requiredFacts),
    ...validateCriteria(shape.answerCriteria),
    ...validateAnnotations(shape, compilationRequest),
  ];
  if (issues.length > 0) throw new EvaluationCaseValidationError(issues);

  return {
    schemaVersion: EVALUATION_CASE_SCHEMA_VERSION,
    id: shape.id,
    datasetSplit: shape.datasetSplit,
    compilationRequest,
    requiredBlockIds: shape.requiredBlockIds,
    requiredFacts: shape.requiredFacts,
    relevantBlockIds: shape.relevantBlockIds,
    irrelevantBlockIds: shape.irrelevantBlockIds,
    ...(shape.expectedCompilationFailure === undefined
      ? {}
      : { expectedCompilationFailure: shape.expectedCompilationFailure }),
    answerCriteria: shape.answerCriteria,
    tags: shape.tags,
  };
}

function validateFacts(facts: readonly EvaluationRequiredFact[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  facts.forEach((fact, factIndex) => {
    if (seenIds.has(fact.id)) {
      issues.push(
        issue(
          'duplicate_fact_id',
          ['requiredFacts', factIndex, 'id'],
          'must be unique within the case',
        ),
      );
    }
    seenIds.add(fact.id);

    const seenGroups = new Set<string>();
    fact.evidenceBlockGroups.forEach((group, groupIndex) => {
      const seenBlocks = new Set<string>();
      group.forEach((blockId, blockIndex) => {
        if (seenBlocks.has(blockId)) {
          issues.push(
            issue(
              'duplicate_evidence_block',
              ['requiredFacts', factIndex, 'evidenceBlockGroups', groupIndex, blockIndex],
              'must not repeat a block identifier inside one evidence group',
            ),
          );
        }
        seenBlocks.add(blockId);
      });

      // Canonical ordering first, so `[a, b]` and `[b, a]` are recognized as one
      // group: they name the same conjunction, and keeping both would count one
      // alternative twice in a report that lists them.
      const key = canonicalJson([...group].sort(compareCodeUnits));
      if (seenGroups.has(key)) {
        issues.push(
          issue(
            'duplicate_evidence_group',
            ['requiredFacts', factIndex, 'evidenceBlockGroups', groupIndex],
            'must not repeat an evidence group that is equal after canonical ordering',
          ),
        );
      }
      seenGroups.add(key);
    });
  });

  return issues;
}

/**
 * Validates the criteria, including that their weights still add up exactly.
 *
 * Each weight is individually a positive safe integer, but a *sum* of safe
 * integers is not necessarily one: `MAX_SAFE_INTEGER` plus `1` is where exact
 * integer arithmetic ends, and `earnedWeight / totalWeight` would stop being the
 * score the case describes. The running total is therefore checked **before**
 * each addition, so the unsafe value is never computed and then inspected.
 */
function validateCriteria(criteria: readonly AnswerCriterion[]): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  let totalWeight = 0;

  criteria.forEach((criterion, index) => {
    if (totalWeight > Number.MAX_SAFE_INTEGER - criterion.weight) {
      issues.push(
        issue(
          'invalid_case',
          ['answerCriteria', index, 'weight'],
          'must keep the total criterion weight within the safe integer range',
        ),
      );
    } else {
      totalWeight += criterion.weight;
    }

    if (seenIds.has(criterion.id)) {
      issues.push(
        issue(
          'duplicate_criterion_id',
          ['answerCriteria', index, 'id'],
          'must be unique within the case',
        ),
      );
    }
    seenIds.add(criterion.id);

    if (criterion.kind === 'exact') return;
    const field = criterion.kind === 'not-contains' ? 'forbidden' : 'expected';
    const values = criterion.kind === 'not-contains' ? criterion.forbidden : criterion.expected;
    const seen = new Set<string>();
    values.forEach((value, valueIndex) => {
      if (seen.has(value)) {
        issues.push(
          issue(
            'invalid_case',
            ['answerCriteria', index, field, valueIndex],
            'must not repeat a value within one criterion',
          ),
        );
      }
      seen.add(value);
    });
  });

  return issues;
}

/**
 * Proves every annotated block identifier exists in the case's own candidate
 * corpus, and that no block is annotated as both wanted and unwanted.
 *
 * Both checks catch the same class of mistake: an answer key that has drifted
 * from the corpus it describes. A required identifier no candidate carries makes
 * required-block recall unreachable by construction.
 *
 * **"Wanted" includes required-fact evidence.** A block named by
 * `requiredFacts[i].evidenceBlockGroups[g][b]` is wanted for exactly the same
 * reason a `requiredBlockIds` entry is: the case says the compiled context needs
 * it. Listing it as irrelevant as well makes the benchmark reward opposite
 * decisions about one block — including it raises weighted fact coverage and
 * lowers the irrelevant-exclusion rate, and excluding it does the reverse — so no
 * compilation can score well on both. That is a broken answer key, and it is
 * **rejected, never repaired**: nothing is removed from `irrelevantBlockIds` and
 * nothing is added to `relevantBlockIds` or `requiredBlockIds` on the author's
 * behalf.
 *
 * Evidence that is simply not listed in `relevantBlockIds` stays perfectly legal:
 * the rule is about contradiction, not about completeness.
 */
function validateAnnotations(
  shape: {
    readonly requiredBlockIds: readonly string[];
    readonly requiredFacts: readonly EvaluationRequiredFact[];
    readonly relevantBlockIds: readonly string[];
    readonly irrelevantBlockIds: readonly string[];
  },
  request: CompilationRequest,
): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // The identifiers are compared as plain strings: the domain brands its own
  // block identifier type, and a case annotation is caller text that has not
  // been through that brand.
  const corpus = new Set<string>(request.candidates.map((candidate) => String(candidate.block.id)));

  const checkList = (field: string, ids: readonly string[]): void => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (!corpus.has(id)) {
        issues.push(
          issue('unknown_block_id', [field, index], 'must name a block of the case candidates'),
        );
      }
      if (seen.has(id)) {
        issues.push(
          issue('duplicate_annotation_block_id', [field, index], 'must not repeat a block'),
        );
      }
      seen.add(id);
    });
  };

  checkList('requiredBlockIds', shape.requiredBlockIds);
  checkList('relevantBlockIds', shape.relevantBlockIds);
  checkList('irrelevantBlockIds', shape.irrelevantBlockIds);

  shape.requiredFacts.forEach((fact, factIndex) => {
    fact.evidenceBlockGroups.forEach((group, groupIndex) => {
      group.forEach((blockId, blockIndex) => {
        if (!corpus.has(blockId)) {
          issues.push(
            issue(
              'unknown_block_id',
              ['requiredFacts', factIndex, 'evidenceBlockGroups', groupIndex, blockIndex],
              'must name a block of the case candidates',
            ),
          );
        }
      });
    });
  });

  const irrelevant = new Set(shape.irrelevantBlockIds);
  for (const [field, ids] of [
    ['requiredBlockIds', shape.requiredBlockIds],
    ['relevantBlockIds', shape.relevantBlockIds],
  ] as const) {
    ids.forEach((id, index) => {
      if (irrelevant.has(id)) {
        issues.push(
          issue(
            'conflicting_annotation',
            [field, index],
            'must not also be annotated as an irrelevant block',
          ),
        );
      }
    });
  }

  // The pointer names the exact evidence occurrence, so an author reading the
  // failure knows which group member to change rather than which fact.
  shape.requiredFacts.forEach((fact, factIndex) => {
    fact.evidenceBlockGroups.forEach((group, groupIndex) => {
      group.forEach((blockId, blockIndex) => {
        if (irrelevant.has(blockId)) {
          issues.push(
            issue(
              'conflicting_annotation',
              ['requiredFacts', factIndex, 'evidenceBlockGroups', groupIndex, blockIndex],
              'must not also be annotated as an irrelevant block',
            ),
          );
        }
      });
    });
  });

  return issues;
}

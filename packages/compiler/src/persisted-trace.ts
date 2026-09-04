import {
  ContentHashSchema,
  ContextBlockIdSchema,
  ScopeSchema,
  SourceDocumentIdSchema,
  SourceLocationSchema,
  SourceTypeSchema,
  TimestampSchema,
  TokenBudgetSchema,
  safeParse,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import {
  COMPILATION_TRACE_SCHEMA_VERSION,
  type SettledCompilationTrace,
} from './compilation-trace.js';

/**
 * Runtime validation of a **persisted** settled compilation trace (DEC-042).
 *
 * A trace that has been written to a database, a file, or a message and read
 * back is external data. The process that wrote it is gone, its version is
 * unknown, and nothing about the bytes proves this kernel produced them. So the
 * shape is proven again on the way in, exactly as candidate wrappers are:
 * compile-time types describe an intention, not a fact about a row
 * (INV-BLOCK-005, INV-STORE-004).
 *
 * ## What this is not
 *
 * It is **not** trace reconstruction. Nothing here re-scores, re-filters,
 * re-allocates, re-orders, or re-renders anything, and nothing recomputes a
 * digest, a token count, or a reconciliation total. It calls no tokenizer, no
 * retrieval provider, no model, and no clock (INV-DET-003, INV-DET-004,
 * INV-DEP-002). A trace whose stored numbers contradict each other is a trace
 * this validator accepts and an auditor reads as contradictory — which is the
 * honest outcome, because "the stored record says this" is precisely the
 * question a persisted audit record answers.
 *
 * It is **not** repair. No value is coerced, defaulted, normalized, reordered,
 * or stripped. An unknown field is a rejection rather than something quietly
 * dropped: a field this kernel does not know about is evidence the record came
 * from a different producer, and silently discarding it would publish a trace
 * that is not the one that was stored.
 *
 * It is **not** part of `TraceBuilder`. Building a trace from live pipeline
 * evidence and proving a stored record is well formed are different problems
 * with different inputs, and one component owning both would be one component
 * with two reasons to change (INV-DEP-003).
 *
 * ## Settled only
 *
 * `CompilationTrace` is a union, and only the settled variant may be attached to
 * a successful compilation (INV-TRACE-006). This validator therefore requires
 * `settled: true`, `compilationId`, `settlement`, and
 * `composition.tokenizerCoverage: 'validation-and-rendering'`. An unsettled
 * snapshot is rejected with its own issue code rather than being reported as a
 * generic shape failure: *this is a trace, but not one that may stand as the
 * record of a completed compilation* is a different finding from *this is not a
 * trace* (DEC-038).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Machine-readable categories of a rejected persisted trace (INV-TRACE-002). */
export type PersistedCompilationTraceIssueCode =
  'invalid_trace' | 'not_json_safe' | 'unsupported_schema_version' | 'unsettled_trace';

/**
 * The single error persisted-trace validation raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error object escapes, and no message quotes a stored value:
 * a trace carries scope identifiers, block identifiers, and digests, and an
 * error is not a place to reprint the record it rejected (INV-SEC-001,
 * INV-ADAPTER-001).
 */
export class PersistedCompilationTraceError extends Error {
  readonly code = 'PERSISTED_COMPILATION_TRACE_INVALID';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Persisted compilation trace is invalid: ${summary}`);
    this.name = 'PersistedCompilationTraceError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue construction                                                          */
/* -------------------------------------------------------------------------- */

function pointerFor(path: readonly (string | number)[]): string {
  return path.reduce<string>((pointer, segment) => {
    if (typeof segment === 'number') return `${pointer}[${String(segment)}]`;
    return pointer.length === 0 ? segment : `${pointer}.${segment}`;
  }, '');
}

function issue(
  path: readonly (string | number)[],
  message: string,
  code: PersistedCompilationTraceIssueCode,
): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/* -------------------------------------------------------------------------- */
/* Passive JSON structure                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The exact JSON-safe structure a persisted trace must already be.
 *
 * Every read below goes through `Object.getOwnPropertyDescriptor`, so an
 * accessor is detected rather than invoked: a getter on an untrusted record can
 * throw, or can return one value to the validator and a different one to the
 * consumer afterwards. A `Proxy`, a class instance, a `Date`, a `Map`, a
 * function, a `symbol`, a `bigint`, a non-finite number, a cycle, and an
 * `undefined`-valued own property are all rejected here rather than at a later
 * stage that would have less to say about them.
 *
 * Rejecting an `undefined`-valued property matters on its own: an optional trace
 * field is either absent or present with a value, and `{ priority: undefined }`
 * is a record claiming *there is a priority, and it is nothing*. JSON has no
 * such value, so a record carrying one did not come from a serialized trace.
 *
 * The check is what makes it safe for {@link SettledCompilationTraceValidator}
 * to publish the **caller's own value** after validating it, rather than a
 * rebuilt copy. Returning the supplied value is the stronger guarantee for a
 * persisted record: what a consumer reads is byte-for-byte what was stored,
 * including property order, and no rebuild step can quietly alter it.
 */
function collectNonJsonSafe(
  value: unknown,
  path: readonly (string | number)[],
  seen: Set<object>,
  issues: ValidationIssue[],
): void {
  if (issues.length > 0) return;

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push(issue(path, 'must be a finite number', 'not_json_safe'));
    }
    return;
  }
  if (typeof value !== 'object') {
    issues.push(issue(path, `must be JSON data, not ${typeof value}`, 'not_json_safe'));
    return;
  }

  const record = value as object;
  if (seen.has(record)) {
    issues.push(issue(path, 'must not contain a reference cycle', 'not_json_safe'));
    return;
  }

  const prototype = Object.getPrototypeOf(record);
  if (Array.isArray(record)) {
    if (prototype !== Array.prototype) {
      issues.push(issue(path, 'must be a plain array', 'not_json_safe'));
      return;
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    issues.push(issue(path, 'must be a plain object', 'not_json_safe'));
    return;
  }

  if (Object.getOwnPropertySymbols(record).length > 0) {
    issues.push(issue(path, 'must not carry symbol-keyed properties', 'not_json_safe'));
    return;
  }

  seen.add(record);
  for (const key of Object.getOwnPropertyNames(record)) {
    if (Array.isArray(record) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) continue;
    const childPath = [...path, Array.isArray(record) ? Number(key) : key];
    if (!('value' in descriptor)) {
      issues.push(issue(childPath, 'must be a data property, not an accessor', 'not_json_safe'));
      break;
    }
    if (descriptor.value === undefined) {
      issues.push(issue(childPath, 'must be absent rather than undefined', 'not_json_safe'));
      break;
    }
    collectNonJsonSafe(descriptor.value, childPath, seen, issues);
    if (issues.length > 0) break;
  }
  seen.delete(record);
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/** A `sha256:<64 lowercase hex characters>` audit digest, unbranded. */
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  message: 'must be a digest of the form "sha256:<64 lowercase hex characters>"',
});

const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' });

const count = z.int().min(0);
const finiteNumber = z.number().refine((value) => Number.isFinite(value), {
  message: 'must be a finite number',
});

const IdentitySchema = z.strictObject({ id: nonBlank, version: nonBlank });

const RequestSchema = z.strictObject({
  id: nonBlank,
  fingerprint: digest,
  scope: ScopeSchema,
  referenceTime: TimestampSchema,
  queryHash: digest,
  budget: TokenBudgetSchema,
  candidateCount: count,
  sourceDocumentCount: count,
});

const SourceSchema = z.strictObject({
  id: SourceDocumentIdSchema,
  sourceType: SourceTypeSchema,
  contentHash: ContentHashSchema,
});

const CanonicalBlockSchema = z.strictObject({
  id: ContextBlockIdSchema,
  sourceDocumentId: SourceDocumentIdSchema,
  sourceType: SourceTypeSchema,
  tokenCount: count,
  normalizedContentHash: ContentHashSchema,
  required: z.boolean(),
  priority: finiteNumber.optional(),
  category: z.string().optional(),
  sourceLocation: SourceLocationSchema.optional(),
});

const RetrievalSchema = z.strictObject({
  providerId: nonBlank,
  providerVersion: nonBlank,
  rank: count.optional(),
  score: z
    .strictObject({
      value: finiteNumber,
      semantics: z.string(),
      higherIsBetter: z.boolean(),
    })
    .optional(),
});

const MemberSchema = z.strictObject({
  blockId: ContextBlockIdSchema,
  sourceDocumentId: SourceDocumentIdSchema,
  matchReason: z.enum(['same-block-id', 'same-normalized-content']),
  retrieval: RetrievalSchema.optional(),
});

const aggregation = z.literal('max');

const ScoreSchema = z.strictObject({
  total: finiteNumber,
  retrieval: z
    .strictObject({
      normalizedValue: finiteNumber,
      weight: finiteNumber,
      contribution: finiteNumber,
      aggregation,
      evidence: z.array(
        z.strictObject({
          blockId: ContextBlockIdSchema,
          providerId: nonBlank,
          providerVersion: nonBlank,
          semantics: z.string(),
          higherIsBetter: z.boolean(),
          rawValue: finiteNumber,
          normalizedValue: finiteNumber,
          ruleId: z.string(),
        }),
      ),
    })
    .optional(),
  authoredPriority: z
    .strictObject({
      normalizedValue: finiteNumber,
      weight: finiteNumber,
      contribution: finiteNumber,
      aggregation,
      min: finiteNumber,
      max: finiteNumber,
      evidence: z.array(
        z.strictObject({
          blockId: ContextBlockIdSchema,
          priority: finiteNumber,
          normalizedValue: finiteNumber,
        }),
      ),
    })
    .optional(),
  sourcePriority: z
    .strictObject({
      normalizedValue: finiteNumber,
      weight: finiteNumber,
      contribution: finiteNumber,
      aggregation,
      defaultValue: finiteNumber,
      evidence: z.array(
        z.strictObject({
          blockId: ContextBlockIdSchema,
          sourceDocumentId: SourceDocumentIdSchema,
          value: finiteNumber,
          valueSource: z.enum(['configured', 'policy-default']),
        }),
      ),
    })
    .optional(),
  categoryPriority: z
    .strictObject({
      normalizedValue: finiteNumber,
      weight: finiteNumber,
      contribution: finiteNumber,
      aggregation,
      defaultValue: finiteNumber,
      evidence: z.array(
        z.strictObject({
          blockId: ContextBlockIdSchema,
          category: z.string().optional(),
          value: finiteNumber,
          valueSource: z.enum(['configured', 'policy-default']),
        }),
      ),
    })
    .optional(),
  recency: z
    .strictObject({
      normalizedValue: finiteNumber,
      weight: finiteNumber,
      contribution: finiteNumber,
      aggregation,
      maxAgeSeconds: finiteNumber,
      missingValue: finiteNumber,
      evidence: z.array(
        z.strictObject({
          blockId: ContextBlockIdSchema,
          timestamp: TimestampSchema.optional(),
          timestampField: z.enum(['updatedAt', 'createdAt']).optional(),
          ageSeconds: finiteNumber.optional(),
          normalizedValue: finiteNumber,
          valueSource: z.enum(['timestamp', 'policy-missing-value']),
        }),
      ),
    })
    .optional(),
});

/**
 * The filtering decision, discriminated on `reason` rather than on `decision`.
 *
 * Two of the three variants share `decision: 'eligible'` and differ in their
 * evidence, so `reason` is the field that actually determines the shape. A union
 * keyed on `decision` would have to accept a required-eligible record carrying a
 * score total, which is a pairing the stage that produced it cannot construct.
 */
const FilteringDecisionSchema = z.discriminatedUnion('reason', [
  z.strictObject({ decision: z.literal('eligible'), reason: z.literal('ELIGIBLE_REQUIRED') }),
  z.strictObject({
    decision: z.literal('eligible'),
    reason: z.literal('ELIGIBLE_POLICY'),
    scoreTotal: finiteNumber,
    minimumTotalScore: finiteNumber.optional(),
  }),
  z.strictObject({
    decision: z.literal('filtered'),
    reason: z.literal('FILTERED_SCORE_BELOW_MINIMUM'),
    scoreTotal: finiteNumber,
    minimumTotalScore: finiteNumber,
  }),
]);

const AllocationDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('included'),
    reason: z.enum(['INCLUDED_REQUIRED', 'INCLUDED_CATEGORY_MINIMUM', 'INCLUDED_SCORE_ORDER']),
  }),
  z.strictObject({
    decision: z.literal('excluded'),
    reason: z.enum(['EXCLUDED_CATEGORY_MAXIMUM', 'EXCLUDED_BUDGET_EXHAUSTED']),
  }),
]);

const GroupSchema = z.strictObject({
  canonical: CanonicalBlockSchema,
  canonicalSelectionReason: z.enum([
    'single-block',
    'required-block',
    'required-then-stable-block-id',
    'stable-block-id',
  ]),
  members: z.array(MemberSchema),
  score: ScoreSchema,
  filtering: FilteringDecisionSchema,
  allocation: AllocationDecisionSchema.optional(),
  currentDisposition: z.enum(['filtered', 'included', 'excluded']),
  renderPosition: count.optional(),
});

const FinalDecisionSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    blockId: ContextBlockIdSchema,
    disposition: z.literal('filtered'),
    reason: z.literal('FILTERED_POLICY'),
  }),
  z.strictObject({
    blockId: ContextBlockIdSchema,
    disposition: z.literal('included'),
    reason: z.enum([
      'INCLUDED_REQUIRED',
      'INCLUDED_CATEGORY_MINIMUM',
      'INCLUDED_SCORE_ORDER',
      'INCLUDED_RENDER_AWARE_CORRECTION',
    ]),
    renderPosition: count,
  }),
  z.strictObject({
    blockId: ContextBlockIdSchema,
    disposition: z.literal('excluded'),
    reason: z.enum(['EXCLUDED_INITIAL_ALLOCATION', 'EXCLUDED_RENDER_AWARE_CORRECTION']),
    initialAllocationReason: z
      .enum(['EXCLUDED_CATEGORY_MAXIMUM', 'EXCLUDED_BUDGET_EXHAUSTED'])
      .optional(),
  }),
]);

const SettlementSchema = z.strictObject({
  strategy: z.literal('render-aware-v1'),
  correctionApplied: z.boolean(),
  initialRenderedTokens: count,
  evictedBlockIds: z.array(ContextBlockIdSchema),
  fallbackSearch: z.strictObject({
    used: z.boolean(),
    selectionsVisited: count,
    maxSelections: count,
    phase: z.enum(['hard-base', 'policy-selection-rescue']).optional(),
    chosenBlockIds: z.array(ContextBlockIdSchema).optional(),
  }),
  decisions: z.array(FinalDecisionSchema),
  ordering: z.strictObject({ orderedBlockIds: z.array(ContextBlockIdSchema) }),
  rendering: z.strictObject({ renderedContextHash: digest, compiledTokens: count }),
  usage: z.strictObject({
    availableInputTokens: count,
    includedContentTokens: count,
    unusedTokens: z.int(),
    renderingTokenDelta: z.int(),
  }),
});

/**
 * The complete settled trace.
 *
 * `settled` is fixed to `true` and `tokenizerCoverage` to
 * `validation-and-rendering`: those two literals are what distinguish a record
 * that may stand as the audit trail of a completed compilation from a snapshot
 * of one measured attempt (DEC-038).
 */
const SettledTraceSchema = z.strictObject({
  schemaVersion: z.literal(COMPILATION_TRACE_SCHEMA_VERSION),
  settled: z.literal(true),
  compilationId: digest,

  request: RequestSchema,
  sources: z.array(SourceSchema),

  composition: z.strictObject({
    compiler: IdentitySchema,
    policy: z.strictObject({
      compilation: IdentitySchema,
      scoring: IdentitySchema,
      filtering: IdentitySchema,
      allocation: IdentitySchema,
      ordering: IdentitySchema,
      rendering: IdentitySchema,
    }),
    tokenizer: IdentitySchema,
    tokenizerCoverage: z.literal('validation-and-rendering'),
    renderer: IdentitySchema,
  }),

  groups: z.array(GroupSchema),

  allocation: z.strictObject({
    availableInputTokens: count,
    selectedBlockContentTokens: count,
    unallocatedBlockContentTokens: count,
    includedBlockIds: z.array(ContextBlockIdSchema),
    excludedBlockIds: z.array(ContextBlockIdSchema),
    optionalEvictionOrder: z.array(ContextBlockIdSchema),
  }),
  ordering: z.strictObject({ orderedBlockIds: z.array(ContextBlockIdSchema) }),
  rendering: z.strictObject({
    renderedContextHash: digest,
    renderedTokens: count,
    fitsAvailableInputBudget: z.boolean(),
  }),
  totals: z.strictObject({
    candidateCount: count,
    deduplicatedGroupCount: count,
    duplicateWrapperCount: count,

    filteredGroupCount: count,
    eligibleGroupCount: count,
    includedGroupCount: count,
    allocationExcludedGroupCount: count,

    candidateTokens: count,
    canonicalContentTokens: count,
    duplicateCandidateTokens: count,

    filteredContentTokens: count,
    includedContentTokens: count,
    allocationExcludedContentTokens: count,
    excludedCanonicalContentTokens: count,
  }),

  settlement: SettlementSchema,
});

/* -------------------------------------------------------------------------- */
/* Validator                                                                   */
/* -------------------------------------------------------------------------- */

/** Reads one own data property without invoking an accessor or a prototype. */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Proves one stored record is a complete, well-formed settled trace.
 *
 * The instance holds no state, reads no configuration, and depends on nothing:
 * it is a class rather than a bare function so that a future consumer can hold
 * one behind an interface, exactly as it holds the other kernel stages.
 */
export class SettledCompilationTraceValidator {
  /** The trace schema version this validator accepts, and the only one. */
  readonly supportedSchemaVersion = COMPILATION_TRACE_SCHEMA_VERSION;

  /**
   * Returns the supplied value, proven to be a `SettledCompilationTrace`.
   *
   * The **same** value is returned, not a copy: for a persisted record, what a
   * consumer reads must be exactly what was stored, and a rebuild step is an
   * opportunity to differ from it. That is sound only because the record is
   * first proven to be passive JSON data — no accessor, no `Proxy`, no cycle,
   * no class instance, no `undefined`-valued property — so reading it twice
   * cannot yield two answers.
   *
   * @throws {PersistedCompilationTraceError} when the value is not one.
   */
  validate(input: unknown): SettledCompilationTrace {
    assertSettledCompilationTrace(input);
    // The assertion above proved the shape of `input` **itself**: `strictObject`
    // rejects an unknown key rather than stripping it, and the passive-JSON
    // check proved every read is a stable data property. Publishing the caller's
    // value is therefore the exact record, not a reconstruction of it.
    return input;
  }
}

/**
 * Narrows one value to a settled trace, or throws with the reason it is not.
 *
 * It is an assertion rather than a boolean guard because the *reason* is the
 * product: a caller reading a stored record needs to know whether it was
 * malformed, written by an unsupported schema version, or an unsettled snapshot,
 * and a `false` says none of those (INV-ADAPTER-003).
 *
 * `schemaVersion` and `settled` are inspected before the schema runs so that an
 * old or unsettled record gets the finding that actually describes it. Under the
 * full schema both would surface as a literal mismatch on one field among
 * however many others failed, and *this trace is from a schema version this
 * build does not support* would be buried in a list (INV-STORE-004).
 */
function assertSettledCompilationTrace(input: unknown): asserts input is SettledCompilationTrace {
  const jsonIssues: ValidationIssue[] = [];
  collectNonJsonSafe(input, [], new Set<object>(), jsonIssues);
  if (jsonIssues.length > 0) {
    throw new PersistedCompilationTraceError(jsonIssues);
  }

  const version = ownValue(input, 'schemaVersion');
  if (typeof version === 'number' && version !== COMPILATION_TRACE_SCHEMA_VERSION) {
    throw new PersistedCompilationTraceError([
      issue(
        ['schemaVersion'],
        `trace schema version ${String(version)} is not supported: this build reads version ${String(COMPILATION_TRACE_SCHEMA_VERSION)}`,
        'unsupported_schema_version',
      ),
    ]);
  }

  if (ownValue(input, 'settled') === false) {
    throw new PersistedCompilationTraceError([
      issue(
        ['settled'],
        'must be a settled trace: an unsettled snapshot is not the record of a completed compilation',
        'unsettled_trace',
      ),
    ]);
  }

  const parsed = safeParse(SettledTraceSchema, input);
  if (!parsed.ok) {
    throw new PersistedCompilationTraceError(
      parsed.issues.map((detail) => ({
        ...detail,
        code: 'invalid_trace' satisfies PersistedCompilationTraceIssueCode,
      })),
    );
  }
}

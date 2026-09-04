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
 * Guarded reflection.
 *
 * Every helper below reports a reflective failure as data instead of throwing.
 * The value being inspected is a stored record from a database, a file, or a
 * message, and in this process it is an arbitrary runtime value: it may be a
 * `Proxy` whose `getPrototypeOf`, `ownKeys`, or `getOwnPropertyDescriptor` trap
 * throws, or a **revoked** `Proxy`, which is `typeof "object"` and not `null` —
 * so it reaches every structural check here — and refuses every reflective
 * operation, `Array.isArray` included.
 *
 * `Object.getPrototypeOf`, `Array.isArray`, `Object.getOwnPropertyNames`,
 * `Object.getOwnPropertySymbols`, and `Object.getOwnPropertyDescriptor` are all
 * total on ordinary values and none of them is total on these, so an unguarded
 * call would let a raw `TypeError` — with the engine's wording, or a message the
 * inspected value chose — escape as this kernel's validation failure. A value
 * that cannot be inspected is reported as `not_json_safe`, which is exactly what
 * it is: a stored record must be passive JSON data, and one that refuses
 * inspection is not (INV-ADAPTER-001, INV-SEC-001).
 *
 * No accessor is invoked and no `get` trap is used anywhere below.
 */

function tryIsArray(value: unknown): boolean | null {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

function tryPrototypeOf(value: object): { readonly prototype: unknown } | null {
  try {
    return { prototype: Object.getPrototypeOf(value) };
  } catch {
    return null;
  }
}

function tryOwnNames(value: object): readonly string[] | null {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return null;
  }
}

function tryHasOwnSymbols(value: object): boolean | null {
  try {
    return Object.getOwnPropertySymbols(value).length > 0;
  } catch {
    return null;
  }
}

/** A descriptor, its deliberate absence, or a failure to read it. */
type DescriptorRead =
  | { readonly kind: 'descriptor'; readonly descriptor: PropertyDescriptor }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' };

function tryOwnDescriptor(value: object, key: string): DescriptorRead {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return { kind: 'failed' };
  }
  return descriptor === undefined ? { kind: 'absent' } : { kind: 'descriptor', descriptor };
}

/** Whether `key` is the canonical spelling of an index below `length`. */
function isIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * The exact JSON-safe structure a persisted trace must already be.
 *
 * Every read goes through a guarded descriptor lookup, so an accessor is
 * detected rather than invoked: a getter on an untrusted record can throw, or
 * can return one value to the validator and a different one to the consumer
 * afterwards. A `Proxy`, a class instance, a `Date`, a `Map`, a function, a
 * `symbol`, a `bigint`, a non-finite number, a cycle, and an `undefined`-valued
 * own property are all rejected here rather than at a later stage that would
 * have less to say about them.
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
 *
 * Because the value is published rather than rebuilt, "is JSON data" has to be
 * exact rather than approximate. Three rules therefore go beyond what a
 * serializer would notice:
 *
 * - A **non-enumerable** own property of a plain object is rejected.
 *   `JSON.stringify` ignores it, so a rebuilt copy would not have it — but the
 *   returned value does, and a consumer reading that field would see data no
 *   serialization of this record contains.
 * - An array's **own string properties other than its elements and `length`**
 *   are rejected, for the same reason: JSON drops them and the returned array
 *   keeps them.
 * - A **sparse** array is rejected. `JSON.stringify` writes a hole as `null`, so
 *   the returned array would not equal the data any serialization of it
 *   describes, and a consumer iterating it would see `undefined` where the
 *   stored document says `null`.
 *
 * The walk also **builds a plain snapshot** of everything it reads, and that
 * snapshot — never the caller's value — is what the schema is run against. Zod
 * reads properties the ordinary way, so validating the original directly would
 * run a `Proxy` `get` trap after the passive pass had carefully avoided one. The
 * snapshot is assembled from own data descriptors in their own order, so it
 * serializes identically to the value it was taken from.
 *
 * One residue is worth naming rather than glossing: a `Proxy` can report one
 * value through `getOwnPropertyDescriptor` and a different one through `get`,
 * and no platform-neutral check can detect that. This validator proves what the
 * descriptors say and publishes the caller's value, so what it proved is *the
 * record's own data properties* — which is exactly what a serializer would have
 * written, and exactly what a stored record is.
 */
function collectNonJsonSafe(
  value: unknown,
  path: readonly (string | number)[],
  seen: Set<object>,
  issues: ValidationIssue[],
): unknown {
  if (issues.length > 0) return undefined;

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push(issue(path, 'must be a finite number', 'not_json_safe'));
    }
    return value;
  }
  if (typeof value !== 'object') {
    issues.push(issue(path, `must be JSON data, not ${typeof value}`, 'not_json_safe'));
    return undefined;
  }

  const record = value as object;
  if (seen.has(record)) {
    issues.push(issue(path, 'must not contain a reference cycle', 'not_json_safe'));
    return undefined;
  }

  const isArray = tryIsArray(record);
  const prototype = isArray === null ? null : tryPrototypeOf(record);
  const hasSymbols = prototype === null ? null : tryHasOwnSymbols(record);
  const names = hasSymbols === null ? null : tryOwnNames(record);
  if (isArray === null || prototype === null || hasSymbols === null || names === null) {
    // The value refused to be inspected. Nothing it said is repeated: a hostile
    // value chooses its own error message, and this one is the kernel's.
    issues.push(issue(path, 'must be a value that can be inspected as JSON', 'not_json_safe'));
    return undefined;
  }

  if (isArray) {
    if (prototype.prototype !== Array.prototype) {
      issues.push(issue(path, 'must be a plain array', 'not_json_safe'));
      return undefined;
    }
  } else if (prototype.prototype !== Object.prototype && prototype.prototype !== null) {
    issues.push(issue(path, 'must be a plain object', 'not_json_safe'));
    return undefined;
  }

  if (hasSymbols) {
    issues.push(issue(path, 'must not carry symbol-keyed properties', 'not_json_safe'));
    return undefined;
  }

  seen.add(record);
  const snapshot = isArray
    ? collectNonJsonSafeArray(record, names, path, seen, issues)
    : collectNonJsonSafeObject(record, names, prototype.prototype, path, seen, issues);
  seen.delete(record);
  return snapshot;
}

/** The own-property rules for a plain object, and the walk into its values. */
function collectNonJsonSafeObject(
  record: object,
  names: readonly string[],
  prototype: unknown,
  path: readonly (string | number)[],
  seen: Set<object>,
  issues: ValidationIssue[],
): unknown {
  // A `null`-prototype source must not become an `Object.prototype` snapshot:
  // the two behave differently on exactly the key a stored record can carry.
  const snapshot: Record<string, unknown> =
    prototype === null ? (Object.create(null) as Record<string, unknown>) : {};

  for (const key of names) {
    const read = tryOwnDescriptor(record, key);
    if (read.kind === 'failed') {
      issues.push(
        issue([...path, key], 'must be a value that can be inspected as JSON', 'not_json_safe'),
      );
      return undefined;
    }
    if (read.kind === 'absent') continue;

    const childPath = [...path, key];
    const descriptor = read.descriptor;
    if (!('value' in descriptor)) {
      issues.push(issue(childPath, 'must be a data property, not an accessor', 'not_json_safe'));
      return undefined;
    }
    if (!descriptor.enumerable) {
      issues.push(
        issue(childPath, 'must be an enumerable property to be JSON data', 'not_json_safe'),
      );
      return undefined;
    }
    if (descriptor.value === undefined) {
      issues.push(issue(childPath, 'must be absent rather than undefined', 'not_json_safe'));
      return undefined;
    }
    const child = collectNonJsonSafe(descriptor.value, childPath, seen, issues);
    if (issues.length > 0) return undefined;
    snapshot[key] = child;
  }
  return snapshot;
}

/** The own-property rules for an array, and the walk into its elements. */
function collectNonJsonSafeArray(
  record: object,
  names: readonly string[],
  path: readonly (string | number)[],
  seen: Set<object>,
  issues: ValidationIssue[],
): unknown {
  const lengthRead = tryOwnDescriptor(record, 'length');
  if (lengthRead.kind === 'failed') {
    issues.push(issue(path, 'must be a value that can be inspected as JSON', 'not_json_safe'));
    return undefined;
  }
  if (lengthRead.kind === 'absent' || !('value' in lengthRead.descriptor)) {
    issues.push(issue(path, 'must carry length as a data property', 'not_json_safe'));
    return undefined;
  }
  const length: unknown = lengthRead.descriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    issues.push(issue(path, 'must carry a non-negative integer length', 'not_json_safe'));
    return undefined;
  }

  for (const key of names) {
    if (key === 'length' || isIndexKey(key, length)) continue;
    issues.push(
      issue(path, 'must not carry own properties other than its elements', 'not_json_safe'),
    );
    return undefined;
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const read = tryOwnDescriptor(record, String(index));
    if (read.kind === 'failed') {
      issues.push(
        issue([...path, index], 'must be a value that can be inspected as JSON', 'not_json_safe'),
      );
      return undefined;
    }
    if (read.kind === 'absent') {
      issues.push(issue([...path, index], 'must not be a hole in a sparse array', 'not_json_safe'));
      return undefined;
    }

    const childPath = [...path, index];
    const descriptor = read.descriptor;
    if (!('value' in descriptor)) {
      issues.push(issue(childPath, 'must be a data property, not an accessor', 'not_json_safe'));
      return undefined;
    }
    if (descriptor.value === undefined) {
      issues.push(issue(childPath, 'must be absent rather than undefined', 'not_json_safe'));
      return undefined;
    }
    const child = collectNonJsonSafe(descriptor.value, childPath, seen, issues);
    if (issues.length > 0) return undefined;
    snapshot.push(child);
  }
  return snapshot;
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

/**
 * Reads one own data property without invoking an accessor or a prototype.
 *
 * The descriptor read is guarded even though the passive-JSON check has already
 * run: a helper whose safety depends on being called in one particular order is
 * a helper that will eventually be called in another (INV-ADAPTER-001).
 */
function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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
   * opportunity to differ from it. That is sound because the record's own data
   * properties are first proven to be passive JSON — no accessor, no cycle, no
   * class instance, no symbol key, no non-enumerable property, no hole, no
   * `undefined`-valued property — and the schema is then run against a plain
   * snapshot of exactly those properties, so nothing in validation reads through
   * the value itself.
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
  // The snapshot is a plain rebuild of everything the passive walk read. Every
  // check below runs against it, so no property read after this line can reach a
  // `Proxy` `get` trap or an installed getter — including the ones zod performs.
  const snapshot = collectNonJsonSafe(input, [], new Set<object>(), jsonIssues);
  if (jsonIssues.length > 0) {
    throw new PersistedCompilationTraceError(jsonIssues);
  }

  const version = ownValue(snapshot, 'schemaVersion');
  if (typeof version === 'number' && version !== COMPILATION_TRACE_SCHEMA_VERSION) {
    throw new PersistedCompilationTraceError([
      issue(
        ['schemaVersion'],
        `trace schema version ${String(version)} is not supported: this build reads version ${String(COMPILATION_TRACE_SCHEMA_VERSION)}`,
        'unsupported_schema_version',
      ),
    ]);
  }

  if (ownValue(snapshot, 'settled') === false) {
    throw new PersistedCompilationTraceError([
      issue(
        ['settled'],
        'must be a settled trace: an unsettled snapshot is not the record of a completed compilation',
        'unsettled_trace',
      ),
    ]);
  }

  const parsed = safeParse(SettledTraceSchema, snapshot);
  if (!parsed.ok) {
    throw new PersistedCompilationTraceError(
      parsed.issues.map((detail) => ({
        ...detail,
        code: 'invalid_trace' satisfies PersistedCompilationTraceIssueCode,
      })),
    );
  }
}

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

/**
 * Adds one own enumerable data property to a snapshot under construction.
 *
 * `snapshot[key] = value` is wrong here, and wrong in a way that loses data
 * silently. `"__proto__"` is a legal JSON key, and `JSON.parse` defines it as an
 * ordinary own property — but plain assignment finds the inherited
 * `Object.prototype.__proto__` **setter** and runs it, so the snapshot's
 * prototype changes and the own key never appears. A stored record carrying that
 * field would then be validated as though it did not have it, and `strictObject`
 * would accept a record with an unknown field it never saw.
 *
 * `Object.defineProperty` creates the own property directly and runs no setter,
 * for every key without special-casing any of them. Whether a field named
 * `__proto__` is allowed at a given location is the schema's decision, not this
 * function's (INV-BLOCK-005).
 */
function defineOwn(snapshot: object, key: string, value: unknown): void {
  Object.defineProperty(snapshot, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
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
 * The walk **builds the value that is published**: a plain snapshot assembled
 * from the own data properties it read, in the order it read them. That snapshot
 * is what the schema validates and what {@link SettledCompilationTraceValidator}
 * returns, so the value a consumer holds is exactly the JSON data this function
 * proved — not the arbitrary runtime object it was handed.
 *
 * Because a snapshot is published, "is JSON data" has to be exact rather than
 * approximate. Three rules therefore go beyond what a serializer would notice,
 * so that the snapshot and its source describe the same document:
 *
 * - A **non-enumerable** own property of a plain object is rejected. It is a
 *   field of the source that the snapshot would not carry and that
 *   `JSON.stringify` would not write, so the two would describe different
 *   documents.
 * - An array's **own string properties other than its elements and `length`**
 *   are rejected, for the same reason: JSON drops them and so does the snapshot.
 * - A **sparse** array is rejected. `JSON.stringify` writes a hole as `null` and
 *   the snapshot would copy it as `undefined`, so neither agrees with the source.
 *
 * Validating the snapshot rather than the original also keeps zod out of the
 * untrusted value: zod reads properties the ordinary way, so running it against
 * the original would fire a `Proxy` `get` trap the passive pass had carefully
 * avoided.
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
  const snapshot: object = prototype === null ? Object.create(null) : {};

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
    defineOwn(snapshot, key, child);
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
   * Returns a **passive validated snapshot** of the supplied record, proven to be
   * a `SettledCompilationTrace`.
   *
   * The returned value is not the argument. It is the plain snapshot the passive
   * walk assembled from the record's own enumerable JSON data — the exact value
   * the schema was run against — and it is JSON-equivalent to the input: same
   * fields, same values, same order, no field added, dropped, coerced, or
   * recomputed. Nothing is re-scored, re-rendered, or re-totalled; a trace whose
   * stored numbers contradict each other comes back contradicting itself.
   *
   * Returning the argument would make the assertion unsound. A `Proxy` can
   * describe honest values through `getOwnPropertyDescriptor` — so the passive
   * walk validates them without ever firing a trap — and return different ones
   * through an ordinary property `get`. The first consumer to read a field would
   * then get a value the validator never saw, so the component would validate
   * one trace and use another. Zero `get` calls *during* validation does not fix
   * that; only publishing what was validated does (INV-BLOCK-005, INV-SEC-001).
   *
   * Value fidelity is what a persisted record needs, and reference identity is
   * not part of this contract: a caller must consume the returned snapshot.
   *
   * @throws {PersistedCompilationTraceError} when the value is not one.
   */
  validate(input: unknown): SettledCompilationTrace {
    return validatedSnapshotOf(input);
  }
}

/**
 * Every path at which the snapshot carries an own `"__proto__"` key.
 *
 * The snapshot is plain, trusted data by the time this runs, so the walk is an
 * ordinary recursion with no guarding needed.
 *
 * It exists because the schema is **structurally blind** to that one key. Zod's
 * unrecognized-key scan skips `"__proto__"` outright — it builds its result by
 * assignment into a plain object, so carrying the key through would run the
 * inherited prototype setter — which means `strictObject` reports every unknown
 * field except this one. `"__proto__"` is a legal JSON key and no field of the
 * trace schema is named that, so an own one is an unknown field at every
 * location, and reporting it here is what makes *an unknown field is rejected
 * rather than quietly dropped* true for all of them.
 *
 * This is not a rule about the key being dangerous. Nothing is deleted, no
 * prototype is written, and the snapshot carried the key faithfully up to this
 * point; the finding is the same `invalid_trace` the schema would have raised if
 * it could see it.
 */
function ownProtoKeyPaths(
  value: unknown,
  path: readonly (string | number)[],
  found: (readonly (string | number)[])[],
): void {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      ownProtoKeyPaths(element, [...path, index], found);
    });
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === '__proto__') found.push(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && 'value' in descriptor) {
      ownProtoKeyPaths(descriptor.value, [...path, key], found);
    }
  }
}

/**
 * Proves one value is a settled trace and returns the validated snapshot of it,
 * or throws with the reason it is not.
 *
 * It throws rather than answering `false` because the *reason* is the product: a
 * caller reading a stored record needs to know whether it was malformed, written
 * by an unsupported schema version, or an unsettled snapshot, and a `false` says
 * none of those (INV-ADAPTER-003).
 *
 * `schemaVersion` and `settled` are inspected before the schema runs so that an
 * old or unsettled record gets the finding that actually describes it. Under the
 * full schema both would surface as a literal mismatch on one field among
 * however many others failed, and *this trace is from a schema version this
 * build does not support* would be buried in a list (INV-STORE-004). Both are
 * read from the **snapshot**, so a hostile value cannot answer one thing here
 * and another to the schema.
 */
function validatedSnapshotOf(input: unknown): SettledCompilationTrace {
  const jsonIssues: ValidationIssue[] = [];
  // The snapshot is a plain rebuild of everything the passive walk read, and it
  // is also what this function returns. Every check below runs against it, so no
  // property read after this line can reach a `Proxy` `get` trap or an installed
  // getter — neither the ones zod performs nor the ones a consumer would.
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

  // One unknown field the schema cannot see for itself.
  const protoPaths: (readonly (string | number)[])[] = [];
  ownProtoKeyPaths(snapshot, [], protoPaths);
  if (protoPaths.length > 0) {
    throw new PersistedCompilationTraceError(
      protoPaths.map((at) =>
        issue(
          at,
          'must not carry the unrecognized key "__proto__"',
          'invalid_trace' satisfies PersistedCompilationTraceIssueCode,
        ),
      ),
    );
  }

  // The snapshot is published, not `parsed.value`. `strictObject` rejects an
  // unknown key rather than stripping one, so the two carry the same fields —
  // but the snapshot is the value this module built from observed own data,
  // and routing the result through a validation library's output would make
  // that library's construction choices part of the persisted record.
  return snapshot as SettledCompilationTrace;
}

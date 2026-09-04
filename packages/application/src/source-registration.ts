import {
  JsonObjectSchema,
  ScopeSchema,
  SourceTypeSchema,
  TimestampSchema,
  findLoneSurrogate,
  safeParse,
  type Scope,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from '@ctxalloc/domain';
import type { SourceRegistration, SourceRegistrationKey } from '@ctxalloc/ports';
import { z } from 'zod';
import { compareCodeUnits } from './local-source-pipeline.js';

/**
 * The one runtime boundary of the control plane (DEC-042).
 *
 * A `SourceRegistration` enters the product from three directions — a control
 * store returns one, a CLI reads one from a file, and a future HTTP request
 * carries one — and every one of them is external. Compile-time types prove
 * nothing about any of them (INV-BLOCK-005).
 *
 * Before this module the schema lived inside `CompileLocalContextService`, where
 * it was reachable only by the read path. Writing needs exactly the same rules,
 * and a second copy of them would be a second thing to keep in step: a
 * registration that the writer accepted and the compiler then rejected would be
 * a record the operator could store and never use (INV-DEP-003).
 *
 * The module owns validation and canonical order and nothing else. It opens no
 * database, reads no file, and knows no storage technology.
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of a `SourceRegistration` (INV-STORE-004). */
export const SOURCE_REGISTRATION_SCHEMA_VERSION = 1;

/** Current schema version of a `SourceRegistrationKey` (INV-STORE-004). */
export const SOURCE_REGISTRATION_KEY_SCHEMA_VERSION = 1;

/**
 * The single error registration validation raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * message quotes a locator or a metadata value: a registration may name a path
 * inside an operator's machine, and an error is not a place to reprint it
 * (INV-SEC-001).
 */
export class SourceRegistrationValidationError extends Error {
  readonly code = 'SOURCE_REGISTRATION_INVALID';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Source registration is invalid: ${summary}`);
    this.name = 'SourceRegistrationValidationError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/** A caller-owned identity string: non-blank, well-formed UTF-16, preserved exactly. */
const exactIdentityString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const IdentitySchema = z.strictObject({
  namespace: exactIdentityString,
  key: exactIdentityString,
});

/**
 * The runtime boundary of one control-plane record.
 *
 * Unknown fields are rejected rather than stripped, nothing is coerced, and no
 * value is defaulted — least of all the source type, which decides how the bytes
 * are interpreted.
 */
const SourceRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_REGISTRATION_SCHEMA_VERSION),
  scope: ScopeSchema,
  sourceType: SourceTypeSchema,
  identity: IdentitySchema,
  locator: exactIdentityString,
  title: z.string().optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema,
});

/**
 * The runtime boundary of one logical key.
 *
 * It carries the identity fields and none of the mutable ones. A key that
 * accepted a locator would invite a caller to believe the locator took part in
 * matching, and a remove that silently ignored it would then delete a record the
 * caller thought it had not addressed (DEC-042).
 */
const SourceRegistrationKeySchema = z.strictObject({
  schemaVersion: z.literal(SOURCE_REGISTRATION_KEY_SCHEMA_VERSION),
  scope: ScopeSchema,
  sourceType: SourceTypeSchema,
  identity: IdentitySchema,
});

/* -------------------------------------------------------------------------- */
/* Reconstruction                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds one validated registration with absent optional fields left absent.
 *
 * The validated value carries an explicit `undefined` for every omitted optional
 * field. Writing that through would produce a record claiming *there is a title,
 * and it is nothing*, and it would change what a serializer emits for the
 * record. Exact values are copied unchanged (INV-ADAPTER-002).
 */
function toRegistration(registration: {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly sourceType: SourceRegistration['sourceType'];
  readonly identity: { readonly namespace: string; readonly key: string };
  readonly locator: string;
  readonly title?: string | undefined;
  readonly createdAt?: Timestamp | undefined;
  readonly updatedAt?: Timestamp | undefined;
  readonly metadata: SourceRegistration['metadata'];
}): SourceRegistration {
  return {
    schemaVersion: registration.schemaVersion,
    scope: registration.scope,
    sourceType: registration.sourceType,
    identity: registration.identity,
    locator: registration.locator,
    ...(registration.title !== undefined ? { title: registration.title } : {}),
    ...(registration.createdAt !== undefined ? { createdAt: registration.createdAt } : {}),
    ...(registration.updatedAt !== undefined ? { updatedAt: registration.updatedAt } : {}),
    metadata: registration.metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/** Validates one registration, returning a discriminated result. */
export function parseSourceRegistration(input: unknown): ValidationResult<SourceRegistration> {
  const parsed = safeParse(SourceRegistrationSchema, input);
  if (!parsed.ok) return parsed;
  return { ok: true, value: toRegistration(parsed.value) };
}

/**
 * Validates one registration.
 *
 * @throws {SourceRegistrationValidationError} when the value is not one.
 */
export function validateSourceRegistration(input: unknown): SourceRegistration {
  const parsed = parseSourceRegistration(input);
  if (!parsed.ok) throw new SourceRegistrationValidationError(parsed.issues);
  return parsed.value;
}

/** Validates one logical key, returning a discriminated result. */
export function parseSourceRegistrationKey(
  input: unknown,
): ValidationResult<SourceRegistrationKey> {
  const parsed = safeParse(SourceRegistrationKeySchema, input);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: {
      schemaVersion: parsed.value.schemaVersion,
      scope: parsed.value.scope,
      sourceType: parsed.value.sourceType,
      identity: parsed.value.identity,
    },
  };
}

/**
 * Validates one logical key.
 *
 * @throws {SourceRegistrationValidationError} when the value is not one.
 */
export function validateSourceRegistrationKey(input: unknown): SourceRegistrationKey {
  const parsed = parseSourceRegistrationKey(input);
  if (!parsed.ok) throw new SourceRegistrationValidationError(parsed.issues);
  return parsed.value;
}

/* -------------------------------------------------------------------------- */
/* Logical identity and canonical order                                        */
/* -------------------------------------------------------------------------- */

/**
 * The logical identity of one registration, as a comparable string.
 *
 * Uniqueness is exact scope plus source type plus identity namespace plus
 * identity key. The locator takes no part: two registrations of one logical
 * source pointing at two paths are a contradiction the control plane must
 * resolve, not a pair of sources that happen to look alike (DEC-028).
 *
 * An absent `projectId` is written as `null` rather than omitted, so the two
 * boundaries stay distinguishable in the serialized form. A representation where
 * absence disappeared would make one scope's key collide with another's
 * (INV-SCOPE-004).
 */
export function sourceRegistrationLogicalKey(
  registration: SourceRegistration | SourceRegistrationKey,
): string {
  return JSON.stringify([
    registration.scope.tenantId,
    registration.scope.workspaceId,
    registration.scope.projectId ?? null,
    registration.sourceType,
    registration.identity.namespace,
    registration.identity.key,
  ]);
}

/**
 * Canonical registration order: source type, then identity namespace, then key.
 *
 * The locator is deliberately absent. Ordering by it would make the prepared
 * corpus depend on where files happen to live, so moving one source could change
 * another source's position — and identity, not location, is what a registration
 * means (DEC-028).
 *
 * One owner, two consumers: the preparation flow orders its corpus with it, and
 * `ctxalloc source list` orders its output with it. A listing that disagreed
 * with the order the corpus was built in would show an operator one thing and
 * compile another (INV-DEP-003, INV-DET-002).
 */
export function compareSourceRegistrations(
  a: SourceRegistration | SourceRegistrationKey,
  b: SourceRegistration | SourceRegistrationKey,
): number {
  return (
    compareCodeUnits(a.sourceType, b.sourceType) ||
    compareCodeUnits(a.identity.namespace, b.identity.namespace) ||
    compareCodeUnits(a.identity.key, b.identity.key)
  );
}

import { z } from 'zod';

/**
 * JSON-safe value model used for all persisted metadata.
 *
 * The architecture documents describe metadata as `Record<string, unknown>`.
 * `unknown` is not acceptable at a persistence boundary (INV-BLOCK-005), so the
 * domain narrows it to values that survive a `JSON.stringify` / `JSON.parse`
 * round trip without loss or coercion.
 *
 * Rejected on purpose: `undefined`, functions, symbols, `bigint`, `Date`
 * instances, `NaN`, `Infinity`, and any class instance that is not a plain
 * object. These either disappear, throw, or silently change shape when
 * serialized, which would break determinism (INV-DET-001).
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * A plain object is one whose prototype is `Object.prototype` or `null`.
 *
 * This check must run *before* key-by-key validation: a `Date` (and most class
 * instances) expose no enumerable own properties, so an object schema alone
 * would see `{}` and incorrectly accept them.
 */
function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Finite numbers only: `NaN` and `Infinity` are not representable in JSON. */
const finiteNumber = z
  .number()
  .refine((value) => Number.isFinite(value), { message: 'must be a finite number' });

/**
 * Rejects non-plain objects before their entries are inspected, then validates
 * each entry recursively.
 *
 * Path granularity note: because a JSON value is a union, a failure deep inside
 * a nested object is reported at the outermost key whose value is not JSON-safe,
 * not at the innermost offending leaf. The path stays accurate and deterministic,
 * it is simply less specific than a non-union schema would give.
 */
const plainObjectGuard = z.custom<Record<string, unknown>>(isPlainObject, {
  message: 'must be a plain JSON object',
});

export const JsonValueSchema: z.ZodType<JsonValue, unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finiteNumber,
    z.string(),
    z.array(JsonValueSchema),
    plainObjectGuard.pipe(z.record(z.string(), JsonValueSchema)),
  ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject, unknown> = plainObjectGuard.pipe(
  z.record(z.string(), JsonValueSchema),
);

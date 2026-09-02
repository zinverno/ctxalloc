/**
 * Canonical comparison and isolation of JSON-safe records (DEC-039).
 *
 * The prepared-corpus provenance boundary compares an untrusted provider's
 * output against records this application prepared, and snapshots that output
 * before compiling it. Both operations therefore run over values that have **not
 * been validated yet**, so both must be **total**: no input may make them throw,
 * and no non-JSON value may be silently reinterpreted as a JSON one.
 *
 * That totality is what keeps the ownership boundary honest. A value this module
 * cannot handle is reported as such, and the candidate carrying it travels on to
 * `CandidateValidator`, which owns `CandidateBlock` schema rejection. A
 * `TypeError` escaping from here would take that decision away from the kernel
 * and hand the caller a runtime error instead of a structured one
 * (INV-ADAPTER-001, INV-DEP-003).
 *
 * Everything here is package-internal. A caller that depended on this exact
 * serialization would be depending on a comparison detail rather than on a
 * contract, so none of it is exported from the package entry point.
 *
 * Nothing reads a clock, a random value, the filesystem, or the environment
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/**
 * The result of trying to canonicalize an untrusted value.
 *
 * `ok: false` carries no reason. The only decision it drives is *this value
 * cannot be compared here*, and a reason would invite a caller to treat one
 * un-canonicalizable value differently from another — a judgement that belongs
 * to the schema validator, not to a serializer.
 */
export type CanonicalRecordAttempt =
  { readonly ok: true; readonly json: string } | { readonly ok: false };

/** The result of trying to deep-copy an untrusted value. */
export type CloneRecordAttempt<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * True for an object whose prototype is `Object.prototype` or `null`.
 *
 * Rejecting anything else is a correctness rule, not caution. `Object.entries`
 * on a `Date`, a `Map`, or a `Set` yields no enumerable own properties, so all
 * three would serialize as `{}` — and compare **equal to a genuinely empty
 * object**. A provider could then pass a `Date` where the prepared record holds
 * `{}` and the comparison would accept it. The same applies to any class
 * instance whose state lives behind accessors.
 */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deterministic JSON with object keys sorted by UTF-16 code unit, or a failure.
 *
 * `JSON.stringify` alone is not enough for an equality test: it emits keys in
 * property insertion order, so two structurally identical records built in
 * different orders would compare unequal. A provider that rebuilt a block field
 * by field is doing nothing wrong, and rejecting it for key order would be a
 * false positive.
 *
 * A key whose value is `undefined` is treated as absent, exactly as
 * `JSON.stringify` treats it: an explicitly-`undefined` optional field and an
 * omitted one describe the same record to every consumer downstream.
 *
 * The attempt fails, rather than throwing, for every value that is not JSON
 * data: `bigint` (which makes `JSON.stringify` throw), `symbol`, a function,
 * `undefined` in a position where absence is not the same as omission, a
 * non-finite number, a non-plain object, and a reference cycle (which makes
 * `JSON.stringify` throw a `RangeError`).
 *
 * `localeCompare` is deliberately not used: its result depends on the machine's
 * locale data, which would order keys one way on a laptop and another in a
 * container (INV-DET-001).
 *
 * For values that are JSON data, the bytes are exactly what the previous
 * always-throwing implementation produced.
 */
export function tryCanonicalRecordJson(value: unknown): CanonicalRecordAttempt {
  // `ancestors` holds the objects on the current path only, so a value that is
  // merely shared between two branches stays legal while a true cycle fails.
  const json = canonicalize(value, new Set<object>());
  return json === null ? { ok: false } : { ok: true, json };
}

function canonicalize(value: unknown, ancestors: Set<object>): string | null {
  if (value === null) return 'null';

  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value) ?? null;
  if (kind === 'number') {
    // `NaN` and `Infinity` are not representable in JSON; `JSON.stringify`
    // renders both as `null`, which would make them compare equal to a real
    // `null` and to each other.
    return Number.isFinite(value) ? (JSON.stringify(value) ?? null) : null;
  }
  if (kind !== 'object') return null;

  const object = value as object;
  if (ancestors.has(object)) return null;
  if (!Array.isArray(object) && !isPlainObject(object)) return null;
  // A symbol-keyed property is invisible to JSON and to schema validation, so a
  // record carrying one is not the plain JSON record this comparison assumes.
  if (Object.getOwnPropertySymbols(object).length > 0) return null;

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const parts: string[] = [];
      for (const entry of object) {
        // An array hole or an explicit `undefined` has no JSON form:
        // `JSON.stringify` writes `null`, losing the difference.
        if (entry === undefined) return null;
        const part = canonicalize(entry, ancestors);
        if (part === null) return null;
        parts.push(part);
      }
      return `[${parts.join(',')}]`;
    }

    const entries = Object.entries(object)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));

    const parts: string[] = [];
    for (const [key, entry] of entries) {
      const part = canonicalize(entry, ancestors);
      if (part === null) return null;
      parts.push(`${JSON.stringify(key)}:${part}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Structural deep copy of an untrusted value, or a failure.
 *
 * The copy shares no object or array with its source, so neither side can reach
 * the other afterwards. `readonly` is a compile-time annotation and stops
 * nothing at runtime; an untrusted provider is exactly the case where that
 * distinction matters (INV-ADAPTER-004).
 *
 * The same values that cannot be canonicalized cannot be copied, and for the
 * same reason: a copy that turned a `Date` into `{}`, or a `bigint` into a
 * string, would be a different record wearing the original's shape.
 *
 * A property whose value is `undefined` is **preserved as a present key**, which
 * is where copying deliberately differs from canonicalizing. Comparison treats
 * absent and explicitly-undefined as the same record; copying must not decide
 * that question on a consumer's behalf, so it reproduces exactly what it was
 * given. A round trip through `JSON.stringify` would drop those keys.
 *
 * The returned value keeps the input's static type, which is sound for the
 * records this is used on: their fields are strings, numbers, booleans, arrays,
 * and plain objects, all of which survive the copy unchanged.
 */
export function tryCloneJsonRecord<T>(value: T): CloneRecordAttempt<T> {
  const copied = cloneUntrusted(value, new Set<object>());
  return copied === FAILED ? { ok: false } : { ok: true, value: copied as T };
}

/** A sentinel, so `null` and `undefined` stay ordinary copyable values. */
const FAILED: unique symbol = Symbol('clone-failed');

function cloneUntrusted(value: unknown, ancestors: Set<object>): unknown | typeof FAILED {
  if (value === null || value === undefined) return value;

  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : FAILED;
  if (kind !== 'object') return FAILED;

  const object = value as object;
  if (ancestors.has(object)) return FAILED;
  if (!Array.isArray(object) && !isPlainObject(object)) return FAILED;
  if (Object.getOwnPropertySymbols(object).length > 0) return FAILED;

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const result: unknown[] = [];
      for (const entry of object) {
        const copied = cloneUntrusted(entry, ancestors);
        if (copied === FAILED) return FAILED;
        result.push(copied);
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      const copied = cloneUntrusted(entry, ancestors);
      if (copied === FAILED) return FAILED;
      result[key] = copied;
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Structural deep copy of a record that is already validated.
 *
 * Used for the prepared corpus handed to a provider, where the input is a
 * domain record the schemas have already proved JSON-safe, so there is no
 * failure case to report.
 */
export function cloneRecord<T>(record: T): T {
  return cloneValidated(record) as T;
}

function cloneValidated(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValidated);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneValidated(entry);
    }
    return result;
  }
  return value;
}

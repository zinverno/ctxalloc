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
 * **What totality covers, and what it does not.** Every function here is total:
 * for any input at all, including an object whose own properties are accessors
 * or a `Proxy` whose traps throw, it returns a result rather than throwing.
 * Reflection is defensive on two levels — only own *data* properties are ever
 * read, so no accessor is invoked, and every reflective call is additionally
 * guarded, so a hostile trap produces `ok: false`. That guarantee is about
 * **this** module. It does not extend downstream: a candidate carrying a
 * pathological object graph that this module declines to inspect still reaches
 * `CandidateValidator`, and the kernel's recursive `JsonValueSchema` has no
 * cycle guard and no accessor guard of its own. Those are pre-existing kernel
 * limitations, documented as such in DEC-039 and in the provenance tests, and
 * Phase 16 does not change compiler behavior to paper over them.
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

/* -------------------------------------------------------------------------- */
/* Defensive reflection                                                        */
/* -------------------------------------------------------------------------- */

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

/** One own enumerable string-keyed data property. */
type OwnEntry = readonly [key: string, value: unknown];

/**
 * The own enumerable string-keyed **data** properties of an object, or `null`.
 *
 * Reading through `Object.getOwnPropertyDescriptor` rather than
 * `Object.entries` is deliberate, and not only because an accessor can throw.
 * A getter is free to return a different value on every read, and this module
 * reads the same untrusted record twice — once to canonicalize it for the
 * provenance comparison, once to copy it into the snapshot. A record whose
 * fields change between those two reads is not the fixed JSON data the
 * comparison assumes, and accepting it would let a provider pass the comparison
 * with one value and compile another (INV-DET-002).
 *
 * So an object carrying an accessor among its own properties is not JSON data
 * and is reported as un-inspectable, without the accessor ever being invoked.
 * A non-enumerable own property is skipped, exactly as `JSON.stringify` skips
 * it. A symbol-keyed property is invisible to JSON and to schema validation, so
 * a record carrying one is not the plain JSON record this comparison assumes.
 */
function ownDataEntries(object: object): readonly OwnEntry[] | null {
  if (Object.getOwnPropertySymbols(object).length > 0) return null;

  const entries: OwnEntry[] = [];
  for (const key of Object.getOwnPropertyNames(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) return null;
    if (!descriptor.enumerable) continue;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * The indexed elements of an array as own data values, or `null`.
 *
 * A hole reads as `undefined`, which is what iteration produces for it, so the
 * callers keep deciding what absence means. Own string keys that are not
 * indices are ignored, exactly as `JSON.stringify` ignores them.
 *
 * `length` is read through its own descriptor rather than as `array.length`.
 * `Array.isArray` is true of a `Proxy` around an array, so the plain read is a
 * property *get* that runs the proxy's `get` trap — and a trap that does not
 * throw is worse than one that does, because it can answer differently on each
 * read or merely observe that it was consulted. A real array always carries
 * `length` as an own data property, so nothing is lost.
 */
function ownArrayItems(array: readonly unknown[]): readonly unknown[] | null {
  if (Object.getOwnPropertySymbols(array).length > 0) return null;

  const lengthDescriptor = Object.getOwnPropertyDescriptor(array, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) return null;
  const length: unknown = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;

  const items: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined) {
      items.push(undefined);
      continue;
    }
    if (!('value' in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
}

/**
 * An empty object carrying the same allowed plain-object prototype as its model.
 *
 * A `null`-prototype source must not become an `Object.prototype` copy: the two
 * behave differently on exactly the key this module has to get right.
 */
function emptyLike(model: object): Record<string, unknown> {
  return Object.getPrototypeOf(model) === null
    ? (Object.create(null) as Record<string, unknown>)
    : {};
}

/**
 * Creates an own enumerable data property, for **any** legal JSON key.
 *
 * Assignment is not safe here. `result['__proto__'] = value` does not create an
 * own property at all: it invokes the inherited `Object.prototype.__proto__`
 * setter, which changes the object's prototype and leaves the key absent. And
 * `__proto__` is an ordinary own key of `JSON.parse('{"__proto__":{}}')`, which
 * the domain's `JsonObject` contract permits — it reserves no key names — so
 * this is reachable valid data, not merely hostile JavaScript. The same applies
 * to any future accessor on `Object.prototype`.
 *
 * `Object.defineProperty` defines the property directly and invokes no setter.
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Canonical serialization                                                     */
/* -------------------------------------------------------------------------- */

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
 * non-finite number, a non-plain object, an object carrying an accessor or a
 * symbol key, a reference cycle (which makes `JSON.stringify` throw a
 * `RangeError`), and any value whose reflection itself throws — a `Proxy` trap,
 * for instance.
 *
 * `localeCompare` is deliberately not used: its result depends on the machine's
 * locale data, which would order keys one way on a laptop and another in a
 * container (INV-DET-001).
 *
 * For values that are JSON data, the bytes are exactly what the previous
 * always-throwing implementation produced.
 */
export function tryCanonicalRecordJson(value: unknown): CanonicalRecordAttempt {
  let json: string | null;
  try {
    // `ancestors` holds the objects on the current path only, so a value that is
    // merely shared between two branches stays legal while a true cycle fails.
    json = canonicalize(value, new Set<object>());
  } catch {
    // Reflection over an untrusted graph is the one operation here that can fail
    // outside this module's own rules, and a raw `TypeError` from a `Proxy` trap
    // must not become the caller's answer.
    return { ok: false };
  }
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

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = ownArrayItems(object);
      if (items === null) return null;

      const parts: string[] = [];
      for (const entry of items) {
        // An array hole or an explicit `undefined` has no JSON form:
        // `JSON.stringify` writes `null`, losing the difference.
        if (entry === undefined) return null;
        const part = canonicalize(entry, ancestors);
        if (part === null) return null;
        parts.push(part);
      }
      return `[${parts.join(',')}]`;
    }

    const own = ownDataEntries(object);
    if (own === null) return null;

    const entries = own
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

/* -------------------------------------------------------------------------- */
/* Isolation                                                                   */
/* -------------------------------------------------------------------------- */

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
 * string, would be a different record wearing the original's shape. The copy is
 * therefore **exact** for everything it accepts — every own enumerable string
 * key, `__proto__` included, is reproduced as an own data property on an object
 * carrying the source's own plain-object prototype.
 *
 * A property whose value is `undefined` is **preserved as a present key**, which
 * is where copying deliberately differs from canonicalizing. Comparison treats
 * absent and explicitly-undefined as the same record; copying must not decide
 * that question on a consumer's behalf, so it reproduces exactly what it was
 * given. A round trip through `JSON.stringify` would drop those keys, and would
 * drop `__proto__` on the way back in.
 *
 * Two branches that shared one object in the source hold two equal copies
 * afterwards. Structural equality is what every consumer of these records reads,
 * and no consumer reads reference identity, so de-aliasing changes nothing they
 * can observe.
 *
 * The returned value keeps the input's static type, which is sound for the
 * records this is used on: their fields are strings, numbers, booleans, arrays,
 * and plain objects, all of which survive the copy unchanged.
 */
export function tryCloneJsonRecord<T>(value: T): CloneRecordAttempt<T> {
  let copied: unknown | typeof FAILED;
  try {
    copied = cloneUntrusted(value, new Set<object>());
  } catch {
    return { ok: false };
  }
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

  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = ownArrayItems(object);
      if (items === null) return FAILED;

      const result: unknown[] = [];
      for (const entry of items) {
        const copied = cloneUntrusted(entry, ancestors);
        if (copied === FAILED) return FAILED;
        result.push(copied);
      }
      return result;
    }

    const own = ownDataEntries(object);
    if (own === null) return FAILED;

    const result = emptyLike(object);
    for (const [key, entry] of own) {
      const copied = cloneUntrusted(entry, ancestors);
      if (copied === FAILED) return FAILED;
      defineOwn(result, key, copied);
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
 * failure case to report. It reproduces own JSON keys as exactly as
 * `tryCloneJsonRecord` does, `__proto__` included: the input being validated
 * makes the copy total, not the key set narrower.
 */
export function cloneRecord<T>(record: T): T {
  return cloneValidated(record) as T;
}

function cloneValidated(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValidated);
  if (typeof value === 'object' && value !== null) {
    const result = emptyLike(value);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      defineOwn(result, key, cloneValidated(entry));
    }
    return result;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Untrusted reads                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The value of one own data property of an untrusted value, or `undefined`.
 *
 * `host.key` would invoke an accessor and inherit from the prototype chain; on
 * a hostile object either can throw, and neither is a read of the record's own
 * JSON data. This is the only property read the boundary needs before schema
 * validation, so it is the only one offered.
 */
export function tryReadOwnDataProperty(host: unknown, key: string): unknown {
  if (typeof host !== 'object' || host === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(host, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/**
 * The elements of an untrusted array as own data values, or `null`.
 *
 * `Array.isArray` is true of a `Proxy` whose target is an array, so ordinary
 * iteration over a value that passed that check can still run provider code and
 * throw. Reading the spine defensively keeps the boundary's promise that no raw
 * reflection failure escapes it.
 */
export function tryReadArrayItems(value: readonly unknown[]): readonly unknown[] | null {
  try {
    return ownArrayItems(value);
  } catch {
    return null;
  }
}

/**
 * The elements of an untrusted value that claims to be an array, or `null`.
 *
 * This is {@link tryReadArrayItems} with the array test itself guarded, and it
 * is what a boundary holding a bare `unknown` needs. `Array.isArray` looks
 * passive, but the specification's `IsArray` unwraps a `Proxy` to reach its
 * target, and on a **revoked** proxy it throws:
 *
 * ```text
 * const { proxy, revoke } = Proxy.revocable([], {});
 * revoke();
 * Array.isArray(proxy);
 * // TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
 * ```
 *
 * A revoked proxy is an ordinary value for a dependency to resolve with — it is
 * `typeof "object"` and not `null` — so an unguarded test there would let a raw
 * `TypeError`, with the engine's own wording, escape as this layer's failure
 * (INV-ADAPTER-001, INV-SEC-001).
 *
 * *Not an array* and *unreadable as one* both answer `null`, because a caller
 * that cannot iterate the result has the same problem either way, and telling
 * the two apart would mean describing a value that has refused to be inspected.
 */
export function tryReadArray(value: unknown): readonly unknown[] | null {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return null;
  }
  if (!isArray) return null;
  return tryReadArrayItems(value as readonly unknown[]);
}

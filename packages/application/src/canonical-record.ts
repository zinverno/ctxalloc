/**
 * Canonical comparison and isolation of JSON-safe domain records (DEC-039).
 *
 * Two operations the prepared-corpus provenance boundary needs, and nothing
 * else. Both are package-internal: neither is exported from the package entry
 * point, because a caller that depended on this exact serialization would be
 * depending on a comparison detail rather than on a contract.
 *
 * Every record these functions handle — `ContextBlock`, `SourceDocument`, and
 * their nested values — is already validated as JSON-safe by the domain
 * (`JsonObjectSchema` rejects `undefined`, functions, symbols, `bigint`, `Date`,
 * `NaN`, and `Infinity`). That is what makes a JSON walk a complete and exact
 * treatment rather than a lossy approximation.
 *
 * Neither function reads a clock, a random value, the filesystem, or the
 * environment (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/**
 * Deterministic JSON with object keys sorted by UTF-16 code unit.
 *
 * `JSON.stringify` alone is not enough for an equality test: it emits keys in
 * property insertion order, so two structurally identical records built in
 * different orders would serialize differently and compare unequal. A provider
 * that rebuilt a block field by field is doing nothing wrong, and rejecting it
 * for its key order would be a false positive.
 *
 * A key whose value is `undefined` is treated as absent, exactly as
 * `JSON.stringify` treats it. An explicitly-`undefined` optional field and an
 * omitted one describe the same record to every consumer downstream, so
 * distinguishing them here would reject a difference that does not exist.
 *
 * `localeCompare` is deliberately not used: its result depends on the machine's
 * locale data, which would make one comparison on a laptop and another in a
 * container (INV-DET-001).
 */
export function canonicalRecordJson(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map(canonicalRecordJson).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));
    const body = entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRecordJson(entry)}`)
      .join(',');
    return `{${body}}`;
  }

  // A non-JSON scalar cannot appear in a validated record, and `JSON.stringify`
  // returns `undefined` rather than a string for one. Rendering that as the
  // literal `"undefined"` keeps this function total: an unusable value compares
  // equal only to another unusable value, never to a real one.
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Structural deep copy of a JSON-safe record.
 *
 * The copy shares no object or array with its source, so a consumer that
 * mutates what it was handed cannot reach the original. `readonly` is a
 * compile-time annotation and stops nothing at runtime; an untrusted provider is
 * exactly the case where that distinction matters (INV-ADAPTER-004).
 *
 * The returned value keeps the input's static type. That is sound for the
 * validated records this is used on: their fields are strings, numbers,
 * booleans, arrays, and plain objects, all of which survive the copy unchanged.
 */
export function cloneRecord<T>(record: T): T {
  return cloneJson(record) as T;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneJson(entry);
    }
    return result;
  }
  return value;
}

import type { JsonObject, JsonValue } from '@ctxalloc/domain';

/**
 * Deterministic JSON for the local SQLite stores (DEC-042).
 *
 * Two things stored as text must be comparable as text. `putTrace` decides
 * whether a second write is the same record or a conflicting one, and a plain
 * `JSON.stringify` would answer that by property insertion order — so a trace
 * rebuilt field by field, or round-tripped through a parser that ordered keys
 * differently, would look like a different audit record and be rejected
 * (INV-DET-002).
 *
 * The helpers are package-internal. They are never re-exported from
 * `@ctxalloc/adapters`, and no public declaration names them.
 */

/** Locale-independent lexical comparison over UTF-16 code units. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serializes JSON data with object keys sorted recursively and array order
 * preserved.
 *
 * The input is always a value a domain schema has already parsed, which
 * restricts it to JSON-safe values, so no cyclic, `undefined`, `NaN`, or
 * class-instance value can reach this function.
 */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Parses stored JSON into a plain object, or `null` when the text is not one.
 *
 * A stored row is external data even though this process may have written it:
 * the file is on an operator's disk, a previous build may have written it, and
 * `JSON.parse` succeeds on `"7"` and `"[]"` as readily as on an object. A
 * malformed or wrongly typed value is reported as `null` so the caller can raise
 * its own stable code, rather than letting a `SyntaxError` escape the adapter
 * (INV-ADAPTER-001, INV-BLOCK-005).
 *
 * `JSON.parse` defines an own `__proto__` data property rather than assigning
 * through the setter, so no stored key can reach a prototype. The result is
 * inspected for a plain prototype anyway, because that is the property the
 * caller relies on.
 */
export function parseStoredJsonObject(text: string): JsonObject | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's message quotes the offending text, which is stored data.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const prototype: unknown = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return parsed as JsonObject;
}

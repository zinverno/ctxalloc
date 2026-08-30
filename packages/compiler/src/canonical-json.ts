/**
 * Deterministic serialization of validated JSON-safe project data.
 *
 * Object keys are sorted recursively and array order is preserved, so two
 * records that differ only in JavaScript property insertion order serialize
 * identically. A plain `JSON.stringify` would not: it emits keys in insertion
 * order, which an adapter, a database driver, or a JSON parser can vary between
 * runs, and comparing or ordering records with it would invent differences that
 * do not exist (INV-DET-002).
 *
 * Two compiler stages depend on producing the same string from the same record:
 * `CandidateValidator` compares canonical `ContextBlock` records to detect one
 * block ID standing for two different records, and `CandidateDeduplicator`
 * orders structurally distinct candidate wrappers that share a block ID. Two
 * implementations of one rule would be free to drift, so the rule is owned once,
 * here (INV-DEP-003).
 *
 * The helper is internal to the compiler kernel. It is never re-exported from
 * the package entry point, and no public declaration names it (INV-ADAPTER-001).
 *
 * The input is always a record the domain schemas have already parsed, which
 * restricts it to JSON-safe values, so no cyclic, `undefined`, `NaN`, or
 * class-instance value can reach this function.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Locale-independent lexical comparison over UTF-16 code units.
 *
 * `localeCompare` is deliberately not used: its result depends on the machine's
 * locale and on the ICU data the runtime was built with, which would make an
 * ordering decision differ between machines (INV-DET-002).
 */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

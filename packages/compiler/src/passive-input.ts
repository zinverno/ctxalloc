/**
 * Candidate records arrive from a provider. Validate a passive snapshot so a
 * nested accessor, cycle, or revoked Proxy cannot execute inside the schema.
 * Schema rules still own ordinary malformed values; no candidate is repaired.
 */
export function snapshotCompilerInput(
  input: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const ancestors = new Set<object>();
  function copy(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    if (ancestors.has(value)) throw new Error();
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new Error();
    const result: object = array ? [] : Object.create(prototype as object | null);
    ancestors.add(value);
    try {
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !('value' in descriptor)) throw new Error();
        Object.defineProperty(result, key, { ...descriptor, value: copy(descriptor.value) });
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  try {
    return { ok: true, value: copy(input) };
  } catch {
    return { ok: false };
  }
}

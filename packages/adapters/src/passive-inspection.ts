/**
 * Passive, total inspection of untrusted runtime values for the local SQLite
 * stores (DEC-042).
 *
 * Everything these adapters are handed at run time is untrusted: a
 * configuration object, a registration, a trace envelope, and a scope all
 * arrive as `unknown` from a caller this package does not control. Any of them
 * may be a `Proxy` whose `ownKeys` or `getOwnPropertyDescriptor` trap throws, an
 * object carrying a throwing accessor, or a **revoked** `Proxy` — which is
 * `typeof "object"` and not `null`, so it passes every structural check, and
 * which refuses every reflective operation including `Array.isArray`.
 *
 * A bare `Object.keys`, a destructuring, or a `value.field` read would then let
 * a raw `TypeError` — carrying the engine's wording or a message the inspected
 * value chose — escape as this adapter's failure, which is exactly what the
 * adapter error contract forbids (INV-ADAPTER-001, INV-ADAPTER-003,
 * INV-SEC-001).
 *
 * So every helper here reports failure as data, and **no accessor is ever
 * invoked and no `get` trap is ever used**. Catching what a getter throws is not
 * enough: by then it has already run, and a getter that does *not* throw can
 * mutate state, answer differently on each read, or merely observe that it was
 * consulted. Every field these adapters need is plain data, so nothing is lost
 * by refusing to run code for it.
 *
 * These helpers are deliberately small and answer only the questions the local
 * stores ask. `minisearch-candidate-provider.ts` keeps its own array-spine
 * inspection because that carries provider-specific rules about candidate
 * shape; sharing only the generic reads keeps each boundary's rules where they
 * belong (INV-DEP-003).
 *
 * This module is package-internal and is never re-exported from
 * `@ctxalloc/adapters`.
 */

/**
 * The value of one own **data** property, or `undefined`.
 *
 * A missing property, an own accessor, and a throwing reflective trap all answer
 * `undefined`. The three are not distinguished because no caller here acts on
 * the difference: each of them means *this value does not offer readable data
 * under that name*, and every caller rejects the input for that one reason.
 */
export function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` is an array, or `null` when even that cannot be determined.
 *
 * `Array.isArray` looks passive and almost always is, but the specification's
 * `IsArray` unwraps a `Proxy` to reach its target, and on a revoked proxy that
 * throws:
 *
 * ```text
 * const { proxy, revoke } = Proxy.revocable([], {});
 * revoke();
 * Array.isArray(proxy);
 * // TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
 * ```
 *
 * The question is answered only this way. Probing the value some other way to
 * decide whether it is an array would mean inspecting a value that has already
 * refused to be inspected.
 */
export function tryIsArray(value: unknown): boolean | null {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

/** Own enumerable string keys, or `null` when the `ownKeys` trap threw. */
export function tryOwnEnumerableKeys(value: object): readonly string[] | null {
  try {
    return Object.keys(value);
  } catch {
    return null;
  }
}

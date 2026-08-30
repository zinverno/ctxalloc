/**
 * Shared rendering of compiler-stage validation issues.
 *
 * A `ValidationIssue` addresses a problem by `path` and renders that path as a
 * `pointer` for logs and human-facing output. Every compiler stage must render
 * the same path the same way, and must bound an untrusted string the same way
 * before putting it in a message: a consumer that reads a pointer from one stage
 * and a pointer from another must not have to learn two spellings, and a stage
 * that quoted an unbounded provider string would let source content decide the
 * size of an error message (INV-SEC-001).
 *
 * Two implementations of one rule would be free to drift, so the rule is owned
 * once, here (INV-DEP-003). The module is internal to the compiler kernel: it is
 * never re-exported from the package entry point, and no public declaration
 * names it (INV-ADAPTER-001).
 */

/** Serializable location of a problem inside a validated input. */
export type IssuePath = readonly (string | number)[];

/**
 * Renders a path the same way the domain renders one, so an issue raised by a
 * schema and an issue raised by a cross-record rule are addressed identically by
 * a consumer.
 */
export function pointerFor(path: IssuePath): string {
  return path.reduce<string>((pointer, segment) => {
    if (typeof segment === 'number') return `${pointer}[${String(segment)}]`;
    return pointer.length === 0 ? segment : `${pointer}.${segment}`;
  }, '');
}

/** Bounded rendering of an untrusted string for an issue message. */
export function quote(value: string): string {
  const MAX_CODE_POINTS = 60;
  const codePoints = [...value];
  if (codePoints.length <= MAX_CODE_POINTS) return JSON.stringify(value);
  return `${JSON.stringify(codePoints.slice(0, MAX_CODE_POINTS).join(''))}... (${String(codePoints.length)} code points)`;
}

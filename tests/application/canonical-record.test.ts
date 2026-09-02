import { describe, expect, it } from 'vitest';
import {
  cloneRecord,
  tryCanonicalRecordJson,
  tryCloneJsonRecord,
  tryReadArrayItems,
  tryReadOwnDataProperty,
} from '../../packages/application/src/canonical-record.js';

/**
 * The canonical helpers behind the prepared-corpus provenance boundary
 * (DEC-039).
 *
 * These are exercised through their module path rather than the package entry
 * point, because they are deliberately not exported: they are comparison
 * mechanics, not a contract. They run over untrusted provider output, so the
 * property that matters most is **totality** — no input may make them throw.
 */

/** Values that are not JSON data, each of which breaks a naive `JSON.stringify`. */
const NOT_JSON: readonly (readonly [string, () => unknown])[] = [
  ['bigint', (): unknown => 1n],
  ['symbol', (): unknown => Symbol('s')],
  ['function', (): unknown => (): void => undefined],
  ['NaN', (): unknown => Number.NaN],
  ['Infinity', (): unknown => Number.POSITIVE_INFINITY],
  ['-Infinity', (): unknown => Number.NEGATIVE_INFINITY],
  ['Date', (): unknown => new Date(0)],
  ['Map', (): unknown => new Map([['a', 1]])],
  ['Set', (): unknown => new Set([1])],
  ['RegExp', (): unknown => /x/g],
  ['class instance', (): unknown => new (class Holder {})()],
];

describe('tryCanonicalRecordJson: total over untrusted values', () => {
  it.each(NOT_JSON)('reports %s as un-canonicalizable instead of throwing', (_name, make) => {
    expect(() => tryCanonicalRecordJson(make())).not.toThrow();
    expect(tryCanonicalRecordJson(make()).ok).toBe(false);

    // Nested at any depth, and inside an array, with the same answer.
    expect(tryCanonicalRecordJson({ metadata: { deep: make() } }).ok).toBe(false);
    expect(tryCanonicalRecordJson({ list: [1, make()] }).ok).toBe(false);
  });

  it('reports an undefined array entry as un-canonicalizable', () => {
    // `JSON.stringify` writes `null` for an array hole or an explicit
    // `undefined`, which would lose the difference between the two.
    expect(tryCanonicalRecordJson([1, undefined, 2]).ok).toBe(false);
    expect(tryCanonicalRecordJson({ list: [undefined] }).ok).toBe(false);
  });

  it('reports a reference cycle instead of throwing a RangeError', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => tryCanonicalRecordJson(cyclic)).not.toThrow();
    expect(tryCanonicalRecordJson(cyclic).ok).toBe(false);

    const viaArray: Record<string, unknown> = {};
    viaArray.items = [viaArray];
    expect(tryCanonicalRecordJson(viaArray).ok).toBe(false);
  });

  it('accepts a value shared between two branches, which is not a cycle', () => {
    const shared = { x: 1 };
    const attempt = tryCanonicalRecordJson({ a: shared, b: shared });
    expect(attempt.ok).toBe(true);
    expect(attempt.ok && attempt.json).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('never lets a Date compare equal to an empty object', () => {
    // The dangerous case: `Object.entries(new Date())` is empty, so a naive
    // serializer renders it as `{}` and a forged record compares equal to a
    // prepared one.
    expect(tryCanonicalRecordJson({ m: new Date(0) }).ok).toBe(false);
    const empty = tryCanonicalRecordJson({ m: {} });
    expect(empty.ok && empty.json).toBe('{"m":{}}');
  });

  it('rejects a record carrying a symbol-keyed property', () => {
    const withSymbol: Record<string, unknown> = { a: 1 };
    (withSymbol as Record<symbol, unknown>)[Symbol('hidden')] = 'invisible to JSON';
    expect(tryCanonicalRecordJson(withSymbol).ok).toBe(false);
  });
});

describe('tryCanonicalRecordJson: canonical bytes', () => {
  it('sorts object keys by UTF-16 code unit, not by locale', () => {
    const attempt = tryCanonicalRecordJson({ b: 1, A: 2, a: 3, B: 4, ä: 5, Z: 6 });
    // Code-unit order puts every uppercase letter before every lowercase one,
    // and 'ä' (U+00E4) last. A locale-aware collator would interleave them.
    expect(attempt.ok && attempt.json).toBe('{"A":2,"B":4,"Z":6,"a":3,"b":1,"ä":5}');
  });

  it('produces the same bytes for the same record built in a different order', () => {
    const one = tryCanonicalRecordJson({ a: 1, b: { c: 2, d: [3, 4] } });
    const other = tryCanonicalRecordJson({ b: { d: [3, 4], c: 2 }, a: 1 });
    expect(one.ok && other.ok && one.json === other.json).toBe(true);
  });

  it('preserves array order, which is significant', () => {
    const forward = tryCanonicalRecordJson([1, 2, 3]);
    const reversed = tryCanonicalRecordJson([3, 2, 1]);
    expect(forward.ok && forward.json).toBe('[1,2,3]');
    expect(forward.ok && reversed.ok && forward.json === reversed.json).toBe(false);
  });

  it('preserves exact strings, normalizing nothing', () => {
    const content = ' líne\r\n  two\ttab 🌍 é vs é ';
    const attempt = tryCanonicalRecordJson({ content });
    expect(attempt.ok && attempt.json).toBe(`{"content":${JSON.stringify(content)}}`);
    // Composed and decomposed forms stay distinct: no Unicode normalization.
    expect(tryCanonicalRecordJson({ c: 'é' }).ok && tryCanonicalRecordJson({ c: 'é' }).ok).toBe(
      true,
    );
    expect(
      (tryCanonicalRecordJson({ c: 'é' }) as { json: string }).json ===
        (tryCanonicalRecordJson({ c: 'é' }) as { json: string }).json,
    ).toBe(false);
  });

  it('treats an explicitly-undefined property as absent, exactly as JSON does', () => {
    const present = tryCanonicalRecordJson({ a: 1, b: undefined });
    const omitted = tryCanonicalRecordJson({ a: 1 });
    expect(present.ok && present.json).toBe('{"a":1}');
    expect(present.ok && omitted.ok && present.json === omitted.json).toBe(true);
  });

  it('emits the documented bytes for scalars and empty containers', () => {
    const cases: readonly (readonly [unknown, string])[] = [
      [null, 'null'],
      [true, 'true'],
      [false, 'false'],
      [0, '0'],
      [-1.5, '-1.5'],
      ['', '""'],
      [[], '[]'],
      [{}, '{}'],
      [{ nested: { empty: [] } }, '{"nested":{"empty":[]}}'],
    ];
    for (const [value, expected] of cases) {
      const attempt = tryCanonicalRecordJson(value);
      expect(attempt.ok && attempt.json, JSON.stringify(value)).toBe(expected);
    }
  });

  it('emits the committed canonical bytes for a block-shaped record', () => {
    // A golden vector, computed independently from the documented rule and
    // unchanged since the prepared-corpus boundary was introduced. It locks the
    // serialization: any drift in key ordering, escaping, or field handling
    // would change which provider blocks compare equal to a prepared one.
    const block = {
      id: 'context-block:sha256:abc',
      schemaVersion: 1,
      scope: { workspaceId: 'default', tenantId: 'local' },
      sourceDocumentId: 'source-document:sha256:def',
      sourceType: 'markdown',
      sourceLocation: {
        kind: 'text-range',
        endOffset: 12,
        startOffset: 0,
        startLine: 1,
        endLine: 2,
      },
      content: 'Body  \r\n text 🌍',
      normalizedContentHash: 'sha256:012',
      tokenCount: 3,
      headingPath: ['Budgets', 'Rendering'],
      createdAt: '2026-01-31T09:15:00.000Z',
      attributes: {},
      metadata: {
        tokenization: { tokenizerId: 't', tokenizerVersion: '1' },
        source: { path: 'a.md' },
      },
    };

    const attempt = tryCanonicalRecordJson(block);
    expect(attempt.ok && attempt.json).toBe(
      '{"attributes":{},"content":"Body  \\r\\n text 🌍","createdAt":"2026-01-31T09:15:00.000Z",' +
        '"headingPath":["Budgets","Rendering"],"id":"context-block:sha256:abc",' +
        '"metadata":{"source":{"path":"a.md"},"tokenization":{"tokenizerId":"t","tokenizerVersion":"1"}},' +
        '"normalizedContentHash":"sha256:012","schemaVersion":1,' +
        '"scope":{"tenantId":"local","workspaceId":"default"},' +
        '"sourceDocumentId":"source-document:sha256:def",' +
        '"sourceLocation":{"endLine":2,"endOffset":12,"kind":"text-range","startLine":1,"startOffset":0},' +
        '"sourceType":"markdown","tokenCount":3}',
    );
  });

  it('matches JSON.stringify for any record whose keys are already sorted', () => {
    // The compatibility guarantee: for JSON data, canonical bytes are the bytes
    // the previous always-throwing implementation produced.
    const record = { a: 1, b: 'two', c: [1, 2, { d: null }], e: { f: true } };
    const attempt = tryCanonicalRecordJson(record);
    expect(attempt.ok && attempt.json).toBe(JSON.stringify(record));
  });
});

describe('tryCloneJsonRecord', () => {
  it.each(NOT_JSON)('reports %s as un-copyable instead of throwing', (_name, make) => {
    expect(() => tryCloneJsonRecord({ metadata: { deep: make() } })).not.toThrow();
    expect(tryCloneJsonRecord({ metadata: { deep: make() } }).ok).toBe(false);
  });

  it('copies an undefined array entry rather than rejecting it', () => {
    // Copying and comparing answer different questions, so they differ here on
    // purpose. Comparison cannot represent this value; copying can reproduce it
    // exactly, and the candidate carrying it is then rejected by
    // `CandidateValidator`, which owns that decision.
    const attempt = tryCloneJsonRecord({ list: [1, undefined, 2] });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.value.list).toHaveLength(3);
    expect(attempt.value.list[1]).toBeUndefined();
    expect(tryCanonicalRecordJson({ list: [1, undefined, 2] }).ok).toBe(false);
  });

  it('reports a reference cycle instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => tryCloneJsonRecord(cyclic)).not.toThrow();
    expect(tryCloneJsonRecord(cyclic).ok).toBe(false);
  });

  it('copies deeply, sharing no object with its source', () => {
    const source = { a: { b: [1, { c: 2 }] }, d: 'text' };
    const attempt = tryCloneJsonRecord(source);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    expect(attempt.value).toEqual(source);
    expect(attempt.value).not.toBe(source);
    expect(attempt.value.a).not.toBe(source.a);
    expect(attempt.value.a.b).not.toBe(source.a.b);
    expect(attempt.value.a.b[1]).not.toBe(source.a.b[1]);

    // Mutating the source afterwards cannot reach the copy.
    source.a.b.push(99);
    (source.a.b[1] as { c: number }).c = 42;
    expect(attempt.value).toEqual({ a: { b: [1, { c: 2 }] }, d: 'text' });
  });

  it('preserves an explicitly-undefined property as a present key', () => {
    // Where copying deliberately differs from canonicalizing: a round trip
    // through `JSON.stringify` would drop the key and change the record.
    const attempt = tryCloneJsonRecord({ a: 1, b: undefined });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(Object.keys(attempt.value).sort()).toEqual(['a', 'b']);
    expect(attempt.value.b).toBeUndefined();
  });

  it('accepts a value shared between two branches', () => {
    const shared = { x: 1 };
    const attempt = tryCloneJsonRecord({ a: shared, b: shared });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.value).toEqual({ a: { x: 1 }, b: { x: 1 } });
    // The copy no longer shares the sub-object, which is the point.
    expect(attempt.value.a).not.toBe(attempt.value.b);
  });
});

describe('cloneRecord', () => {
  it('deep-copies a validated record', () => {
    const source = { id: 'x', metadata: { tags: ['a'], nested: { n: 1 } } };
    const copy = cloneRecord(source);

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.metadata.tags).not.toBe(source.metadata.tags);

    source.metadata.tags.push('b');
    source.metadata.nested.n = 2;
    expect(copy.metadata).toEqual({ tags: ['a'], nested: { n: 1 } });
  });
});

describe('arbitrary JSON object keys', () => {
  /**
   * `__proto__` is an ordinary own key of a `JSON.parse` result, and the domain
   * models JSON object keys as arbitrary strings — `JsonObject` reserves no
   * names. Copying such a record with `result[key] = value` does not reproduce
   * it: the assignment invokes the inherited `Object.prototype.__proto__`
   * setter, so the copy loses the key and gains a different prototype. That is
   * a silently wrong copy of valid data, not a hostile-input edge case.
   */
  const withProtoKey = (): Record<string, unknown> =>
    JSON.parse('{"__proto__":{"x":1},"safe":1}') as Record<string, unknown>;

  it('reads an own __proto__ key as ordinary data', () => {
    const source = withProtoKey();
    expect(Object.getOwnPropertyNames(source)).toEqual(['__proto__', 'safe']);
    expect(tryCanonicalRecordJson(source)).toEqual({
      ok: true,
      json: '{"__proto__":{"x":1},"safe":1}',
    });
  });

  it('copies an own __proto__ key as an own data property', () => {
    const source = withProtoKey();
    const attempt = tryCloneJsonRecord(source);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    const copy = attempt.value;
    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyNames(copy)).toEqual(['__proto__', 'safe']);
    expect(Object.getOwnPropertyDescriptor(copy, '__proto__')).toEqual({
      value: { x: 1 },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    // The prototype is untouched: the key stayed data, it did not become one.
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(tryCanonicalRecordJson(copy)).toEqual(tryCanonicalRecordJson(source));
  });

  it('copies a nested own __proto__ key', () => {
    const source = JSON.parse('{"metadata":{"__proto__":{"x":1}}}') as Record<string, unknown>;
    const attempt = tryCloneJsonRecord(source);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    const nested = (attempt.value as { metadata: object }).metadata;
    expect(Object.prototype.hasOwnProperty.call(nested, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(tryCanonicalRecordJson(attempt.value)).toEqual(tryCanonicalRecordJson(source));
  });

  it('copies constructor and prototype keys', () => {
    const source = JSON.parse('{"constructor":"c","prototype":"p","toString":"t"}') as Record<
      string,
      unknown
    >;
    const attempt = tryCloneJsonRecord(source);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;

    expect(Object.getOwnPropertyNames(attempt.value)).toEqual([
      'constructor',
      'prototype',
      'toString',
    ]);
    expect(attempt.value).toEqual(source);
    expect(tryCanonicalRecordJson(attempt.value)).toEqual(tryCanonicalRecordJson(source));
  });

  it('copies a null-prototype record without giving it Object.prototype', () => {
    const source: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(source, '__proto__', {
      value: { x: 1 },
      writable: true,
      enumerable: true,
      configurable: true,
    });

    const attempt = tryCloneJsonRecord(source);
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(Object.getPrototypeOf(attempt.value)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(attempt.value, '__proto__')).toBe(true);
  });

  it('gives cloneRecord the same guarantees for a validated record', () => {
    const source = withProtoKey();
    const copy = cloneRecord(source);

    expect(Object.prototype.hasOwnProperty.call(copy, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyNames(copy)).toEqual(['__proto__', 'safe']);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(tryCanonicalRecordJson(copy)).toEqual(tryCanonicalRecordJson(source));

    const nested = JSON.parse('{"metadata":{"__proto__":{"x":1}}}') as Record<string, unknown>;
    const nestedCopy = cloneRecord(nested) as { metadata: object };
    expect(Object.prototype.hasOwnProperty.call(nestedCopy.metadata, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(nestedCopy.metadata)).toBe(Object.prototype);
  });
});

describe('total over active object graphs', () => {
  /**
   * Reflection is the one operation these helpers perform that the *input* can
   * control. An enumerable accessor is enough: `Object.entries` would invoke it,
   * and a throwing getter would escape this boundary as a raw `Error` before
   * `CandidateValidator` ever saw the candidate.
   *
   * Two guarantees are asserted together. The helpers never invoke an accessor —
   * a getter is free to return a different value on each read, and this module
   * reads the same untrusted record twice, so an accessor-bearing record is not
   * the fixed JSON data the comparison assumes. And no reflective failure
   * escapes: a `Proxy` trap that throws produces `ok: false`, not an exception.
   */
  const withThrowingGetter = (): object => {
    const host: Record<string, unknown> = { id: 'block-1' };
    Object.defineProperty(host, 'metadata', {
      enumerable: true,
      configurable: true,
      get(): never {
        throw new Error('accessor invoked');
      },
    });
    return host;
  };

  it('reports a record carrying a throwing enumerable getter, without invoking it', () => {
    expect(() => tryCanonicalRecordJson(withThrowingGetter())).not.toThrow();
    expect(tryCanonicalRecordJson(withThrowingGetter()).ok).toBe(false);
    expect(() => tryCloneJsonRecord(withThrowingGetter())).not.toThrow();
    expect(tryCloneJsonRecord(withThrowingGetter()).ok).toBe(false);

    // Nested, where the accessor is not the value handed in directly.
    expect(tryCanonicalRecordJson({ block: withThrowingGetter() }).ok).toBe(false);
    expect(tryCloneJsonRecord({ block: withThrowingGetter() }).ok).toBe(false);
  });

  it('reports a record carrying a non-throwing accessor rather than reading it twice', () => {
    let reads = 0;
    const host: Record<string, unknown> = {};
    Object.defineProperty(host, 'drifting', {
      enumerable: true,
      configurable: true,
      get(): number {
        reads += 1;
        return reads;
      },
    });

    expect(tryCanonicalRecordJson(host).ok).toBe(false);
    expect(tryCloneJsonRecord(host).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it.each([
    [
      'getPrototypeOf',
      {
        getPrototypeOf: (): never => {
          throw new Error('trap');
        },
      },
    ],
    [
      'ownKeys',
      {
        ownKeys: (): never => {
          throw new Error('trap');
        },
      },
    ],
    [
      'getOwnPropertyDescriptor',
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error('trap');
        },
      },
    ],
  ] as const)('reports a Proxy whose %s trap throws', (_name, handler) => {
    const make = (): unknown => new Proxy({ a: 1 }, handler as ProxyHandler<object>);

    expect(() => tryCanonicalRecordJson(make())).not.toThrow();
    expect(tryCanonicalRecordJson(make()).ok).toBe(false);
    expect(() => tryCloneJsonRecord(make())).not.toThrow();
    expect(tryCloneJsonRecord(make()).ok).toBe(false);

    expect(() => tryCanonicalRecordJson({ block: make() })).not.toThrow();
    expect(tryCanonicalRecordJson({ block: make() }).ok).toBe(false);
    expect(() => tryCloneJsonRecord({ block: make() })).not.toThrow();
    expect(tryCloneJsonRecord({ block: make() }).ok).toBe(false);
  });

  it('reads through a Proxy whose get trap throws, because it never uses get', () => {
    // Not an oversight: reading own *descriptors* rather than properties is what
    // makes an accessor unreachable, and it makes this trap unreachable too. The
    // values seen are the target's own data, which is the record being proposed.
    const make = (): unknown =>
      new Proxy(
        { a: 1 },
        {
          get: (): never => {
            throw new Error('trap');
          },
        },
      );

    expect(() => tryCanonicalRecordJson(make())).not.toThrow();
    expect(tryCanonicalRecordJson(make())).toEqual({ ok: true, json: '{"a":1}' });
    expect(() => tryCloneJsonRecord(make())).not.toThrow();
    expect(tryCloneJsonRecord(make())).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports an array whose element is an accessor', () => {
    const list: unknown[] = [];
    Object.defineProperty(list, '0', {
      enumerable: true,
      configurable: true,
      get(): never {
        throw new Error('accessor invoked');
      },
    });
    Object.defineProperty(list, 'length', { value: 1, writable: true });

    expect(() => tryCanonicalRecordJson(list)).not.toThrow();
    expect(tryCanonicalRecordJson(list).ok).toBe(false);
    expect(() => tryCloneJsonRecord(list)).not.toThrow();
    expect(tryCloneJsonRecord(list).ok).toBe(false);
  });
});

describe('tryReadOwnDataProperty', () => {
  it('reads an own data property, including an own __proto__ key', () => {
    const host = JSON.parse('{"block":{"id":"b1"},"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(tryReadOwnDataProperty(host, 'block')).toEqual({ id: 'b1' });
    expect(tryReadOwnDataProperty(host, '__proto__')).toEqual({ x: 1 });
  });

  it('returns undefined for a missing, inherited, or non-object host', () => {
    expect(tryReadOwnDataProperty({}, 'block')).toBeUndefined();
    // `toString` lives on the prototype, and an inherited value is not the
    // record's own data.
    expect(tryReadOwnDataProperty({}, 'toString')).toBeUndefined();
    expect(tryReadOwnDataProperty(null, 'block')).toBeUndefined();
    expect(tryReadOwnDataProperty('text', 'length')).toBeUndefined();
  });

  it('returns undefined for an accessor instead of invoking it', () => {
    const host: Record<string, unknown> = {};
    Object.defineProperty(host, 'block', {
      enumerable: true,
      get(): never {
        throw new Error('accessor invoked');
      },
    });
    expect(() => tryReadOwnDataProperty(host, 'block')).not.toThrow();
    expect(tryReadOwnDataProperty(host, 'block')).toBeUndefined();
  });

  it('returns undefined when a Proxy trap throws', () => {
    const host = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error('trap');
        },
      },
    );
    expect(() => tryReadOwnDataProperty(host, 'block')).not.toThrow();
    expect(tryReadOwnDataProperty(host, 'block')).toBeUndefined();
  });
});

describe('tryReadArrayItems', () => {
  it('reads an ordinary array in order', () => {
    expect(tryReadArrayItems([1, 'a', { b: 2 }])).toEqual([1, 'a', { b: 2 }]);
    expect(tryReadArrayItems([])).toEqual([]);
  });

  it('reads a hole as undefined', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(tryReadArrayItems([1, , 3])).toEqual([1, undefined, 3]);
  });

  it('returns null when reading the spine throws', () => {
    const host = new Proxy([1, 2], {
      get: (): never => {
        throw new Error('trap');
      },
    });
    expect(() => tryReadArrayItems(host)).not.toThrow();
    expect(tryReadArrayItems(host)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  cloneRecord,
  tryCanonicalRecordJson,
  tryCloneJsonRecord,
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

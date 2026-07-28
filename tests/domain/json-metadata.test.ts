import { describe, expect, it } from 'vitest';
import { JsonObjectSchema, JsonValueSchema, safeParse } from '../../packages/domain/src/index.js';

describe('INV-BLOCK-005: metadata is runtime-validated JSON-safe data', () => {
  it('accepts deeply nested JSON values', () => {
    const value = {
      title: 'notes',
      counts: [1, 2, 3],
      nested: { flag: true, missing: null, deeper: { list: [{ a: 1 }] } },
    };
    const result = safeParse(JsonObjectSchema, value);
    expect(result.ok && result.value).toEqual(value);
  });

  it('accepts an empty object and empty array', () => {
    expect(safeParse(JsonObjectSchema, {}).ok).toBe(true);
    expect(safeParse(JsonValueSchema, []).ok).toBe(true);
  });

  it('preserves Unicode and emoji exactly', () => {
    const value = { emoji: '😀🇺🇦', cyrillic: 'Привет', cjk: '你好', combining: 'é' };
    const result = safeParse(JsonObjectSchema, value);
    expect(result.ok && result.value).toEqual(value);
  });

  it.each([
    ['NaN', { n: Number.NaN }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }],
    ['undefined', { u: undefined }],
    ['bigint', { b: 1n }],
    ['function', { f: () => 'x' }],
    ['symbol', { s: Symbol('x') }],
    ['Date instance', { d: new Date(0) }],
    ['Map instance', { m: new Map() }],
    ['nested NaN', { outer: { inner: [1, Number.NaN] } }],
  ])('rejects %s inside metadata', (_label, input) => {
    expect(safeParse(JsonObjectSchema, input).ok).toBe(false);
  });

  it('rejects a class instance that is not a plain object', () => {
    class Custom {
      readonly value = 1;
    }
    expect(safeParse(JsonObjectSchema, new Custom()).ok).toBe(false);
    expect(safeParse(JsonObjectSchema, { nested: new Custom() }).ok).toBe(false);
  });

  it('rejects a Date even though it exposes no enumerable own properties', () => {
    expect(Object.keys(new Date(0))).toEqual([]);
    expect(safeParse(JsonObjectSchema, new Date(0)).ok).toBe(false);
  });

  it('rejects an array or primitive as the metadata container', () => {
    expect(safeParse(JsonObjectSchema, [1, 2]).ok).toBe(false);
    expect(safeParse(JsonObjectSchema, 'text').ok).toBe(false);
    expect(safeParse(JsonObjectSchema, null).ok).toBe(false);
  });

  it('reports the path of an invalid top-level value', () => {
    const result = safeParse(JsonObjectSchema, { good: 1, bad: Number.NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.pointer).toBe('bad');
    }
  });

  it('reports a nested failure at the outermost non-JSON-safe key', () => {
    // A JSON value is a union, so the reported path stops at the key whose value
    // failed the union rather than descending to the offending leaf.
    const result = safeParse(JsonObjectSchema, { outer: { inner: Number.NaN } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.pointer).toBe('outer');
    }
  });

  it('survives a JSON stringify and parse round trip unchanged', () => {
    const value = { a: [1, 'two', null, true], b: { c: '😀' } };
    const parsed = safeParse(JsonObjectSchema, value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.value));
      expect(safeParse(JsonObjectSchema, roundTripped)).toEqual(parsed);
    }
  });
});

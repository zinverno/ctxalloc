import { describe, expect, it } from 'vitest';
import * as domain from '../../packages/domain/src/index.js';
import {
  ContentHashSchema,
  ContextBlockIdSchema,
  SourceDocumentIdSchema,
  safeParse,
} from '../../packages/domain/src/index.js';
import { VALID_HASH } from './fixtures.js';

describe('INV-BLOCK-001: identifiers are stable opaque values', () => {
  it.each([
    ['SourceDocumentId', SourceDocumentIdSchema],
    ['ContextBlockId', ContextBlockIdSchema],
  ])('%s accepts a non-empty opaque string unchanged', (_label, schema) => {
    const result = safeParse(schema, 'notes/architecture.md#heading-2');
    expect(result.ok && result.value).toBe('notes/architecture.md#heading-2');
  });

  it.each([
    ['SourceDocumentId', SourceDocumentIdSchema],
    ['ContextBlockId', ContextBlockIdSchema],
  ])('%s rejects empty and whitespace-only values', (_label, schema) => {
    expect(safeParse(schema, '').ok).toBe(false);
    expect(safeParse(schema, '   ').ok).toBe(false);
    expect(safeParse(schema, '\n\t').ok).toBe(false);
  });

  it.each([
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', { id: 'x' }],
  ])('rejects a %s identifier', (_label, input) => {
    expect(safeParse(SourceDocumentIdSchema, input).ok).toBe(false);
  });

  it('preserves surrounding whitespace rather than canonicalizing it', () => {
    const result = safeParse(ContextBlockIdSchema, ' block-1 ');
    expect(result.ok && result.value).toBe(' block-1 ');
  });
});

describe('INV-DET-003: the domain generates no identifiers', () => {
  it('exposes no generation, randomness, or uuid helper', () => {
    const generators = Object.keys(domain).filter((name) =>
      /generate|random|uuid|newId|createId/i.test(name),
    );
    expect(generators).toEqual([]);
  });
});

describe('INV-PROV-005: content hashes are validated content-derived values', () => {
  it('accepts the documented sha256 representation', () => {
    const result = safeParse(ContentHashSchema, VALID_HASH);
    expect(result.ok && result.value).toBe(VALID_HASH);
  });

  it.each([
    ['missing algorithm label', 'a'.repeat(64)],
    ['unknown algorithm', `md5:${'a'.repeat(32)}`],
    ['too short', `sha256:${'a'.repeat(63)}`],
    ['too long', `sha256:${'a'.repeat(65)}`],
    ['uppercase hex', `sha256:${'A'.repeat(64)}`],
    ['non-hex characters', `sha256:${'z'.repeat(64)}`],
    ['empty string', ''],
    ['whitespace padded', ` sha256:${'a'.repeat(64)} `],
  ])('rejects a hash with %s', (_label, input) => {
    expect(safeParse(ContentHashSchema, input).ok).toBe(false);
  });

  it('exposes no hashing function, because computation belongs to ingestion', () => {
    const hashers = Object.keys(domain).filter((name) => /^(hash|computeHash|sha)/i.test(name));
    expect(hashers).toEqual([]);
  });
});

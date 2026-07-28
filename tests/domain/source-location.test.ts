import { describe, expect, it } from 'vitest';
import { SourceLocationSchema, safeParse } from '../../packages/domain/src/index.js';

describe('INV-BLOCK-006: source boundaries must be valid', () => {
  it('accepts a text range', () => {
    const location = { kind: 'text-range', startOffset: 10, endOffset: 42 };
    expect(safeParse(SourceLocationSchema, location)).toEqual({ ok: true, value: location });
  });

  it('accepts zero offsets and an empty range', () => {
    expect(
      safeParse(SourceLocationSchema, { kind: 'text-range', startOffset: 0, endOffset: 0 }).ok,
    ).toBe(true);
  });

  it('accepts consistent optional line numbers', () => {
    const location = {
      kind: 'text-range',
      startOffset: 0,
      endOffset: 20,
      startLine: 3,
      endLine: 7,
    };
    expect(safeParse(SourceLocationSchema, location).ok).toBe(true);
  });

  it('accepts a single-line range', () => {
    const location = { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 4, endLine: 4 };
    expect(safeParse(SourceLocationSchema, location).ok).toBe(true);
  });

  it.each([
    ['negative startOffset', { kind: 'text-range', startOffset: -1, endOffset: 5 }],
    ['negative endOffset', { kind: 'text-range', startOffset: 0, endOffset: -5 }],
    ['reversed offsets', { kind: 'text-range', startOffset: 9, endOffset: 2 }],
    ['fractional offset', { kind: 'text-range', startOffset: 0.5, endOffset: 5 }],
    ['NaN offset', { kind: 'text-range', startOffset: Number.NaN, endOffset: 5 }],
    ['missing endOffset', { kind: 'text-range', startOffset: 0 }],
    ['zero startLine', { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 0 }],
    ['negative endLine', { kind: 'text-range', startOffset: 0, endOffset: 5, endLine: -2 }],
    [
      'reversed lines',
      { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 9, endLine: 3 },
    ],
    [
      'fractional line',
      { kind: 'text-range', startOffset: 0, endOffset: 5, startLine: 1.5, endLine: 3 },
    ],
  ])('rejects a text range with %s', (_label, input) => {
    expect(safeParse(SourceLocationSchema, input).ok).toBe(false);
  });

  it('reports reversed offsets on the endOffset path', () => {
    const result = safeParse(SourceLocationSchema, {
      kind: 'text-range',
      startOffset: 9,
      endOffset: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.pointer).toBe('endOffset');
    }
  });
});

describe('INV-PROV-002: conversation lineage uses a message identifier', () => {
  it('accepts a conversation message location', () => {
    const location = { kind: 'conversation-message', messageId: 'msg-17' };
    expect(safeParse(SourceLocationSchema, location)).toEqual({ ok: true, value: location });
  });

  it('accepts an optional message index', () => {
    const location = { kind: 'conversation-message', messageId: 'msg-17', messageIndex: 0 };
    expect(safeParse(SourceLocationSchema, location).ok).toBe(true);
  });

  it.each([
    ['empty messageId', { kind: 'conversation-message', messageId: '' }],
    ['whitespace messageId', { kind: 'conversation-message', messageId: '  ' }],
    ['missing messageId', { kind: 'conversation-message' }],
    ['negative index', { kind: 'conversation-message', messageId: 'm', messageIndex: -1 }],
  ])('rejects a conversation location with %s', (_label, input) => {
    expect(safeParse(SourceLocationSchema, input).ok).toBe(false);
  });
});

describe('source location discriminated union is closed', () => {
  it.each([
    ['unknown discriminant', { kind: 'pdf-page', page: 3 }],
    ['missing discriminant', { startOffset: 0, endOffset: 5 }],
    ['null input', null],
  ])('rejects %s', (_label, input) => {
    expect(safeParse(SourceLocationSchema, input).ok).toBe(false);
  });

  it('rejects fields borrowed from the other variant', () => {
    expect(
      safeParse(SourceLocationSchema, {
        kind: 'text-range',
        startOffset: 0,
        endOffset: 5,
        messageId: 'msg-1',
      }).ok,
    ).toBe(false);
  });
});

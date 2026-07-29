import {
  FakeTokenizer,
  FakeTokenizerConfigurationError,
  FakeTokenizerUnknownTextError,
  type FakeTokenizerEntry,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

describe('FakeTokenizer exact mapping', () => {
  it('returns the configured count for the configured text', () => {
    const tokenizer = new FakeTokenizer([{ text: 'alpha', tokens: 7 }]);
    expect(tokenizer.countTokens('alpha')).toBe(7);
  });

  it('returns a different count for a different exact string', () => {
    const tokenizer = new FakeTokenizer([
      { text: 'alpha', tokens: 7 },
      { text: 'beta', tokens: 3 },
    ]);
    expect(tokenizer.countTokens('alpha')).toBe(7);
    expect(tokenizer.countTokens('beta')).toBe(3);
  });

  it('supports an explicitly configured empty string', () => {
    const tokenizer = new FakeTokenizer([{ text: '', tokens: 0 }]);
    expect(tokenizer.countTokens('')).toBe(0);
  });

  it('accepts a configured count of zero for non-empty text', () => {
    const zeroWidthSpace = '\u200b';
    const tokenizer = new FakeTokenizer([{ text: zeroWidthSpace, tokens: 0 }]);
    expect(tokenizer.countTokens(zeroWidthSpace)).toBe(0);
  });

  it('exposes a default identity and accepts an explicit one', () => {
    expect(new FakeTokenizer([]).id).toBe('fake');
    expect(new FakeTokenizer([]).version).toBe('1');

    const named = new FakeTokenizer([], { id: 'fake-cl100k', version: '2024-01' });
    expect(named.id).toBe('fake-cl100k');
    expect(named.version).toBe('2024-01');
  });

  it('treats prototype-like text as ordinary keys', () => {
    const tokenizer = new FakeTokenizer([
      { text: '__proto__', tokens: 4 },
      { text: 'constructor', tokens: 5 },
      { text: 'toString', tokens: 6 },
    ]);
    expect(tokenizer.countTokens('__proto__')).toBe(4);
    expect(tokenizer.countTokens('constructor')).toBe(5);
    expect(tokenizer.countTokens('toString')).toBe(6);
  });
});

describe('FakeTokenizer preserves exact text', () => {
  it('keeps leading and trailing whitespace significant', () => {
    const tokenizer = new FakeTokenizer([
      { text: 'value', tokens: 1 },
      { text: ' value', tokens: 2 },
      { text: 'value ', tokens: 3 },
      { text: ' value ', tokens: 4 },
    ]);
    expect(tokenizer.countTokens('value')).toBe(1);
    expect(tokenizer.countTokens(' value')).toBe(2);
    expect(tokenizer.countTokens('value ')).toBe(3);
    expect(tokenizer.countTokens(' value ')).toBe(4);
  });

  it('treats LF and CRLF as distinct keys', () => {
    const tokenizer = new FakeTokenizer([
      { text: 'a\nb', tokens: 11 },
      { text: 'a\r\nb', tokens: 12 },
    ]);
    expect(tokenizer.countTokens('a\nb')).toBe(11);
    expect(tokenizer.countTokens('a\r\nb')).toBe(12);
  });

  it('does not apply Unicode normalization', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    const tokenizer = new FakeTokenizer([
      { text: composed, tokens: 21 },
      { text: decomposed, tokens: 22 },
    ]);
    expect(composed).not.toBe(decomposed);
    expect(tokenizer.countTokens(composed)).toBe(21);
    expect(tokenizer.countTokens(decomposed)).toBe(22);
  });

  it('INV-BLOCK-007: preserves emoji sequences and surrogate pairs', () => {
    const family = '👩‍👩‍👧‍👦';
    const clef = '𝄞';
    const tokenizer = new FakeTokenizer([
      { text: family, tokens: 31 },
      { text: clef, tokens: 32 },
    ]);
    expect(tokenizer.countTokens(family)).toBe(31);
    expect(tokenizer.countTokens(clef)).toBe(32);
    expect(() => tokenizer.countTokens(clef.charAt(0))).toThrow(FakeTokenizerUnknownTextError);
  });
});

describe('FakeTokenizer failure semantics', () => {
  it('INV-ADAPTER-003: fails explicitly for unconfigured text', () => {
    const tokenizer = new FakeTokenizer([{ text: 'alpha', tokens: 7 }]);
    expect(() => tokenizer.countTokens('gamma')).toThrow(FakeTokenizerUnknownTextError);

    try {
      tokenizer.countTokens('gamma');
      expect.unreachable('countTokens must throw for unconfigured text');
    } catch (error) {
      expect(error).toBeInstanceOf(FakeTokenizerUnknownTextError);
      const failure = error as FakeTokenizerUnknownTextError;
      expect(failure.code).toBe('FAKE_TOKENIZER_UNKNOWN_TEXT');
      expect(failure.text).toBe('gamma');
      expect(failure.message).toContain('"gamma"');
    }
  });

  it('INV-DET-001: reports the same failure message for the same unconfigured text', () => {
    const tokenizer = new FakeTokenizer([]);
    const first = (() => {
      try {
        tokenizer.countTokens('missing');
        return 'no error';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const second = (() => {
      try {
        tokenizer.countTokens('missing');
        return 'no error';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(second).toBe(first);
    expect(first).not.toBe('no error');
  });

  it('truncates long text in the failure message without splitting a code point', () => {
    const tokenizer = new FakeTokenizer([]);
    const long = '𝄞'.repeat(100);
    try {
      tokenizer.countTokens(long);
      expect.unreachable('countTokens must throw for unconfigured text');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('100 code points');
      expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(message).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('INV-BUDGET-005: rejects a negative count', () => {
    expect(() => new FakeTokenizer([{ text: 'alpha', tokens: -1 }])).toThrow(
      FakeTokenizerConfigurationError,
    );
  });

  it('INV-BUDGET-005: rejects a fractional count', () => {
    expect(() => new FakeTokenizer([{ text: 'alpha', tokens: 1.5 }])).toThrow(
      FakeTokenizerConfigurationError,
    );
  });

  it('INV-BUDGET-005: rejects NaN', () => {
    expect(() => new FakeTokenizer([{ text: 'alpha', tokens: Number.NaN }])).toThrow(
      FakeTokenizerConfigurationError,
    );
  });

  it('INV-BUDGET-005: rejects Infinity', () => {
    expect(() => new FakeTokenizer([{ text: 'alpha', tokens: Number.POSITIVE_INFINITY }])).toThrow(
      FakeTokenizerConfigurationError,
    );
    expect(() => new FakeTokenizer([{ text: 'alpha', tokens: Number.NEGATIVE_INFINITY }])).toThrow(
      FakeTokenizerConfigurationError,
    );
  });

  it('rejects an empty tokenizer id or version', () => {
    expect(() => new FakeTokenizer([], { id: '' })).toThrow(FakeTokenizerConfigurationError);
    expect(() => new FakeTokenizer([], { version: '' })).toThrow(FakeTokenizerConfigurationError);
  });

  it('INV-TRACE-005: rejects a whitespace-only tokenizer id', () => {
    for (const id of [' ', '   ', '\t', '\n', ' \r\n\t ']) {
      expect(() => new FakeTokenizer([], { id })).toThrow(FakeTokenizerConfigurationError);
    }
  });

  it('INV-TRACE-005: rejects a whitespace-only tokenizer version', () => {
    for (const version of [' ', '   ', '\t', '\n', ' \r\n\t ']) {
      expect(() => new FakeTokenizer([], { version })).toThrow(FakeTokenizerConfigurationError);
    }
  });

  it('keeps a surrounding-whitespace identity verbatim instead of trimming it', () => {
    const tokenizer = new FakeTokenizer([], { id: ' fake ', version: ' 1 ' });
    expect(tokenizer.id).toBe(' fake ');
    expect(tokenizer.version).toBe(' 1 ');
  });

  it('rejects a duplicate mapping for the same exact text', () => {
    expect(
      () =>
        new FakeTokenizer([
          { text: 'alpha', tokens: 7 },
          { text: 'alpha', tokens: 9 },
        ]),
    ).toThrow(FakeTokenizerConfigurationError);
  });

  it('rejects a duplicate mapping even when both counts are equal', () => {
    expect(
      () =>
        new FakeTokenizer([
          { text: 'alpha', tokens: 7 },
          { text: 'alpha', tokens: 7 },
        ]),
    ).toThrow(FakeTokenizerConfigurationError);
  });

  it('carries a stable configuration error code', () => {
    try {
      new FakeTokenizer([{ text: 'alpha', tokens: -1 }]);
      expect.unreachable('construction must throw for an invalid count');
    } catch (error) {
      expect((error as FakeTokenizerConfigurationError).code).toBe(
        'FAKE_TOKENIZER_INVALID_CONFIGURATION',
      );
    }
  });

  it('provides no heuristic fallback for text similar to a configured key', () => {
    const tokenizer = new FakeTokenizer([{ text: 'alpha', tokens: 7 }]);
    for (const text of ['Alpha', 'alpha ', 'alph', 'alphaa', 'al pha', '']) {
      expect(() => tokenizer.countTokens(text)).toThrow(FakeTokenizerUnknownTextError);
    }
  });
});

describe('FakeTokenizer stability', () => {
  it('INV-DET-001: repeated calls return the same count', () => {
    const tokenizer = new FakeTokenizer([
      { text: 'alpha', tokens: 7 },
      { text: 'beta', tokens: 3 },
    ]);
    const counts = [
      tokenizer.countTokens('alpha'),
      tokenizer.countTokens('beta'),
      tokenizer.countTokens('alpha'),
      tokenizer.countTokens('alpha'),
      tokenizer.countTokens('beta'),
    ];
    expect(counts).toEqual([7, 3, 7, 7, 3]);
  });

  it('does not mutate the supplied configuration', () => {
    const entries: FakeTokenizerEntry[] = [
      { text: 'alpha', tokens: 7 },
      { text: 'beta', tokens: 3 },
    ];
    const snapshot = structuredClone(entries);
    const tokenizer = new FakeTokenizer(entries);
    tokenizer.countTokens('alpha');
    expect(entries).toEqual(snapshot);
  });

  it('ignores configuration changes made after construction', () => {
    const entries: FakeTokenizerEntry[] = [{ text: 'alpha', tokens: 7 }];
    const tokenizer = new FakeTokenizer(entries);
    entries.push({ text: 'gamma', tokens: 9 });
    expect(tokenizer.countTokens('alpha')).toBe(7);
    expect(() => tokenizer.countTokens('gamma')).toThrow(FakeTokenizerUnknownTextError);
  });

  it('INV-DET-002: configuration order does not change behavior', () => {
    const entries: readonly FakeTokenizerEntry[] = [
      { text: 'alpha', tokens: 7 },
      { text: 'beta', tokens: 3 },
      { text: 'gamma', tokens: 5 },
    ];
    const forward = new FakeTokenizer(entries);
    const reversed = new FakeTokenizer([...entries].reverse());
    for (const { text } of entries) {
      expect(reversed.countTokens(text)).toBe(forward.countTokens(text));
    }
  });

  it('keeps two independently configured instances isolated', () => {
    const first = new FakeTokenizer([{ text: 'alpha', tokens: 7 }]);
    const second = new FakeTokenizer([{ text: 'alpha', tokens: 8 }]);
    expect(first.countTokens('alpha')).toBe(7);
    expect(second.countTokens('alpha')).toBe(8);
  });

  it('exposes no mutable configuration state on the instance', () => {
    const tokenizer = new FakeTokenizer([{ text: 'alpha', tokens: 7 }]);
    expect(Object.keys(tokenizer).sort()).toEqual(['id', 'version']);
  });
});

import {
  O200K_BASE_ENCODING,
  O200K_BASE_TOKENIZER_ID,
  O200K_BASE_TOKENIZER_VERSION,
  O200kBaseTokenizer,
  TokenizerInvalidUnicodeError,
} from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';
import { O200K_BASE_GOLDEN_FIXTURE, goldenCase } from './golden-fixture.js';

/**
 * Focused tests for the real `o200k_base` adapter.
 *
 * Building the rank table costs about a second, so the suite shares one instance
 * where independence is not the property under test and creates a second one only
 * where it is.
 */
const tokenizer = new O200kBaseTokenizer();

describe('O200kBaseTokenizer golden counts', () => {
  it('INV-TRACE-005: the fixture names the pinned adapter and encoding', () => {
    expect(O200K_BASE_GOLDEN_FIXTURE.fixtureSchemaVersion).toBe(1);
    expect(O200K_BASE_GOLDEN_FIXTURE.encoding).toBe('o200k_base');
    expect(O200K_BASE_GOLDEN_FIXTURE.adapter).toEqual({
      package: 'js-tiktoken',
      version: '1.0.21',
    });
    expect(O200K_BASE_GOLDEN_FIXTURE.oracle).toEqual({
      package: 'tiktoken',
      version: '0.12.0',
      method: 'encode_ordinary',
    });
  });

  it.each(O200K_BASE_GOLDEN_FIXTURE.cases.map((entry) => [entry.id, entry] as const))(
    'INV-DET-001: counts the golden case %s exactly',
    (_id, goldenTokenizerCase) => {
      expect(tokenizer.countTokens(goldenTokenizerCase.text)).toBe(
        goldenTokenizerCase.expectedTokens,
      );
    },
  );

  it('counts the empty string as zero tokens', () => {
    expect(goldenCase('empty').expectedTokens).toBe(0);
    expect(tokenizer.countTokens('')).toBe(0);
  });

  it('INV-BUDGET-005: every golden count is a finite non-negative integer', () => {
    for (const entry of O200K_BASE_GOLDEN_FIXTURE.cases) {
      const tokens = tokenizer.countTokens(entry.text);
      expect(Number.isSafeInteger(tokens), entry.id).toBe(true);
      expect(tokens).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('O200kBaseTokenizer counts the exact supplied text', () => {
  it('treats leading and trailing whitespace as significant', () => {
    const padded = goldenCase('ascii-whitespace-padded');
    expect(tokenizer.countTokens(padded.text)).toBe(padded.expectedTokens);
    expect(padded.text).toMatch(/^ {3}.* {3}$/);
    // The trimmed text is a different input and is counted as such.
    expect(tokenizer.countTokens(padded.text.trim())).not.toBe(padded.expectedTokens);
  });

  it('does not normalize CRLF into LF', () => {
    const lf = goldenCase('line-ending-lf-trailing-space');
    const crlf = goldenCase('line-ending-crlf-trailing-space');
    expect(crlf.text).toBe(lf.text.replaceAll('\n', '\r\n'));
    expect(tokenizer.countTokens(lf.text)).toBe(lf.expectedTokens);
    expect(tokenizer.countTokens(crlf.text)).toBe(crlf.expectedTokens);
    expect(crlf.expectedTokens).not.toBe(lf.expectedTokens);
  });

  it('INV-BLOCK-007: does not normalize NFD into NFC', () => {
    const composed = goldenCase('unicode-nfc-composed');
    const decomposed = goldenCase('unicode-nfd-decomposed');
    expect(decomposed.text.normalize('NFC')).toBe(composed.text);
    expect(decomposed.text).not.toBe(composed.text);
    expect(tokenizer.countTokens(composed.text)).toBe(composed.expectedTokens);
    expect(tokenizer.countTokens(decomposed.text)).toBe(decomposed.expectedTokens);
    expect(decomposed.expectedTokens).not.toBe(composed.expectedTokens);
  });

  it('INV-SEC-001: counts special-token-looking text as literal source text', () => {
    const literal = goldenCase('literal-special-token');
    expect(literal.text).toContain('<|endoftext|>');
    expect(tokenizer.countTokens(literal.text)).toBe(literal.expectedTokens);

    // A control-token interpretation would collapse the marker into one token or
    // raise a special-token error. Neither happens: it stays ordinary text.
    expect(tokenizer.countTokens('<|endoftext|>')).toBeGreaterThan(1);
    expect(tokenizer.countTokens('<|endofprompt|>')).toBeGreaterThan(1);
  });

  it('INV-DET-001: returns the same count for repeated calls', () => {
    for (const entry of O200K_BASE_GOLDEN_FIXTURE.cases) {
      expect(tokenizer.countTokens(entry.text)).toBe(entry.expectedTokens);
      expect(tokenizer.countTokens(entry.text)).toBe(entry.expectedTokens);
    }
  });

  it('INV-DET-001: returns the same count from an independent instance', () => {
    const independent = new O200kBaseTokenizer();
    for (const entry of O200K_BASE_GOLDEN_FIXTURE.cases) {
      expect(independent.countTokens(entry.text), entry.id).toBe(tokenizer.countTokens(entry.text));
    }
  });

  it('does not modify the supplied text', () => {
    for (const entry of O200K_BASE_GOLDEN_FIXTURE.cases) {
      const original = [...entry.text].join('');
      tokenizer.countTokens(entry.text);
      expect(entry.text).toBe(original);
    }
  });
});

describe('O200kBaseTokenizer INV-BLOCK-007: Unicode safety', () => {
  it.each([
    ['cyrillic', 'Кириллица и комбинирующие знаки'],
    ['japanese', '日本語のテキスト'],
    ['combining marks', 'e\u0301 a\u0300 n\u0303 o\u0308'],
    ['emoji', '🚀🌍'],
    ['emoji sequence', '👩‍👩‍👧‍👦'],
    ['supplementary plane', '𝄞 𝕏 𠮷'],
  ])('counts valid %s text', (_name, text) => {
    const tokens = tokenizer.countTokens(text);
    expect(Number.isSafeInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
  });

  it('accepts a valid surrogate pair', () => {
    const rocket = '\uD83D\uDE80';
    expect(rocket.length).toBe(2);
    expect(rocket).toBe(goldenCase('emoji-single').text);
    expect(tokenizer.countTokens(rocket)).toBe(goldenCase('emoji-single').expectedTokens);
  });

  it.each([
    ['lone high surrogate', '\uD800', 0],
    ['lone high surrogate between letters', 'a\uD83Db', 1],
    ['lone low surrogate', '\uDC00', 0],
    ['lone low surrogate between letters', 'a\uDE80b', 1],
    ['reversed surrogate pair', '\uDE80\uD83D', 0],
    ['doubled high surrogate', '\uD83D\uD83D', 0],
    ['high surrogate at end of text', 'context\uD83D', 7],
  ])('fails explicitly on a %s', (_name, text, index) => {
    expect(() => tokenizer.countTokens(text)).toThrow(TokenizerInvalidUnicodeError);
    try {
      tokenizer.countTokens(text);
      expect.unreachable('malformed UTF-16 must not be counted');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenizerInvalidUnicodeError);
      expect((error as TokenizerInvalidUnicodeError).code).toBe('TOKENIZER_INVALID_UNICODE');
      expect((error as TokenizerInvalidUnicodeError).index).toBe(index);
    }
  });

  it('does not repair malformed UTF-16 into a replacement character count', () => {
    const replacementCount = tokenizer.countTokens('�');
    expect(replacementCount).toBeGreaterThan(0);
    // A silent repair would have returned the replacement-character count here.
    expect(() => tokenizer.countTokens('\uD800')).toThrow(TokenizerInvalidUnicodeError);
  });
});

describe('O200kBaseTokenizer INV-TRACE-005: identity', () => {
  it('exposes the stable tokenizer identity', () => {
    expect(tokenizer.id).toBe('js-tiktoken:o200k_base');
    expect(tokenizer.version).toBe('1.0.21');
  });

  it('exports the identity as constants matching the instance', () => {
    expect(O200K_BASE_TOKENIZER_ID).toBe('js-tiktoken:o200k_base');
    expect(O200K_BASE_TOKENIZER_VERSION).toBe('1.0.21');
    expect(O200K_BASE_ENCODING).toBe('o200k_base');
    expect(tokenizer.id).toBe(O200K_BASE_TOKENIZER_ID);
    expect(tokenizer.version).toBe(O200K_BASE_TOKENIZER_VERSION);
  });
});

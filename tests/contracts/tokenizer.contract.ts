import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';

/**
 * Reusable contract for every implementation of the Tokenizer port
 * (INV-ADAPTER-005).
 *
 * The contract asserts capability-level properties only. It never asserts a
 * specific token count for arbitrary text, because different tokenizers
 * legitimately produce different counts for the same string; the single exception
 * is the empty string, which must cost zero tokens.
 */

/** ASCII text, including significant whitespace and both line endings. */
const PLAIN_TEXTS = [
  'The compiler selects final context.',
  '  leading and trailing whitespace  ',
  'first\nsecond',
  'first\r\nsecond',
] as const;

/** Combining marks, non-Latin scripts, a supplementary plane character, and an emoji sequence. */
const UNICODE_TEXTS = [
  'Grüße, mañana — ćwiczenie',
  'Кириллица и 日本語のテキスト',
  '𝄞 clef and 👩‍👩‍👧‍👦 family',
] as const;

/** Structured source text: Markdown and code. */
const STRUCTURED_TEXTS = [
  '# Heading\n\n- first item\n- second item\n',
  '```ts\nexport const budget = { totalTokens: 1000 } as const;\n```',
] as const;

/** Every text a contract fixture must be able to count. */
export const TOKENIZER_CONTRACT_TEXTS = [
  '',
  ...PLAIN_TEXTS,
  ...UNICODE_TEXTS,
  ...STRUCTURED_TEXTS,
] as const;

export interface TokenizerContractFixture {
  /** Name used in the generated test suite title. */
  readonly name: string;
  /** Creates an independent tokenizer able to count TOKENIZER_CONTRACT_TEXTS. */
  createTokenizer(): Tokenizer;
}

/** Registers the shared Tokenizer contract suite for one implementation. */
export function describeTokenizerContract(fixture: TokenizerContractFixture): void {
  describe(`Tokenizer contract: ${fixture.name}`, () => {
    it('INV-TRACE-005: exposes a non-empty tokenizer identity', () => {
      const tokenizer = fixture.createTokenizer();
      expect(tokenizer.id.length).toBeGreaterThan(0);
      expect(tokenizer.version.length).toBeGreaterThan(0);
    });

    it('INV-DET-001: reports the same identity for every instance', () => {
      const first = fixture.createTokenizer();
      const second = fixture.createTokenizer();
      expect(second.id).toBe(first.id);
      expect(second.version).toBe(first.version);
    });

    it('counts the empty string as zero tokens', () => {
      expect(fixture.createTokenizer().countTokens('')).toBe(0);
    });

    it('INV-BUDGET-005: returns finite non-negative integers', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of TOKENIZER_CONTRACT_TEXTS) {
        const tokens = tokenizer.countTokens(text);
        expect(Number.isInteger(tokens), `integer count for ${JSON.stringify(text)}`).toBe(true);
        expect(tokens).toBeGreaterThanOrEqual(0);
      }
    });

    it('INV-DET-001: returns the same count for repeated identical input', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of TOKENIZER_CONTRACT_TEXTS) {
        const first = tokenizer.countTokens(text);
        expect(tokenizer.countTokens(text)).toBe(first);
        expect(tokenizer.countTokens(text)).toBe(first);
      }
    });

    it('INV-DET-001: returns the same count from an independent instance', () => {
      const first = fixture.createTokenizer();
      const second = fixture.createTokenizer();
      for (const text of TOKENIZER_CONTRACT_TEXTS) {
        expect(second.countTokens(text)).toBe(first.countTokens(text));
      }
    });

    it('INV-DET-002: counting order does not affect results', () => {
      const entries = TOKENIZER_CONTRACT_TEXTS.map((text, index) => ({ text, index }));

      const forward = fixture.createTokenizer();
      const forwardCounts = new Map(
        entries.map(({ text, index }) => [index, forward.countTokens(text)]),
      );

      const backward = fixture.createTokenizer();
      const backwardCounts = new Map<number, number>();
      for (const { text, index } of [...entries].reverse()) {
        backwardCounts.set(index, backward.countTokens(text));
      }

      expect([...backwardCounts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        ...forwardCounts.entries(),
      ]);
    });

    it('INV-BLOCK-007: counts Unicode and emoji text deterministically', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of UNICODE_TEXTS) {
        const tokens = tokenizer.countTokens(text);
        expect(Number.isInteger(tokens)).toBe(true);
        expect(tokenizer.countTokens(text)).toBe(tokens);
      }
    });

    it('counts Markdown and code text deterministically', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of STRUCTURED_TEXTS) {
        const tokens = tokenizer.countTokens(text);
        expect(Number.isInteger(tokens)).toBe(true);
        expect(tokenizer.countTokens(text)).toBe(tokens);
      }
    });

    it('does not mutate the supplied text', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of TOKENIZER_CONTRACT_TEXTS) {
        const original = [...text].join('');
        tokenizer.countTokens(text);
        expect(text).toBe(original);
        expect(text.length).toBe(original.length);
      }
    });

    it('returns a synchronous number, never a promise', () => {
      const tokenizer = fixture.createTokenizer();
      for (const text of TOKENIZER_CONTRACT_TEXTS) {
        const tokens: unknown = tokenizer.countTokens(text);
        expect(typeof tokens).toBe('number');
        expect(tokens).not.toBeInstanceOf(Promise);
        expect(Object(tokens)).not.toHaveProperty('then');
      }
    });
  });
}

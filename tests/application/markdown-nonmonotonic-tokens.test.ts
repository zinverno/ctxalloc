import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { markdownSource, scriptedTokenizer } from './markdown-fixtures.js';

/**
 * Regression tests: boundary selection must not assume monotonic token counts.
 *
 * The `Tokenizer` port promises deterministic exact counts. It does **not** promise
 * that `countTokens` grows as text is extended, and a subword tokenizer can merge
 * tokens so that a longer substring costs fewer of them.
 *
 * Boundary selection used to stop scanning at the first candidate above
 * `maxTokens`, which is exactly that assumption: a later sentence, whitespace, or
 * whole-code-point boundary whose exact count fits was never measured, and the
 * chunker fell through to a needlessly small piece — in these cases a single
 * oversized character. Every candidate is now evaluated.
 *
 * The port contract is unchanged: monotonicity is still not required of any
 * implementation.
 */

describe('sentence boundaries are all evaluated', () => {
  // Body: `aaa. bbb. ccc. ddd.` — three sentence candidates.
  // The first overflows, the second fits exactly, the third overflows.
  const tokenizer = scriptedTokenizer(
    {
      'aaa. bbb. ccc. ddd.': 99,
      'aaa.': 99,
      'aaa. bbb.': 6,
      'aaa. bbb. ccc.': 99,
      'ccc. ddd.': 5,
    },
    99,
  );
  const content = '# H\naaa. bbb. ccc. ddd.';
  const chunker = new MarkdownChunker(tokenizer, { targetTokens: 6, maxTokens: 6 });

  it('selects the later fitting sentence boundary instead of falling back', () => {
    const blocks = chunker.chunk(markdownSource(content));

    expect(blocks.map((block) => block.content)).toEqual(['aaa. bbb.', 'ccc. ddd.']);
    // Before the fix the first candidate's overflowing count ended the scan, every
    // class fell through, and the hard boundary emitted a single `a`.
    expect(blocks[0]?.content).not.toBe('a');
  });

  it('records the exact scripted counts and marks nothing oversized', () => {
    const blocks = chunker.chunk(markdownSource(content));

    expect(blocks.map((block) => block.tokenCount)).toEqual([6, 5]);
    for (const block of blocks) {
      expect(block.tokenCount).toBeLessThanOrEqual(6);
      expect(JSON.stringify(block.metadata)).not.toContain('oversized');
    }
  });

  it('keeps content an exact source slice and loses no text', () => {
    const blocks = chunker.chunk(markdownSource(content));

    for (const block of blocks) {
      const location = block.sourceLocation;
      expect(location?.kind).toBe('text-range');
      if (location?.kind !== 'text-range') throw new Error('expected a text range');
      expect(content.slice(location.startOffset, location.endOffset)).toBe(block.content);
    }
    expect(blocks.map((block) => block.content).join(' ')).toBe('aaa. bbb. ccc. ddd.');
  });

  it('stays deterministic across repeated runs', () => {
    expect(chunker.chunk(markdownSource(content))).toEqual(chunker.chunk(markdownSource(content)));
  });
});

describe('whitespace boundaries are all evaluated', () => {
  it('selects a later fitting whitespace boundary when no sentence boundary exists', () => {
    // No sentence punctuation at all, so only whitespace candidates apply. The
    // first two overflow and the third fits.
    const tokenizer = scriptedTokenizer(
      {
        'alpha beta gamma delta': 99,
        alpha: 99,
        'alpha beta': 99,
        'alpha beta gamma': 4,
        delta: 2,
      },
      99,
    );
    const content = '# H\nalpha beta gamma delta';
    const blocks = new MarkdownChunker(tokenizer, { targetTokens: 4, maxTokens: 4 }).chunk(
      markdownSource(content),
    );

    expect(blocks.map((block) => block.content)).toEqual(['alpha beta gamma', 'delta']);
    expect(blocks.map((block) => block.tokenCount)).toEqual([4, 2]);
  });
});

describe('hard boundaries are all evaluated', () => {
  // Body: `abcdef` — one unbroken word, so neither sentence nor whitespace
  // candidates exist and only whole-code-point boundaries remain. Every prefix
  // shorter than `abcd` overflows.
  const tokenizer = scriptedTokenizer(
    { abcdef: 99, a: 99, ab: 99, abc: 99, abcd: 3, abcde: 99, ef: 2 },
    99,
  );
  const content = '# H\nabcdef';
  const chunker = new MarkdownChunker(tokenizer, { targetTokens: 3, maxTokens: 3 });

  it('does not stop at the first overflowing prefix', () => {
    const blocks = chunker.chunk(markdownSource(content));

    expect(blocks.map((block) => block.content)).toEqual(['abcd', 'ef']);
    // Before the fix the scan stopped at `a` and emitted it alone as oversized.
    expect(blocks[0]?.content).not.toBe('a');
  });

  it('marks nothing oversized when a whole-code-point candidate fits', () => {
    for (const block of chunker.chunk(markdownSource(content))) {
      expect(block.tokenCount).toBeLessThanOrEqual(3);
      expect(JSON.stringify(block.metadata)).not.toContain('oversized');
    }
  });

  it('INV-BLOCK-007: never divides a surrogate pair while scanning candidates', () => {
    // `ab😀cd`: the emoji occupies two UTF-16 code units. Only the prefix that
    // ends after the whole emoji fits.
    const emojiTokenizer = scriptedTokenizer({ 'ab😀': 2, cd: 1 }, 99);
    const emojiContent = '# H\nab😀cd';
    const blocks = new MarkdownChunker(emojiTokenizer, {
      targetTokens: 2,
      maxTokens: 2,
    }).chunk(markdownSource(emojiContent));

    expect(blocks.map((block) => block.content)).toEqual(['ab😀', 'cd']);
    for (const block of blocks) {
      expect(block.content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(block.content).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    }
  });

  it('emits one indivisible code point oversized only when no candidate fits', () => {
    // Every whole-code-point prefix overflows, so the only correct outcome is to
    // emit the code point intact and mark it.
    const nothingFits = scriptedTokenizer({}, 99);
    const blocks = new MarkdownChunker(nothingFits, { targetTokens: 1, maxTokens: 1 }).chunk(
      markdownSource('# H\n😀😀'),
    );

    expect(blocks.map((block) => block.content)).toEqual(['😀', '😀']);
    for (const block of blocks) {
      expect(JSON.stringify(block.metadata)).toContain('"oversized":true');
    }
  });
});

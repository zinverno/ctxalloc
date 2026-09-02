import { TextChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import {
  chunkText,
  codePointTokenizer,
  countWords,
  nonMonotonicTokenizer,
  textSource,
  wordTokenizer,
} from './text-fixtures.js';

const TIGHT = { targetTokens: 1, maxTokens: 3 } as const;

describe('TextChunker: paragraph structure', () => {
  it('produces no block for an empty source', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('INV-BLOCK-004: produces no block for a whitespace-only source', () => {
    for (const content of ['   ', '\n\n\n', '  \n\t\n  \n', '\r\n\r\n']) {
      expect(chunkText(content), JSON.stringify(content)).toEqual([]);
    }
  });

  it('emits one block for one paragraph', () => {
    const blocks = chunkText('A single paragraph of prose.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('A single paragraph of prose.');
  });

  it('keeps the lines of one paragraph together', () => {
    const blocks = chunkText('first line\nsecond line\nthird line\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('first line\nsecond line\nthird line');
  });

  it('separates paragraphs at a blank line and groups them under the target', () => {
    const content = 'alpha one\n\nbeta two\n\ngamma three\n';
    const grouped = chunkText(content, { targetTokens: 10, maxTokens: 20 });
    expect(grouped).toHaveLength(1);
    // The group is the exact contiguous slice, so the blank lines that separated
    // the paragraphs stay inside the content.
    expect(grouped[0]?.content).toBe('alpha one\n\nbeta two\n\ngamma three');

    const separate = chunkText(content, { targetTokens: 2, maxTokens: 2 });
    expect(separate.map((block) => block.content)).toEqual([
      'alpha one',
      'beta two',
      'gamma three',
    ]);
  });

  it('treats a run of several blank lines as one separator', () => {
    const blocks = chunkText('alpha one\n\n\n\nbeta two\n', { targetTokens: 2, maxTokens: 2 });
    expect(blocks.map((block) => block.content)).toEqual(['alpha one', 'beta two']);
  });

  it('treats a whitespace-only line as a paragraph separator', () => {
    const blocks = chunkText('alpha one\n   \nbeta two\n', { targetTokens: 2, maxTokens: 2 });
    expect(blocks.map((block) => block.content)).toEqual(['alpha one', 'beta two']);
  });

  it('reads no Markdown structure into plain text', () => {
    // A heading, a list, a fence, and a table are ordinary text here: plain text
    // makes no promise of structure, so none is inferred (DEC-039).
    const content = '# Not a heading\n- not a list\n| not | a table |\n';
    const blocks = chunkText(content, { targetTokens: 50, maxTokens: 100 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('# Not a heading\n- not a list\n| not | a table |');
    expect(blocks[0]?.headingPath).toBeUndefined();
  });

  it('never assigns a heading path, even when the document has a title', () => {
    const blocks = chunkText('body text\n', undefined, undefined, { title: 'Project notes' });
    expect(blocks[0]?.headingPath).toBeUndefined();
  });
});

describe('TextChunker: exact source preservation', () => {
  it('INV-BLOCK-006: every block content is its exact source slice', () => {
    const content = 'alpha  one\ttwo\n\n  indented paragraph  \n\nlast\n';
    const source = textSource(content);
    const blocks = new TextChunker(wordTokenizer, TIGHT).chunk(source);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const location = block.sourceLocation;
      expect(location?.kind).toBe('text-range');
      if (location?.kind !== 'text-range') throw new Error('expected a text range');
      expect(location.startOffset).toBeGreaterThanOrEqual(0);
      expect(location.endOffset).toBeGreaterThanOrEqual(location.startOffset);
      expect(location.endOffset).toBeLessThanOrEqual(content.length);
      expect(block.content).toBe(content.slice(location.startOffset, location.endOffset));
    }
  });

  it('preserves CRLF, indentation, and trailing spaces inside a block', () => {
    const content = 'first\r\n  second  \r\n\r\nthird\r\n';
    const blocks = chunkText(content, { targetTokens: 2, maxTokens: 2 });
    expect(blocks[0]?.content).toBe('first\r\n  second  ');
    expect(blocks[1]?.content).toBe('third');
  });

  it('preserves an initial byte-order mark as ordinary text', () => {
    const content = '﻿first paragraph\n';
    const blocks = chunkText(content);
    expect(blocks[0]?.content).toBe('﻿first paragraph');
    expect(blocks[0]?.content.codePointAt(0)).toBe(0xfeff);
  });

  it('reports one-based line numbers that bracket the block', () => {
    const content = 'line one\n\nline three\nline four\n';
    // A limit of four keeps the second paragraph whole, so its block really does
    // span two lines rather than being split into one block per line.
    const blocks = chunkText(content, { targetTokens: 4, maxTokens: 4 });
    const first = blocks[0]?.sourceLocation;
    const second = blocks[1]?.sourceLocation;
    if (first?.kind !== 'text-range' || second?.kind !== 'text-range') {
      throw new Error('expected text ranges');
    }
    expect(first.startLine).toBe(1);
    expect(first.endLine).toBe(1);
    expect(second.startLine).toBe(3);
    expect(second.endLine).toBe(4);
  });

  it('never overlaps and never reorders', () => {
    const content = 'one two\n\nthree four\n\nfive six\n';
    const blocks = chunkText(content, { targetTokens: 2, maxTokens: 2 });
    let previousEnd = -1;
    for (const block of blocks) {
      const location = block.sourceLocation;
      if (location?.kind !== 'text-range') throw new Error('expected a text range');
      expect(location.startOffset).toBeGreaterThan(previousEnd - 1);
      previousEnd = location.endOffset;
    }
  });
});

describe('TextChunker: oversized paragraph splitting', () => {
  it('splits at a sentence boundary when one fits', () => {
    const content = 'First sentence here. Second sentence here. Third sentence here.\n';
    const blocks = chunkText(content, { targetTokens: 3, maxTokens: 3 });
    expect(blocks.map((block) => block.content)).toEqual([
      'First sentence here.',
      'Second sentence here.',
      'Third sentence here.',
    ]);
  });

  it('falls back to a whitespace boundary when no sentence boundary fits', () => {
    const content = 'alpha beta gamma delta epsilon zeta\n';
    const blocks = chunkText(content, { targetTokens: 2, maxTokens: 2 });
    expect(blocks.map((block) => block.content)).toEqual([
      'alpha beta',
      'gamma delta',
      'epsilon zeta',
    ]);
    expect(blocks.map((block) => block.content).join(' ')).toBe(content.trimEnd());
  });

  it('INV-BLOCK-007: falls back to whole code points without splitting a surrogate pair', () => {
    // One long unbroken run of astral characters has no sentence or whitespace
    // boundary at all, so only the code-point fallback can divide it.
    const content = '🌍🌎🌏🌐🌑🌒\n';
    const blocks = chunkText(content, { targetTokens: 2, maxTokens: 2 }, codePointTokenizer);

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((block) => block.content).join('')).toBe('🌍🌎🌏🌐🌑🌒');
    for (const block of blocks) {
      for (let index = 0; index < block.content.length; index += 1) {
        const unit = block.content.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
          const next = block.content.charCodeAt(index + 1);
          expect(next >= 0xdc00 && next <= 0xdfff, 'lone high surrogate').toBe(true);
          index += 1;
        } else {
          expect(unit >= 0xdc00 && unit <= 0xdfff, 'lone low surrogate').toBe(false);
        }
      }
    }
  });

  it('makes no token-prefix monotonicity assumption', () => {
    // Every short prefix overflows; only the longest candidate fits, because the
    // tokenizer merges it. A chunker that stopped at the first overflow would
    // emit several pieces instead of one.
    const content = 'alpha beta gamma delta MERGE\n';
    const blocks = chunkText(content, { targetTokens: 1, maxTokens: 1 }, nonMonotonicTokenizer);
    expect(blocks.map((block) => block.content)).toEqual(['alpha beta gamma delta MERGE']);
    expect(blocks[0]?.tokenCount).toBe(1);
  });

  it('emits an indivisible code point whole and marks the block oversized', () => {
    const content = '🌍\n';
    const blocks = chunkText(
      content,
      { targetTokens: 1, maxTokens: 1 },
      {
        id: 'test:always-two',
        version: '1',
        countTokens: (): number => 2,
      },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('🌍');
    expect(blocks[0]?.tokenCount).toBe(2);
    expect(blocks[0]?.metadata).toMatchObject({ chunking: { oversized: true } });
  });

  it('reports a token count measured over the exact block content', () => {
    const blocks = chunkText('alpha beta gamma\n\ndelta epsilon\n', {
      targetTokens: 3,
      maxTokens: 3,
    });
    for (const block of blocks) {
      expect(block.tokenCount).toBe(countWords(block.content));
    }
  });
});

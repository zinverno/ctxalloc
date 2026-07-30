import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import {
  codePointTokenizer,
  hasLoneSurrogate,
  isInsideSurrogatePair,
  markdownSource,
  range,
  words,
} from './markdown-fixtures.js';

/**
 * Exact content preservation, source ranges, and Unicode boundaries.
 *
 * The central property is that a block's content is literally a slice of the
 * source. It is asserted directly on many shapes rather than assumed from the
 * implementation.
 */

function chunkerWith(targetTokens: number, maxTokens: number): MarkdownChunker {
  return new MarkdownChunker(codePointTokenizer, { targetTokens, maxTokens });
}

const roomy = chunkerWith(400, 4000);

const SOURCES: readonly (readonly [string, string])[] = [
  ['plain paragraph', 'Just a paragraph.'],
  ['heading and body', '# Title\nBody text.'],
  ['CRLF document', '# Title\r\nFirst line.\r\nSecond line.\r\n\r\n## Next\r\nMore.\r\n'],
  ['lone CR document', '# Title\rBody with old Mac line endings.\r'],
  ['frontmatter', '---\ntitle: Note\n---\n# Title\nBody.'],
  ['BOM frontmatter CRLF', '﻿---\r\na: 1\r\n---\r\nBody.'],
  ['fenced code', '# Code\n```ts\nconst a = 1;\n```\n\nAfter.'],
  ['table', '# T\n| A | B |\n| --- | --- |\n| 1 | 2 |'],
  ['list', '# L\n- one\n  - nested\n\n- two'],
  ['callout', '# Q\n> [!warning] Careful\n> Body.'],
  ['html', '# H\n<div>\nInline HTML.\n</div>'],
  ['wiki links and embeds', '# W\nSee [[Other Note]] and ![[Embedded Note]] here.'],
  ['cyrillic', '# Заголовок\nТекст на русском языке.'],
  ['japanese', '# 見出し\n日本語の本文です。'],
  ['emoji', '# E\nFamily: 👨‍👩‍👧‍👦 and flag: 🇯🇵 done.'],
  ['combining marks', '# C\ncafé vs café stay distinct.'],
  ['trailing spaces', '# S\nLine with trailing spaces.   \nNext line.'],
  ['tabs', '# T\n\tIndented with a tab.'],
  ['long paragraph', `# Long\n${words('token', 120)}`],
  ['no trailing newline', '# N\nEnds without a newline.'],
  ['many blank lines', '# B\nFirst.\n\n\n\nSecond.'],
];

describe('INV-PROV-002: ContextBlock content is exact source text', () => {
  it.each(SOURCES)('%s: content equals its own source slice', (_name, content) => {
    for (const budget of [
      [400, 4000],
      [8, 16],
      [30, 45],
    ] as const) {
      const blocks = chunkerWith(budget[0], budget[1]).chunk(markdownSource(content));
      for (const block of blocks) {
        const location = range(block);
        expect(content.slice(location.startOffset, location.endOffset)).toBe(block.content);
      }
    }
  });

  it.each(SOURCES)('%s: ranges stay inside the source and never overlap', (_name, content) => {
    const blocks = chunkerWith(30, 45).chunk(markdownSource(content));
    let previousEnd = 0;
    for (const block of blocks) {
      const location = range(block);
      expect(location.startOffset).toBeGreaterThanOrEqual(0);
      expect(location.startOffset).toBeLessThan(location.endOffset);
      expect(location.endOffset).toBeLessThanOrEqual(content.length);
      // Non-decreasing source order with no overlap between canonical blocks.
      expect(location.startOffset).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = location.endOffset;
    }
  });

  it.each(SOURCES)('%s: emits no lone surrogate', (_name, content) => {
    for (const block of chunkerWith(8, 16).chunk(markdownSource(content))) {
      expect(hasLoneSurrogate(block.content)).toBe(false);
    }
  });

  it('does not normalize CRLF inside block content', () => {
    const content = '# T\nFirst line.\r\nSecond line.';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toContain('\r\n');
  });

  it('does not trim content or remove trailing spaces', () => {
    const content = '# T\nTrailing spaces here.   ';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toBe('Trailing spaces here.   ');
  });

  it('does not remove trailing spaces in the middle of a block', () => {
    const content = '# T\nFirst line.   \nSecond line.';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toBe('First line.   \nSecond line.');
  });

  it('keeps blank lines between grouped blocks', () => {
    const content = '# T\nFirst.\n\n\nSecond.';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toBe('First.\n\n\nSecond.');
  });

  it('never prepends a heading label or breadcrumb to content', () => {
    const content = '# AI Hub\n## MCP\nClaude gets access.';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toBe('Claude gets access.');
    expect(block?.headingPath).toEqual(['AI Hub', 'MCP']);
    expect(block?.content).not.toContain('AI Hub');
    expect(block?.content).not.toContain('>');
  });

  it('never rewrites wiki links or embeds', () => {
    const content = '# W\nSee [[Other Note|alias]] and ![[Embedded]].';
    const [block] = roomy.chunk(markdownSource(content));
    expect(block?.content).toBe('See [[Other Note|alias]] and ![[Embedded]].');
  });

  it('never normalizes Unicode composition', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';
    const [block] = roomy.chunk(markdownSource(`# U\n${decomposed}`));
    expect(block?.content).toBe(decomposed);
    expect(block?.content).not.toBe(composed);
  });

  it('INV-RENDER-005: never truncates or adds an ellipsis', () => {
    const content = `# Long\n${words('word', 200)}`;
    const blocks = chunkerWith(20, 30).chunk(markdownSource(content));
    for (const block of blocks) expect(block.content).not.toContain('…');
    // Every non-separator character of the paragraph survives across the pieces.
    expect(blocks.map((block) => block.content).join(' ')).toBe(words('word', 200));
  });
});

describe('INV-BLOCK-006: source ranges are valid and line numbers are one-based', () => {
  it('reports the first line as line 1', () => {
    const [block] = roomy.chunk(markdownSource('First line body.'));
    expect(range(block!)).toEqual({
      kind: 'text-range',
      startOffset: 0,
      endOffset: 16,
      startLine: 1,
      endLine: 1,
    });
  });

  it('reports endLine as the line holding the final character', () => {
    const content = '# T\nline one\nline two\nline three';
    const [block] = roomy.chunk(markdownSource(content));
    expect(range(block!).startLine).toBe(2);
    expect(range(block!).endLine).toBe(4);
  });

  it('keeps CRLF offsets exact', () => {
    const content = '# T\r\nalpha\r\nbeta';
    const [block] = roomy.chunk(markdownSource(content));
    const location = range(block!);
    expect(content.slice(location.startOffset, location.endOffset)).toBe('alpha\r\nbeta');
    expect(location.startLine).toBe(2);
    expect(location.endLine).toBe(3);
  });

  it('excludes the heading line from the body range', () => {
    const content = '# Heading\nBody.';
    const [block] = roomy.chunk(markdownSource(content));
    const location = range(block!);
    expect(content.slice(location.startOffset, location.endOffset)).toBe('Body.');
    expect(content.slice(location.startOffset, location.endOffset)).not.toContain('#');
  });
});

describe('INV-BLOCK-007: Unicode boundaries survive splitting', () => {
  it('never splits a surrogate pair when a paragraph is divided', () => {
    const body = '😀'.repeat(40);
    const content = `# U\n${body}`;
    const blocks = chunkerWith(5, 6).chunk(markdownSource(content));

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((block) => block.content).join('')).toBe(body);
    for (const block of blocks) {
      const location = range(block);
      expect(hasLoneSurrogate(block.content)).toBe(false);
      expect(isInsideSurrogatePair(content, location.startOffset)).toBe(false);
      expect(isInsideSurrogatePair(content, location.endOffset)).toBe(false);
      expect(block.tokenCount).toBeLessThanOrEqual(6);
    }
  });

  it('emits one indivisible code point intact and marks it oversized', () => {
    // maxTokens is 0 tokens short of one emoji under the code-point tokenizer,
    // so the only correct behavior is to emit it whole rather than cut it.
    const content = '😀'.repeat(3);
    const source = markdownSource(content);
    const blocks = new MarkdownChunker(
      { id: 'test:double', version: '1', countTokens: (text) => [...text].length * 2 },
      { targetTokens: 1, maxTokens: 1 },
    ).chunk(source);

    expect(blocks.map((block) => block.content).join('')).toBe(content);
    for (const block of blocks) {
      expect(hasLoneSurrogate(block.content)).toBe(false);
      expect(block.content).toBe('😀');
      expect(block.metadata).toMatchObject({ chunking: { oversized: true } });
    }
  });

  it('keeps a ZWJ emoji sequence inside one block when it fits', () => {
    const family = '👨‍👩‍👧‍👦';
    const [block] = roomy.chunk(markdownSource(`# E\n${family}`));
    expect(block?.content).toBe(family);
    expect(hasLoneSurrogate(block!.content)).toBe(false);
  });

  it('splits a mixed-script paragraph without producing a lone surrogate', () => {
    const content = `# M\n${'日本語テキスト 😀 текст '.repeat(20)}`;
    for (const block of chunkerWith(6, 10).chunk(markdownSource(content))) {
      expect(hasLoneSurrogate(block.content)).toBe(false);
      expect(isInsideSurrogatePair(content, range(block).startOffset)).toBe(false);
      expect(isInsideSurrogatePair(content, range(block).endOffset)).toBe(false);
    }
  });
});

describe('paragraph splitting boundaries', () => {
  it('prefers a sentence boundary when one fits', () => {
    const content = `# S\nAlpha one two. Beta three four. Gamma five six.`;
    const blocks = chunkerWith(16, 20).chunk(markdownSource(content));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      // A sentence-boundary split ends on the sentence punctuation.
      expect(block.content.endsWith('.')).toBe(true);
    }
  });

  it('falls back to a whitespace boundary when no sentence boundary fits', () => {
    const content = `# W\n${words('alpha', 40)}`;
    const blocks = chunkerWith(20, 30).chunk(markdownSource(content));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.content).not.toMatch(/^\s|\s$/);
      expect(block.tokenCount).toBeLessThanOrEqual(30);
    }
  });

  it('falls back to a hard boundary inside one long unbroken word', () => {
    const content = `# H\n${'x'.repeat(90)}`;
    const blocks = chunkerWith(20, 25).chunk(markdownSource(content));
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((block) => block.content).join('')).toBe('x'.repeat(90));
    for (const block of blocks) expect(block.tokenCount).toBeLessThanOrEqual(25);
  });

  it('INV-BLOCK-004: emits no whitespace-only piece', () => {
    const content = `# W\n${'word    '.repeat(40)}`;
    for (const block of chunkerWith(10, 14).chunk(markdownSource(content))) {
      expect(block.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps split pieces in source order without overlap', () => {
    const content = `# O\n${words('piece', 80)}`;
    const blocks = chunkerWith(15, 25).chunk(markdownSource(content));
    let previousEnd = -1;
    for (const block of blocks) {
      const location = range(block);
      expect(location.startOffset).toBeGreaterThan(previousEnd);
      previousEnd = location.endOffset - 1;
    }
  });

  it('does not split a paragraph that already fits', () => {
    const content = '# F\nShort enough.';
    expect(chunkerWith(50, 100).chunk(markdownSource(content))).toHaveLength(1);
  });
});

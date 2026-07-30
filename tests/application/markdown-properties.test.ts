import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import {
  codePointTokenizer,
  hasLoneSurrogate,
  markdownSource,
  range,
  wordTokenizer,
} from './markdown-fixtures.js';

/**
 * Property tests over many generated documents.
 *
 * The generator is a deterministic linear congruential sequence, never
 * `Math.random`, so a failure is always reproducible and the suite stays
 * deterministic (INV-DET-003).
 */

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const FRAGMENTS: readonly string[] = [
  '# Heading one',
  '## Heading two',
  '### Heading three',
  'A plain paragraph of ordinary prose text.',
  'Another paragraph. It has two sentences. And a third one!',
  '- list item one\n- list item two\n  - nested item',
  '1. ordered one\n2. ordered two',
  '> a quoted line\n> a second quoted line',
  '> [!note] Callout\n> callout body',
  '| A | B |\n| --- | --- |\n| 1 | 2 |',
  '```ts\nconst value = 1;\nconst other = 2;\n```',
  '~~~\nplain fenced text\n~~~',
  '<div>\nHTML block content\n</div>',
  'Unicode: Кириллица 日本語 😀 👨‍👩‍👧‍👦 done.',
  'Text with [[a wiki link]] and ![[an embed]].',
  'Trailing spaces here.   ',
  '',
  '',
];

/** Builds one deterministic pseudo-document from the fragment pool. */
function generateDocument(seed: number): string {
  const random = makeRandom(seed);
  const parts: string[] = [];
  if (seed % 3 === 0) parts.push('---\ntitle: Generated\nkey: value\n---');
  const count = 4 + Math.floor(random() * 12);
  for (let index = 0; index < count; index += 1) {
    const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
    parts.push(fragment);
  }
  const joined = parts.join('\n\n');
  return seed % 5 === 0 ? joined.replace(/\n/g, '\r\n') : joined;
}

const SEEDS = Array.from({ length: 60 }, (_, index) => index * 7717 + 13);

const POLICIES = [
  { targetTokens: 1, maxTokens: 1 },
  { targetTokens: 4, maxTokens: 8 },
  { targetTokens: 20, maxTokens: 30 },
  { targetTokens: 100, maxTokens: 250 },
  { targetTokens: 5000, maxTokens: 5000 },
] as const;

describe('MarkdownChunker properties over generated documents', () => {
  it.each(POLICIES)('INV-BLOCK-006: content equals its source slice at %o', (options) => {
    const chunker = new MarkdownChunker(codePointTokenizer, options);
    for (const seed of SEEDS) {
      const content = generateDocument(seed);
      for (const block of chunker.chunk(markdownSource(content))) {
        const location = range(block);
        expect(
          content.slice(location.startOffset, location.endOffset),
          `seed ${String(seed)}`,
        ).toBe(block.content);
      }
    }
  });

  it.each(POLICIES)('blocks never overlap and stay in source order at %o', (options) => {
    const chunker = new MarkdownChunker(codePointTokenizer, options);
    for (const seed of SEEDS) {
      const content = generateDocument(seed);
      let previousEnd = 0;
      for (const block of chunker.chunk(markdownSource(content))) {
        const location = range(block);
        expect(location.startOffset, `seed ${String(seed)}`).toBeGreaterThanOrEqual(previousEnd);
        expect(location.startOffset).toBeLessThan(location.endOffset);
        expect(location.endOffset).toBeLessThanOrEqual(content.length);
        previousEnd = location.endOffset;
      }
    }
  });

  it.each(POLICIES)(
    'INV-BUDGET-005: only an oversized block may exceed maxTokens at %o',
    (options) => {
      const chunker = new MarkdownChunker(codePointTokenizer, options);
      for (const seed of SEEDS) {
        const blocks = chunker.chunk(markdownSource(generateDocument(seed)));
        for (const block of blocks) {
          expect(Number.isSafeInteger(block.tokenCount)).toBe(true);
          expect(block.tokenCount).toBe(codePointTokenizer.countTokens(block.content));
          const oversized = JSON.stringify(block.metadata).includes('"oversized":true');
          if (!oversized) {
            expect(block.tokenCount, `seed ${String(seed)}`).toBeLessThanOrEqual(options.maxTokens);
          }
        }
      }
    },
  );

  it.each(POLICIES)('INV-BLOCK-007: never emits a lone surrogate at %o', (options) => {
    const chunker = new MarkdownChunker(codePointTokenizer, options);
    for (const seed of SEEDS) {
      for (const block of chunker.chunk(markdownSource(generateDocument(seed)))) {
        expect(hasLoneSurrogate(block.content), `seed ${String(seed)}`).toBe(false);
      }
    }
  });

  it.each(POLICIES)('INV-BLOCK-004: never emits blank content at %o', (options) => {
    const chunker = new MarkdownChunker(codePointTokenizer, options);
    for (const seed of SEEDS) {
      for (const block of chunker.chunk(markdownSource(generateDocument(seed)))) {
        expect(block.content.trim().length, `seed ${String(seed)}`).toBeGreaterThan(0);
      }
    }
  });

  it('INV-BLOCK-002: keeps every block identifier unique inside one source', () => {
    const chunker = new MarkdownChunker(codePointTokenizer, { targetTokens: 20, maxTokens: 40 });
    for (const seed of SEEDS) {
      const ids = chunker.chunk(markdownSource(generateDocument(seed))).map((block) => block.id);
      expect(new Set(ids).size, `seed ${String(seed)}`).toBe(ids.length);
    }
  });

  it('INV-DET-001: repeats identically across runs and tokenizers', () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const source = markdownSource(generateDocument(seed));

      const first = new MarkdownChunker(codePointTokenizer, {
        targetTokens: 20,
        maxTokens: 40,
      }).chunk(source);
      const second = new MarkdownChunker(codePointTokenizer, {
        targetTokens: 20,
        maxTokens: 40,
      }).chunk(source);
      expect(second, `seed ${String(seed)}`).toEqual(first);

      // A different tokenizer changes sizes and counts but never identity rules.
      const other = new MarkdownChunker(wordTokenizer, {
        targetTokens: 5000,
        maxTokens: 5000,
      }).chunk(source);
      const roomy = new MarkdownChunker(codePointTokenizer, {
        targetTokens: 5000,
        maxTokens: 5000,
      }).chunk(source);
      expect(other.map((block) => block.id)).toEqual(roomy.map((block) => block.id));
    }
  });

  it('preserves every non-separator body character except frontmatter and heading lines', () => {
    const chunker = new MarkdownChunker(codePointTokenizer, { targetTokens: 8, maxTokens: 16 });
    for (const seed of SEEDS) {
      const content = generateDocument(seed);
      const emitted = chunker
        .chunk(markdownSource(content))
        .map((block) => block.content)
        .join('');

      // Two kinds of source text are excluded by design: frontmatter, and the
      // heading lines themselves, which travel in `headingPath` instead of in
      // content (DEC-029). Everything else must survive, ignoring the whitespace
      // that separated the blocks.
      //
      // The naive heading filter is safe here because no fragment in the pool
      // contains a heading-like line inside a fence; the fence-aware case is
      // covered by the structural tests.
      const bodyStart = content.startsWith('---')
        ? content.indexOf('\n---', 3) + '\n---'.length
        : 0;
      const expected = content
        .slice(bodyStart)
        .split('\n')
        .filter((line) => !/^ {0,3}#{1,6}(\s|$)/.test(line.replace(/\r$/, '')))
        .join('\n')
        .replace(/\s/g, '');

      expect(emitted.replace(/\s/g, ''), `seed ${String(seed)}`).toBe(expected);
    }
  });
});

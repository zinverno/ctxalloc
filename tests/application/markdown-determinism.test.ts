import { readFileSync } from 'node:fs';
import { MarkdownChunker } from '@ctxalloc/application';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';
import { codePointTokenizer, markdownSource, range, words } from './markdown-fixtures.js';

/**
 * Determinism, offline behavior, and the real tokenizer.
 *
 * The chunker must produce identical output for identical input, must not depend
 * on the clock, randomness, or ambient state, and must behave the same when a
 * production tokenizer replaces the test double.
 */

const REALISTIC_DOCUMENT = [
  '---',
  'title: Release notes',
  'tags: [release, notes]',
  '---',
  '# Release notes',
  '',
  'This release focuses on deterministic context allocation and adds the first',
  'structural Markdown chunker. Nothing in the compiler changed.',
  '',
  '## Highlights',
  '',
  '- Token budgets replace character budgets.',
  '- Canonical blocks never overlap.',
  '- Block identity is content-derived.',
  '',
  '### Example',
  '',
  '```ts',
  'const chunker = new MarkdownChunker(tokenizer, {',
  '  targetTokens: 400,',
  '  maxTokens: 800,',
  '});',
  '```',
  '',
  '> [!note] Compatibility',
  '> Existing source documents are unaffected.',
  '',
  '| Field | Meaning |',
  '| --- | --- |',
  '| `targetTokens` | Preferred block size |',
  '| `maxTokens` | Hard block limit |',
  '',
  '## Notes',
  '',
  'See [[Architecture]] and ![[Invariants]] for the full rules. Unicode such as',
  'Кириллица, 日本語, and 😀 is preserved exactly.',
  '',
].join('\n');

describe('INV-DET-001: identical input produces identical output', () => {
  it('returns structurally identical blocks on repeated runs', () => {
    const chunker = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 60,
      maxTokens: 120,
    });
    const first = chunker.chunk(markdownSource(REALISTIC_DOCUMENT));
    const second = chunker.chunk(markdownSource(REALISTIC_DOCUMENT));
    expect(second).toEqual(first);
  });

  it('returns identical blocks from an independently constructed chunker', () => {
    const options = { targetTokens: 60, maxTokens: 120 };
    const first = new MarkdownChunker(codePointTokenizer, options).chunk(
      markdownSource(REALISTIC_DOCUMENT),
    );
    const second = new MarkdownChunker(codePointTokenizer, { ...options }).chunk(
      markdownSource(REALISTIC_DOCUMENT),
    );
    expect(second).toEqual(first);
  });

  it('INV-DET-002: does not depend on chunking order across sources', () => {
    const a = markdownSource('# A\nAlpha body.', { key: 'a.md' });
    const b = markdownSource('# B\nBeta body.', { key: 'b.md' });
    const chunker = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 40,
      maxTokens: 80,
    });

    const forward = [...chunker.chunk(a), ...chunker.chunk(b)];
    const reverseChunker = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 40,
      maxTokens: 80,
    });
    const backward = [...reverseChunker.chunk(b), ...reverseChunker.chunk(a)];

    expect(backward.map((block) => block.id).sort()).toEqual(
      forward.map((block) => block.id).sort(),
    );
  });

  it('INV-DET-003, INV-DET-004: reads no clock and no random value', () => {
    const chunkerSource = readFileSync(
      new URL('../../packages/application/src/markdown-chunker.ts', import.meta.url),
      'utf8',
    );
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date',
      'crypto.randomUUID',
      'process.env',
      'process.hrtime',
      'readFile',
      'fetch(',
      'require(',
    ]) {
      expect(chunkerSource, `chunker uses ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('returns blocks in source order', () => {
    const blocks = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 40,
      maxTokens: 90,
    }).chunk(markdownSource(REALISTIC_DOCUMENT));

    const starts = blocks.map((block) => range(block).startOffset);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe('MarkdownChunker with the real o200k_base tokenizer', () => {
  const tokenizer = new O200kBaseTokenizer();

  it('produces exact counts and stays within maxTokens', () => {
    const blocks = new MarkdownChunker(tokenizer, {
      targetTokens: 40,
      maxTokens: 80,
    }).chunk(markdownSource(REALISTIC_DOCUMENT));

    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.tokenCount).toBe(tokenizer.countTokens(block.content));
      const oversized = JSON.stringify(block.metadata).includes('"oversized":true');
      if (!oversized) expect(block.tokenCount).toBeLessThanOrEqual(80);
    }
  });

  it('keeps content exact and ranges non-overlapping', () => {
    const blocks = new MarkdownChunker(tokenizer, {
      targetTokens: 30,
      maxTokens: 60,
    }).chunk(markdownSource(REALISTIC_DOCUMENT));

    let previousEnd = 0;
    for (const block of blocks) {
      const location = range(block);
      expect(REALISTIC_DOCUMENT.slice(location.startOffset, location.endOffset)).toBe(
        block.content,
      );
      expect(location.startOffset).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = location.endOffset;
    }
  });

  it('records the tokenizer identity in block metadata', () => {
    const [block] = new MarkdownChunker(tokenizer, {
      targetTokens: 400,
      maxTokens: 800,
    }).chunk(markdownSource('# A\nBody.'));

    expect(block?.metadata).toMatchObject({
      tokenization: { tokenizerId: tokenizer.id, tokenizerVersion: tokenizer.version },
    });
  });

  it('produces the same block identity as any other tokenizer', () => {
    const source = markdownSource(REALISTIC_DOCUMENT);
    const real = new MarkdownChunker(tokenizer, { targetTokens: 4000, maxTokens: 8000 }).chunk(
      source,
    );
    const fake = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 4000,
      maxTokens: 8000,
    }).chunk(source);

    expect(fake.map((block) => block.id)).toEqual(real.map((block) => block.id));
  });

  it('splits a long realistic paragraph without losing source text', () => {
    const paragraph = `# Long\n${words('measurement', 300)}`;
    const blocks = new MarkdownChunker(tokenizer, {
      targetTokens: 50,
      maxTokens: 90,
    }).chunk(markdownSource(paragraph));

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map((block) => block.content).join(' ')).toBe(words('measurement', 300));
  });
});

import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { codePointTokenizer, markdownSource, range, words } from './markdown-fixtures.js';

/**
 * Structural scanning: headings, sections, frontmatter, and logical block kinds.
 *
 * The generous token policy keeps these tests about structure alone; splitting
 * and grouping behavior is covered separately.
 */
const chunker = new MarkdownChunker(codePointTokenizer, {
  targetTokens: 400,
  maxTokens: 4000,
});

function contentsOf(source: string, title?: string): string[] {
  return chunker
    .chunk(markdownSource(source, title === undefined ? {} : { title }))
    .map((block) => block.content);
}

function pathsOf(source: string, title?: string): (readonly string[] | undefined)[] {
  return chunker
    .chunk(markdownSource(source, title === undefined ? {} : { title }))
    .map((block) => block.headingPath);
}

describe('MarkdownChunker sections and headings', () => {
  it('returns no block for an empty source', () => {
    expect(chunker.chunk(markdownSource(''))).toEqual([]);
  });

  it('INV-BLOCK-004: returns no block for a whitespace-only source', () => {
    expect(chunker.chunk(markdownSource('\n\n   \n\t\n'))).toEqual([]);
  });

  it('INV-BLOCK-004: returns no block for a frontmatter-only source', () => {
    expect(chunker.chunk(markdownSource('---\ntitle: Note\n---\n'))).toEqual([]);
  });

  it('builds an H1/H2/H3 hierarchy without duplicating a child body into its parent', () => {
    const source = '# One\nBody one.\n\n## Two\nBody two.\n\n### Three\nBody three.';
    expect(pathsOf(source)).toEqual([['One'], ['One', 'Two'], ['One', 'Two', 'Three']]);
    expect(contentsOf(source)).toEqual(['Body one.', 'Body two.', 'Body three.']);
  });

  it('allows skipped heading levels', () => {
    expect(pathsOf('# One\nA.\n\n#### Four\nB.')).toEqual([['One'], ['One', 'Four']]);
  });

  it('pops the stack when returning from a deeper level to a shallower one', () => {
    const source = '# A\na.\n\n## B\nb.\n\n### C\nc.\n\n## D\nd.';
    expect(pathsOf(source)).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C'], ['A', 'D']]);
  });

  it('allows duplicate heading text', () => {
    const source = '## Notes\nFirst.\n\n## Notes\nSecond.';
    expect(pathsOf(source)).toEqual([['Notes'], ['Notes']]);
    expect(contentsOf(source)).toEqual(['First.', 'Second.']);
  });

  it('creates no block for a heading without a body', () => {
    const source = '# Empty\n\n## Filled\nBody.';
    expect(contentsOf(source)).toEqual(['Body.']);
    expect(pathsOf(source)).toEqual([['Empty', 'Filled']]);
  });

  it('creates a root section for content before the first heading', () => {
    expect(contentsOf('Intro text.\n\n# Later\nBody.')).toEqual(['Intro text.', 'Body.']);
  });

  it('uses the exact document title as the root heading path when one exists', () => {
    expect(pathsOf('Rootless body.', 'Project  notes ')).toEqual([['Project  notes ']]);
  });

  it('omits headingPath for root content when the document has no title', () => {
    expect(pathsOf('Rootless body.')).toEqual([undefined]);
  });

  it('omits headingPath for root content when the title is blank', () => {
    expect(pathsOf('Rootless body.', '   ')).toEqual([undefined]);
  });

  it('never derives a heading from a path or filename in metadata', () => {
    const source = markdownSource('Rootless body.', {
      metadata: { path: '/home/user/vault/Important Note.md' },
    });
    const [block] = chunker.chunk(source);
    expect(block?.headingPath).toBeUndefined();
    expect(block?.content).toBe('Rootless body.');
  });

  it('normalizes heading text and removes a closing ATX marker', () => {
    expect(pathsOf('#   Spaced   Title   #\nBody.')).toEqual([['Spaced Title']]);
  });

  it('does not treat a line without a space after the hashes as a heading', () => {
    expect(contentsOf('#NotAHeading\nBody.')).toEqual(['#NotAHeading\nBody.']);
  });

  it('does not treat seven hashes as a heading', () => {
    expect(contentsOf('####### Seven\nBody.')).toEqual(['####### Seven\nBody.']);
  });

  it('DEC-029: treats a Setext-underlined title as ordinary paragraph content', () => {
    // Setext headings are deliberately unsupported in this phase. The behavior is
    // pinned so that adding support later is a visible, tested change.
    const source = 'Title\n=====\n\nBody.';
    // No section is created, so the underline stays in the body and the whole
    // root section remains one ungrouped-by-heading unit.
    expect(pathsOf(source)).toEqual([undefined]);
    expect(contentsOf(source)).toEqual(['Title\n=====\n\nBody.']);
  });

  it('DEC-029: treats a dash Setext underline as ordinary paragraph content', () => {
    const source = 'Title\n-----\n\nBody.';
    expect(pathsOf(source)).toEqual([undefined]);
    expect(contentsOf(source)).toEqual(['Title\n-----\n\nBody.']);
  });
});

describe('MarkdownChunker fenced code', () => {
  it('ignores a heading-like line inside a backtick fence', () => {
    const source = '# Real\n```\n# Not a heading\n```';
    expect(pathsOf(source)).toEqual([['Real']]);
    expect(contentsOf(source)).toEqual(['```\n# Not a heading\n```']);
  });

  it('ignores a heading-like line inside a tilde fence', () => {
    const source = '# Real\n~~~\n## Not a heading\n~~~';
    expect(pathsOf(source)).toEqual([['Real']]);
  });

  it('preserves a fenced block with a language tag exactly', () => {
    const block = '```ts\nconst answer = 1;\n```';
    expect(contentsOf(`# Code\n${block}`)).toEqual([block]);
  });

  it('treats an unclosed fence as code through the end of its section', () => {
    const source = '# Code\n```\nstill code\n\n# Not a heading\nmore';
    expect(contentsOf(source)).toEqual(['```\nstill code\n\n# Not a heading\nmore']);
    expect(pathsOf(source)).toEqual([['Code']]);
  });

  it('does not close a backtick fence with a tilde fence', () => {
    const source = '# Code\n```\na\n~~~\nb\n```';
    expect(contentsOf(source)).toEqual(['```\na\n~~~\nb\n```']);
  });

  it('does not treat a backtick run with an inline backtick as a fence', () => {
    expect(contentsOf('# T\n```js`\nnot a fence')).toEqual(['```js`\nnot a fence']);
  });
});

describe('MarkdownChunker atomic logical blocks', () => {
  it('keeps a list as one block including its internal blank lines', () => {
    const list = '- first\n\n- second\n\n- third';
    expect(contentsOf(`# L\n${list}`)).toEqual([list]);
  });

  it('keeps a nested list inside the same block', () => {
    const list = '- parent\n  - child\n  - child two\n- sibling';
    expect(contentsOf(`# L\n${list}`)).toEqual([list]);
  });

  it('keeps an ordered list as one block', () => {
    const list = '1. first\n2. second\n3. third';
    expect(contentsOf(`# L\n${list}`)).toEqual([list]);
  });

  it('does not absorb a following paragraph into a list', () => {
    const blocks = chunker.chunk(markdownSource('# L\n- one\n- two\n\nA separate paragraph.'));
    // One group is allowed, but the list and the paragraph stay distinct units:
    // the emitted content is the exact contiguous slice either way.
    expect(blocks.map((block) => block.content).join('\n\n')).toContain('- one\n- two');
    expect(blocks.map((block) => block.content).join('\n\n')).toContain('A separate paragraph.');
  });

  it('does not absorb a following heading into a list', () => {
    const paths = pathsOf('# L\n- one\n- two\n# Next\nNext body.');
    expect(paths).toEqual([['L'], ['Next']]);
  });

  it('keeps a blockquote as one block', () => {
    const quote = '> quoted line\n> second quoted line';
    expect(contentsOf(`# Q\n${quote}`)).toEqual([quote]);
  });

  it('keeps an Obsidian-style callout as one block', () => {
    const callout = '> [!note] Title\n> Callout body.\n> More body.';
    expect(contentsOf(`# Q\n${callout}`)).toEqual([callout]);
  });

  it('keeps a Markdown table as one block', () => {
    const table = '| Name | Value |\n| --- | ---: |\n| A | 1 |\n| B | 2 |';
    expect(contentsOf(`# T\n${table}`)).toEqual([table]);
  });

  it('keeps an HTML block as one block', () => {
    const html = '<div class="note">\nHTML body stays intact.\n</div>';
    expect(contentsOf(`# H\n${html}`)).toEqual([html]);
  });

  it('keeps an HTML comment as one block', () => {
    const html = '<!-- a comment\nspanning lines -->';
    expect(contentsOf(`# H\n${html}`)).toEqual([html]);
  });

  it.each([
    ['list', '- one very long item\n- two very long items\n- three very long items'],
    ['callout', '> [!note] A long title\n> long quoted content\n> more quoted content'],
    ['table', '| Name | Value |\n| --- | --- |\n| Alpha | Long value |\n| Beta | Long |'],
    ['HTML', '<div>\nA deliberately long HTML block that stays atomic.\n</div>'],
    ['code', '```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```'],
  ])('never splits an oversized atomic %s block', (_name, block) => {
    const small = new MarkdownChunker(codePointTokenizer, { targetTokens: 20, maxTokens: 30 });
    const blocks = small.chunk(markdownSource(`# Atomic\n${block}`));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(block);
    expect(blocks[0]?.metadata).toMatchObject({ chunking: { oversized: true } });
  });
});

describe('MarkdownChunker frontmatter', () => {
  it('excludes valid frontmatter and keeps exact body offsets', () => {
    const source = '---\nstatus: active\n---\nVisible body.';
    const [block] = chunker.chunk(markdownSource(source));
    expect(block?.content).toBe('Visible body.');
    expect(range(block!).startOffset).toBe(source.indexOf('Visible body.'));
  });

  it('supports a BOM opener with CRLF line endings', () => {
    const source = '﻿---\r\nstatus: active\r\n---\r\nVisible body.';
    const [block] = chunker.chunk(markdownSource(source));
    expect(block?.content).toBe('Visible body.');
    expect(range(block!)).toEqual({
      kind: 'text-range',
      startOffset: source.indexOf('Visible body.'),
      endOffset: source.length,
      startLine: 4,
      endLine: 4,
    });
  });

  it.each(['  ---', '\t---'])(
    'does not accept an opener with leading whitespace (%j)',
    (opener) => {
      const source = `${opener}\nsecret: yes\n---\nVisible.`;
      const joined = contentsOf(source).join('\n');
      expect(joined).toContain('secret: yes');
      expect(joined).toContain(opener.trim());
    },
  );

  it('does not accept an indented closing delimiter', () => {
    const source = '---\nsecret: yes\n  ---\nVisible.';
    const [block] = chunker.chunk(markdownSource(source));
    expect(block?.content).toContain('secret: yes');
    expect(range(block!).startOffset).toBe(0);
  });

  it('keeps an unclosed frontmatter opener as ordinary content', () => {
    const source = '---\nsecret: yes\nVisible.';
    const [block] = chunker.chunk(markdownSource(source));
    expect(block?.content).toBe('---\nsecret: yes\nVisible.');
    expect(range(block!).startOffset).toBe(0);
  });

  it('does not mistake a thematic break in the body for frontmatter', () => {
    const joined = contentsOf('Intro.\n\n---\n\nOutro.').join('\n');
    expect(joined).toContain('Intro.');
    expect(joined).toContain('---');
    expect(joined).toContain('Outro.');
  });

  it('INV-SEC-001: never parses frontmatter into metadata', () => {
    const source = markdownSource('---\nrequired: true\npriority: 999\n---\nBody.');
    const [block] = chunker.chunk(source);
    expect(block?.metadata).toEqual({
      source: {},
      chunking: { chunkerId: 'ctxalloc-markdown-structural', chunkerVersion: '1' },
      tokenization: { tokenizerId: 'test:code-point', tokenizerVersion: '1' },
    });
    expect(block?.attributes).toEqual({});
  });

  it('leaves SourceDocument.contentHash describing the complete original source', () => {
    const source = markdownSource('---\nstatus: active\n---\nBody.');
    const before = source.document.contentHash;
    chunker.chunk(source);
    expect(source.document.contentHash).toBe(before);
    expect(source.content).toBe('---\nstatus: active\n---\nBody.');
  });
});

describe('MarkdownChunker grouping', () => {
  it('groups adjacent blocks into one exact contiguous slice', () => {
    const source = '# G\nFirst paragraph.\n\nSecond paragraph.';
    const [block, ...rest] = chunker.chunk(markdownSource(source));
    expect(rest).toEqual([]);
    expect(block?.content).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('never groups across a heading section', () => {
    const source = '# A\nOne.\n\n# B\nTwo.';
    expect(contentsOf(source)).toEqual(['One.', 'Two.']);
  });

  it('flushes a group when the next block would exceed maxTokens', () => {
    const small = new MarkdownChunker(codePointTokenizer, { targetTokens: 10, maxTokens: 20 });
    const blocks = small.chunk(markdownSource('# G\nAAAAAAAA.\n\nBBBBBBBB.\n\nCCCCCCCC.'));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.tokenCount).toBeLessThanOrEqual(20);
  });

  it('INV-BUDGET-005: keeps every grouped block within maxTokens', () => {
    const source = `# G\n${words('alpha', 60)}\n\n${words('beta', 60)}`;
    const blocks = new MarkdownChunker(codePointTokenizer, {
      targetTokens: 120,
      maxTokens: 200,
    }).chunk(markdownSource(source));
    for (const block of blocks) expect(block.tokenCount).toBeLessThanOrEqual(200);
  });
});

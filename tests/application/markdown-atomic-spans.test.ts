import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { codePointTokenizer, markdownSource, range } from './markdown-fixtures.js';

/**
 * Regression tests: heading discovery must never split an atomic structure.
 *
 * Section discovery and logical block parsing used to be two passes, and only the
 * block pass understood every atomic span. The heading pass protected fenced code
 * alone, so an ATX-looking line inside an HTML block or comment, or inside indented
 * list content, was recognized as a heading. That cut the atomic block in half at
 * the inner line and leaked its text into `headingPath`.
 *
 * The two passes are now one, so these cases are structurally impossible rather
 * than individually patched.
 */
const chunker = new MarkdownChunker(codePointTokenizer, {
  targetTokens: 400,
  maxTokens: 4000,
});

/** Every heading-path segment produced for `content`, flattened. */
function allHeadingSegments(content: string): string[] {
  return chunker.chunk(markdownSource(content)).flatMap((block) => [...(block.headingPath ?? [])]);
}

function contentsOf(content: string): string[] {
  return chunker.chunk(markdownSource(content)).map((block) => block.content);
}

const ATOMIC_CASES: readonly (readonly [string, string, string])[] = [
  ['HTML block', '<div>\n# Not a section\n</div>', 'Not a section'],
  ['HTML comment', '<!--\n## Not a section\n-->', 'Not a section'],
  ['HTML block with several inner headings', '<section>\n# One\ntext\n### Two\n</section>', 'One'],
  [
    'list item continuation',
    '- item\n  ## Nested text that belongs to the list\n  continuation',
    'Nested text that belongs to the list',
  ],
  [
    'ordered list item continuation',
    '1. item\n   ### Deeper nested heading text\n   continuation',
    'Deeper nested heading text',
  ],
  [
    'loose list with an inner heading line',
    '- first\n  # Inner one\n\n- second\n  ## Inner two',
    'Inner one',
  ],
  [
    'nested list with an inner heading line',
    '- parent\n  - child\n    #### Inner heading text\n  - sibling',
    'Inner heading text',
  ],
  ['fenced code', '```\n# Not a section\n```', 'Not a section'],
  ['tilde fenced code', '~~~\n## Not a section\n~~~', 'Not a section'],
];

describe('heading discovery never splits an atomic block', () => {
  it.each(ATOMIC_CASES)('%s stays one complete block', (_name, atomic) => {
    const content = `# Root\n${atomic}`;
    const blocks = chunker.chunk(markdownSource(content));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(atomic);
    // The whole atomic source slice, not a fragment of it.
    const location = range(blocks[0]!);
    expect(content.slice(location.startOffset, location.endOffset)).toBe(atomic);
  });

  it.each(ATOMIC_CASES)(
    '%s keeps its inner heading text out of headingPath',
    (_name, atomic, inner) => {
      const content = `# Root\n${atomic}`;
      expect(allHeadingSegments(content)).toEqual(['Root']);
      expect(allHeadingSegments(content)).not.toContain(inner);
    },
  );

  it.each(ATOMIC_CASES)('%s creates exactly one section', (_name, atomic) => {
    const content = `# Root\n${atomic}\n\n# After\nAfter body.`;
    const blocks = chunker.chunk(markdownSource(content));

    expect(blocks.map((block) => block.headingPath)).toEqual([['Root'], ['After']]);
    expect(blocks[0]?.content).toBe(atomic);
    expect(blocks[1]?.content).toBe('After body.');
  });
});

describe('document-level headings still end a list', () => {
  it('does not absorb an unindented heading that follows a list', () => {
    const blocks = chunker.chunk(markdownSource('# Root\n- one\n- two\n# Next\nNext body.'));
    expect(blocks.map((block) => block.content)).toEqual(['- one\n- two', 'Next body.']);
    expect(blocks.map((block) => block.headingPath)).toEqual([['Root'], ['Next']]);
  });

  it('does not absorb a heading indented less than the item content column', () => {
    // `- item` puts content at column 2, so a heading at column 1 is document
    // structure, not list content.
    const blocks = chunker.chunk(markdownSource('# Root\n- item\n # Next\nNext body.'));
    expect(blocks.map((block) => block.content)).toEqual(['- item', 'Next body.']);
    expect(blocks.map((block) => block.headingPath)).toEqual([['Root'], ['Next']]);
  });

  it('keeps a heading at the item content column inside the list', () => {
    const blocks = chunker.chunk(markdownSource('# Root\n- item\n  # Inner\nmore'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe('- item\n  # Inner\nmore');
    expect(blocks[0]?.headingPath).toEqual(['Root']);
  });

  it('ends a list at an unindented heading after a blank line', () => {
    const blocks = chunker.chunk(markdownSource('# Root\n- one\n\n# Next\nNext body.'));
    expect(blocks.map((block) => block.content)).toEqual(['- one', 'Next body.']);
  });
});

describe('atomic spans keep exact content and non-overlapping ranges', () => {
  it.each(ATOMIC_CASES)('%s preserves the exact source slice', (_name, atomic) => {
    const content = `Intro.\n\n# Root\n${atomic}\n\nOutro.`;
    let previousEnd = 0;
    for (const block of chunker.chunk(markdownSource(content))) {
      const location = range(block);
      expect(content.slice(location.startOffset, location.endOffset)).toBe(block.content);
      expect(location.startOffset).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = location.endOffset;
    }
  });

  it('keeps a heading-like line inside an unclosed fence out of headingPath', () => {
    const content = '# Root\n```\n# Not a section\nstill code';
    expect(contentsOf(content)).toEqual(['```\n# Not a section\nstill code']);
    expect(allHeadingSegments(content)).toEqual(['Root']);
  });

  it('still recognizes a heading after a blank line closes an HTML block', () => {
    // A blank line ends the basic HTML span, so what follows is document
    // structure again. This is the documented extent of basic HTML support.
    const content = '# Root\n<div>\ninner\n</div>\n\n## After\nAfter body.';
    expect(allHeadingSegments(content)).toEqual(['Root', 'Root', 'After']);
    expect(contentsOf(content)).toEqual(['<div>\ninner\n</div>', 'After body.']);
  });
});

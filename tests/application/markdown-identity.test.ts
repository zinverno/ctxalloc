import { createHash } from 'node:crypto';
import { MarkdownChunker } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN_BLOCKS,
  GOLDEN_DUPLICATE_IDS,
  GOLDEN_NULL_HEADING_PATH_ID,
  GOLDEN_SOURCE,
  GOLDEN_SOURCE_DOCUMENT_ID,
  codePointTokenizer,
  markdownSource,
  wordTokenizer,
} from './markdown-fixtures.js';

/**
 * Block identity, content hashing, token counts, and metadata.
 *
 * The golden vectors are committed values recomputed independently from the
 * DEC-029 specification, so a silent change to the payload shape, its order, the
 * algorithm version, or the occurrence counter fails here.
 */
const chunker = new MarkdownChunker(codePointTokenizer, {
  targetTokens: 400,
  maxTokens: 4000,
});

const ID_PATTERN = /^context-block:sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

describe('DEC-029 golden ContextBlock identity vectors', () => {
  it('reproduces the committed block identifiers and content hashes', () => {
    const source = markdownSource(GOLDEN_SOURCE);
    expect(source.document.id).toBe(GOLDEN_SOURCE_DOCUMENT_ID);

    const blocks = chunker.chunk(source);
    expect(blocks).toHaveLength(GOLDEN_BLOCKS.length);
    blocks.forEach((block, index) => {
      const golden = GOLDEN_BLOCKS[index];
      expect(block.content).toBe(golden?.content);
      expect(block.headingPath).toEqual(golden?.headingPath);
      expect(block.normalizedContentHash).toBe(golden?.normalizedContentHash);
      expect(block.id).toBe(golden?.id);
    });
  });

  it('reproduces the committed duplicate-occurrence identifiers', () => {
    const blocks = chunker.chunk(markdownSource('# Dup\nSame.\n\n# Dup\nSame.\n'));
    expect(blocks.map((block) => block.id)).toEqual([...GOLDEN_DUPLICATE_IDS]);
    expect(blocks[0]?.normalizedContentHash).toBe(blocks[1]?.normalizedContentHash);
    expect(blocks[0]?.content).toBe(blocks[1]?.content);
  });

  it('reproduces the committed identifier for an absent heading path', () => {
    const blocks = chunker.chunk(markdownSource('Rootless.'));
    expect(blocks[0]?.headingPath).toBeUndefined();
    expect(blocks[0]?.id).toBe(GOLDEN_NULL_HEADING_PATH_ID);
  });

  it('matches an independent recomputation of the documented algorithm', () => {
    const sha256 = (text: string): string =>
      `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    const source = markdownSource(GOLDEN_SOURCE);

    for (const block of chunker.chunk(source)) {
      const normalized = block.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      expect(block.normalizedContentHash).toBe(sha256(normalized));

      const payload = JSON.stringify([
        'ctxalloc-context-block-id',
        1,
        source.document.id,
        block.headingPath ?? null,
        block.normalizedContentHash,
        0,
      ]);
      expect(block.id).toBe(`context-block:${sha256(payload)}`);
    }
  });
});

describe('INV-BLOCK-001: block identity is stable and content-derived', () => {
  it('keeps a block ID unchanged when unrelated earlier text shifts its offsets', () => {
    const before = chunker.chunk(markdownSource('# A\nFirst.\n\n# B\nSecond.'));
    const after = chunker.chunk(
      markdownSource('# A\nFirst body is now much longer.\n\n# B\nSecond.'),
    );

    const beforeB = before.find((block) => block.content === 'Second.');
    const afterB = after.find((block) => block.content === 'Second.');
    expect(afterB?.id).toBe(beforeB?.id);
    // The offsets really did move, so the stability is not a coincidence.
    expect(afterB?.sourceLocation).not.toEqual(beforeB?.sourceLocation);
  });

  it('keeps a block ID unchanged when a new section is inserted before it', () => {
    const before = chunker.chunk(markdownSource('# A\nAlpha.\n\n# C\nGamma.'));
    const after = chunker.chunk(markdownSource('# A\nAlpha.\n\n# B\nBeta.\n\n# C\nGamma.'));
    const beforeC = before.find((block) => block.content === 'Gamma.');
    const afterC = after.find((block) => block.content === 'Gamma.');
    expect(afterC?.id).toBe(beforeC?.id);
  });

  it('changes the block ID when the heading path changes', () => {
    const first = chunker.chunk(markdownSource('# A\nBody.'));
    const second = chunker.chunk(markdownSource('# B\nBody.'));
    expect(second[0]?.normalizedContentHash).toBe(first[0]?.normalizedContentHash);
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });

  it('changes the block ID when the content changes', () => {
    const first = chunker.chunk(markdownSource('# A\nBody one.'));
    const second = chunker.chunk(markdownSource('# A\nBody two.'));
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });

  it('INV-SCOPE-002: changes the block ID when the source document changes', () => {
    const first = chunker.chunk(markdownSource('# A\nBody.', { key: 'one.md' }));
    const second = chunker.chunk(markdownSource('# A\nBody.', { key: 'two.md' }));
    expect(second[0]?.id).not.toBe(first[0]?.id);

    const otherProject = chunker.chunk(markdownSource('# A\nBody.', { projectId: 'other' }));
    expect(otherProject[0]?.id).not.toBe(first[0]?.id);
  });

  it('does not depend on the tokenizer, the token count, or the options', () => {
    const source = markdownSource('# A\nBody text here.');
    const withCodePoints = chunker.chunk(source);
    const withWords = new MarkdownChunker(wordTokenizer, {
      targetTokens: 400,
      maxTokens: 4000,
    }).chunk(source);

    expect(withWords[0]?.id).toBe(withCodePoints[0]?.id);
    expect(withWords[0]?.tokenCount).not.toBe(withCodePoints[0]?.tokenCount);
  });

  it('does not depend on the document title, timestamps, or metadata', () => {
    const plain = chunker.chunk(markdownSource('# A\nBody.'));
    const decorated = chunker.chunk(
      markdownSource('# A\nBody.', {
        title: 'Some title',
        createdAt: '2026-01-31T09:15:00.000Z',
        updatedAt: '2026-02-01T09:15:00.000Z',
        metadata: { path: '/absolute/path.md', tags: ['a', 'b'] },
      }),
    );
    expect(decorated[0]?.id).toBe(plain[0]?.id);
  });

  it('INV-BLOCK-002: gives every block in one source a unique identifier', () => {
    const source = markdownSource('# A\nSame.\n\n# A\nSame.\n\n## B\nSame.\n\n# A\nSame.\n');
    const ids = chunker.chunk(source).map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('emits identifiers and hashes in the documented representation', () => {
    for (const block of chunker.chunk(markdownSource(GOLDEN_SOURCE))) {
      expect(block.id).toMatch(ID_PATTERN);
      expect(block.normalizedContentHash).toMatch(HASH_PATTERN);
    }
  });
});

describe('normalizedContentHash normalization rule', () => {
  it('hashes an LF and a CRLF copy of the same text identically', () => {
    const lf = chunker.chunk(markdownSource('# A\nfirst\nsecond'));
    const crlf = chunker.chunk(markdownSource('# A\r\nfirst\r\nsecond'));
    expect(crlf[0]?.normalizedContentHash).toBe(lf[0]?.normalizedContentHash);
    // The content itself is still the exact, unmodified source text.
    expect(crlf[0]?.content).toBe('first\r\nsecond');
    expect(lf[0]?.content).toBe('first\nsecond');
  });

  it('hashes a lone-CR copy identically as well', () => {
    const lf = chunker.chunk(markdownSource('# A\nfirst\nsecond'));
    const cr = chunker.chunk(markdownSource('# A\nfirst\rsecond'));
    expect(cr[0]?.normalizedContentHash).toBe(lf[0]?.normalizedContentHash);
  });

  it('does not collapse blank lines, trim, or drop trailing spaces', () => {
    const tight = chunker.chunk(markdownSource('# A\nfirst\n\nsecond'));
    const loose = chunker.chunk(markdownSource('# A\nfirst\n\n\n\nsecond'));
    const spaced = chunker.chunk(markdownSource('# A\nfirst   \n\nsecond'));
    expect(loose[0]?.normalizedContentHash).not.toBe(tight[0]?.normalizedContentHash);
    expect(spaced[0]?.normalizedContentHash).not.toBe(tight[0]?.normalizedContentHash);
  });

  it('does not normalize Unicode composition', () => {
    // Written as escapes on purpose: the two forms must stay distinct in the
    // file itself, not depend on how an editor saved the literal.
    const composed = chunker.chunk(markdownSource('# A\ncaf\u00e9'));
    const decomposed = chunker.chunk(markdownSource('# A\ncafe\u0301'));
    expect(decomposed[0]?.content).not.toBe(composed[0]?.content);
    expect(decomposed[0]?.normalizedContentHash).not.toBe(composed[0]?.normalizedContentHash);
  });

  it('does not preserve indentation-insensitive equality', () => {
    const plain = chunker.chunk(markdownSource('# A\n```\nx\n```'));
    const indented = chunker.chunk(markdownSource('# A\n```\n  x\n```'));
    expect(indented[0]?.normalizedContentHash).not.toBe(plain[0]?.normalizedContentHash);
  });
});

describe('INV-BLOCK-003: token counts describe block content exactly', () => {
  it('records the tokenizer count of the exact content', () => {
    for (const block of chunker.chunk(markdownSource(GOLDEN_SOURCE))) {
      expect(block.tokenCount).toBe(codePointTokenizer.countTokens(block.content));
    }
  });

  it('does not count the heading path, a breadcrumb, or a separator', () => {
    const [block] = chunker.chunk(markdownSource('# A Long Heading Name\nHi.'));
    expect(block?.tokenCount).toBe(3);
    expect(block?.headingPath).toEqual(['A Long Heading Name']);
  });

  it('reports a finite non-negative safe integer', () => {
    for (const block of chunker.chunk(markdownSource('# A\nBody.\n\n# B\nMore.'))) {
      expect(Number.isSafeInteger(block.tokenCount)).toBe(true);
      expect(block.tokenCount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('ContextBlock fields and metadata', () => {
  it('carries the documented fields', () => {
    const source = markdownSource('# A\nBody.', {
      title: 'Note',
      createdAt: '2026-01-31T09:15:00.000Z',
      updatedAt: '2026-02-01T09:15:00.000Z',
      metadata: { path: 'notes/a.md', tags: ['x'] },
      projectId: 'proj',
    });
    const [block] = chunker.chunk(source);

    expect(block?.schemaVersion).toBe(1);
    expect(block?.scope).toEqual({ tenantId: 'local', workspaceId: 'default', projectId: 'proj' });
    expect(block?.sourceDocumentId).toBe(source.document.id);
    expect(block?.sourceType).toBe('markdown');
    expect(block?.createdAt).toBe('2026-01-31T09:15:00.000Z');
    expect(block?.updatedAt).toBe('2026-02-01T09:15:00.000Z');
    expect(block?.attributes).toEqual({});
    expect(block?.metadata).toEqual({
      source: { path: 'notes/a.md', tags: ['x'] },
      chunking: { chunkerId: 'ctxalloc-markdown-structural', chunkerVersion: '1' },
      tokenization: { tokenizerId: 'test:code-point', tokenizerVersion: '1' },
    });
  });

  it('omits createdAt and updatedAt when the document has none', () => {
    const [block] = chunker.chunk(markdownSource('# A\nBody.'));
    expect(block?.createdAt).toBeUndefined();
    expect(block?.updatedAt).toBeUndefined();
  });

  it('INV-ADAPTER-002: never mutates the source document or its metadata', () => {
    const source = markdownSource('# A\nBody.', { metadata: { tags: ['x'], nested: { a: 1 } } });
    const snapshot = JSON.stringify(source);
    const [block] = chunker.chunk(source);

    expect(JSON.stringify(source)).toBe(snapshot);
    // The copied metadata is a distinct object graph, so mutating a block cannot
    // reach back into the ingested source.
    const metadata = block?.metadata as { source: { nested: { a: number } } };
    expect(metadata.source).not.toBe(source.document.metadata);
    expect(metadata.source.nested).not.toBe(
      (source.document.metadata as { nested: unknown }).nested,
    );
  });

  it('DEC-026: adds no retrieval score, allocation decision, or summary', () => {
    const [block] = chunker.chunk(markdownSource('# A\nBody.'));
    const serialized = JSON.stringify(block);
    for (const forbidden of ['relevanceScore', 'recencyScore', 'summary', 'included', 'required']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('marks only oversized blocks with the chunking flag', () => {
    const small = new MarkdownChunker(codePointTokenizer, { targetTokens: 5, maxTokens: 8 });
    const blocks = small.chunk(markdownSource('# A\n```\nA long fenced code block here.\n```'));
    expect(blocks[0]?.metadata).toMatchObject({ chunking: { oversized: true } });

    const [fitting] = chunker.chunk(markdownSource('# A\nShort.'));
    expect(JSON.stringify(fitting?.metadata)).not.toContain('oversized');
  });
});

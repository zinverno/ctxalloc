import { TextChunker, TextChunkingError, TextChunkingValidationError } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import {
  brokenTokenizer,
  chunkText,
  explodingTokenizer,
  textSource,
  wordTokenizer,
} from './text-fixtures.js';

describe('TextChunker: block identity', () => {
  it('INV-BLOCK-001: keeps a block identifier stable when unrelated earlier text changes', () => {
    const before = chunkText('first paragraph\n\ntarget paragraph\n', {
      targetTokens: 2,
      maxTokens: 2,
    });
    const after = chunkText('first paragraph edited here\n\ntarget paragraph\n', {
      targetTokens: 2,
      maxTokens: 2,
    });

    const target = (blocks: typeof before): string | undefined =>
      blocks.find((block) => block.content === 'target paragraph')?.id;

    expect(target(before)).toBeDefined();
    expect(target(after)).toBe(target(before));
  });

  it('INV-BLOCK-001: changes the identifier when the block content changes', () => {
    const first = chunkText('alpha content\n');
    const second = chunkText('beta content\n');
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it('INV-BLOCK-002: gives duplicate paragraphs distinct occurrence identifiers', () => {
    const blocks = chunkText('same text\n\nsame text\n\nsame text\n', {
      targetTokens: 2,
      maxTokens: 2,
    });
    expect(blocks.map((block) => block.content)).toEqual(['same text', 'same text', 'same text']);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(3);
    expect(new Set(blocks.map((block) => block.normalizedContentHash)).size).toBe(1);
  });

  it('binds the identifier to the source document', () => {
    const one = chunkText('shared body\n', undefined, undefined, {
      identity: { namespace: 'vault:notes', key: 'a.txt' },
    });
    const two = chunkText('shared body\n', undefined, undefined, {
      identity: { namespace: 'vault:notes', key: 'b.txt' },
    });
    expect(one[0]?.id).not.toBe(two[0]?.id);
  });

  it('INV-DET-001: derives the same identifiers for the same source and policy', () => {
    const content = 'alpha one\n\nbeta two\n\ngamma three\n';
    const first = chunkText(content, { targetTokens: 3, maxTokens: 5 });
    const second = chunkText(content, { targetTokens: 3, maxTokens: 5 });
    expect(first).toEqual(second);
  });

  it('INV-DET-003: derives the identifier from content alone, never from offsets or counts', () => {
    // Two sources whose target paragraph sits at different offsets and different
    // line numbers still agree on that paragraph's identity.
    const short = chunkText('x\n\nrepeated body\n', { targetTokens: 2, maxTokens: 2 });
    const long = chunkText('x y\n\nsomething else here\n\nrepeated body\n', {
      targetTokens: 2,
      maxTokens: 3,
    });
    const pick = (blocks: typeof short): string | undefined =>
      blocks.find((block) => block.content === 'repeated body')?.id;
    expect(pick(short)).toBe(pick(long));
  });
});

describe('TextChunker: block records', () => {
  it('records the chunker and tokenizer identities on every block', () => {
    const blocks = chunkText('body text\n');
    expect(blocks[0]?.metadata).toMatchObject({
      chunking: { chunkerId: 'ctxalloc-text-paragraph', chunkerVersion: '1' },
      tokenization: { tokenizerId: 'test:word', tokenizerVersion: '1' },
    });
  });

  it('deep-copies source metadata rather than sharing the caller object', () => {
    const metadata = { path: 'notes.txt', tags: ['a'] };
    const blocks = chunkText('body text\n', undefined, undefined, { metadata });

    metadata.path = 'changed.txt';
    metadata.tags.push('b');

    expect(blocks[0]?.metadata).toMatchObject({ source: { path: 'notes.txt', tags: ['a'] } });
  });

  it('carries the document timestamps and invents none', () => {
    const withTimes = chunkText('body text\n', undefined, undefined, {
      createdAt: '2026-01-31T09:15:00.000Z',
      updatedAt: '2026-02-01T09:15:00.000Z',
    });
    expect(withTimes[0]?.createdAt).toBe('2026-01-31T09:15:00.000Z');
    expect(withTimes[0]?.updatedAt).toBe('2026-02-01T09:15:00.000Z');

    const withoutTimes = chunkText('body text\n');
    expect(withoutTimes[0]?.createdAt).toBeUndefined();
    expect(withoutTimes[0]?.updatedAt).toBeUndefined();
  });

  it('emits empty attributes: a chunker declares no requirement or priority', () => {
    expect(chunkText('body text\n')[0]?.attributes).toEqual({});
  });

  it('emits the source scope and source type unchanged', () => {
    const blocks = chunkText('body text\n');
    expect(blocks[0]?.scope).toEqual({ tenantId: 'local', workspaceId: 'default' });
    expect(blocks[0]?.sourceType).toBe('text');
  });
});

describe('TextChunker: validation', () => {
  it('rejects a token policy that is not two positive safe integers', () => {
    for (const options of [
      { targetTokens: 0, maxTokens: 10 },
      { targetTokens: -1, maxTokens: 10 },
      { targetTokens: 1.5, maxTokens: 10 },
      { targetTokens: 10, maxTokens: 0 },
      { targetTokens: Number.NaN, maxTokens: 10 },
      { targetTokens: Number.POSITIVE_INFINITY, maxTokens: 10 },
      { targetTokens: Number.MAX_SAFE_INTEGER + 2, maxTokens: Number.MAX_SAFE_INTEGER + 2 },
    ]) {
      expect(() => new TextChunker(wordTokenizer, options), JSON.stringify(options)).toThrow(
        TextChunkingValidationError,
      );
    }
  });

  it('rejects a target above the maximum', () => {
    expect(() => new TextChunker(wordTokenizer, { targetTokens: 11, maxTokens: 10 })).toThrow(
      TextChunkingValidationError,
    );
  });

  it('injects no default token policy', () => {
    expect(
      () =>
        new TextChunker(
          wordTokenizer,
          {} as unknown as { targetTokens: number; maxTokens: number },
        ),
    ).toThrow(TextChunkingValidationError);
  });

  it('rejects a tokenizer that does not satisfy the port', () => {
    for (const tokenizer of [
      null,
      {},
      { id: '', version: '1', countTokens: (): number => 0 },
      { id: 'x', version: ' ', countTokens: (): number => 0 },
      { id: 'x', version: '1' },
    ]) {
      expect(
        () => new TextChunker(tokenizer as never, { targetTokens: 1, maxTokens: 1 }),
        JSON.stringify(tokenizer),
      ).toThrow(TextChunkingValidationError);
    }
  });

  it('rejects a source whose type is not text', () => {
    const chunker = new TextChunker(wordTokenizer, { targetTokens: 5, maxTokens: 5 });
    const markdown = textSource('# Title\n', { sourceType: 'markdown' });
    expect(() => chunker.chunk(markdown)).toThrow(TextChunkingValidationError);
    try {
      chunker.chunk(markdown);
    } catch (cause) {
      expect((cause as TextChunkingValidationError).issues[0]?.code).toBe('invalid_source_type');
    }
  });

  it('INV-PROV-005: rejects content that does not hash to the document hash', () => {
    const chunker = new TextChunker(wordTokenizer, { targetTokens: 5, maxTokens: 5 });
    const source = textSource('original body\n');
    const tampered = { document: source.document, content: 'different body\n' };
    try {
      chunker.chunk(tampered);
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(TextChunkingValidationError);
      expect((cause as TextChunkingValidationError).issues[0]?.code).toBe('content_hash_mismatch');
    }
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 content', () => {
    const chunker = new TextChunker(wordTokenizer, { targetTokens: 5, maxTokens: 5 });
    const source = textSource('body\n');
    const tampered = { document: source.document, content: 'lone \ud800 surrogate' };
    try {
      chunker.chunk(tampered);
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(TextChunkingValidationError);
      expect((cause as TextChunkingValidationError).issues[0]?.code).toBe('invalid_unicode');
    }
  });

  it('rejects a source record that is not an ingestion result', () => {
    const chunker = new TextChunker(wordTokenizer, { targetTokens: 5, maxTokens: 5 });
    for (const source of [null, {}, { content: 'x' }, { document: {}, content: 'x' }]) {
      expect(() => chunker.chunk(source as never)).toThrow(TextChunkingValidationError);
    }
  });
});

describe('TextChunker: tokenizer failure', () => {
  it('INV-ADAPTER-001: wraps a tokenizer exception instead of leaking it', () => {
    const chunker = new TextChunker(explodingTokenizer, { targetTokens: 5, maxTokens: 5 });
    try {
      chunker.chunk(textSource('body text\n'));
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(TextChunkingError);
      const error = cause as TextChunkingError;
      expect(error.code).toBe('TEXT_CHUNKING_TOKENIZER_FAILED');
      expect(error.range).not.toBeNull();
      expect(Object.keys(error)).not.toContain('libraryDetail');
    }
  });

  it('INV-BUDGET-005: rejects a count that is not a non-negative safe integer', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      const chunker = new TextChunker(brokenTokenizer(value), { targetTokens: 5, maxTokens: 5 });
      expect(() => chunker.chunk(textSource('body text\n')), String(value)).toThrow(
        TextChunkingError,
      );
    }
  });
});

describe('TextChunker: immutability', () => {
  it('does not mutate the ingested source it is given', () => {
    const source = textSource('alpha one\n\nbeta two\n');
    const snapshot = structuredClone({ document: source.document, content: source.content });

    new TextChunker(wordTokenizer, { targetTokens: 2, maxTokens: 2 }).chunk(source);

    expect({ document: source.document, content: source.content }).toEqual(snapshot);
  });

  it('does not let a later option mutation change policy', () => {
    const options = { targetTokens: 2, maxTokens: 2 };
    const chunker = new TextChunker(wordTokenizer, options);
    const before = chunker.chunk(textSource('alpha one\n\nbeta two\n'));

    (options as { targetTokens: number }).targetTokens = 100;
    (options as { maxTokens: number }).maxTokens = 100;

    expect(chunker.chunk(textSource('alpha one\n\nbeta two\n'))).toEqual(before);
  });
});

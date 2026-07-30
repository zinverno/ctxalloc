import {
  MarkdownChunker,
  MarkdownChunkingError,
  MarkdownChunkingValidationError,
  ingestSource,
  type IngestedSource,
  type MarkdownChunkingOptions,
} from '@ctxalloc/application';
import { DomainValidationError } from '@ctxalloc/domain';
import { describe, expect, it } from 'vitest';
import {
  ExplodingTokenizerError,
  brokenTokenizer,
  codePointTokenizer,
  explodingTokenizer,
  markdownSource,
} from './markdown-fixtures.js';

/**
 * Construction and input validation at the runtime boundary.
 *
 * The chunker is reached by data that may have been persisted, transported, or
 * assembled by hand, so every property it relies on is re-established rather than
 * trusted from the compile-time type (INV-BLOCK-005).
 */

const VALID_OPTIONS: MarkdownChunkingOptions = { targetTokens: 100, maxTokens: 200 };

function construct(options: unknown): MarkdownChunker {
  return new MarkdownChunker(codePointTokenizer, options as MarkdownChunkingOptions);
}

describe('MarkdownChunkingOptions validation', () => {
  it('accepts equal target and max values', () => {
    expect(() => construct({ targetTokens: 50, maxTokens: 50 })).not.toThrow();
  });

  it.each([
    ['a numeric string target', { targetTokens: '100', maxTokens: 200 }],
    ['a numeric string max', { targetTokens: 100, maxTokens: '200' }],
    ['a fractional target', { targetTokens: 10.5, maxTokens: 200 }],
    ['a fractional max', { targetTokens: 100, maxTokens: 200.5 }],
    ['NaN', { targetTokens: Number.NaN, maxTokens: 200 }],
    ['Infinity', { targetTokens: 100, maxTokens: Number.POSITIVE_INFINITY }],
    ['zero', { targetTokens: 0, maxTokens: 200 }],
    ['a negative target', { targetTokens: -1, maxTokens: 200 }],
    ['a negative max', { targetTokens: 100, maxTokens: -200 }],
    ['a value above MAX_SAFE_INTEGER', { targetTokens: 1, maxTokens: 2 ** 53 }],
    ['target greater than max', { targetTokens: 300, maxTokens: 200 }],
    ['a missing target', { maxTokens: 200 }],
    ['a missing max', { targetTokens: 100 }],
    ['an unknown field', { targetTokens: 100, maxTokens: 200, overlapTokens: 20 }],
    ['a legacy character option', { targetChars: 1200, maxChars: 1800 }],
    ['null', null],
    ['a string', 'big'],
  ])('rejects %s', (_name, options) => {
    expect(() => construct(options)).toThrow(MarkdownChunkingValidationError);
  });

  it('reports serializable, deterministically ordered issues', () => {
    let error: MarkdownChunkingValidationError | undefined;
    try {
      construct({ targetTokens: -1, maxTokens: 0 });
    } catch (caught) {
      error = caught as MarkdownChunkingValidationError;
    }

    expect(error?.code).toBe('MARKDOWN_CHUNKING_INVALID_INPUT');
    expect(JSON.parse(JSON.stringify(error?.issues))).toEqual(error?.issues);
    for (const issue of error?.issues ?? []) {
      expect(typeof issue.code).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(issue.pointer.startsWith('options.')).toBe(true);
    }

    // Repeating the same invalid construction reports the identical issues.
    let second: MarkdownChunkingValidationError | undefined;
    try {
      construct({ targetTokens: -1, maxTokens: 0 });
    } catch (caught) {
      second = caught as MarkdownChunkingValidationError;
    }
    expect(second?.issues).toEqual(error?.issues);
  });

  it('does not mutate the supplied options object', () => {
    const options = { targetTokens: 100, maxTokens: 200 };
    new MarkdownChunker(codePointTokenizer, options);
    expect(options).toEqual({ targetTokens: 100, maxTokens: 200 });
  });

  it('does not follow a later mutation of the caller options object', () => {
    const options = { targetTokens: 100, maxTokens: 200 };
    const chunker = new MarkdownChunker(codePointTokenizer, options);
    const before = chunker.chunk(markdownSource('# A\nBody.'));
    (options as { maxTokens: number }).maxTokens = 1;
    expect(chunker.chunk(markdownSource('# A\nBody.'))).toEqual(before);
  });

  it('injects no production default', () => {
    // Every field is required, so an empty object cannot silently become a policy.
    expect(() => construct({})).toThrow(MarkdownChunkingValidationError);
  });
});

describe('tokenizer dependency validation', () => {
  it.each([
    ['null', null],
    ['a plain object', {}],
    ['a missing countTokens', { id: 'x', version: '1' }],
    ['an empty id', { id: '', version: '1', countTokens: (): number => 1 }],
    ['a whitespace-only version', { id: 'x', version: '  ', countTokens: (): number => 1 }],
  ])('rejects %s as a tokenizer', (_name, tokenizer) => {
    expect(() => new MarkdownChunker(tokenizer as never, VALID_OPTIONS)).toThrow(
      MarkdownChunkingValidationError,
    );
  });
});

describe('chunking input validation', () => {
  const chunker = new MarkdownChunker(codePointTokenizer, VALID_OPTIONS);

  function chunkInvalid(source: unknown): void {
    chunker.chunk(source as IngestedSource);
  }

  it.each([
    ['null', null],
    ['a string', 'not a source'],
    ['a missing document', { content: 'Body.' }],
    ['a missing content', { document: markdownSource('Body.').document }],
    ['a non-string content', { document: markdownSource('Body.').document, content: 42 }],
    ['an unknown field', { ...markdownSource('Body.'), extra: true }],
  ])('rejects %s', (_name, source) => {
    expect(() => chunkInvalid(source)).toThrow(MarkdownChunkingValidationError);
  });

  it.each(['text', 'conversation'])('rejects the %s source type', (sourceType) => {
    const source = ingestSource({
      scope: { tenantId: 'local', workspaceId: 'default' },
      sourceType,
      identity: { namespace: 'vault', key: 'note' },
      content: 'Body.',
      metadata: {},
    });

    let error: MarkdownChunkingValidationError | undefined;
    try {
      chunker.chunk(source);
    } catch (caught) {
      error = caught as MarkdownChunkingValidationError;
    }
    expect(error).toBeInstanceOf(MarkdownChunkingValidationError);
    expect(error?.issues.map((detail) => detail.code)).toContain('invalid_source_type');
  });

  it('rejects a contentHash mismatch with an explicit machine-readable issue', () => {
    const source = markdownSource('# A\nOriginal body.');
    const tampered = { document: source.document, content: '# A\nTampered body.' };

    let error: MarkdownChunkingValidationError | undefined;
    try {
      chunker.chunk(tampered);
    } catch (caught) {
      error = caught as MarkdownChunkingValidationError;
    }

    expect(error).toBeInstanceOf(MarkdownChunkingValidationError);
    expect(error?.code).toBe('MARKDOWN_CHUNKING_INVALID_INPUT');
    expect(error?.issues.map((detail) => detail.code)).toContain('content_hash_mismatch');
    expect(error?.issues.map((detail) => detail.pointer)).toContain('content');
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 content before hashing or counting', () => {
    const lone = 'Body \ud800 end.';
    const source = { document: markdownSource('Body.').document, content: lone };

    let error: MarkdownChunkingValidationError | undefined;
    try {
      chunker.chunk(source);
    } catch (caught) {
      error = caught as MarkdownChunkingValidationError;
    }
    expect(error?.issues.map((detail) => detail.code)).toContain('invalid_unicode');
    // The Unicode failure is reported on its own: no hash of replacement
    // characters is ever computed to produce a second, misleading issue.
    expect(error?.issues.map((detail) => detail.code)).not.toContain('content_hash_mismatch');
  });

  it('does not mutate the supplied source', () => {
    const source = markdownSource('# A\nBody.', { metadata: { tags: ['x'] } });
    const snapshot = JSON.stringify(source);
    chunker.chunk(source);
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it('INV-ADAPTER-001: never lets a validation-library error escape', () => {
    try {
      chunkInvalid({ document: null, content: '' });
      expect.unreachable('expected a validation failure');
    } catch (caught) {
      expect(caught).toBeInstanceOf(MarkdownChunkingValidationError);
      expect(caught).not.toBeInstanceOf(DomainValidationError);
      expect((caught as Error).name).toBe('MarkdownChunkingValidationError');
      expect(String(caught)).not.toContain('Zod');
    }
  });
});

describe('INV-ADAPTER-003: tokenizer failure is explicit and wrapped', () => {
  it('wraps a thrown tokenizer error with a stable code and a block range', () => {
    const chunker = new MarkdownChunker(explodingTokenizer, VALID_OPTIONS);

    let error: MarkdownChunkingError | undefined;
    try {
      chunker.chunk(markdownSource('# A\nBody.'));
    } catch (caught) {
      error = caught as MarkdownChunkingError;
    }

    expect(error).toBeInstanceOf(MarkdownChunkingError);
    expect(error).not.toBeInstanceOf(ExplodingTokenizerError);
    expect(error?.code).toBe('MARKDOWN_CHUNKING_TOKENIZER_FAILED');
    expect(error?.range?.startOffset).toBeGreaterThanOrEqual(0);
    expect(error?.range?.endOffset).toBeGreaterThan(error?.range?.startOffset ?? 0);
    // The failing tokenizer is named and its message is quoted, but the external
    // error object itself does not travel across the boundary.
    expect(error?.message).toContain('test:exploding');
    expect(error?.message).toContain('encoder exploded');
    expect((error as { cause?: unknown } | undefined)?.cause).toBeUndefined();
  });

  it.each([
    ['a fractional count', 1.5],
    ['a negative count', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s instead of returning a block', (_name, value) => {
    const chunker = new MarkdownChunker(brokenTokenizer(value), VALID_OPTIONS);

    let error: MarkdownChunkingError | undefined;
    try {
      chunker.chunk(markdownSource('# A\nBody.'));
    } catch (caught) {
      error = caught as MarkdownChunkingError;
    }
    expect(error).toBeInstanceOf(MarkdownChunkingError);
    expect(error?.code).toBe('MARKDOWN_CHUNKING_TOKENIZER_FAILED');
  });

  it('never substitutes an estimate for a failed count', () => {
    const chunker = new MarkdownChunker(explodingTokenizer, VALID_OPTIONS);
    expect(() => chunker.chunk(markdownSource('# A\nBody.'))).toThrow(MarkdownChunkingError);
  });
});

import {
  ConversationChunker,
  ConversationChunkingError,
  ConversationChunkingValidationError,
  ingestConversationSource,
  type IngestedConversationSource,
} from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { brokenTokenizer, explodingTokenizer, wordTokenizer } from './text-fixtures.js';

const SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;
const IDENTITY = { namespace: 'chat:local', key: 'thread-1' } as const;

function ingest(
  messages: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): IngestedConversationSource {
  return ingestConversationSource({
    scope: { ...SCOPE },
    identity: { ...IDENTITY },
    payload: { schemaVersion: 1, messages },
    metadata: {},
    ...overrides,
  });
}

function chunk(
  messages: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): ReturnType<ConversationChunker['chunk']> {
  return new ConversationChunker(wordTokenizer).chunk(ingest(messages, overrides));
}

const MESSAGES = [
  { id: 'm1', content: 'What is the budget?' },
  { id: 'm2', content: 'Four thousand tokens for input.' },
  { id: 'm3', content: 'Thank you.' },
];

describe('ConversationChunker: one message, one block', () => {
  it('produces no block for a conversation with no messages', () => {
    expect(chunk([])).toEqual([]);
  });

  it('produces exactly one block per message, in message order', () => {
    const blocks = chunk(MESSAGES);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.content)).toEqual(MESSAGES.map((m) => m.content));
  });

  it('INV-PROV-002: never splits a message, however long', () => {
    const long = 'word '.repeat(500).trim();
    const blocks = chunk([{ id: 'm1', content: long }]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe(long);
    expect(blocks[0]?.tokenCount).toBe(500);
  });

  it('INV-PROV-002: locates each block at the message it came from', () => {
    const blocks = chunk(MESSAGES);
    blocks.forEach((block, index) => {
      const location = block.sourceLocation;
      expect(location?.kind).toBe('conversation-message');
      if (location?.kind !== 'conversation-message') throw new Error('expected a message location');
      expect(location.messageId).toBe(MESSAGES[index]?.id);
      expect(location.messageIndex).toBe(index);
      expect(block.content).toBe(MESSAGES[index]?.content);
    });
  });

  it('carries the source document identity and type on every block', () => {
    const ingested = ingest(MESSAGES);
    const blocks = new ConversationChunker(wordTokenizer).chunk(ingested);
    for (const block of blocks) {
      expect(block.sourceDocumentId).toBe(ingested.document.id);
      expect(block.sourceType).toBe('conversation');
      expect(block.scope).toEqual(SCOPE);
      expect(block.attributes).toEqual({});
      expect(block.headingPath).toBeUndefined();
    }
  });

  it('preserves message content exactly, including line endings and Unicode', () => {
    const content = 'first\r\n  second  \n🌍 中文';
    const blocks = chunk([{ id: 'm1', content }]);
    expect(blocks[0]?.content).toBe(content);
  });
});

describe('ConversationChunker: block identity', () => {
  it('INV-BLOCK-001: keeps the identifier when an unrelated earlier message is inserted', () => {
    const before = chunk([MESSAGES[1]!, MESSAGES[2]!]);
    const after = chunk(MESSAGES);

    const target = (blocks: typeof before): string | undefined =>
      blocks.find((block) => block.content === MESSAGES[1]?.content)?.id;

    expect(target(before)).toBeDefined();
    expect(target(after)).toBe(target(before));
  });

  it('INV-BLOCK-001: keeps the identifier when a message moves, though its index changes', () => {
    const forward = chunk([MESSAGES[0]!, MESSAGES[1]!]);
    const reversed = chunk([MESSAGES[1]!, MESSAGES[0]!]);

    const find = (blocks: typeof forward, id: string) =>
      blocks.find((block) => {
        const location = block.sourceLocation;
        return location?.kind === 'conversation-message' && location.messageId === id;
      });

    const before = find(forward, 'm2');
    const after = find(reversed, 'm2');
    expect(before?.id).toBe(after?.id);

    const beforeLocation = before?.sourceLocation;
    const afterLocation = after?.sourceLocation;
    if (
      beforeLocation?.kind !== 'conversation-message' ||
      afterLocation?.kind !== 'conversation-message'
    ) {
      throw new Error('expected message locations');
    }
    expect(beforeLocation.messageIndex).toBe(1);
    expect(afterLocation.messageIndex).toBe(0);
  });

  it('INV-BLOCK-001: changes the identifier when the message content changes', () => {
    const before = chunk([{ id: 'm1', content: 'original' }]);
    const after = chunk([{ id: 'm1', content: 'edited' }]);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  it('changes the identifier when the message identifier changes', () => {
    const before = chunk([{ id: 'm1', content: 'same body' }]);
    const after = chunk([{ id: 'm9', content: 'same body' }]);
    expect(after[0]?.id).not.toBe(before[0]?.id);
  });

  it('binds the identifier to the source document', () => {
    const one = chunk([{ id: 'm1', content: 'same body' }]);
    const two = chunk([{ id: 'm1', content: 'same body' }], {
      identity: { namespace: 'chat:local', key: 'thread-2' },
    });
    expect(one[0]?.id).not.toBe(two[0]?.id);
  });

  it('INV-BLOCK-002: gives two messages with identical content distinct identifiers', () => {
    const blocks = chunk([
      { id: 'm1', content: 'repeated' },
      { id: 'm2', content: 'repeated' },
    ]);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(2);
    expect(new Set(blocks.map((block) => block.normalizedContentHash)).size).toBe(1);
  });
});

describe('ConversationChunker: block records', () => {
  it('INV-DET-004: prefers the message timestamp, falls back to the document, invents none', () => {
    const blocks = chunk(
      [
        { id: 'm1', content: 'with own times', createdAt: '2026-03-01T00:00:00.000Z' },
        { id: 'm2', content: 'without own times' },
      ],
      { createdAt: '2026-01-01T00:00:00.000Z' },
    );
    expect(blocks[0]?.createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(blocks[1]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(blocks[0]?.updatedAt).toBeUndefined();
    expect(blocks[1]?.updatedAt).toBeUndefined();

    const undated = chunk([{ id: 'm1', content: 'no times anywhere' }]);
    expect(undated[0]?.createdAt).toBeUndefined();
    expect(undated[0]?.updatedAt).toBeUndefined();
  });

  it('records the chunker and tokenizer identities', () => {
    expect(chunk(MESSAGES)[0]?.metadata).toMatchObject({
      chunking: { chunkerId: 'ctxalloc-conversation-message', chunkerVersion: '1' },
      tokenization: { tokenizerId: 'test:word', tokenizerVersion: '1' },
    });
  });

  it('deep-copies source and message metadata rather than sharing caller objects', () => {
    const sourceMetadata = { path: 'thread.json', tags: ['a'] };
    const messageMetadata = { seq: 1, labels: ['x'] };
    const blocks = chunk([{ id: 'm1', content: 'body', metadata: messageMetadata }], {
      metadata: sourceMetadata,
    });

    sourceMetadata.path = 'changed.json';
    sourceMetadata.tags.push('b');
    messageMetadata.seq = 99;
    messageMetadata.labels.push('y');

    expect(blocks[0]?.metadata).toMatchObject({
      source: { path: 'thread.json', tags: ['a'] },
      message: { seq: 1, labels: ['x'] },
    });
  });

  it('omits the message metadata entry when the message declares none', () => {
    const blocks = chunk([{ id: 'm1', content: 'body' }]);
    expect(Object.keys(blocks[0]?.metadata ?? {})).toEqual(['source', 'chunking', 'tokenization']);
  });

  it('counts tokens over the exact message content', () => {
    const blocks = chunk(MESSAGES);
    expect(blocks.map((block) => block.tokenCount)).toEqual([4, 5, 2]);
  });
});

describe('ConversationChunker: validation and failure', () => {
  it('rejects a tokenizer that does not satisfy the port', () => {
    for (const tokenizer of [null, {}, { id: 'x', version: '1' }]) {
      expect(() => new ConversationChunker(tokenizer as never)).toThrow(
        ConversationChunkingValidationError,
      );
    }
  });

  it('rejects a source whose type is not conversation', () => {
    const ingested = ingest(MESSAGES);
    const wrong = {
      ...ingested,
      document: { ...ingested.document, sourceType: 'markdown' as const },
    };
    expect(() => new ConversationChunker(wordTokenizer).chunk(wrong)).toThrow(
      ConversationChunkingValidationError,
    );
  });

  it('INV-PROV-005: rejects messages that do not hash to the document hash', () => {
    const ingested = ingest(MESSAGES);
    const tampered = {
      ...ingested,
      messages: [...ingested.messages, { id: 'm4', content: 'smuggled in' }],
    };
    try {
      new ConversationChunker(wordTokenizer).chunk(tampered);
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConversationChunkingValidationError);
      const codes = (cause as ConversationChunkingValidationError).issues.map(
        (detail) => detail.code,
      );
      expect(codes).toContain('content_mismatch');
      expect(codes).toContain('content_hash_mismatch');
    }
  });

  it('rejects a record that is not a conversation ingestion result', () => {
    const chunker = new ConversationChunker(wordTokenizer);
    for (const source of [null, {}, { document: {}, content: '', messages: [] }]) {
      expect(() => chunker.chunk(source as never)).toThrow(ConversationChunkingValidationError);
    }
  });

  it('INV-ADAPTER-001: wraps a tokenizer exception instead of leaking it', () => {
    try {
      new ConversationChunker(explodingTokenizer).chunk(ingest(MESSAGES));
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConversationChunkingError);
      const error = cause as ConversationChunkingError;
      expect(error.code).toBe('CONVERSATION_CHUNKING_TOKENIZER_FAILED');
      expect(error.messageId).toBe('m1');
      expect(Object.keys(error)).not.toContain('libraryDetail');
    }
  });

  it('INV-BUDGET-005: rejects a count that is not a non-negative safe integer', () => {
    for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null]) {
      expect(
        () => new ConversationChunker(brokenTokenizer(value)).chunk(ingest(MESSAGES)),
        String(value),
      ).toThrow(ConversationChunkingError);
    }
  });

  it('INV-DET-001: produces identical blocks for identical input', () => {
    expect(chunk(MESSAGES)).toEqual(chunk(MESSAGES));
  });

  it('does not mutate the source it is given', () => {
    const ingested = ingest(MESSAGES);
    const snapshot = structuredClone({
      document: ingested.document,
      content: ingested.content,
      messages: ingested.messages,
    });
    new ConversationChunker(wordTokenizer).chunk(ingested);
    expect({
      document: ingested.document,
      content: ingested.content,
      messages: ingested.messages,
    }).toEqual(snapshot);
  });
});

import {
  ConversationChunker,
  ingestConversationSource,
  parseConversationSourceJson,
} from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { wordTokenizer } from './text-fixtures.js';

/**
 * Committed golden identity vectors for conversation sources (DEC-039).
 *
 * The values were recomputed independently from the documented preimages, not
 * copied from a run of the implementation. They exist so a change to a canonical
 * payload, its field order, or its algorithm version breaks a test rather than
 * silently reinterpreting stored conversations and their blocks
 * (INV-BLOCK-001, INV-PROV-005).
 */

const SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;
const IDENTITY = { namespace: 'chat:local', key: 'thread-1' } as const;

const MESSAGES = [
  { id: 'msg-1', content: 'What is the token budget?' },
  { id: 'msg-2', content: 'Four thousand tokens.' },
];

/**
 * `["ctxalloc-conversation-content", 1, [[messageId, exactContent], ...]]`,
 * serialized compactly.
 */
const GOLDEN_CANONICAL_CONTENT =
  '["ctxalloc-conversation-content",1,[["msg-1","What is the token budget?"],["msg-2","Four thousand tokens."]]]';

/** SHA-256 of the canonical identity payload for this scope, type, and identity. */
const GOLDEN_DOCUMENT_ID =
  'source-document:sha256:f1436d58610a579eea362b42556d49c2bba9d2299e19f561e8e2f2c9a6ef412e';

/** SHA-256 of the canonical logical content above, encoded as UTF-8. */
const GOLDEN_CONTENT_HASH =
  'sha256:4c66cd40d9dbaff8390586fbbdfd5367abb460c3d54a4b305161e20bd87acdd9';

/**
 * SHA-256 of
 * `["ctxalloc-conversation-context-block-id", 1, sourceDocumentId, messageId, normalizedContentHash]`
 * for each message.
 */
const GOLDEN_BLOCK_IDS = [
  'context-block:sha256:f63f779b078bd8d333d9008c76ce5a190dc456a4355e3f4057baa790fd994c9d',
  'context-block:sha256:19c47d3c59ed1027c73d4c0452ce6057e204b04c3bf0f9c5591faa85de8c3b0b',
];

const GOLDEN_BLOCK_HASHES = [
  'sha256:9bcb4684903dec571b10b3861a0a9d1a8da30e98edcc03aed080b6fc6f21147d',
  'sha256:cb2ce55d114de3cc2ce16b09b47b84a18cf2267ea7d3f8cb66c00efc0f0de1ea',
];

function ingest(payload: unknown): ReturnType<typeof ingestConversationSource> {
  return ingestConversationSource({
    scope: { ...SCOPE },
    identity: { ...IDENTITY },
    payload,
    metadata: {},
  });
}

describe('DEC-039 golden conversation identity vectors', () => {
  it('derives the committed canonical logical content, document identity, and content hash', () => {
    const ingested = ingest({ schemaVersion: 1, messages: MESSAGES });
    expect(ingested.content).toBe(GOLDEN_CANONICAL_CONTENT);
    expect(ingested.document.id).toBe(GOLDEN_DOCUMENT_ID);
    expect(ingested.document.contentHash).toBe(GOLDEN_CONTENT_HASH);
  });

  it('derives the committed block identifiers and content hashes', () => {
    const blocks = new ConversationChunker(wordTokenizer).chunk(
      ingest({ schemaVersion: 1, messages: MESSAGES }),
    );
    expect(blocks.map((block) => block.id)).toEqual(GOLDEN_BLOCK_IDS);
    expect(blocks.map((block) => block.normalizedContentHash)).toEqual(GOLDEN_BLOCK_HASHES);
  });

  it('derives the same vectors from a pretty-printed file with reordered keys', () => {
    const reformatted = JSON.stringify(
      {
        messages: MESSAGES.map((message) => ({ content: message.content, id: message.id })),
        schemaVersion: 1,
      },
      null,
      4,
    );
    const ingested = ingest(parseConversationSourceJson(reformatted));

    expect(ingested.content).toBe(GOLDEN_CANONICAL_CONTENT);
    expect(ingested.document.id).toBe(GOLDEN_DOCUMENT_ID);
    expect(ingested.document.contentHash).toBe(GOLDEN_CONTENT_HASH);
    expect(new ConversationChunker(wordTokenizer).chunk(ingested).map((block) => block.id)).toEqual(
      GOLDEN_BLOCK_IDS,
    );
  });

  it('keeps a block identifier when an unrelated earlier message is inserted', () => {
    const withInsertion = ingest({
      schemaVersion: 1,
      messages: [{ id: 'msg-0', content: 'An earlier question.' }, ...MESSAGES],
    });
    const blocks = new ConversationChunker(wordTokenizer).chunk(withInsertion);

    // The document content hash changes, because the conversation says something
    // different; the identifiers of the unchanged messages do not.
    expect(withInsertion.document.contentHash).not.toBe(GOLDEN_CONTENT_HASH);
    expect(blocks.slice(1).map((block) => block.id)).toEqual(GOLDEN_BLOCK_IDS);
  });
});

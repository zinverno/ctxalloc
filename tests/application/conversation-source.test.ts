import {
  CONVERSATION_SOURCE_SCHEMA_VERSION,
  ConversationSourceValidationError,
  ingestConversationSource,
  parseConversationSourceJson,
  validateConversationSourcePayload,
} from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';

const SCOPE = { tenantId: 'local', workspaceId: 'default' } as const;
const IDENTITY = { namespace: 'chat:local', key: 'thread-1' } as const;

function payload(messages: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: CONVERSATION_SOURCE_SCHEMA_VERSION, messages };
}

function ingest(messages: readonly Record<string, unknown>[], overrides = {}) {
  return ingestConversationSource({
    scope: { ...SCOPE },
    identity: { ...IDENTITY },
    payload: payload(messages),
    metadata: {},
    ...overrides,
  });
}

const TWO_MESSAGES = [
  { id: 'm1', content: 'What is the budget?' },
  { id: 'm2', content: 'Four thousand tokens.' },
];

describe('conversation source format: strict validation', () => {
  it('accepts a minimal valid payload', () => {
    const parsed = validateConversationSourcePayload(payload(TWO_MESSAGES));
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
  });

  it('accepts an empty messages array', () => {
    expect(validateConversationSourcePayload(payload([])).messages).toEqual([]);
  });

  it('preserves exact message order', () => {
    const parsed = validateConversationSourcePayload(
      payload([
        { id: 'z', content: 'last' },
        { id: 'a', content: 'first' },
      ]),
    );
    expect(parsed.messages.map((message) => message.id)).toEqual(['z', 'a']);
  });

  it('rejects an unknown field rather than stripping it', () => {
    expect(() =>
      validateConversationSourcePayload({ ...payload(TWO_MESSAGES), extra: true }),
    ).toThrow(ConversationSourceValidationError);
    expect(() =>
      validateConversationSourcePayload(payload([{ id: 'm1', content: 'x', role: 'user' }])),
    ).toThrow(ConversationSourceValidationError);
  });

  it('rejects a schema version other than the one it supports', () => {
    for (const schemaVersion of [0, 2, '1', null, undefined]) {
      expect(
        () => validateConversationSourcePayload({ schemaVersion, messages: [] }),
        String(schemaVersion),
      ).toThrow(ConversationSourceValidationError);
    }
  });

  it('rejects a blank or malformed message identifier', () => {
    for (const id of ['', '   ', 'lone \ud800 surrogate', 7, null]) {
      expect(
        () => validateConversationSourcePayload(payload([{ id, content: 'body' }])),
        String(id),
      ).toThrow(ConversationSourceValidationError);
    }
  });

  it('INV-BLOCK-004: rejects whitespace-only content instead of dropping the message', () => {
    for (const content of ['', '   ', '\n\n']) {
      expect(
        () => validateConversationSourcePayload(payload([{ id: 'm1', content }])),
        JSON.stringify(content),
      ).toThrow(ConversationSourceValidationError);
    }
  });

  it('INV-BLOCK-002: rejects a duplicate message identifier', () => {
    try {
      validateConversationSourcePayload(
        payload([
          { id: 'm1', content: 'first' },
          { id: 'm1', content: 'second' },
        ]),
      );
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConversationSourceValidationError);
      expect((cause as ConversationSourceValidationError).issues[0]?.code).toBe(
        'duplicate_message_id',
      );
    }
  });

  it('rejects an exact timestamp that is not a real UTC instant', () => {
    for (const createdAt of ['2026-02-31T00:00:00.000Z', '2026-01-01 00:00:00', 'now', 12345]) {
      expect(
        () => validateConversationSourcePayload(payload([{ id: 'm1', content: 'x', createdAt }])),
        String(createdAt),
      ).toThrow(ConversationSourceValidationError);
    }
  });

  it('rejects metadata that is not JSON-safe', () => {
    for (const metadata of [{ when: new Date() }, { fn: (): void => undefined }, { n: NaN }]) {
      expect(() =>
        validateConversationSourcePayload(payload([{ id: 'm1', content: 'x', metadata }])),
      ).toThrow(ConversationSourceValidationError);
    }
  });

  it('declares no role, tool call, attachment, or thread field', () => {
    for (const field of ['role', 'toolCalls', 'attachments', 'parts', 'threadId', 'author']) {
      expect(
        () =>
          validateConversationSourcePayload(payload([{ id: 'm1', content: 'x', [field]: 'v' }])),
        field,
      ).toThrow(ConversationSourceValidationError);
    }
  });
});

describe('conversation source format: JSON parsing', () => {
  it('parses a well-formed conversation file', () => {
    const text = JSON.stringify(payload(TWO_MESSAGES));
    expect(parseConversationSourceJson(text).messages).toHaveLength(2);
  });

  it('INV-ADAPTER-001: wraps invalid JSON as a project-owned error, never a SyntaxError', () => {
    for (const text of ['{', 'not json', '', '[1,2', '{"a":}']) {
      try {
        parseConversationSourceJson(text);
        throw new Error(`expected a rejection for ${JSON.stringify(text)}`);
      } catch (cause) {
        expect(cause, JSON.stringify(text)).toBeInstanceOf(ConversationSourceValidationError);
        expect(cause).not.toBeInstanceOf(SyntaxError);
        expect((cause as ConversationSourceValidationError).issues[0]?.code).toBe('invalid_json');
      }
    }
  });

  it('rejects valid JSON that is not a conversation payload', () => {
    for (const text of ['null', '[]', '"text"', '{"messages":[]}']) {
      expect(() => parseConversationSourceJson(text), text).toThrow(
        ConversationSourceValidationError,
      );
    }
  });

  it('rejects a non-string input', () => {
    expect(() => parseConversationSourceJson(7 as unknown as string)).toThrow(
      ConversationSourceValidationError,
    );
  });
});

describe('conversation ingestion: logical content hashing', () => {
  it('hashes the canonical logical content, not the raw file', () => {
    const compact = ingest(TWO_MESSAGES);
    expect(compact.content).toBe(
      JSON.stringify([
        'ctxalloc-conversation-content',
        1,
        [
          ['m1', 'What is the budget?'],
          ['m2', 'Four thousand tokens.'],
        ],
      ]),
    );
  });

  it('INV-PROV-005: JSON formatting does not change the content hash', () => {
    const messages = TWO_MESSAGES;
    const compact = parseConversationSourceJson(JSON.stringify(payload(messages)));
    const pretty = parseConversationSourceJson(JSON.stringify(payload(messages), null, 4));
    const reordered = parseConversationSourceJson(
      JSON.stringify({
        messages: messages.map((message) => ({ content: message.content, id: message.id })),
        schemaVersion: 1,
      }),
    );

    const hashOf = (parsedPayload: unknown): string =>
      ingestConversationSource({
        scope: { ...SCOPE },
        identity: { ...IDENTITY },
        payload: parsedPayload,
        metadata: {},
      }).document.contentHash;

    expect(hashOf(pretty)).toBe(hashOf(compact));
    expect(hashOf(reordered)).toBe(hashOf(compact));
  });

  it('does not change the document identity when the file is reformatted', () => {
    const compact = ingest(TWO_MESSAGES);
    const pretty = ingestConversationSource({
      scope: { ...SCOPE },
      identity: { ...IDENTITY },
      payload: parseConversationSourceJson(JSON.stringify(payload(TWO_MESSAGES), null, 2)),
      metadata: {},
    });
    expect(pretty.document.id).toBe(compact.document.id);
  });

  it('changes the content hash when a message identifier changes', () => {
    const before = ingest(TWO_MESSAGES);
    const after = ingest([{ id: 'm1-renamed', content: 'What is the budget?' }, TWO_MESSAGES[1]!]);
    expect(after.document.contentHash).not.toBe(before.document.contentHash);
  });

  it('changes the content hash when message content changes', () => {
    const before = ingest(TWO_MESSAGES);
    const after = ingest([TWO_MESSAGES[0]!, { id: 'm2', content: 'Five thousand tokens.' }]);
    expect(after.document.contentHash).not.toBe(before.document.contentHash);
  });

  it('changes the content hash when the messages are reordered', () => {
    const before = ingest(TWO_MESSAGES);
    const after = ingest([TWO_MESSAGES[1]!, TWO_MESSAGES[0]!]);
    expect(after.document.contentHash).not.toBe(before.document.contentHash);
  });

  it('does not change the content hash when only a timestamp or metadata changes', () => {
    const plain = ingest(TWO_MESSAGES);
    const annotated = ingest([
      { ...TWO_MESSAGES[0]!, createdAt: '2026-01-31T09:15:00.000Z', metadata: { seq: 1 } },
      { ...TWO_MESSAGES[1]!, updatedAt: '2026-02-01T09:15:00.000Z' },
    ]);
    expect(annotated.document.contentHash).toBe(plain.document.contentHash);
  });

  it('records the source type as conversation and returns the exact messages', () => {
    const ingested = ingest(TWO_MESSAGES);
    expect(ingested.document.sourceType).toBe('conversation');
    expect(ingested.messages).toEqual(TWO_MESSAGES);
  });

  it('INV-SCOPE-002: binds document identity to the scope', () => {
    const local = ingest(TWO_MESSAGES);
    const other = ingest(TWO_MESSAGES, {
      scope: { tenantId: 'local', workspaceId: 'other' },
    });
    expect(other.document.id).not.toBe(local.document.id);
  });

  it('rejects an ingestion input that is not a complete request', () => {
    for (const input of [
      null,
      {},
      { scope: SCOPE, identity: IDENTITY, payload: payload([]) },
      { scope: SCOPE, identity: { namespace: '', key: 'k' }, payload: payload([]), metadata: {} },
      { scope: SCOPE, identity: IDENTITY, payload: payload([]), metadata: {}, extra: 1 },
    ]) {
      expect(() => ingestConversationSource(input), JSON.stringify(input)).toThrow(
        ConversationSourceValidationError,
      );
    }
  });

  it('INV-DET-001: produces identical records for identical input', () => {
    expect(ingest(TWO_MESSAGES)).toEqual(ingest(TWO_MESSAGES));
  });
});

import { describe, expect, it } from 'vitest';
import { ContextBlockSchema, safeParse } from '../../packages/domain/src/index.js';
import { VALID_HASH, validContextBlock } from './fixtures.js';

describe('ContextBlock accepts documented candidates', () => {
  it('accepts a complete valid block', () => {
    const input = validContextBlock();
    const result = safeParse(ContextBlockSchema, input);
    expect(result.ok && result.value).toEqual(input);
  });

  it('accepts a minimal block without optional fields', () => {
    const result = safeParse(ContextBlockSchema, {
      id: 'block-1',
      schemaVersion: 1,
      scope: { tenantId: 'local', workspaceId: 'default' },
      sourceDocumentId: 'doc-1',
      sourceType: 'text',
      content: 'body',
      normalizedContentHash: VALID_HASH,
      tokenCount: 0,
      attributes: {},
      metadata: {},
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a conversation block located by message identifier', () => {
    const result = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      sourceType: 'conversation',
      sourceLocation: { kind: 'conversation-message', messageId: 'msg-3', messageIndex: 2 },
    });
    expect(result.ok).toBe(true);
  });
});

describe('INV-BLOCK-004: empty blocks are not ordinary candidates', () => {
  it.each([
    ['empty string', ''],
    ['spaces', '   '],
    ['tabs and newlines', '\t\n\r '],
  ])('rejects content that is %s', (_label, content) => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), content }).ok).toBe(false);
  });

  it('accepts content whose visible characters are surrounded by whitespace', () => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), content: '  x  ' }).ok).toBe(
      true,
    );
  });
});

describe('INV-PROV-001: provenance is explicit and project-owned', () => {
  it.each(['id', 'scope', 'sourceDocumentId', 'sourceType', 'normalizedContentHash', 'metadata'])(
    'rejects a block missing %s',
    (field) => {
      const input = validContextBlock();
      delete input[field];
      expect(safeParse(ContextBlockSchema, input).ok).toBe(false);
    },
  );

  it.each([
    ['empty sourceDocumentId', { sourceDocumentId: '' }],
    ['whitespace sourceDocumentId', { sourceDocumentId: '  ' }],
    ['non-string sourceDocumentId', { sourceDocumentId: 12 }],
    ['malformed normalizedContentHash', { normalizedContentHash: 'sha256:zzz' }],
    ['unsupported sourceType', { sourceType: 'pdf' }],
    ['scope from another shape', { scope: { tenant: 'local' } }],
  ])('rejects a block with %s', (_label, override) => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), ...override }).ok).toBe(false);
  });

  it('rejects an invalid source location', () => {
    expect(
      safeParse(ContextBlockSchema, {
        ...validContextBlock(),
        sourceLocation: { kind: 'text-range', startOffset: 10, endOffset: 2 },
      }).ok,
    ).toBe(false);
  });
});

describe('supplied measurement and attribute values are validated', () => {
  it.each([
    ['negative tokenCount', -1],
    ['fractional tokenCount', 1.5],
    ['NaN tokenCount', Number.NaN],
    ['Infinite tokenCount', Number.POSITIVE_INFINITY],
    ['string tokenCount', '7'],
  ])('rejects a block with %s', (_label, tokenCount) => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), tokenCount }).ok).toBe(false);
  });

  it('rejects a block with no tokenCount', () => {
    const input = validContextBlock();
    delete input['tokenCount'];
    expect(safeParse(ContextBlockSchema, input).ok).toBe(false);
  });

  it('accepts a zero tokenCount as supplied measurement data', () => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), tokenCount: 0 }).ok).toBe(true);
  });

  it.each([
    ['NaN relevanceScore', { relevanceScore: Number.NaN }],
    ['Infinite relevanceScore', { relevanceScore: Number.POSITIVE_INFINITY }],
    ['Infinite recencyScore', { recencyScore: Number.NEGATIVE_INFINITY }],
    ['fractional priority', { priority: 1.5 }],
    ['non-boolean required', { required: 'yes' }],
    ['unknown attribute', { score: 1 }],
  ])('INV-SCORE-004: rejects attributes with %s', (_label, attributes) => {
    expect(
      safeParse(ContextBlockSchema, {
        ...validContextBlock(),
        attributes: { ...attributes },
      }).ok,
    ).toBe(false);
  });

  it('accepts finite provider scores as untrusted inputs', () => {
    expect(
      safeParse(ContextBlockSchema, {
        ...validContextBlock(),
        attributes: { relevanceScore: 0.87, recencyScore: -3, required: false, priority: -1 },
      }).ok,
    ).toBe(true);
  });
});

describe('INV-BLOCK-007: content is preserved byte-for-byte', () => {
  const contents = [
    '# Heading\n\n- list item\n- another\n',
    '```ts\nconst x: number = 1;\n```\n',
    'emoji 😀🇺🇦 and CJK 你好 and Cyrillic Привет',
    'surrogate pair: \u{1D11E} and combining: é',
    '| a | b |\n| - | - |\n| 1 | 2 |',
    'trailing whitespace preserved   \n\n',
  ];

  it.each(contents)('preserves %j exactly', (content) => {
    const result = safeParse(ContextBlockSchema, { ...validContextBlock(), content });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe(content);
      expect([...result.value.content]).toEqual([...content]);
    }
  });
});

describe('ContextBlock is strict and serializable', () => {
  it('rejects unknown fields rather than silently stripping them', () => {
    expect(safeParse(ContextBlockSchema, { ...validContextBlock(), providerScore: 0.9 }).ok).toBe(
      false,
    );
  });

  it('rejects compiler results that belong to later stages', () => {
    for (const field of ['decision', 'renderedContext', 'summary', 'trace']) {
      expect(safeParse(ContextBlockSchema, { ...validContextBlock(), [field]: 'x' }).ok).toBe(
        false,
      );
    }
  });

  it('rejects invalid metadata', () => {
    expect(
      safeParse(ContextBlockSchema, { ...validContextBlock(), metadata: { at: new Date(0) } }).ok,
    ).toBe(false);
  });

  it('survives a JSON stringify and parse round trip', () => {
    const parsed = safeParse(ContextBlockSchema, validContextBlock());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.value));
      expect(safeParse(ContextBlockSchema, roundTripped)).toEqual(parsed);
    }
  });
});

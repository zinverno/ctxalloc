import { describe, expect, it } from 'vitest';
import {
  SOURCE_DOCUMENT_SCHEMA_VERSION,
  SourceDocumentSchema,
  safeParse,
} from '../../packages/domain/src/index.js';
import { VALID_HASH, validSourceDocument } from './fixtures.js';

describe('SourceDocument accepts documented records', () => {
  it('accepts a complete valid document', () => {
    const input = validSourceDocument();
    const result = safeParse(SourceDocumentSchema, input);
    expect(result.ok && result.value).toEqual(input);
  });

  it('accepts a minimal document without optional fields', () => {
    const result = safeParse(SourceDocumentSchema, {
      id: 'doc-1',
      schemaVersion: SOURCE_DOCUMENT_SCHEMA_VERSION,
      scope: { tenantId: 'local', workspaceId: 'default' },
      sourceType: 'text',
      contentHash: VALID_HASH,
      metadata: {},
    });
    expect(result.ok).toBe(true);
  });

  it.each(['markdown', 'text', 'conversation'])('accepts the %s source type', (sourceType) => {
    expect(safeParse(SourceDocumentSchema, { ...validSourceDocument(), sourceType }).ok).toBe(true);
  });
});

describe('INV-STORE-004: persisted records declare an explicit schema version', () => {
  it.each([
    ['missing schemaVersion', undefined],
    ['unsupported future version', 2],
    ['string version', '1'],
    ['zero', 0],
  ])('rejects %s', (_label, schemaVersion) => {
    const input = validSourceDocument();
    if (schemaVersion === undefined) {
      delete input['schemaVersion'];
    } else {
      input['schemaVersion'] = schemaVersion;
    }
    expect(safeParse(SourceDocumentSchema, input).ok).toBe(false);
  });
});

describe('INV-PROV-001 / INV-SCOPE-002: provenance and scope are mandatory', () => {
  it.each(['id', 'scope', 'sourceType', 'contentHash', 'metadata'])(
    'rejects a document missing %s',
    (field) => {
      const input = validSourceDocument();
      delete input[field];
      expect(safeParse(SourceDocumentSchema, input).ok).toBe(false);
    },
  );

  it.each([
    ['empty id', { id: '' }],
    ['whitespace id', { id: '   ' }],
    ['malformed contentHash', { contentHash: 'not-a-hash' }],
    ['unsupported sourceType', { sourceType: 'pdf' }],
    ['scope missing workspace', { scope: { tenantId: 'local' } }],
    ['metadata as array', { metadata: [] }],
    ['metadata with Date', { metadata: { at: new Date(0) } }],
    ['non-string title', { title: 42 }],
  ])('rejects a document with %s', (_label, override) => {
    expect(safeParse(SourceDocumentSchema, { ...validSourceDocument(), ...override }).ok).toBe(
      false,
    );
  });
});

describe('timestamps use a validated serialized format', () => {
  it.each(['2026-01-31T09:15:00Z', '2026-01-31T09:15:00.000Z', '2026-01-31T09:15:00.123456Z'])(
    'accepts the UTC timestamp %s',
    (createdAt) => {
      expect(safeParse(SourceDocumentSchema, { ...validSourceDocument(), createdAt }).ok).toBe(
        true,
      );
    },
  );

  it.each([
    ['local time without zone', '2026-01-31T09:15:00'],
    ['numeric offset', '2026-01-31T09:15:00+02:00'],
    ['date only', '2026-01-31'],
    ['impossible month', '2026-13-31T09:15:00Z'],
    // Regression: Date.parse silently rolls these over to a different real
    // instant, which previously let them through as valid timestamps.
    ['impossible day in February', '2026-02-31T09:15:00Z'],
    ['31st of a 30-day month', '2026-04-31T09:15:00Z'],
    ['non-leap 29 February', '2026-02-29T09:15:00Z'],
    ['hour 24', '2026-01-31T24:00:00Z'],
    ['minute 60', '2026-01-31T09:60:00Z'],
    ['second 60', '2026-01-31T09:15:60Z'],
    ['epoch number', 0],
    ['Date instance', new Date(0)],
  ])('rejects %s', (_label, createdAt) => {
    expect(safeParse(SourceDocumentSchema, { ...validSourceDocument(), createdAt }).ok).toBe(false);
  });

  it('accepts 29 February in a leap year', () => {
    expect(
      safeParse(SourceDocumentSchema, {
        ...validSourceDocument(),
        createdAt: '2028-02-29T09:15:00Z',
      }).ok,
    ).toBe(true);
  });
});

describe('SourceDocument is strict and serializable', () => {
  it('rejects unknown fields rather than silently stripping them', () => {
    const result = safeParse(SourceDocumentSchema, {
      ...validSourceDocument(),
      absolutePath: '/home/user/notes.md',
    });
    expect(result.ok).toBe(false);
  });

  it('survives a JSON stringify and parse round trip', () => {
    const parsed = safeParse(SourceDocumentSchema, validSourceDocument());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(parsed.value));
      expect(safeParse(SourceDocumentSchema, roundTripped)).toEqual(parsed);
    }
  });
});

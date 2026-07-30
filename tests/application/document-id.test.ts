import { ingestSource } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { SourceDocumentIdSchema, safeParse } from '../../packages/domain/src/index.js';
import { GOLDEN_SOURCE_DOCUMENT_ID, validInput } from './fixtures.js';

function idOf(overrides: Record<string, unknown> = {}): string {
  return ingestSource(validInput(overrides)).document.id;
}

describe('INV-BLOCK-001: the source document ID is stable and content-independent', () => {
  it('matches the committed golden canonical identity vector', () => {
    expect(idOf()).toBe(GOLDEN_SOURCE_DOCUMENT_ID);
  });

  it('has the documented representation', () => {
    expect(idOf()).toMatch(/^source-document:sha256:[0-9a-f]{64}$/);
    expect(safeParse(SourceDocumentIdSchema, idOf()).ok).toBe(true);
  });

  it('is identical for identical logical identity', () => {
    expect(idOf()).toBe(idOf());
  });

  it('does not change when the content changes', () => {
    expect(idOf({ content: 'first revision' })).toBe(idOf({ content: 'second revision\n' }));
  });

  it('does not change when the title changes', () => {
    expect(idOf({ title: 'One' })).toBe(idOf({ title: 'Two' }));
    expect(idOf({ title: 'One' })).toBe(idOf());
  });

  it('does not change when metadata changes', () => {
    expect(idOf({ metadata: { path: 'a.md' } })).toBe(idOf({ metadata: { path: 'b.md' } }));
    expect(idOf({ metadata: { path: 'a.md' } })).toBe(idOf());
  });

  it('INV-DET-004: does not change when timestamps change', () => {
    expect(idOf({ createdAt: '2026-01-31T09:15:00.000Z' })).toBe(
      idOf({ createdAt: '2020-01-01T00:00:00Z', updatedAt: '2026-02-01T10:00:00Z' }),
    );
    expect(idOf({ updatedAt: '2026-02-01T10:00:00Z' })).toBe(idOf());
  });

  it('changes when the identity namespace changes', () => {
    expect(idOf({ identity: { namespace: 'vault:other', key: 'projects/ctxalloc.md' } })).not.toBe(
      GOLDEN_SOURCE_DOCUMENT_ID,
    );
  });

  it('changes when the identity key changes', () => {
    expect(idOf({ identity: { namespace: 'vault:notes', key: 'projects/other.md' } })).not.toBe(
      GOLDEN_SOURCE_DOCUMENT_ID,
    );
  });

  it('does not collide when identity components are split differently', () => {
    const left = idOf({ identity: { namespace: 'a', key: 'b/c' } });
    const right = idOf({ identity: { namespace: 'a/b', key: 'c' } });
    expect(left).not.toBe(right);
  });

  it('INV-SCOPE-002: changes when the tenant changes', () => {
    expect(idOf({ scope: { tenantId: 'other', workspaceId: 'default' } })).not.toBe(
      GOLDEN_SOURCE_DOCUMENT_ID,
    );
  });

  it('INV-SCOPE-002: changes when the workspace changes', () => {
    expect(idOf({ scope: { tenantId: 'local', workspaceId: 'other' } })).not.toBe(
      GOLDEN_SOURCE_DOCUMENT_ID,
    );
  });

  it('INV-SCOPE-002: changes when the project changes', () => {
    const first = idOf({ scope: { tenantId: 'local', workspaceId: 'default', projectId: 'a' } });
    const second = idOf({ scope: { tenantId: 'local', workspaceId: 'default', projectId: 'b' } });
    expect(first).not.toBe(second);
  });

  it('INV-SCOPE-002: distinguishes an absent project from an explicit project value', () => {
    const scoped = idOf({
      scope: { tenantId: 'local', workspaceId: 'default', projectId: 'ctxalloc' },
    });
    expect(scoped).not.toBe(GOLDEN_SOURCE_DOCUMENT_ID);
  });

  it('changes when the source type changes', () => {
    expect(idOf({ sourceType: 'text' })).not.toBe(GOLDEN_SOURCE_DOCUMENT_ID);
    expect(idOf({ sourceType: 'conversation' })).not.toBe(idOf({ sourceType: 'text' }));
  });

  it('INV-DET-002: does not depend on input property order', () => {
    const ordered = validInput({ title: 'Project notes', createdAt: '2026-01-31T09:15:00.000Z' });
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());

    expect(ingestSource(reversed).document.id).toBe(ingestSource(ordered).document.id);
  });

  it('INV-DET-003: is not a UUID and contains no random or time-based component', () => {
    expect(idOf()).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(idOf()).toBe(GOLDEN_SOURCE_DOCUMENT_ID);
  });
});

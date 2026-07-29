import { describe, expect, it } from 'vitest';
import { ScopeSchema, safeParse, scopesEqual } from '../../packages/domain/src/index.js';

describe('INV-SCOPE-001: every scope is explicit', () => {
  it('accepts a tenant and workspace scope', () => {
    const result = safeParse(ScopeSchema, { tenantId: 'local', workspaceId: 'default' });
    expect(result).toEqual({ ok: true, value: { tenantId: 'local', workspaceId: 'default' } });
  });

  it('accepts an optional project identifier', () => {
    const result = safeParse(ScopeSchema, {
      tenantId: 'local',
      workspaceId: 'default',
      projectId: 'ctxalloc',
    });
    expect(result.ok && result.value.projectId).toBe('ctxalloc');
  });

  it.each([
    ['missing tenantId', { workspaceId: 'default' }],
    ['missing workspaceId', { tenantId: 'local' }],
    ['empty tenantId', { tenantId: '', workspaceId: 'default' }],
    ['whitespace workspaceId', { tenantId: 'local', workspaceId: '   ' }],
    ['whitespace projectId', { tenantId: 'local', workspaceId: 'default', projectId: ' ' }],
    ['no scope at all', {}],
  ])('rejects %s', (_label, input) => {
    expect(safeParse(ScopeSchema, input).ok).toBe(false);
  });

  it('rejects unknown scope fields instead of stripping them', () => {
    const result = safeParse(ScopeSchema, {
      tenantId: 'local',
      workspaceId: 'default',
      organizationId: 'sneaky',
    });
    expect(result.ok).toBe(false);
  });

  it('does not trim or rewrite accepted identifiers', () => {
    const result = safeParse(ScopeSchema, { tenantId: ' local ', workspaceId: 'default' });
    expect(result.ok && result.value.tenantId).toBe(' local ');
  });
});

describe('INV-SCOPE-003: scope equality is deterministic', () => {
  const base = { tenantId: 'local', workspaceId: 'default' } as const;

  it('treats identical scopes as equal regardless of comparison direction', () => {
    const other = { tenantId: 'local', workspaceId: 'default' } as const;
    expect(scopesEqual(base, other)).toBe(true);
    expect(scopesEqual(other, base)).toBe(true);
  });

  it('treats an absent projectId as equal to an omitted projectId', () => {
    expect(scopesEqual(base, { tenantId: 'local', workspaceId: 'default' })).toBe(true);
  });

  it.each([
    ['different tenant', { tenantId: 'other', workspaceId: 'default' }],
    ['different workspace', { tenantId: 'local', workspaceId: 'other' }],
    ['added project', { tenantId: 'local', workspaceId: 'default', projectId: 'p' }],
  ])('treats %s as unequal', (_label, other) => {
    expect(scopesEqual(base, other)).toBe(false);
  });

  it('distinguishes different project identifiers in the same workspace', () => {
    const a = { tenantId: 'local', workspaceId: 'default', projectId: 'a' };
    const b = { tenantId: 'local', workspaceId: 'default', projectId: 'b' };
    expect(scopesEqual(a, b)).toBe(false);
  });
});

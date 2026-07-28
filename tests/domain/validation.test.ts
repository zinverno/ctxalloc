import { describe, expect, it } from 'vitest';
import {
  ContextBlockSchema,
  DomainValidationError,
  ScopeSchema,
  parseOrThrow,
  safeParse,
} from '../../packages/domain/src/index.js';
import { validContextBlock } from './fixtures.js';

describe('validation API returns project-owned structured failures', () => {
  it('parseOrThrow returns the parsed value for valid input', () => {
    expect(parseOrThrow(ScopeSchema, { tenantId: 'local', workspaceId: 'default' })).toEqual({
      tenantId: 'local',
      workspaceId: 'default',
    });
  });

  it('parseOrThrow throws a DomainValidationError carrying issues', () => {
    let caught: unknown;
    try {
      parseOrThrow(ScopeSchema, { tenantId: '' });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainValidationError);
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof DomainValidationError) {
      expect(caught.name).toBe('DomainValidationError');
      expect(caught.issues.length).toBeGreaterThan(0);
      expect(caught.message).toContain('Domain validation failed');
      // The message is a summary, not the only channel: structured issues remain.
      expect(caught.issues.every((issue) => typeof issue.code === 'string')).toBe(true);
    }
  });

  it('safeParse returns a discriminated success result', () => {
    const result = safeParse(ScopeSchema, { tenantId: 'local', workspaceId: 'default' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tenantId).toBe('local');
      expect('issues' in result).toBe(false);
    }
  });

  it('safeParse returns a discriminated failure result and never throws', () => {
    const result = safeParse(ScopeSchema, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect('value' in result).toBe(false);
    }
  });

  it('issues carry a code, a serializable path, a pointer, and a message', () => {
    const result = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      scope: { tenantId: '', workspaceId: 'default' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues[0];
      expect(issue).toBeDefined();
      expect(typeof issue?.code).toBe('string');
      expect(issue?.path).toEqual(['scope', 'tenantId']);
      expect(issue?.pointer).toBe('scope.tenantId');
      expect(typeof issue?.message).toBe('string');
      expect(issue?.message.length).toBeGreaterThan(0);
    }
  });

  it('renders array indices in the pointer', () => {
    const result = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      headingPath: ['ok', 42],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toEqual(['headingPath', 1]);
      expect(result.issues[0]?.pointer).toBe('headingPath[1]');
    }
  });

  it('issues are JSON-serializable without loss', () => {
    const result = safeParse(ContextBlockSchema, { ...validContextBlock(), tokenCount: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(result.issues));
      expect(roundTripped).toEqual(result.issues);
    }
  });

  it('reports every independent problem, not only the first', () => {
    const result = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      tokenCount: -1,
      normalizedContentHash: 'bad',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const pointers = result.issues.map((issue) => issue.pointer);
      expect(pointers).toContain('tokenCount');
      expect(pointers).toContain('normalizedContentHash');
    }
  });
});

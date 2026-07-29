import { describe, expect, it } from 'vitest';
import { ContextBlockSchema, safeParse } from '../../packages/domain/src/index.js';
import { validContextBlock } from './fixtures.js';

/**
 * These tests use only literal fixtures. They never read the clock, generate
 * randomness, or touch the network, filesystem, database, or a model API.
 */
describe('INV-DET-001: identical canonical input produces identical output', () => {
  it('repeated parses of the same input are equivalent', () => {
    const input = validContextBlock();
    expect(safeParse(ContextBlockSchema, input)).toEqual(safeParse(ContextBlockSchema, input));
  });

  it('property insertion order does not change the accepted value', () => {
    const ordered = validContextBlock();
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());

    const a = safeParse(ContextBlockSchema, ordered);
    const b = safeParse(ContextBlockSchema, reversed);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).toEqual(b.value);
    }
  });

  it('property insertion order does not change nested accepted values', () => {
    const a = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      scope: { tenantId: 'local', workspaceId: 'default', projectId: 'p' },
    });
    const b = safeParse(ContextBlockSchema, {
      ...validContextBlock(),
      scope: { projectId: 'p', workspaceId: 'default', tenantId: 'local' },
    });
    expect(a.ok && b.ok && a.value).toEqual(b.ok && b.value);
  });

  it('identical invalid input produces identical issue ordering', () => {
    const invalid = { ...validContextBlock(), tokenCount: -1, normalizedContentHash: 'bad' };
    const first = safeParse(ContextBlockSchema, invalid);
    const second = safeParse(ContextBlockSchema, invalid);

    expect(first.ok).toBe(false);
    if (!first.ok && !second.ok) {
      expect(first.issues).toEqual(second.issues);
      expect(first.issues.map((issue) => issue.pointer)).toEqual(
        second.issues.map((issue) => issue.pointer),
      );
    }
  });

  it('parsing does not mutate the caller input', () => {
    const input = validContextBlock();
    const snapshot: unknown = JSON.parse(JSON.stringify(input));
    safeParse(ContextBlockSchema, input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

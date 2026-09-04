import type { Scope } from '@ctxalloc/domain';
import type { SourceRegistration } from '@ctxalloc/ports';
import { InMemoryControlStore, InMemoryControlStoreConfigurationError } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

const SCOPE: Scope = { tenantId: 'local', workspaceId: 'default' };
const OTHER_SCOPE: Scope = { tenantId: 'local', workspaceId: 'other' };
const PROJECT_SCOPE: Scope = { tenantId: 'local', workspaceId: 'default', projectId: 'alpha' };

function registration(overrides: Partial<SourceRegistration> = {}): SourceRegistration {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'a.md' },
    locator: 'a.md',
    metadata: {},
    ...overrides,
  } as SourceRegistration;
}

describe('InMemoryControlStore', () => {
  it('returns the registrations of the exact requested scope', async () => {
    const store = new InMemoryControlStore([
      registration({ identity: { namespace: 'vault:notes', key: 'a.md' } }),
      registration({ scope: OTHER_SCOPE, identity: { namespace: 'vault:notes', key: 'b.md' } }),
    ]);

    const listed = await store.listSources(SCOPE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.identity.key).toBe('a.md');
  });

  it('INV-SCOPE-004: never returns a registration of a neighbouring scope', async () => {
    const store = new InMemoryControlStore([
      registration({ scope: OTHER_SCOPE }),
      registration({ scope: PROJECT_SCOPE }),
    ]);
    await expect(store.listSources(SCOPE)).resolves.toEqual([]);
  });

  it('treats an absent projectId and a present one as different boundaries', async () => {
    const store = new InMemoryControlStore([
      registration({ scope: SCOPE, identity: { namespace: 'n', key: 'no-project' } }),
      registration({ scope: PROJECT_SCOPE, identity: { namespace: 'n', key: 'with-project' } }),
    ]);
    await expect(store.listSources(SCOPE)).resolves.toMatchObject([
      { identity: { key: 'no-project' } },
    ]);
    await expect(store.listSources(PROJECT_SCOPE)).resolves.toMatchObject([
      { identity: { key: 'with-project' } },
    ]);
  });

  it('INV-DET-001: lists the same registrations, in the same order, on every call', async () => {
    const store = new InMemoryControlStore([
      registration({ identity: { namespace: 'n', key: 'z.md' } }),
      registration({ identity: { namespace: 'n', key: 'a.md' } }),
    ]);
    const first = await store.listSources(SCOPE);
    const second = await store.listSources(SCOPE);
    expect(first).toEqual(second);
    // The configured order is preserved: the store imposes no canonical order,
    // so a consumer that depends on one must impose it (INV-DET-002).
    expect(first.map((entry) => entry.identity.key)).toEqual(['z.md', 'a.md']);
  });

  it('copies its input, so a later mutation of the caller array cannot change a listing', async () => {
    const metadata = { path: 'a.md' };
    const entries = [registration({ metadata })];
    const store = new InMemoryControlStore(entries);

    entries.push(registration({ identity: { namespace: 'n', key: 'added' } }));
    metadata.path = 'changed.md';

    const listed = await store.listSources(SCOPE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.metadata).toEqual({ path: 'a.md' });
  });

  it('copies its output, so a consumer mutation cannot change a later listing', async () => {
    const store = new InMemoryControlStore([registration({ metadata: { path: 'a.md' } })]);

    const first = await store.listSources(SCOPE);
    const mutable = first[0] as { locator: string; metadata: Record<string, unknown> };
    mutable.locator = 'hijacked.md';
    mutable.metadata.path = 'hijacked.md';

    const second = await store.listSources(SCOPE);
    expect(second[0]?.locator).toBe('a.md');
    expect(second[0]?.metadata).toEqual({ path: 'a.md' });
  });

  it('exposes exactly the two port contracts and no convenience mutator', () => {
    // The three write methods arrived with `ControlStoreWriter` in Phase 19
    // (DEC-042). Nothing beyond the two ports is published: a `save` or a
    // `clear` would be a capability no real store has, and a test built on one
    // would be testing the double (INV-ADAPTER-005).
    const store: Record<string, unknown> = new InMemoryControlStore([]) as unknown as Record<
      string,
      unknown
    >;
    for (const method of ['listSources', 'registerSource', 'updateSource', 'removeSource']) {
      expect(typeof store[method], `is missing ${method}`).toBe('function');
    }
    for (const method of ['save', 'clear', 'reset', 'upsertSource', 'deleteSource']) {
      expect(typeof store[method], `defines ${method}`).toBe('undefined');
    }
  });

  it('rejects a blank identity without rewriting it', () => {
    expect(() => new InMemoryControlStore([], { id: ' ' })).toThrow(
      InMemoryControlStoreConfigurationError,
    );
    expect(() => new InMemoryControlStore([], { version: '' })).toThrow(
      InMemoryControlStoreConfigurationError,
    );
  });
});

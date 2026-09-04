import { LocalSourceRegistryError, LocalSourceRegistryService } from '@ctxalloc/application';
import type { ControlStore, ControlStoreWriter, SourceRegistration } from '@ctxalloc/ports';
import { InMemoryControlStore } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import { OTHER_SCOPE, SCOPE, registration } from './local-service-fixtures.js';

/**
 * `LocalSourceRegistryService` (DEC-042).
 *
 * The service owns validation, key semantics, canonical listing order, and the
 * translation of a store failure into a project-owned one. What it must never do
 * is let a dependency's own wording — a SQL statement, a database path, a driver
 * message — reach its caller (INV-SEC-001, INV-ADAPTER-001).
 */

const KEY = {
  schemaVersion: 1,
  scope: SCOPE,
  sourceType: 'markdown',
  identity: { namespace: 'vault:notes', key: 'a.md' },
};

function service(registrations: readonly SourceRegistration[] = []): LocalSourceRegistryService {
  const store = new InMemoryControlStore(registrations);
  return new LocalSourceRegistryService(store, store);
}

/** A store whose every operation fails with the code it was told to raise. */
function failingStore(code: string | undefined): ControlStore & ControlStoreWriter {
  const fail = (): Promise<never> => {
    const error = new Error(
      'connection failed: /home/operator/.secret/ctxalloc.sqlite; SELECT * FROM ctxalloc_source_registration',
    );
    if (code !== undefined) Object.defineProperty(error, 'code', { value: code });
    return Promise.reject(error);
  };
  return {
    id: 'failing-store',
    version: '1',
    listSources: fail,
    registerSource: fail,
    updateSource: fail,
    removeSource: fail,
  };
}

async function failure(body: () => Promise<unknown>): Promise<LocalSourceRegistryError> {
  try {
    await body();
  } catch (cause) {
    if (cause instanceof LocalSourceRegistryError) return cause;
    throw cause;
  }
  throw new Error('expected a LocalSourceRegistryError');
}

describe('LocalSourceRegistryService: the control-plane use case', () => {
  it('registers a valid registration', async () => {
    const registry = service();

    expect(
      await registry.execute({
        schemaVersion: 1,
        operation: 'register',
        registration: registration(),
      }),
    ).toEqual({ operation: 'register', registered: true });
    expect(await registry.execute({ schemaVersion: 1, operation: 'list', scope: SCOPE })).toEqual({
      operation: 'list',
      registrations: [registration()],
    });
  });

  it('updates an existing registration', async () => {
    const registry = service([registration()]);
    const moved = { ...registration(), locator: 'moved.md', title: 'Moved' };

    expect(
      await registry.execute({ schemaVersion: 1, operation: 'update', registration: moved }),
    ).toEqual({ operation: 'update', updated: true });
    expect(await registry.execute({ schemaVersion: 1, operation: 'list', scope: SCOPE })).toEqual({
      operation: 'list',
      registrations: [moved],
    });
  });

  it('removes an existing registration and answers false the second time', async () => {
    const registry = service([registration()]);

    expect(await registry.execute({ schemaVersion: 1, operation: 'remove', key: KEY })).toEqual({
      operation: 'remove',
      removed: true,
    });
    expect(await registry.execute({ schemaVersion: 1, operation: 'remove', key: KEY })).toEqual({
      operation: 'remove',
      removed: false,
    });
  });

  it('INV-BLOCK-001: renaming an identity is not hidden as an update', async () => {
    const registry = service([registration()]);
    const renamed = { ...registration(), identity: { namespace: 'vault:notes', key: 'b.md' } };

    // A different identity is a different logical source, so the update finds
    // nothing rather than quietly renaming the original.
    const error = await failure(() =>
      registry.execute({ schemaVersion: 1, operation: 'update', registration: renamed }),
    );
    expect(error.issues[0]?.code).toBe('source_not_found');

    expect(await registry.execute({ schemaVersion: 1, operation: 'list', scope: SCOPE })).toEqual({
      operation: 'list',
      registrations: [registration()],
    });
  });

  it('INV-SCOPE-004: an operation cannot reach another scope', async () => {
    const registry = service([registration()]);

    const update = await failure(() =>
      registry.execute({
        schemaVersion: 1,
        operation: 'update',
        registration: { ...registration(), scope: OTHER_SCOPE },
      }),
    );
    expect(update.issues[0]?.code).toBe('source_not_found');

    expect(
      await registry.execute({
        schemaVersion: 1,
        operation: 'remove',
        key: { ...KEY, scope: OTHER_SCOPE },
      }),
    ).toEqual({ operation: 'remove', removed: false });

    expect(
      await registry.execute({ schemaVersion: 1, operation: 'list', scope: OTHER_SCOPE }),
    ).toEqual({ operation: 'list', registrations: [] });
  });

  it('INV-DET-002: lists in canonical order regardless of the store order', async () => {
    // Configured in an order that is neither canonical nor its reverse.
    const registrations = [
      registration({
        sourceType: 'text',
        identity: { namespace: 'vault:notes', key: 'z.txt' },
        locator: 'z.txt',
      }),
      registration({ identity: { namespace: 'vault:notes', key: 'm.md' }, locator: 'm.md' }),
      registration({ identity: { namespace: 'aault:notes', key: 'a.md' }, locator: 'a.md' }),
    ];
    const result = await service(registrations).execute({
      schemaVersion: 1,
      operation: 'list',
      scope: SCOPE,
    });

    expect(result.operation).toBe('list');
    if (result.operation !== 'list') return;
    expect(
      result.registrations.map((entry) => `${entry.sourceType}/${entry.identity.namespace}`),
    ).toEqual(['markdown/aault:notes', 'markdown/vault:notes', 'text/vault:notes']);
  });

  it('rejects a malformed registration with an addressed issue', async () => {
    const error = await failure(() =>
      service().execute({
        schemaVersion: 1,
        operation: 'register',
        registration: { ...registration(), sourceType: 'spreadsheet' },
      }),
    );

    expect(error.issues[0]?.code).toBe('invalid_registration');
    expect(error.issues[0]?.pointer).toBe('registration.sourceType');
  });

  it('rejects an unknown registration field rather than stripping it', async () => {
    const error = await failure(() =>
      service().execute({
        schemaVersion: 1,
        operation: 'register',
        registration: { ...registration(), cacheKey: 'x' },
      }),
    );

    expect(error.issues[0]?.code).toBe('invalid_registration');
  });

  it('rejects a key carrying a locator, which takes no part in identity', async () => {
    const error = await failure(() =>
      service().execute({
        schemaVersion: 1,
        operation: 'remove',
        key: { ...KEY, locator: 'a.md' },
      }),
    );

    // Accepting it would invite a caller to believe the locator was matched on.
    expect(error.issues[0]?.code).toBe('invalid_key');
  });

  it.each([
    ['an unknown operation', { schemaVersion: 1, operation: 'purge' }],
    ['a missing operation', { schemaVersion: 1 }],
    ['an unsupported schema version', { schemaVersion: 2, operation: 'list', scope: SCOPE }],
    ['a register carrying a key', { schemaVersion: 1, operation: 'register', key: KEY }],
  ])('rejects %s as an invalid request', async (_label, input) => {
    const error = await failure(() => service().execute(input));
    expect(error.issues[0]?.code).toBe('invalid_request');
  });

  it('rejects an invalid scope for a listing', async () => {
    const error = await failure(() =>
      service().execute({ schemaVersion: 1, operation: 'list', scope: { tenantId: '  ' } }),
    );

    expect(error.issues[0]?.code).toBe('invalid_scope');
  });

  it('rejects a dependency that is not a usable port', () => {
    expect(
      () => new LocalSourceRegistryService({} as ControlStore, {} as ControlStoreWriter),
    ).toThrow(LocalSourceRegistryError);
  });
});

describe('INV-SEC-001: a store failure never escapes with its own wording', () => {
  it.each([
    ['SOURCE_CONFLICT', 'source_conflict'],
    ['SOURCE_NOT_FOUND', 'source_not_found'],
    ['INVALID_STORED_DATA', 'invalid_stored_data'],
  ])('translates the stable code %s into %s', async (storeCode, issueCode) => {
    const registry = new LocalSourceRegistryService(
      failingStore(storeCode),
      failingStore(storeCode),
    );
    const error = await failure(() =>
      registry.execute({ schemaVersion: 1, operation: 'register', registration: registration() }),
    );

    expect(error.issues[0]?.code).toBe(issueCode);
  });

  it('treats an unrecognised code as an unavailable store', async () => {
    for (const code of [undefined, 'SQLITE_BUSY', 'ECONNREFUSED']) {
      const registry = new LocalSourceRegistryService(failingStore(code), failingStore(code));
      const error = await failure(() =>
        registry.execute({ schemaVersion: 1, operation: 'list', scope: SCOPE }),
      );

      expect(error.issues[0]?.code).toBe('control_store_unavailable');
    }
  });

  it('copies no path, SQL, or dependency message into its issues', async () => {
    const registry = new LocalSourceRegistryService(
      failingStore(undefined),
      failingStore(undefined),
    );

    for (const request of [
      { schemaVersion: 1, operation: 'register', registration: registration() },
      { schemaVersion: 1, operation: 'update', registration: registration() },
      { schemaVersion: 1, operation: 'remove', key: KEY },
      { schemaVersion: 1, operation: 'list', scope: SCOPE },
    ]) {
      const error = await failure(() => registry.execute(request));
      const text = `${error.message} ${JSON.stringify(error.issues)}`;

      expect(text).not.toContain('/home/operator');
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('connection failed');
    }
  });

  it('rejects a store that resolves a non-boolean from removeSource', async () => {
    const store: ControlStore & ControlStoreWriter = {
      id: 'odd-store',
      version: '1',
      listSources: () => Promise.resolve([]),
      registerSource: () => Promise.resolve(),
      updateSource: () => Promise.resolve(),
      removeSource: () => Promise.resolve('yes') as unknown as Promise<boolean>,
    };
    const error = await failure(() =>
      new LocalSourceRegistryService(store, store).execute({
        schemaVersion: 1,
        operation: 'remove',
        key: KEY,
      }),
    );

    expect(error.issues[0]?.code).toBe('control_store_unavailable');
  });

  it('INV-BLOCK-005: rejects a corrupt record the store returned', async () => {
    const store: ControlStore & ControlStoreWriter = {
      id: 'corrupt-store',
      version: '1',
      listSources: () => Promise.resolve([{ schemaVersion: 1 }] as unknown as SourceRegistration[]),
      registerSource: () => Promise.resolve(),
      updateSource: () => Promise.resolve(),
      removeSource: () => Promise.resolve(false),
    };
    const error = await failure(() =>
      new LocalSourceRegistryService(store, store).execute({
        schemaVersion: 1,
        operation: 'list',
        scope: SCOPE,
      }),
    );

    expect(error.issues.every((issue) => issue.code === 'invalid_stored_data')).toBe(true);
  });
});

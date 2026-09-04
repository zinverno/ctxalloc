import type { StoredCompilationTraceRecord, TraceStore } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';

/**
 * The shared behaviour every `TraceStore` must have (INV-ADAPTER-005, DEC-042).
 *
 * One suite, two implementations: `InMemoryTraceStore` and `SQLiteTraceStore`.
 * The two behaviours that matter most are the ones a naive store gets wrong —
 * idempotence for an identical record, and a **conflict** rather than an
 * overwrite for a different one under the same deterministic identifier
 * (INV-ADAPTER-004).
 */

const SCOPE = { tenantId: 'contract', workspaceId: 'traces' };
const OTHER_SCOPE = { tenantId: 'contract', workspaceId: 'elsewhere' };
const PROJECT_SCOPE = { tenantId: 'contract', workspaceId: 'traces', projectId: 'alpha' };

const ID = `sha256:${'a'.repeat(64)}`;
const OTHER_ID = `sha256:${'b'.repeat(64)}`;

/** How one contract run creates a fresh, empty store. */
export interface TraceStoreFactory {
  readonly name: string;
  readonly create: () => { readonly store: TraceStore; readonly dispose: () => void };
}

/**
 * One stored envelope with the given fields replaced.
 *
 * The overrides are a loose record for the same reason the control-store
 * fixture's are, and the result is validated by every store it is handed to.
 */
export function recordOf(overrides: Record<string, unknown> = {}): StoredCompilationTraceRecord {
  return {
    schemaVersion: 1,
    scope: SCOPE,
    compilationId: ID,
    traceSchemaVersion: 2,
    payload: {
      settled: true,
      compilationId: ID,
      groups: [{ id: 'block:a', tokens: 12 }],
      nested: { b: 1, a: 2 },
    },
    ...overrides,
  } as StoredCompilationTraceRecord;
}

export function runTraceStoreContract(factory: TraceStoreFactory): void {
  describe(`TraceStore contract: ${factory.name}`, () => {
    it('publishes a non-blank identity and version', () => {
      const { store, dispose } = factory.create();
      try {
        expect(store.id.trim().length).toBeGreaterThan(0);
        expect(store.version.trim().length).toBeGreaterThan(0);
      } finally {
        dispose();
      }
    });

    it('returns null for a compilation identifier that was never stored', async () => {
      const { store, dispose } = factory.create();
      try {
        // `null` means "no such trace", never "the store failed"
        // (INV-ADAPTER-003).
        expect(await store.getTrace(SCOPE, ID)).toBeNull();
      } finally {
        dispose();
      }
    });

    it('returns a stored record exactly as it was written', async () => {
      const { store, dispose } = factory.create();
      try {
        const record = recordOf();
        await store.putTrace(record);

        expect(await store.getTrace(SCOPE, ID)).toEqual(record);
      } finally {
        dispose();
      }
    });

    it('preserves a payload carrying quote-heavy and Unicode values', async () => {
      const { store, dispose } = factory.create();
      try {
        const record = recordOf({
          payload: {
            settled: true,
            note: 'o\'brien "quoted" — 🎉',
            'key\\with"escapes': ['a', 1, null, true],
          },
        });
        await store.putTrace(record);

        expect(await store.getTrace(SCOPE, ID)).toEqual(record);
      } finally {
        dispose();
      }
    });

    it('storing the identical record twice succeeds', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());
        await store.putTrace(recordOf());

        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
      } finally {
        dispose();
      }
    });

    it('INV-DET-002: equality is canonical, so key order does not create a conflict', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());
        // The same payload, rebuilt with its keys in a different insertion
        // order. A store comparing raw JSON text would call this a conflict.
        await store.putTrace(
          recordOf({
            payload: {
              nested: { a: 2, b: 1 },
              groups: [{ tokens: 12, id: 'block:a' }],
              compilationId: ID,
              settled: true,
            },
          }),
        );

        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
      } finally {
        dispose();
      }
    });

    it('INV-ADAPTER-004: a different record under one identifier conflicts', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());

        await expect(
          store.putTrace(
            recordOf({ payload: { settled: true, compilationId: ID, altered: true } }),
          ),
        ).rejects.toMatchObject({ code: 'TRACE_CONFLICT' });
      } finally {
        dispose();
      }
    });

    it('INV-ADAPTER-004: a rejected conflict leaves the original record intact', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());
        await expect(
          store.putTrace(recordOf({ payload: { settled: false } })),
        ).rejects.toBeInstanceOf(Error);

        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
      } finally {
        dispose();
      }
    });

    it('treats a differing trace schema version as a conflict, not an overwrite', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());

        await expect(store.putTrace(recordOf({ traceSchemaVersion: 3 }))).rejects.toMatchObject({
          code: 'TRACE_CONFLICT',
        });
        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
      } finally {
        dispose();
      }
    });

    it('INV-SEC-004: a wrong scope reads as not found', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());

        // Indistinguishable from a record that was never stored: the caller
        // learns nothing about another scope.
        expect(await store.getTrace(OTHER_SCOPE, ID)).toBeNull();
        expect(await store.getTrace(OTHER_SCOPE, OTHER_ID)).toBeNull();
      } finally {
        dispose();
      }
    });

    it('INV-SEC-004: an absent projectId does not match a present one', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());

        expect(await store.getTrace(PROJECT_SCOPE, ID)).toBeNull();
        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
      } finally {
        dispose();
      }
    });

    it('keeps records under different identifiers apart', async () => {
      const { store, dispose } = factory.create();
      try {
        await store.putTrace(recordOf());
        await store.putTrace(
          recordOf({ compilationId: OTHER_ID, payload: { settled: true, other: true } }),
        );

        expect(await store.getTrace(SCOPE, ID)).toEqual(recordOf());
        expect(await store.getTrace(SCOPE, OTHER_ID)).toEqual(
          recordOf({ compilationId: OTHER_ID, payload: { settled: true, other: true } }),
        );
      } finally {
        dispose();
      }
    });

    it('does not share mutable state with the caller', async () => {
      const { store, dispose } = factory.create();
      try {
        const record = recordOf({ payload: { settled: true, tags: ['a'] } });
        await store.putTrace(record);

        (record.payload.tags as string[]).push('b');
        const loaded = await store.getTrace(SCOPE, ID);
        (loaded?.payload.tags as string[]).push('c');

        expect(await store.getTrace(SCOPE, ID)).toEqual(
          recordOf({ payload: { settled: true, tags: ['a'] } }),
        );
      } finally {
        dispose();
      }
    });
  });
}

import {
  CompilationTracePersistenceError,
  CompilationTracePersistenceService,
} from '@ctxalloc/application';
import type { SettledCompilationTrace } from '@ctxalloc/compiler';
import type { Scope } from '@ctxalloc/domain';
import type { StoredCompilationTraceRecord, TraceStore } from '@ctxalloc/ports';
import { InMemoryTraceStore } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import { compile } from '../compiler/compiler-fixtures.js';
import { trace as unsettledTrace } from '../compiler/trace-fixtures.js';

/**
 * `CompilationTracePersistenceService` (DEC-042).
 *
 * This is the seam between two vocabularies: the compiler's
 * `SettledCompilationTrace` and the port's JSON envelope. Both directions are
 * validated — a malformed trace must never become a stored one, and a stored row
 * must never be published as a trace on the strength of its type alone
 * (INV-ADAPTER-004, INV-BLOCK-005).
 */

function settled(): SettledCompilationTrace {
  return compile({
    specs: [
      { id: 'must', tokens: 2, required: true, priority: 0 },
      { id: 'high', tokens: 2, priority: 900 },
    ],
    available: 200,
  }).trace;
}

/** The scope a settled trace belongs to, read from the trace itself. */
function scopeOf(trace: SettledCompilationTrace): Scope {
  return trace.request.scope;
}

/** A store that records what it was handed and answers what it was told to. */
function scriptedStore(answer: unknown): TraceStore & { readonly written: unknown[] } {
  const written: unknown[] = [];
  return {
    id: 'scripted-trace-store',
    version: '1',
    written,
    putTrace: (record) => {
      written.push(record);
      return Promise.resolve();
    },
    getTrace: () => Promise.resolve(answer as StoredCompilationTraceRecord | null),
  };
}

async function failure(body: () => Promise<unknown>): Promise<CompilationTracePersistenceError> {
  try {
    await body();
  } catch (cause) {
    if (cause instanceof CompilationTracePersistenceError) return cause;
    throw cause;
  }
  throw new Error('expected a CompilationTracePersistenceError');
}

describe('CompilationTracePersistenceService: the seam between trace and envelope', () => {
  it('round trips a real settled trace through a store', async () => {
    const trace = settled();
    const service = new CompilationTracePersistenceService(new InMemoryTraceStore());

    await service.store(trace);

    expect(await service.get(scopeOf(trace), trace.compilationId)).toEqual(trace);
  });

  it('builds the envelope from the trace itself, never from a second source', async () => {
    const trace = settled();
    const store = scriptedStore(null);
    await new CompilationTracePersistenceService(store).store(trace);

    expect(store.written).toHaveLength(1);
    expect(store.written[0]).toEqual({
      schemaVersion: 1,
      scope: trace.request.scope,
      compilationId: trace.compilationId,
      traceSchemaVersion: trace.schemaVersion,
      payload: JSON.parse(JSON.stringify(trace)),
    });
  });

  it('INV-SEC-003: the stored payload carries no compiled context and no raw query', async () => {
    const trace = settled();
    const store = scriptedStore(null);
    await new CompilationTracePersistenceService(store).store(trace);

    const payload = JSON.stringify(store.written[0]);
    expect(payload).not.toContain('compiledContext');
    expect(payload).not.toContain('"query"');
    expect(payload).not.toContain('"content"');
    // The query survives only as a hash, which is what makes the audit question
    // answerable without storing the text.
    expect(payload).toContain('queryHash');
  });

  it('returns null when there is no such trace in this scope', async () => {
    const service = new CompilationTracePersistenceService(new InMemoryTraceStore());

    expect(
      await service.get({ tenantId: 'a', workspaceId: 'b' }, `sha256:${'0'.repeat(64)}`),
    ).toBeNull();
  });

  it('INV-SEC-004: a wrong scope reads as null, not as another scope’s trace', async () => {
    const trace = settled();
    const service = new CompilationTracePersistenceService(new InMemoryTraceStore());
    await service.store(trace);

    expect(
      await service.get({ tenantId: 'other', workspaceId: 'other' }, trace.compilationId),
    ).toBeNull();
  });

  it('storing the same trace twice succeeds', async () => {
    const trace = settled();
    const service = new CompilationTracePersistenceService(new InMemoryTraceStore());

    await service.store(trace);
    await service.store(trace);

    expect(await service.get(scopeOf(trace), trace.compilationId)).toEqual(trace);
  });

  it('reports a store conflict as its own issue code, not the adapter’s', async () => {
    const service = new CompilationTracePersistenceService({
      id: 'conflicting-store',
      version: '1',
      putTrace: () => {
        // Exactly the stable code a real store publishes when one identifier
        // already holds a different record.
        const error = new Error('a different trace is stored');
        Object.defineProperty(error, 'code', { value: 'TRACE_CONFLICT' });
        return Promise.reject(error);
      },
      getTrace: () => Promise.resolve(null),
    });

    expect((await failure(() => service.store(settled()))).issues[0]?.code).toBe('trace_conflict');
  });
});

describe('INV-ADAPTER-004: an ill-formed trace never becomes a stored one', () => {
  it('refuses to store an unsettled snapshot', async () => {
    const store = scriptedStore(null);
    const error = await failure(() =>
      new CompilationTracePersistenceService(store).store(
        unsettledTrace({ specs: [{ id: 'one', tokens: 2 }] }),
      ),
    );

    expect(error.issues[0]?.code).toBe('invalid_trace');
    expect(error.issues[0]?.pointer).toBe('trace.settled');
    // Nothing reached the store.
    expect(store.written).toEqual([]);
  });

  it.each([
    ['a non-object', 7],
    ['null', null],
    ['an unknown field', { ...JSON.parse(JSON.stringify(settled())), extra: 1 }],
    ['a corrupted identifier', { ...JSON.parse(JSON.stringify(settled())), compilationId: 'nope' }],
  ])('refuses to store %s', async (_label, value) => {
    const store = scriptedStore(null);
    const error = await failure(() => new CompilationTracePersistenceService(store).store(value));

    expect(error.issues[0]?.code).toBe('invalid_trace');
    expect(store.written).toEqual([]);
  });
});

describe('INV-BLOCK-005: a stored record is proven before it is published', () => {
  const trace = settled();
  const envelope = (overrides: Record<string, unknown> = {}): unknown => ({
    schemaVersion: 1,
    scope: trace.request.scope,
    compilationId: trace.compilationId,
    traceSchemaVersion: trace.schemaVersion,
    payload: JSON.parse(JSON.stringify(trace)),
    ...overrides,
  });

  async function load(stored: unknown): Promise<CompilationTracePersistenceError> {
    return failure(() =>
      new CompilationTracePersistenceService(scriptedStore(stored)).get(
        scopeOf(trace),
        trace.compilationId,
      ),
    );
  }

  it('accepts a well-formed record', async () => {
    const loaded = await new CompilationTracePersistenceService(scriptedStore(envelope())).get(
      scopeOf(trace),
      trace.compilationId,
    );

    expect(loaded).toEqual(trace);
  });

  it('rejects a record whose envelope schema version is unsupported', async () => {
    expect((await load(envelope({ schemaVersion: 2 }))).issues[0]?.code).toBe(
      'invalid_stored_record',
    );
  });

  it('rejects a record carrying an unknown envelope field', async () => {
    expect((await load(envelope({ createdAt: 'x' }))).issues[0]?.code).toBe(
      'invalid_stored_record',
    );
  });

  it('rejects a record whose envelope scope is not the requested one', async () => {
    const error = await load(envelope({ scope: { tenantId: 'other', workspaceId: 'other' } }));

    expect(error.issues[0]?.code).toBe('stored_record_scope_mismatch');
  });

  it('rejects a record whose envelope identifier is not the requested one', async () => {
    const error = await load(envelope({ compilationId: `sha256:${'9'.repeat(64)}` }));

    expect(error.issues[0]?.code).toBe('stored_record_id_mismatch');
  });

  it('rejects a record whose payload identifier contradicts its envelope', async () => {
    // Envelope and payload agree with the request, but not with each other: the
    // record's addressing does not describe its content.
    const payload = {
      ...JSON.parse(JSON.stringify(trace)),
      compilationId: `sha256:${'8'.repeat(64)}`,
    };
    const error = await load(envelope({ payload }));

    expect(error.issues[0]?.code).toBe('stored_record_id_mismatch');
    expect(error.issues[0]?.pointer).toBe('record.payload.compilationId');
  });

  it('rejects a record whose payload scope contradicts its envelope', async () => {
    const payload = JSON.parse(JSON.stringify(trace)) as {
      request: { scope: unknown };
    };
    payload.request.scope = { tenantId: 'elsewhere', workspaceId: 'elsewhere' };
    const error = await load(envelope({ payload }));

    expect(error.issues[0]?.code).toBe('stored_record_scope_mismatch');
    expect(error.issues[0]?.pointer).toBe('record.payload.request.scope');
  });

  it('rejects a record whose declared trace schema version contradicts its payload', async () => {
    const error = await load(envelope({ traceSchemaVersion: 3 }));

    expect(error.issues[0]?.code).toBe('invalid_stored_record');
  });

  it('rejects a payload that is not a settled trace', async () => {
    const error = await load(envelope({ payload: { settled: false, schemaVersion: 2 } }));

    expect(error.issues[0]?.code).toBe('invalid_stored_record');
    expect(error.issues[0]?.pointer).toBe('record.payload.settled');
  });

  it('rejects a payload carrying an unknown trace field', async () => {
    const payload = { ...JSON.parse(JSON.stringify(trace)), surplus: true };

    expect((await load(envelope({ payload }))).issues[0]?.code).toBe('invalid_stored_record');
  });

  it('rejects an invalid scope or identifier argument before touching the store', async () => {
    const store = scriptedStore(envelope());
    const service = new CompilationTracePersistenceService(store);

    expect(
      (await failure(() => service.get({ tenantId: ' ' }, trace.compilationId))).issues[0]?.code,
    ).toBe('invalid_scope');
    expect((await failure(() => service.get(scopeOf(trace), '  '))).issues[0]?.code).toBe(
      'invalid_compilation_id',
    );
  });

  it('INV-SEC-001: copies no dependency message into its issues', async () => {
    const service = new CompilationTracePersistenceService({
      id: 'failing',
      version: '1',
      putTrace: () => Promise.reject(new Error('/home/operator/db.sqlite: SELECT failed')),
      getTrace: () => Promise.reject(new Error('/home/operator/db.sqlite: SELECT failed')),
    });

    for (const body of [
      (): Promise<unknown> => service.store(trace),
      (): Promise<unknown> => service.get(scopeOf(trace), trace.compilationId),
    ]) {
      const error = await failure(body);
      const text = `${error.message} ${JSON.stringify(error.issues)}`;

      expect(text).not.toContain('/home/operator');
      expect(text).not.toContain('SELECT');
      expect(error.issues[0]?.code).toBe('trace_store_unavailable');
    }
  });

  it('rejects a store that is not a usable port', () => {
    expect(() => new CompilationTracePersistenceService({} as TraceStore)).toThrow(
      CompilationTracePersistenceError,
    );
  });
});

/**
 * The failure-code inspection is passive and **total** (INV-ADAPTER-001).
 *
 * A rejected `TraceStore` may reject with any JavaScript value. If reading
 * `code` from it could throw, or could run a getter, a store would be able to
 * choose this service's verdict or escape it entirely.
 */
/**
 * The service envelopes the validator's snapshot, never its argument
 * (INV-BLOCK-005, INV-SEC-001).
 *
 * A `Proxy` can describe honest values through `getOwnPropertyDescriptor` — so
 * the validator's passive walk accepts them without firing a trap — and return
 * different ones through an ordinary property `get`. `#envelope` reads
 * `compilationId`, `request.scope`, and `schemaVersion` after validating, so if
 * validation returned the argument those three reads would run the trap and the
 * service would store a record the validator never approved.
 */
describe('INV-BLOCK-005: a hostile trace cannot differ between validation and storage', () => {
  const LIE_ID = `sha256:${'f'.repeat(64)}`;
  const LIE_SCOPE = { tenantId: 'attacker', workspaceId: 'elsewhere' };

  /** A real settled trace, and a root Proxy that describes it honestly and lies on `get`. */
  function hostile(): {
    readonly trace: SettledCompilationTrace;
    readonly proxy: unknown;
    readonly gets: () => number;
  } {
    const trace = settled();
    const target = JSON.parse(JSON.stringify(trace)) as Record<string, unknown>;
    let gets = 0;
    const proxy = new Proxy(target, {
      getOwnPropertyDescriptor: (t, key) => Object.getOwnPropertyDescriptor(t, key),
      ownKeys: (t) => Reflect.ownKeys(t),
      getPrototypeOf: (t) => Object.getPrototypeOf(t) as object | null,
      get: (t, key) => {
        gets += 1;
        if (key === 'compilationId') return LIE_ID;
        if (key === 'schemaVersion') return 999;
        if (key === 'request') return { scope: LIE_SCOPE };
        return Reflect.get(t, key);
      },
    });
    return { trace, proxy, gets: () => gets };
  }

  it('stores the descriptor-validated values and never fires the get trap', async () => {
    const { trace, proxy, gets } = hostile();
    const store = new InMemoryTraceStore();

    await new CompilationTracePersistenceService(store).store(proxy);
    const readsAfterStore = gets();

    const stored = await store.getTrace(scopeOf(trace), trace.compilationId);
    expect(stored).not.toBeNull();
    // The envelope carries what the descriptors said, not what `get` answered.
    expect(stored?.compilationId).toBe(trace.compilationId);
    expect(stored?.compilationId).not.toBe(LIE_ID);
    expect(stored?.scope).toEqual(scopeOf(trace));
    expect(stored?.scope).not.toEqual(LIE_SCOPE);
    expect(stored?.traceSchemaVersion).toBe(trace.schemaVersion);
    // Nothing in the service path read through the original value.
    expect(readsAfterStore).toBe(0);
  });

  it('the stored payload is the real trace, and reads back as it', async () => {
    const { trace, proxy, gets } = hostile();
    const store = new InMemoryTraceStore();
    const service = new CompilationTracePersistenceService(store);

    await service.store(proxy);
    const loaded = await service.get(scopeOf(trace), trace.compilationId);
    const reads = gets();

    expect(loaded).toEqual(trace);
    expect(JSON.stringify(loaded)).not.toContain(LIE_ID);
    expect(JSON.stringify(loaded)).not.toContain('attacker');
    expect(reads).toBe(0);
  });

  it('a lying get value never reaches the store under any key', async () => {
    const { proxy, gets } = hostile();
    const store = scriptedStore(null);

    await new CompilationTracePersistenceService(store).store(proxy);
    const reads = gets();

    expect(store.written).toHaveLength(1);
    expect(JSON.stringify(store.written[0])).not.toContain(LIE_ID);
    expect(JSON.stringify(store.written[0])).not.toContain('attacker');
    expect(reads).toBe(0);
  });
});

describe('INV-ADAPTER-001: a hostile rejection cannot escape or choose the verdict', () => {
  const CANARY = 'ctxalloc-trace-store-canary';

  function rejectingWith(value: unknown): TraceStore {
    return {
      id: 'hostile-trace-store',
      version: '1',
      putTrace: () => Promise.reject(value),
      getTrace: () => Promise.reject(value),
    };
  }

  async function storeAgainst(store: TraceStore): Promise<CompilationTracePersistenceError> {
    return failure(() => new CompilationTracePersistenceService(store).store(settled()));
  }

  it('reports a rejection whose code descriptor throws as a dependency failure', async () => {
    const hostile = new Proxy(
      { code: 'TRACE_CONFLICT' },
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error(CANARY);
        },
      },
    );

    const error = await storeAgainst(rejectingWith(hostile));

    // Not `trace_conflict`: an unreadable code is the same as no code.
    expect(error.issues[0]?.code).toBe('trace_store_unavailable');
    expect(error.message).not.toContain(CANARY);
    expect(JSON.stringify(error.issues)).not.toContain(CANARY);
  });

  it('reports a rejection that is a revoked proxy as a dependency failure', async () => {
    const { proxy, revoke } = Proxy.revocable({ code: 'TRACE_CONFLICT' }, {});
    revoke();

    expect((await storeAgainst(rejectingWith(proxy))).issues[0]?.code).toBe(
      'trace_store_unavailable',
    );
  });

  it('never invokes an accessor named code', async () => {
    let reads = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'code', {
      get: () => {
        reads += 1;
        return 'TRACE_CONFLICT';
      },
      enumerable: true,
      configurable: true,
    });

    expect((await storeAgainst(rejectingWith(hostile))).issues[0]?.code).toBe(
      'trace_store_unavailable',
    );
    expect(reads).toBe(0);
  });

  it('never uses a get trap on the rejected value', async () => {
    let gets = 0;
    const hostile = new Proxy(
      { code: 'TRACE_CONFLICT' },
      {
        get: (target, key) => {
          // `then` is excluded: rejecting a promise with this value makes the
          // runtime itself probe for a thenable.
          if (key !== 'then') gets += 1;
          return Reflect.get(target, key);
        },
      },
    );

    await storeAgainst(rejectingWith(hostile));
    expect(gets).toBe(0);
  });

  it('still honours a genuine project-owned conflict code', async () => {
    const conflict = new Error('a different trace is already stored');
    Object.defineProperty(conflict, 'code', { value: 'TRACE_CONFLICT' });

    expect((await storeAgainst(rejectingWith(conflict))).issues[0]?.code).toBe('trace_conflict');
  });
});

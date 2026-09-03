import { MiniSearchCandidateProvider, MiniSearchCandidateProviderError } from '@ctxalloc/adapters';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import MiniSearch from 'minisearch';
import { describe, expect, it, vi } from 'vitest';
import { block, providerRequest } from './minisearch-fixtures.js';

/**
 * Adapter-side inspection is total over hostile runtime values (DEC-041).
 *
 * The configuration, the request, its blocks, and the dependency's own output are
 * all untrusted at run time. Any of them may be a `Proxy` whose traps throw or an
 * object whose properties are throwing accessors, and a bare `Object.keys`,
 * destructuring, or descriptor read would let a raw `TypeError` — or a message
 * the value itself chose — escape as this adapter's failure. Phase 16 and Phase
 * 17 established that this must not happen; these are the Phase 18 regressions
 * (INV-ADAPTER-001, INV-ADAPTER-003, INV-SEC-001).
 *
 * Every case here must produce a project-owned error with the right code and
 * **no trace of the canary**.
 */

/** A string that must never appear in anything this adapter publishes. */
const CANARY = 'CANARY-DEPENDENCY-DETAIL-9F3A';

function provider(maxCandidates = 10): MiniSearchCandidateProvider {
  return new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates });
}

/** An object whose `ownKeys` trap throws with the canary. */
function throwingOwnKeys(target: object): object {
  return new Proxy(target, {
    ownKeys() {
      throw new Error(CANARY);
    },
  });
}

/** An object whose `getOwnPropertyDescriptor` trap throws for one key. */
function throwingDescriptor(target: object, key: string): object {
  return new Proxy(target, {
    getOwnPropertyDescriptor(inner, property) {
      if (property === key) throw new Error(CANARY);
      return Reflect.getOwnPropertyDescriptor(inner, property);
    },
  });
}

/** An object carrying a throwing accessor rather than a data property. */
function throwingGetter(base: Record<string, unknown>, key: string): object {
  const object = { ...base };
  Object.defineProperty(object, key, {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error(CANARY);
    },
  });
  return object;
}

function assertProjectOwned(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(MiniSearchCandidateProviderError);
  const owned = error as MiniSearchCandidateProviderError;
  expect(owned.code).toBe(code);
  // Nothing the hostile value said may travel out of the adapter.
  expect(owned.message).not.toContain(CANARY);
  expect(owned.blockId).not.toContain(CANARY);
  expect(JSON.stringify({ ...owned, message: owned.message })).not.toContain(CANARY);
}

function constructionError(config: unknown): unknown {
  try {
    new MiniSearchCandidateProvider(config);
  } catch (cause) {
    return cause;
  }
  throw new Error('expected construction to fail');
}

async function requestError(request: unknown): Promise<unknown> {
  try {
    await provider().getCandidates(request as CandidateProviderRequest);
  } catch (cause) {
    return cause;
  }
  throw new Error('expected the request to fail');
}

const CORPUS = [
  block('blk-a', 'The reticulator calibrates the allocator.'),
  block('blk-b', 'A budget reserve is subtracted first.'),
];

describe('hostile configuration is inspected without a raw exception escaping', () => {
  it('reports a throwing ownKeys trap as invalid configuration', () => {
    // `Object.keys` on this value throws. The adapter must not let that be its
    // failure.
    const error = constructionError(throwingOwnKeys({ schemaVersion: 1, maxCandidates: 5 }));
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
    // Names the guarded inspection, so this is the reflection guard firing and
    // not some unrelated rejection reached by accident.
    expect((error as MiniSearchCandidateProviderError).message).toContain('could not inspect');
  });

  it('reports a throwing getOwnPropertyDescriptor trap as invalid configuration', () => {
    assertProjectOwned(
      constructionError(
        throwingDescriptor({ schemaVersion: 1, maxCandidates: 5 }, 'maxCandidates'),
      ),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
    );
  });

  it('never invokes a configuration accessor, and rejects the field as absent', () => {
    // The getter is not called at all: an own accessor is treated as absent
    // rather than read, so the value is rejected for having no usable bound.
    let called = false;
    const config = { schemaVersion: 1 };
    Object.defineProperty(config, 'maxCandidates', {
      enumerable: true,
      configurable: true,
      get() {
        called = true;
        throw new Error(CANARY);
      },
    });
    assertProjectOwned(constructionError(config), 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG');
    expect(called).toBe(false);
  });
});

describe('a hostile request is inspected without a raw exception escaping', () => {
  it('reports a throwing ownKeys trap as an invalid request', async () => {
    const error = await requestError(
      throwingOwnKeys(providerRequest({ query: 'budget', blocks: CORPUS })),
    );
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    expect((error as MiniSearchCandidateProviderError).message).toContain('could not inspect');
  });

  it('reports a throwing descriptor trap on the query as an invalid request', async () => {
    assertProjectOwned(
      await requestError(
        throwingDescriptor(providerRequest({ query: 'budget', blocks: CORPUS }), 'query'),
      ),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('never invokes a query accessor, and rejects the field as absent', async () => {
    const request = throwingGetter(
      { ...providerRequest({ query: 'budget', blocks: CORPUS }) } as unknown as Record<
        string,
        unknown
      >,
      'query',
    );
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a throwing descriptor trap on the scope as an invalid request', async () => {
    const request = {
      ...providerRequest({ query: 'budget', blocks: CORPUS }),
      scope: throwingDescriptor({ tenantId: 't', workspaceId: 'w' }, 'tenantId'),
    };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a blocks array whose element descriptor throws as an invalid request', async () => {
    // The array spine is snapshotted through own data descriptors, so this is the
    // trap that matters. A `get` trap is deliberately never reached — see the
    // passivity suite below.
    const blocks = new Proxy([...CORPUS], {
      getOwnPropertyDescriptor(inner, property) {
        if (property === '0') throw new Error(CANARY);
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });
    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a blocks array whose length descriptor throws as an invalid request', async () => {
    const blocks = new Proxy([...CORPUS], {
      getOwnPropertyDescriptor(inner, property) {
        if (property === 'length') throw new Error(CANARY);
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });
    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('rejects a blocks array whose length is an accessor rather than data', async () => {
    const blocks = new Proxy([...CORPUS], {
      getOwnPropertyDescriptor(inner, property) {
        if (property === 'length') return { get: () => 1, configurable: true };
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });
    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a block whose descriptor trap throws as an invalid request', async () => {
    const hostile = throwingDescriptor({ ...CORPUS[0] }, 'id');
    const request = providerRequest({
      query: 'budget',
      blocks: [hostile as never, ...CORPUS.slice(1)],
    });
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a block whose content descriptor throws, naming only the caller-owned id', async () => {
    const hostile = throwingDescriptor({ ...CORPUS[0] }, 'content');
    const request = providerRequest({
      query: 'budget',
      blocks: [hostile as never, ...CORPUS.slice(1)],
    });
    const error = await requestError(request);
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    // The identifier came from the caller's own corpus, so reporting it
    // discloses nothing the caller does not already hold.
    expect((error as MiniSearchCandidateProviderError).blockId).toBe('blk-a');
  });

  it('never invokes a block content accessor', async () => {
    let called = false;
    const hostile: Record<string, unknown> = { ...CORPUS[0] };
    Object.defineProperty(hostile, 'content', {
      enumerable: true,
      configurable: true,
      get() {
        called = true;
        throw new Error(CANARY);
      },
    });
    assertProjectOwned(
      await requestError(providerRequest({ query: 'budget', blocks: [hostile as never] })),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
    expect(called).toBe(false);
  });

  it('every hostile request failure is a rejected promise, never a synchronous throw', () => {
    let threw = false;
    let promise: Promise<unknown> | undefined;
    try {
      promise = provider().getCandidates(
        throwingOwnKeys(
          providerRequest({ query: 'budget', blocks: CORPUS }),
        ) as CandidateProviderRequest,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    return expect(promise).rejects.toBeInstanceOf(MiniSearchCandidateProviderError);
  });
});

describe('array inspection is passive: no accessor and no get trap ever runs', () => {
  /**
   * The strongest form of the claim, and the one that was previously untrue.
   *
   * `tryOwnDataProperty` never invoked an accessor on an ordinary object field,
   * but the array-spine snapshot read `value.length` and `value[index]` as plain
   * property *gets*. On a `Proxy` each ran the `get` trap; on an array with an
   * installed getter the element read ran that getter. Wrapping them in a `try`
   * made a *thrown* failure project-owned, but by then the untrusted code had
   * already executed — and a getter that does **not** throw is worse, because it
   * can mutate state, answer differently on each read, or simply observe that it
   * was consulted.
   *
   * The snapshot now goes through `Object.getOwnPropertyDescriptor`, which
   * reports an accessor without calling it. These tests count invocations, so a
   * regression that reintroduces a plain read fails here even when nothing
   * throws.
   */

  it('never invokes an accessor installed at an array index', async () => {
    let getterCalls = 0;
    const blocks: unknown[] = [];
    Object.defineProperty(blocks, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        return CORPUS[0];
      },
    });
    Object.defineProperty(blocks, 'length', { value: 1, writable: true });

    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
    expect(getterCalls).toBe(0);
  });

  it('never uses the get trap of a Proxy-backed blocks array', async () => {
    let getCalls = 0;
    let descriptorCalls = 0;
    const blocks = new Proxy([...CORPUS], {
      get(inner, property, receiver) {
        getCalls += 1;
        return Reflect.get(inner, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor(inner, property) {
        descriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(inner, property);
      },
    });

    // Passive own data descriptors are still readable, so a well-formed
    // Proxy-backed array retrieves normally rather than being rejected for
    // merely being a Proxy.
    const request = { ...providerRequest({ query: 'reticulator', blocks: CORPUS }), blocks };
    const got = await provider().getCandidates(request as CandidateProviderRequest);

    expect(got.map((candidate) => candidate.block.id)).toEqual(['blk-a']);
    expect(getCalls).toBe(0);
    expect(descriptorCalls).toBeGreaterThan(0);
  });

  it('never invokes an accessor in a dependency search-result array', async () => {
    let getterCalls = 0;
    const results: unknown[] = [];
    Object.defineProperty(results, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error(CANARY);
      },
    });
    Object.defineProperty(results, 'length', { value: 1, writable: true });

    vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue(results as never);
    try {
      const error = await requestError(providerRequest({ query: 'reticulator', blocks: CORPUS }));
      assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED');
    } finally {
      vi.restoreAllMocks();
    }
    expect(getterCalls).toBe(0);
  });

  it('snapshots an ordinary dense array byte-identically', async () => {
    // The passive path must not change what a normal request retrieves.
    const dense = [...CORPUS];
    const viaArray = await provider().getCandidates(
      providerRequest({ query: 'reticulator budget', blocks: dense }),
    );
    const viaProxy = await provider().getCandidates({
      ...providerRequest({ query: 'reticulator budget', blocks: CORPUS }),
      blocks: new Proxy([...CORPUS], {}),
    } as CandidateProviderRequest);
    expect(JSON.stringify(viaProxy)).toBe(JSON.stringify(viaArray));
  });

  it('treats a hole as absent data, deterministically and without throwing', async () => {
    // A sparse array is a data problem, not a second reflective failure mode: the
    // hole snapshots as `undefined` and ordinary block validation rejects it.
    const sparse: unknown[] = [];
    Object.defineProperty(sparse, 'length', { value: 2, writable: true });
    Object.defineProperty(sparse, '1', { value: CORPUS[0], enumerable: true, configurable: true });

    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks: sparse };
    const first = await requestError(request);
    assertProjectOwned(first, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    // Deterministic: the same input fails the same way every time.
    const second = await requestError(request);
    expect((second as MiniSearchCandidateProviderError).code).toBe(
      (first as MiniSearchCandidateProviderError).code,
    );
  });
});

describe('a revoked Proxy cannot leak a native TypeError', () => {
  /**
   * The sharpest hostile value, and the last unguarded path.
   *
   * A revoked proxy is `typeof "object"` and not `null`, so it reaches every
   * structural check the adapter performs — and it refuses *every* reflective
   * operation, including `Array.isArray`, which looks passive but unwraps a proxy
   * to reach its target:
   *
   * ```text
   * const { proxy, revoke } = Proxy.revocable([], {});
   * revoke();
   * Array.isArray(proxy);
   * // TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
   * ```
   *
   * The engine's own wording is what must not escape, so every assertion below
   * checks for it by name rather than only checking the error type.
   */

  /** The exact substring Node uses, which no project-owned error may carry. */
  const NATIVE_ISARRAY_MESSAGE = 'has been revoked';

  function revoked(target: object): unknown {
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return proxy;
  }

  function assertNoNativeText(error: unknown): void {
    const owned = error as MiniSearchCandidateProviderError;
    expect(owned.message).not.toContain(NATIVE_ISARRAY_MESSAGE);
    expect(owned.message).not.toContain('IsArray');
    expect(owned.message).not.toContain('TypeError');
  }

  it.each([
    ['an array target', [] as object],
    ['an object target', {} as object],
  ])('pins that Array.isArray throws on a revoked proxy with %s', (_label, target) => {
    // Pinned rather than assumed: on this Node version an object-target revoked
    // proxy throws too, so the guard cannot be scoped to array-backed ones.
    const proxy = revoked(target);
    expect(typeof proxy).toBe('object');
    expect(proxy).not.toBeNull();
    expect(() => Array.isArray(proxy)).toThrow(TypeError);
  });

  it.each([
    ['an array target', [] as object],
    ['an object target', {} as object],
  ])('rejects a revoked proxy configuration with %s', (_label, target) => {
    const error = constructionError(revoked(target));
    expect(error).toBeInstanceOf(MiniSearchCandidateProviderError);
    expect((error as MiniSearchCandidateProviderError).code).toBe(
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_CONFIG',
    );
    assertNoNativeText(error);
  });

  it.each([
    ['an array target', [] as object],
    ['an object target', {} as object],
  ])('rejects a revoked proxy request with %s', async (_label, target) => {
    const error = await requestError(revoked(target));
    expect(error).toBeInstanceOf(MiniSearchCandidateProviderError);
    expect((error as MiniSearchCandidateProviderError).code).toBe(
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
    assertNoNativeText(error);
  });

  it('rejects revoked-proxy blocks through the unreadable-array path', async () => {
    // This is the array-kind guard inside the spine snapshot: without it,
    // `Array.isArray` on the corpus throws the native TypeError straight out.
    const request = {
      ...providerRequest({ query: 'budget', blocks: CORPUS }),
      blocks: revoked([]),
    };
    const error = await requestError(request);
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    assertNoNativeText(error);
  });

  it('rejects revoked-proxy sourceDocuments', async () => {
    const request = {
      ...providerRequest({ query: 'budget', blocks: CORPUS }),
      sourceDocuments: revoked([]),
    };
    const error = await requestError(request);
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    assertNoNativeText(error);
  });

  it('rejects a revoked-proxy scope', async () => {
    const request = {
      ...providerRequest({ query: 'budget', blocks: CORPUS }),
      scope: revoked({}),
    };
    const error = await requestError(request);
    assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    assertNoNativeText(error);
  });

  it('reports a revoked-proxy search result as a search failure', async () => {
    // Two guards can catch this — the `try` around the library call and the
    // array-kind guard on the result root — and which one fires depends on
    // whether anything touches the value on the way back. The contract is the
    // outcome, not the route: a project-owned `SEARCH_FAILED` carrying none of
    // the engine's wording.
    vi.spyOn(MiniSearch.prototype, 'search').mockReturnValue(revoked([]) as never);
    try {
      const error = await requestError(providerRequest({ query: 'reticulator', blocks: CORPUS }));
      assertProjectOwned(error, 'MINISEARCH_CANDIDATE_PROVIDER_SEARCH_FAILED');
      assertNoNativeText(error);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('leaves ordinary objects and arrays behaving exactly as before', async () => {
    // The guard must cost nothing for a well-formed value.
    const got = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: CORPUS }),
    );
    expect(got.map((candidate) => candidate.block.id)).toEqual(['blk-a']);
    // A plain array is still rejected as a request, and a plain object is still
    // rejected as a corpus — the two shape rules the guard replaced.
    assertProjectOwned(await requestError([]), 'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST');
    assertProjectOwned(
      await requestError({ ...providerRequest({ query: 'x', blocks: CORPUS }), blocks: {} }),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });
});

describe('a passive valid request is entirely unaffected by the guards', () => {
  it('still retrieves normally', async () => {
    const got = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: CORPUS }),
    );
    expect(got.map((candidate) => candidate.block.id)).toEqual(['blk-a']);
  });
});

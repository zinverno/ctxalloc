import { MiniSearchCandidateProvider, MiniSearchCandidateProviderError } from '@ctxalloc/adapters';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
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

  it('reports a blocks array whose element read throws as an invalid request', async () => {
    // `Array.isArray` is true of a Proxy around an array, and its element reads
    // run code the adapter does not own.
    const blocks = new Proxy([...CORPUS], {
      get(inner, property, receiver) {
        if (property === '0') throw new Error(CANARY);
        return Reflect.get(inner, property, receiver) as unknown;
      },
    });
    const request = { ...providerRequest({ query: 'budget', blocks: CORPUS }), blocks };
    assertProjectOwned(
      await requestError(request),
      'MINISEARCH_CANDIDATE_PROVIDER_INVALID_REQUEST',
    );
  });

  it('reports a blocks array whose length read throws as an invalid request', async () => {
    const blocks = new Proxy([...CORPUS], {
      get(inner, property, receiver) {
        if (property === 'length') throw new Error(CANARY);
        return Reflect.get(inner, property, receiver) as unknown;
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

describe('a passive valid request is entirely unaffected by the guards', () => {
  it('still retrieves normally', async () => {
    const got = await provider().getCandidates(
      providerRequest({ query: 'reticulator', blocks: CORPUS }),
    );
    expect(got.map((candidate) => candidate.block.id)).toEqual(['blk-a']);
  });
});

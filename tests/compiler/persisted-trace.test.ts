import {
  COMPILATION_TRACE_SCHEMA_VERSION,
  PersistedCompilationTraceError,
  SettledCompilationTraceValidator,
  type SettledCompilationTrace,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  COUNTEREXAMPLE_AVAILABLE,
  COUNTEREXAMPLE_SPECS,
  COUNTEREXAMPLE_TOKENIZER,
  FACTS_MINIMUM_POLICY,
  compile,
  jsonlOverheadTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';
import { trace as unsettledTrace } from './trace-fixtures.js';

/**
 * `SettledCompilationTraceValidator` (DEC-042).
 *
 * A trace read back from a store is external data. These tests use traces the
 * real `ContextCompiler` produced, round-tripped through JSON exactly as a store
 * would, so the schema is proven against the record the kernel actually writes
 * rather than against a hand-built approximation.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 2, required: true, priority: 0 },
  { id: 'high', tokens: 2, priority: 900 },
  { id: 'low', tokens: 2, priority: 100 },
];

/** A settled trace that also carries eviction evidence and a correction. */
function correctedTrace(): SettledCompilationTrace {
  return compile({ specs: SPECS, available: 14 }, jsonlOverheadTokenizer(3)).trace;
}

/** A settled trace produced by the bounded fallback search. */
function fallbackTrace(): SettledCompilationTrace {
  return compile(
    {
      specs: COUNTEREXAMPLE_SPECS,
      available: COUNTEREXAMPLE_AVAILABLE,
      policy: FACTS_MINIMUM_POLICY,
    },
    COUNTEREXAMPLE_TOKENIZER,
  ).trace;
}

/** A settled trace whose initial render fits, so no correction was applied. */
function uncorrectedTrace(): SettledCompilationTrace {
  return compile({ specs: SPECS, available: 200 }).trace;
}

/** Exactly what a store round trip does to a record. */
function persisted(trace: SettledCompilationTrace): unknown {
  return JSON.parse(JSON.stringify(trace));
}

function reject(input: unknown): PersistedCompilationTraceError {
  try {
    new SettledCompilationTraceValidator().validate(input);
  } catch (cause) {
    if (cause instanceof PersistedCompilationTraceError) return cause;
    throw cause;
  }
  throw new Error('expected the validator to reject the value');
}

describe('INV-STORE-004: persisted settled traces are validated on the way in', () => {
  it('accepts every settled trace the compiler produces, after a JSON round trip', () => {
    for (const trace of [correctedTrace(), fallbackTrace(), uncorrectedTrace()]) {
      const stored = persisted(trace);
      const validated = new SettledCompilationTraceValidator().validate(stored);

      expect(validated).toEqual(trace);
      expect(validated.settled).toBe(true);
      expect(validated.schemaVersion).toBe(COMPILATION_TRACE_SCHEMA_VERSION);
    }
  });

  it('publishes a JSON-equivalent snapshot of the stored value', () => {
    const stored = persisted(correctedTrace());
    const validated = new SettledCompilationTraceValidator().validate(stored);

    // The published record is the snapshot the schema validated, and it carries
    // the same JSON document: same fields, same values, same order.
    expect(validated).toEqual(stored);
    expect(JSON.stringify(validated)).toBe(JSON.stringify(stored));
  });

  it('names the schema version it accepts', () => {
    expect(new SettledCompilationTraceValidator().supportedSchemaVersion).toBe(
      COMPILATION_TRACE_SCHEMA_VERSION,
    );
  });

  it('does not mutate the value it validates', () => {
    const stored = persisted(correctedTrace());
    const before = JSON.stringify(stored);

    new SettledCompilationTraceValidator().validate(stored);

    expect(JSON.stringify(stored)).toBe(before);
  });

  it('rejects an unsupported future schema version with its own code', () => {
    const stored = { ...(persisted(correctedTrace()) as object), schemaVersion: 3 };
    const error = reject(stored);

    expect(error.issues[0]?.code).toBe('unsupported_schema_version');
    expect(error.issues[0]?.pointer).toBe('schemaVersion');
  });

  it('rejects a superseded past schema version with the same code', () => {
    const stored = { ...(persisted(correctedTrace()) as object), schemaVersion: 1 };

    expect(reject(stored).issues[0]?.code).toBe('unsupported_schema_version');
  });

  it('rejects an unsettled snapshot with its own code', () => {
    const stored = JSON.parse(
      JSON.stringify(unsettledTrace({ specs: [{ id: 'one', tokens: 2 }] })),
    ) as unknown;
    const error = reject(stored);

    expect(error.issues[0]?.code).toBe('unsettled_trace');
    expect(error.issues[0]?.pointer).toBe('settled');
  });

  it('rejects an unknown field rather than stripping it', () => {
    const stored = { ...(persisted(correctedTrace()) as object), extra: 'x' };
    const error = reject(stored);

    expect(error.issues.every((detail) => detail.code === 'invalid_trace')).toBe(true);
    // The issue is addressed to the record that carried the surplus key, and the
    // key itself is named in the message: an unknown field is evidence the record
    // came from a different producer, so it is reported rather than dropped.
    expect(error.issues.map((detail) => detail.pointer)).toContain('');
    expect(error.message).toContain('extra');
  });

  it('rejects an unknown field nested inside the settlement', () => {
    const stored = persisted(correctedTrace()) as {
      settlement: Record<string, unknown>;
    };
    stored.settlement.extra = 1;

    const error = reject(stored);

    expect(error.issues.map((detail) => detail.pointer)).toContain('settlement');
    expect(error.message).toContain('extra');
  });

  it.each([
    ['compilationId', 'not-a-digest'],
    ['settled', false],
    ['groups', {}],
  ])('rejects a corrupted %s', (field, value) => {
    const stored = { ...(persisted(correctedTrace()) as object), [field]: value };

    expect(reject(stored).issues.length).toBeGreaterThan(0);
  });

  it('rejects a settlement whose render position is not an integer', () => {
    const stored = persisted(correctedTrace()) as {
      settlement: { decisions: Record<string, unknown>[] };
    };
    const included = stored.settlement.decisions.find(
      (decision) => decision.disposition === 'included',
    );
    expect(included).toBeDefined();
    if (included !== undefined) included.renderPosition = 1.5;

    expect(reject(stored).issues.length).toBeGreaterThan(0);
  });

  it('rejects a trace claiming rendering-attempt-only tokenizer coverage', () => {
    const stored = persisted(correctedTrace()) as {
      composition: Record<string, unknown>;
    };
    stored.composition.tokenizerCoverage = 'rendering-attempt-only';

    expect(reject(stored).issues.map((detail) => detail.pointer)).toContain(
      'composition.tokenizerCoverage',
    );
  });

  it.each([
    ['a non-object', 7],
    ['null', null],
    ['an array', []],
    ['a string', '{}'],
  ])('rejects %s', (_label, input) => {
    expect(reject(input).issues.length).toBeGreaterThan(0);
  });
});

describe('INV-SEC-001: the validator inspects passive data only', () => {
  it('rejects an accessor rather than invoking it', () => {
    const stored = persisted(correctedTrace()) as Record<string, unknown>;
    let invoked = false;
    Object.defineProperty(stored, 'compilationId', {
      get() {
        invoked = true;
        return 'sha256:'.padEnd(71, '0');
      },
      enumerable: true,
      configurable: true,
    });

    const error = reject(stored);

    expect(invoked).toBe(false);
    expect(error.issues[0]?.code).toBe('not_json_safe');
  });

  it('rejects an undefined-valued optional property', () => {
    const stored = persisted(correctedTrace()) as { groups: Record<string, unknown>[] };
    const group = stored.groups[0];
    expect(group).toBeDefined();
    if (group !== undefined) group.renderPosition = undefined;

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
  });

  it('rejects a reference cycle', () => {
    const stored = persisted(correctedTrace()) as Record<string, unknown>;
    stored.request = stored;

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
  });

  it('rejects a class instance where a plain object is required', () => {
    const stored = persisted(correctedTrace()) as Record<string, unknown>;
    stored.rendering = new (class {
      readonly renderedContextHash = 'sha256:'.padEnd(71, '0');
      readonly renderedTokens = 1;
      readonly fitsAvailableInputBudget = true;
    })();

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
  });

  it('rejects a non-finite number', () => {
    const stored = persisted(correctedTrace()) as { totals: Record<string, unknown> };
    stored.totals.candidateTokens = Number.NaN;

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
  });

  it('quotes no stored value in its message', () => {
    const trace = correctedTrace();
    const stored = { ...(persisted(trace) as object), extra: 'x' };
    const error = reject(stored);

    expect(error.message).not.toContain(trace.compilationId);
    expect(error.message).not.toContain(trace.request.queryHash);
  });
});

/**
 * The validator returns the **caller's own value**, so "is JSON data" has to be
 * exact and its inspection has to be total (INV-ADAPTER-001, INV-SEC-001).
 *
 * Every reflective operation it performs — `Array.isArray`, `getPrototypeOf`,
 * `getOwnPropertyNames`, `getOwnPropertySymbols`, `getOwnPropertyDescriptor` —
 * is total on ordinary values and none is total on a hostile one. A revoked
 * `Proxy` is `typeof "object"` and not `null`, so it reaches every structural
 * check, and it refuses all five.
 *
 * Reverting any of the guards makes these fail with a raw `TypeError` escaping
 * the kernel instead of a project-owned `not_json_safe`.
 */
describe('INV-ADAPTER-001: hostile runtime values cannot escape as raw errors', () => {
  /** A message a hostile value would love to see republished. */
  const CANARY = 'ctxalloc-trace-canary';

  /** One settled trace with `groups` replaced by a hostile value. */
  function withHostileGroups(groups: unknown): unknown {
    const stored = persisted(correctedTrace()) as Record<string, unknown>;
    stored.groups = groups;
    return stored;
  }

  it('rejects a revoked array-target proxy', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();

    const error = reject(withHostileGroups(proxy));
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.issues[0]?.pointer).toBe('groups');
  });

  it('rejects a revoked object-target proxy', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(reject(withHostileGroups(proxy)).issues[0]?.code).toBe('not_json_safe');
  });

  it('rejects a throwing getPrototypeOf trap without repeating its message', () => {
    const hostile = new Proxy([], {
      getPrototypeOf: (): never => {
        throw new Error(CANARY);
      },
    });

    const error = reject(withHostileGroups(hostile));
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.message).not.toContain(CANARY);
    expect(error.issues[0]?.message).not.toContain(CANARY);
  });

  it('rejects a throwing ownKeys trap without repeating its message', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: (): never => {
          throw new Error(CANARY);
        },
      },
    );

    const error = reject(withHostileGroups(hostile));
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.message).not.toContain(CANARY);
  });

  it('rejects a throwing getOwnPropertyDescriptor trap without repeating its message', () => {
    const hostile = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor: (): never => {
          throw new Error(CANARY);
        },
      },
    );

    const error = reject(withHostileGroups(hostile));
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.message).not.toContain(CANARY);
  });

  it('never invokes an accessor, however deep it is', () => {
    let reads = 0;
    const nested = {};
    Object.defineProperty(nested, 'id', {
      get: () => {
        reads += 1;
        return 'block:a';
      },
      enumerable: true,
      configurable: true,
    });

    expect(reject(withHostileGroups([nested])).issues[0]?.code).toBe('not_json_safe');
    expect(reads).toBe(0);
  });

  it('never uses a get trap', () => {
    let gets = 0;
    const hostile = new Proxy(
      { id: 'block:a' },
      {
        get: (target, key) => {
          gets += 1;
          return Reflect.get(target, key);
        },
      },
    );

    // Whatever the verdict, no `get` trap ran: a trap that answers rather than
    // throws could return one value to the validator and another to the
    // consumer of the published record.
    reject(withHostileGroups([hostile]));
    expect(gets).toBe(0);
  });
});

/**
 * The three rules that go beyond what a serializer would notice.
 *
 * They exist because the validated value is **published**, not rebuilt: a
 * property `JSON.stringify` ignores is still observable on the object a consumer
 * receives, so a record carrying one is not the record any serialization of it
 * describes.
 */
describe('INV-STORE-004: the published value is exactly JSON data', () => {
  function withGroupProperty(mutate: (group: Record<string, unknown>) => void): unknown {
    const stored = persisted(correctedTrace()) as { groups: Record<string, unknown>[] };
    const group = stored.groups[0];
    expect(group).toBeDefined();
    if (group !== undefined) mutate(group);
    return stored;
  }

  it('rejects a symbol-keyed own property', () => {
    const stored = withGroupProperty((group) => {
      (group as Record<symbol, unknown>)[Symbol('hidden')] = 1;
    });

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
    expect(reject(stored).issues[0]?.message).toContain('symbol');
  });

  it('rejects a non-enumerable own property that JSON would omit', () => {
    const stored = withGroupProperty((group) => {
      Object.defineProperty(group, 'hidden', {
        value: 'invisible to JSON, visible on the returned object',
        enumerable: false,
        configurable: true,
        writable: true,
      });
    });

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
    expect(reject(stored).issues[0]?.message).toContain('enumerable');
  });

  it('rejects an array carrying a custom own property', () => {
    const stored = persisted(correctedTrace()) as { groups: unknown[] };
    (stored.groups as unknown as Record<string, unknown>).note = 'dropped by JSON';

    const error = reject(stored);
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.issues[0]?.message).toContain('other than its elements');
  });

  it('rejects an array with an accessor element', () => {
    const stored = persisted(correctedTrace()) as { groups: unknown[] };
    let reads = 0;
    Object.defineProperty(stored.groups, '0', {
      get: () => {
        reads += 1;
        return {};
      },
      enumerable: true,
      configurable: true,
    });

    expect(reject(stored).issues[0]?.code).toBe('not_json_safe');
    expect(reads).toBe(0);
  });

  it('rejects a sparse array rather than reading its holes as undefined', () => {
    const stored = persisted(correctedTrace()) as { groups: unknown[] };
    // `JSON.stringify` writes a hole as `null`, so the published array would not
    // equal the data any serialization of this record describes.
    stored.groups.length = stored.groups.length + 2;

    const error = reject(stored);
    expect(error.issues[0]?.code).toBe('not_json_safe');
    expect(error.issues[0]?.message).toContain('sparse');
  });

  it('returns a JSON-equivalent snapshot of an ordinary round-tripped trace', () => {
    const trace = correctedTrace();
    const stored = persisted(trace);
    const validated = new SettledCompilationTraceValidator().validate(stored);

    // Value fidelity, not reference identity: same fields, same values, same
    // order, nothing added, dropped, coerced, or recomputed.
    expect(validated).toEqual(stored);
    expect(JSON.stringify(validated)).toBe(JSON.stringify(stored));
  });
});

/**
 * The validator publishes the snapshot it validated, never the argument
 * (INV-BLOCK-005, INV-SEC-001).
 *
 * This is the case zero `get` calls *during* validation does not cover. A
 * `Proxy` can describe honest values through `getOwnPropertyDescriptor` — so the
 * passive walk validates them without firing a trap — and return different ones
 * through an ordinary property `get`. If the argument were returned, the first
 * consumer to read a field would get a value the validator never saw, and a
 * component would validate one trace and use another:
 *
 * ```text
 * descriptor view: compilationId = "<real>"   gets during walk: 0
 * consumer read:   compilationId = "<lie>"    gets now: 1
 * ```
 */
/**
 * `"__proto__"` is a legal JSON key, and the snapshot must carry it as an own
 * property (INV-BLOCK-005).
 *
 * `JSON.parse('{"__proto__":{"x":1}}')` produces an object with an own
 * enumerable `__proto__` data property. Building the snapshot with
 * `snapshot[key] = value` would instead find the inherited
 * `Object.prototype.__proto__` **setter** and run it:
 *
 * ```text
 * input own names:                 [ "__proto__", "a" ]
 * assignment snapshot own names:   [ "a" ]              prototype mutated: true
 * defineProperty snapshot names:   [ "__proto__", "a" ] prototype intact:  true
 * ```
 *
 * The field would vanish before the schema ever saw it, so a stored record
 * carrying an unknown `__proto__` field would be accepted as though it did not
 * have one — and `strictObject`'s whole point is that a surplus field is
 * evidence the record came from a different producer.
 *
 * The key is not special-cased away. Whether a field with that name is allowed
 * at a location is the schema's decision.
 */
describe('INV-BLOCK-005: an own "__proto__" key survives into the snapshot', () => {
  /** A record with a genuine own enumerable `__proto__` data property. */
  function withOwnProto(base: object, value: unknown): unknown {
    return JSON.parse(
      JSON.stringify({ ...base, __PLACEHOLDER__: value }).replace(
        '"__PLACEHOLDER__"',
        '"__proto__"',
      ),
    );
  }

  it('reaches the schema as an unknown field rather than being silently lost', () => {
    const stored = withOwnProto(persisted(correctedTrace()) as object, { x: 1 });
    expect(Object.getOwnPropertyNames(stored)).toContain('__proto__');

    const error = reject(stored);

    // Reported, not dropped: the field the record actually carried is named.
    expect(error.issues.every((detail) => detail.code === 'invalid_trace')).toBe(true);
    expect(error.message).toContain('__proto__');
  });

  it('mutates no prototype and raises no raw error', () => {
    const stored = withOwnProto(persisted(correctedTrace()) as object, { polluted: true });

    expect(() => reject(stored)).not.toThrow(TypeError);
    // Neither the input's prototype nor the global one moved.
    expect(Object.getPrototypeOf(stored as object)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).toBe(Object.getPrototypeOf({}));
  });

  it('reports a nested own "__proto__" field on a strict trace object', () => {
    const stored = persisted(correctedTrace()) as Record<string, unknown>;
    stored.settlement = withOwnProto(stored.settlement as object, 1);

    const error = reject(stored);

    expect(error.issues.map((detail) => detail.pointer)).toContain('settlement');
    expect(error.message).toContain('__proto__');
  });

  it('a valid trace with no such key is unaffected', () => {
    const stored = persisted(correctedTrace());
    const validated = new SettledCompilationTraceValidator().validate(stored);

    expect(Object.getPrototypeOf(validated)).toBe(Object.prototype);
    expect(validated).toEqual(stored);
  });
});

describe('INV-BLOCK-005: an accepted hostile Proxy is never the published value', () => {
  const LIE = 'sha256:'.padEnd(71, 'f');

  /** A settled trace, plus a root Proxy that describes it honestly and lies on `get`. */
  function hostileRoot(): {
    readonly target: Record<string, unknown>;
    readonly proxy: unknown;
    readonly gets: () => number;
  } {
    const target = persisted(correctedTrace()) as Record<string, unknown>;
    let gets = 0;
    const proxy = new Proxy(target, {
      // Reflection is faithful, so the passive walk sees the real record and
      // accepts it.
      getOwnPropertyDescriptor: (t, key) => Object.getOwnPropertyDescriptor(t, key),
      ownKeys: (t) => Reflect.ownKeys(t),
      getPrototypeOf: (t) => Object.getPrototypeOf(t) as object | null,
      // Ordinary reads lie.
      get: (t, key) => {
        gets += 1;
        if (key === 'compilationId') return LIE;
        if (key === 'schemaVersion') return 999;
        if (key === 'request') return { scope: { tenantId: 'x', workspaceId: 'y' } };
        return Reflect.get(t, key);
      },
    });
    return { target, proxy, gets: () => gets };
  }

  it('accepts on the descriptor view without firing the get trap', () => {
    const { proxy, gets } = hostileRoot();

    expect(() => new SettledCompilationTraceValidator().validate(proxy)).not.toThrow();
    expect(gets()).toBe(0);
  });

  it('does not return the Proxy, and its values are the descriptor-validated ones', () => {
    const { target, proxy, gets } = hostileRoot();
    const validated = new SettledCompilationTraceValidator().validate(proxy);

    // Everything the production path would do, measured **before** any matcher
    // runs: vitest's own `not.toBe` diff hint reads the value it is handed, so
    // asserting identity through a matcher would count the assertion library's
    // reads as the service's.
    const isProxy = Object.is(validated, proxy);
    const publishedId = validated.compilationId;
    const publishedVersion = validated.schemaVersion;
    const publishedScope = validated.request.scope;
    const readsAfterConsuming = gets();

    expect(isProxy).toBe(false);
    // The real values, not what `get` would have answered.
    expect(publishedId).toBe(target.compilationId);
    expect(publishedId).not.toBe(LIE);
    expect(publishedVersion).toBe(COMPILATION_TRACE_SCHEMA_VERSION);
    expect(publishedScope).toEqual((target.request as { scope: unknown }).scope);
    expect(validated).toEqual(target);

    // Validating and then fully consuming the published record never reached
    // the original value.
    expect(readsAfterConsuming).toBe(0);
  });

  it('publishes a record whose repeated reads agree', () => {
    const { proxy, gets } = hostileRoot();
    const validated = new SettledCompilationTraceValidator().validate(proxy);

    const first = JSON.stringify(validated);
    const second = JSON.stringify(validated);
    const reads = gets();

    // Reading the published record twice yields the same document, which is the
    // property the return type asserts and the one a `Proxy` can break.
    expect(first).toBe(second);
    expect(reads).toBe(0);
  });
});

describe('INV-DEP-002: validation reconstructs nothing', () => {
  it('accepts a trace whose stored totals contradict each other', () => {
    const stored = persisted(correctedTrace()) as { totals: Record<string, unknown> };
    stored.totals.candidateTokens = 99_999;

    expect(() => new SettledCompilationTraceValidator().validate(stored)).not.toThrow();
  });

  it('accepts a trace whose stored digests do not describe its content', () => {
    const stored = persisted(correctedTrace()) as {
      rendering: Record<string, unknown>;
    };
    stored.rendering.renderedContextHash = `sha256:${'0'.repeat(64)}`;

    expect(() => new SettledCompilationTraceValidator().validate(stored)).not.toThrow();
  });
});

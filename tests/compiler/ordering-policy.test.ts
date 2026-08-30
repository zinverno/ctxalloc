import { CONTEXT_ORDERING_POLICY_SCHEMA_VERSION, ContextOrderer } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { allocate, issueCodesOf, order, orderedIds, orderingPolicy } from './ordering-fixtures.js';

/**
 * Ordering policy validation.
 *
 * The policy is external configuration and therefore a runtime boundary: it is
 * validated strictly, nothing is coerced, and no default is injected (DEC-034).
 */

function reject(policy: unknown): readonly string[] {
  return issueCodesOf(() => new ContextOrderer(policy));
}

describe('ContextOrderer policy validation', () => {
  it('accepts the minimal policy and publishes its identity verbatim', () => {
    const result = order(
      allocate([{ id: 'b1', tokens: 2 }], { available: 50 }),
      orderingPolicy({ policyId: ' spaced Id ', policyVersion: '2.0.0-rc.1' }),
    );

    expect(result.orderingPolicyId).toBe(' spaced Id ');
    expect(result.orderingPolicyVersion).toBe('2.0.0-rc.1');
  });

  it('publishes the schema version of the policy contract', () => {
    expect(CONTEXT_ORDERING_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('rejects a policy that is not an object', () => {
    for (const invalid of [undefined, null, 'policy', 7, [], true]) {
      expect(reject(invalid), String(invalid)).toEqual(['invalid_policy']);
    }
  });

  it('rejects an unsupported schema version', () => {
    expect(reject(orderingPolicy({ schemaVersion: 2 }))).toEqual(['invalid_policy']);
    expect(reject(orderingPolicy({ schemaVersion: '1' }))).toEqual(['invalid_policy']);
  });

  it('rejects a blank policy identity', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(reject(orderingPolicy({ policyId: blank }))).toEqual(['invalid_policy']);
      expect(reject(orderingPolicy({ policyVersion: blank }))).toEqual(['invalid_policy']);
    }
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 in policy strings', () => {
    const loneSurrogate = '\ud800';
    expect(reject(orderingPolicy({ policyId: `p${loneSurrogate}` }))).toEqual(['invalid_policy']);
    expect(reject(orderingPolicy({ policyVersion: `1${loneSurrogate}` }))).toEqual([
      'invalid_policy',
    ]);
  });

  it('rejects an unknown policy field rather than stripping it', () => {
    expect(reject(orderingPolicy({ groupByCategory: true }))).toEqual(['invalid_policy']);
    expect(reject(orderingPolicy({ requiredFirst: true }))).toEqual(['invalid_policy']);
  });

  it('rejects an unsupported strategy', () => {
    for (const strategy of [
      'score-desc',
      'required-first',
      'allocation-chronology',
      '',
      undefined,
    ]) {
      expect(reject(orderingPolicy({ strategy })), String(strategy)).toEqual(['invalid_policy']);
    }
  });

  it('publishes a stable top-level error code', () => {
    try {
      new ContextOrderer({});
    } catch (error) {
      expect((error as { code: string }).code).toBe('CONTEXT_ORDERING_FAILED');
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('does not mutate the caller policy object', () => {
    const policy = orderingPolicy();
    const snapshot = structuredClone(policy);
    order(allocate([{ id: 'b1', tokens: 2 }], { available: 50 }), policy);
    expect(policy).toEqual(snapshot);
  });

  it('reuses one validated policy across calls', () => {
    const orderer = new ContextOrderer(orderingPolicy());
    const allocation = allocate([{ id: 'b1', tokens: 2 }], { available: 50 });
    expect(orderedIds(orderer.order(allocation))).toEqual(orderedIds(orderer.order(allocation)));
  });
});

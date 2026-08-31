import { describe, expect, it } from 'vitest';
import {
  buildTrace,
  candidateOf,
  contextBlock,
  dispositionsOf,
  hugeTokenizer,
  issueCodesOf,
  issuePointersOf,
  runPipeline,
  trace,
  tracePolicy,
  type CandidateSpec,
} from './trace-fixtures.js';

/**
 * Exact token and count reconciliation (INV-TRACE-003, corrected by DEC-037).
 *
 * The fixture below is pinned: it mixes duplicate wrappers, a filtered group, two
 * included groups, and an allocation-excluded group, and every total is asserted
 * against an exact expected number rather than against a recomputation of the
 * implementation.
 */

const SHARED_CONTENT = 'shared alpha beta gamma';

function sharedCandidate(id: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    block: contextBlock({ id, content: SHARED_CONTENT, attributes: { priority: 900 } }),
  };
}

const THRESHOLD_POLICY = tracePolicy({
  filtering: {
    schemaVersion: 1,
    policyId: 'filtering',
    policyVersion: '3.0.0',
    minimumTotalScore: 0.3,
  },
});

/**
 * The pinned reconciliation fixture.
 *
 * ```text
 * group    members  canonical tokens  disposition
 * req      1        5                 included (required)
 * dup-a    3        4                 included (score order)
 * low      1        7                 filtered (0.1 < 0.3)
 * big      1        20                excluded (budget exhausted)
 * ```
 *
 * The `dup-a` group holds one byte-identical repeat of `dup-a` and one `dup-b`
 * wrapper carrying the same content under a different block ID, so three
 * wrappers collapse to one canonical block of four tokens.
 */
function reconciliationRun(): ReturnType<typeof runPipeline> {
  const dupA = sharedCandidate('dup-a');
  return runPipeline({
    policy: THRESHOLD_POLICY,
    available: 10,
    candidates: [
      candidateOf({ id: 'req', tokens: 5, priority: 0, required: true }),
      dupA,
      dupA,
      sharedCandidate('dup-b'),
      candidateOf({ id: 'low', tokens: 7, priority: 100 }),
      candidateOf({ id: 'big', tokens: 20, priority: 500 }),
    ],
  });
}

describe('INV-TRACE-003: trace totals reconcile exactly', () => {
  it('the fixture reaches the intended dispositions', () => {
    const built = buildTrace(reconciliationRun());
    expect(dispositionsOf(built)).toEqual({
      big: 'excluded',
      'dup-a': 'included',
      low: 'filtered',
      req: 'included',
    });
  });

  it('pins every count', () => {
    const totals = buildTrace(reconciliationRun()).totals;

    expect(totals.candidateCount).toBe(6);
    expect(totals.deduplicatedGroupCount).toBe(4);
    expect(totals.duplicateWrapperCount).toBe(2);
    expect(totals.filteredGroupCount).toBe(1);
    expect(totals.eligibleGroupCount).toBe(3);
    expect(totals.includedGroupCount).toBe(2);
    expect(totals.allocationExcludedGroupCount).toBe(1);
  });

  it('pins candidateTokens over every validated wrapper', () => {
    // 5 (req) + 4 + 4 + 4 (three wrappers of the shared content) + 7 + 20
    expect(buildTrace(reconciliationRun()).totals.candidateTokens).toBe(44);
  });

  it('pins canonicalContentTokens over every group exactly once', () => {
    // 5 (req) + 4 (dup-a) + 7 (low) + 20 (big)
    expect(buildTrace(reconciliationRun()).totals.canonicalContentTokens).toBe(36);
  });

  it('pins duplicateCandidateTokens as the group-level difference', () => {
    // 44 - 36, never a chosen "duplicate member" wrapper subtracted by identity.
    expect(buildTrace(reconciliationRun()).totals.duplicateCandidateTokens).toBe(8);
  });

  it('pins filteredContentTokens', () => {
    expect(buildTrace(reconciliationRun()).totals.filteredContentTokens).toBe(7);
  });

  it('pins includedContentTokens', () => {
    // 5 (req) + 4 (dup-a)
    expect(buildTrace(reconciliationRun()).totals.includedContentTokens).toBe(9);
  });

  it('pins allocationExcludedContentTokens', () => {
    expect(buildTrace(reconciliationRun()).totals.allocationExcludedContentTokens).toBe(20);
  });

  it('pins excludedCanonicalContentTokens', () => {
    // 7 (filtered) + 20 (allocation-excluded)
    expect(buildTrace(reconciliationRun()).totals.excludedCanonicalContentTokens).toBe(27);
  });

  it('satisfies every reconciliation equation', () => {
    const t = buildTrace(reconciliationRun()).totals;

    expect(t.candidateCount).toBe(
      buildTrace(reconciliationRun()).groups.reduce(
        (total, group) => total + group.members.length,
        0,
      ),
    );
    expect(t.duplicateWrapperCount).toBe(t.candidateCount - t.deduplicatedGroupCount);
    expect(t.eligibleGroupCount).toBe(t.includedGroupCount + t.allocationExcludedGroupCount);
    expect(t.deduplicatedGroupCount).toBe(t.filteredGroupCount + t.eligibleGroupCount);
    expect(t.candidateTokens).toBe(t.canonicalContentTokens + t.duplicateCandidateTokens);
    expect(t.excludedCanonicalContentTokens).toBe(
      t.filteredContentTokens + t.allocationExcludedContentTokens,
    );
    expect(t.canonicalContentTokens).toBe(
      t.includedContentTokens + t.excludedCanonicalContentTokens,
    );
  });

  it('keeps duplicateCandidateTokens non-negative, including with no duplicates', () => {
    const withDuplicates = buildTrace(reconciliationRun()).totals;
    expect(withDuplicates.duplicateCandidateTokens).toBeGreaterThanOrEqual(0);

    const none = trace({ specs: [{ id: 'solo', tokens: 3 }] }).totals;
    expect(none.duplicateCandidateTokens).toBe(0);
    expect(none.candidateTokens).toBe(none.canonicalContentTokens);
  });

  it('publishes only finite non-negative safe integers', () => {
    for (const [field, value] of Object.entries(buildTrace(reconciliationRun()).totals)) {
      expect(Number.isSafeInteger(value), `${field} is not a safe integer`).toBe(true);
      expect(value, `${field} is negative`).toBeGreaterThanOrEqual(0);
    }
  });

  it('METRICS 8.6: rendering counts never take part in the content equations', () => {
    // The same request under a tokenizer that counts the JSON quoting too. Block
    // content carries no quotes, so every block count — and therefore every
    // content total — is unchanged, while the rendered measurement is not.
    const quoteAware = {
      id: 'test:word-plus-quotes',
      version: '1',
      countTokens: (text: string): number =>
        text.split(/\s+/).filter((word) => word.length > 0).length +
        (text.match(/"/g) ?? []).length,
    };
    const plain = buildTrace(reconciliationRun());
    const other = buildTrace(
      runPipeline({
        policy: THRESHOLD_POLICY,
        available: 10,
        tokenizer: quoteAware,
        candidates: [
          candidateOf({ id: 'req', tokens: 5, priority: 0, required: true }),
          sharedCandidate('dup-a'),
          sharedCandidate('dup-a'),
          sharedCandidate('dup-b'),
          candidateOf({ id: 'low', tokens: 7, priority: 100 }),
          candidateOf({ id: 'big', tokens: 20, priority: 500 }),
        ],
      }),
    );

    expect(other.rendering.renderedTokens).toBeGreaterThan(plain.rendering.renderedTokens);
    expect(other.totals).toStrictEqual(plain.totals);
  });

  it('declares no rejected-candidate total in a successful trace', () => {
    const totals = buildTrace(reconciliationRun()).totals;
    for (const absent of [
      'rejectedCandidateTokens',
      'rejectedCandidateCount',
      'includedCandidateTokens',
      'excludedCandidateTokens',
      'compiledTokens',
      'unusedTokens',
      'renderingTokenDelta',
    ]) {
      expect(Object.keys(totals), `totals exposes ${absent}`).not.toContain(absent);
    }
    expect(Object.keys(totals).sort()).toEqual([
      'allocationExcludedContentTokens',
      'allocationExcludedGroupCount',
      'candidateCount',
      'candidateTokens',
      'canonicalContentTokens',
      'deduplicatedGroupCount',
      'duplicateCandidateTokens',
      'duplicateWrapperCount',
      'eligibleGroupCount',
      'excludedCanonicalContentTokens',
      'filteredContentTokens',
      'filteredGroupCount',
      'includedContentTokens',
      'includedGroupCount',
    ]);
  });

  it('reconciles a trace whose groups are all filtered', () => {
    const built = trace({
      specs: [
        { id: 'a', tokens: 3, priority: 10 },
        { id: 'b', tokens: 4, priority: 20 },
      ],
      policy: THRESHOLD_POLICY,
      available: 100,
    });

    expect(built.totals.filteredGroupCount).toBe(2);
    expect(built.totals.eligibleGroupCount).toBe(0);
    expect(built.totals.includedContentTokens).toBe(0);
    expect(built.totals.excludedCanonicalContentTokens).toBe(7);
    expect(built.totals.canonicalContentTokens).toBe(7);
  });
});

describe('INV-BUDGET-005: an unsafe total fails explicitly', () => {
  const HUGE = 2 ** 52;

  /**
   * Two filtered groups whose token counts each fit the safe range and whose sum
   * does not.
   *
   * The tokenizer returns the same huge count for every string, so
   * `CandidateValidator` accepts the declared counts and the renderer measures a
   * count of its own; only the trace's content arithmetic overflows.
   */
  function overflowRun(): ReturnType<typeof runPipeline> {
    const huge = (id: string, content: string): Record<string, unknown> => ({
      schemaVersion: 1,
      block: contextBlock({ id, content, tokenCount: HUGE, attributes: { priority: 0 } }),
    });
    return runPipeline({
      policy: THRESHOLD_POLICY,
      available: 10,
      tokenizer: hugeTokenizer(HUGE),
      candidates: [huge('huge-a', 'first huge block'), huge('huge-b', 'second huge block')],
    });
  }

  it('rejects a trace whose token totals leave the safe integer range', () => {
    const run = overflowRun();
    expect(Number.isSafeInteger(HUGE)).toBe(true);
    expect(Number.isSafeInteger(HUGE * 2)).toBe(false);

    expect(issueCodesOf(() => buildTrace(run))).toContain('invalid_trace_result');
    expect(issuePointersOf(() => buildTrace(run))).toContain('totals');
  });

  it('returns no partial trace when the totals overflow', () => {
    expect(() => buildTrace(overflowRun())).toThrow(/Compilation trace build failed/);
  });
});

describe('the totals describe the current selection, not a settled compilation', () => {
  it('reports current allocation content while the trace stays unsettled', () => {
    const built = buildTrace(reconciliationRun());
    expect(built.settled).toBe(false);
    expect(built.totals.includedContentTokens).toBe(built.allocation.selectedBlockContentTokens);
  });

  it('changes with the budget, because the current selection changes', () => {
    const specs: readonly CandidateSpec[] = [
      { id: 'a', tokens: 5, priority: 900 },
      { id: 'b', tokens: 5, priority: 800 },
    ];
    const tight = trace({ specs, available: 5 });
    const roomy = trace({ specs, available: 10 });

    expect(tight.totals.includedContentTokens).toBe(5);
    expect(roomy.totals.includedContentTokens).toBe(10);
    expect(tight.totals.canonicalContentTokens).toBe(roomy.totals.canonicalContentTokens);
  });
});

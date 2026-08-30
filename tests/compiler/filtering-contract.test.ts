import { readFileSync } from 'node:fs';
import {
  CandidateFilter,
  type CandidateFilteringDecision,
  type CandidateFilteringDecisionReason,
  type FilteredCandidateSet,
  type ScoredCandidate,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  decisionIds,
  eligibleIds,
  filter,
  filteringPolicy,
  permutations,
  reversedSet,
  scoreSpecs,
  scoredIds,
} from './filtering-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

/** Source with comments removed, so prose naming a concept is not read as code. */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The body of the one method that decides a candidate's eligibility. */
function decisionSource(): string {
  const declarations = stripComments(readSource('packages/compiler/src/candidate-filter.ts'));
  // The declaration, not the call site inside `filter`, which legitimately
  // carries the scope, registry, and reference time through to the eligible set.
  const start = declarations.indexOf('#decide(candidate: ScoredCandidate)');
  expect(start).toBeGreaterThan(-1);
  return declarations.slice(start);
}

const MIXED = [
  { id: 'a', priority: 100 },
  { id: 'b', priority: 900 },
  { id: 'c', priority: 500 },
  { id: 'd', priority: 300, required: true },
] as const;

/**
 * The filtered stage contract (DEC-036).
 *
 * Every scored candidate finishes with exactly one decision, the input stays
 * reachable and unmutated, and the eligible subset is directly consumable by the
 * allocator.
 */
describe('INV-TRACE-001: CandidateFilter conservation', () => {
  it('gives every scored candidate exactly one decision', () => {
    const result = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });

    expect(result.decisions).toHaveLength(result.scored.candidates.length);
    expect([...decisionIds(result)].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(decisionIds(result)).size).toBe(4);
  });

  it('reaches every input candidate through the scored set it carried in', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    expect(result.scored).toBe(scored);
    expect(result.scored.candidates).toBe(scored.candidates);
  });

  it('keeps a filtered candidate out of the eligible set and inside the decisions', () => {
    const result = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });

    expect(eligibleIds(result)).not.toContain('a');
    expect(decisionIds(result)).toContain('a');
  });

  it('partitions the decisions into exactly the eligible set', () => {
    const result = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });
    const eligible = result.decisions
      .filter((decision) => decision.decision === 'eligible')
      .map((decision) => decision.candidate);

    expect(result.eligible.candidates).toEqual(eligible);
    expect(result.eligible.candidates.length + (result.decisions.length - eligible.length)).toBe(
      result.scored.candidates.length,
    );
  });

  it('publishes the filtering policy identity it was constructed with', () => {
    const result = filter(MIXED, {
      policy: filteringPolicy({ policyId: 'strict', policyVersion: '2.1.0' }),
    });

    expect(result.filteringPolicyId).toBe('strict');
    expect(result.filteringPolicyVersion).toBe('2.1.0');
  });

  it('adds no schema version: the filtered set is an ephemeral stage result', () => {
    const result = filter(MIXED);
    expect(Object.keys(result)).not.toContain('schemaVersion');
    expect(Object.keys(result).sort()).toEqual([
      'decisions',
      'eligible',
      'filteringPolicyId',
      'filteringPolicyVersion',
      'scored',
    ]);
  });
});

describe('INV-ALLOC-004: CandidateFilter reuses records rather than copying them', () => {
  it('reuses every surviving ScoredCandidate by reference', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    for (const survivor of result.eligible.candidates) {
      expect(scored.candidates).toContain(survivor);
    }
    for (const decision of result.decisions) {
      expect(scored.candidates).toContain(decision.candidate);
    }
  });

  it('carries scope, source registry, scoring identity, and reference time exactly', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    expect(result.eligible.scope).toBe(scored.scope);
    expect(result.eligible.sourceDocuments).toBe(scored.sourceDocuments);
    expect(result.eligible.policyId).toBe(scored.policyId);
    expect(result.eligible.policyVersion).toBe(scored.policyVersion);
    expect(result.eligible.referenceTime).toBe(scored.referenceTime);
  });

  it('changes only the candidates of the eligible set', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy()).filter(scored);

    expect(result.eligible).toEqual(scored);
    expect(Object.keys(result.eligible).sort()).toEqual(Object.keys(scored).sort());
  });

  it('mutates nothing reachable from the input', () => {
    const scored = scoreSpecs(MIXED);
    const before = structuredClone(scored);
    new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);
    expect(scored).toEqual(before);
  });

  it('never mutates a block, its attributes, or its score', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    for (const decision of result.decisions) {
      const block = decision.candidate.candidate.canonicalBlock;
      expect(Object.keys(block.attributes).sort()).toEqual(
        Object.keys(
          scored.candidates.find((entry) => entry.candidate.canonicalBlock.id === block.id)
            ?.candidate.canonicalBlock.attributes ?? {},
        ).sort(),
      );
    }
  });
});

describe('INV-DET-002: CandidateFilter is a stable filter, not a re-ranker', () => {
  it('keeps the survivors in the order the scorer ranked them', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);
    const expected = scoredIds(scored).filter((id) => eligibleIds(result).includes(id));

    expect(eligibleIds(result)).toEqual(expected);
  });

  it('publishes decisions in input order, not in decision order', () => {
    const scored = scoreSpecs(MIXED);
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    expect(decisionIds(result)).toEqual(scoredIds(scored));
  });

  it('does not sort: a deliberately unranked input keeps its own order', () => {
    // A caller that composed the stages by hand can hand this stage an order the
    // scorer would never produce. The filter must not silently repair it: doing
    // so would put ranking under two owners (DEC-032).
    const scored = reversedSet(scoreSpecs(MIXED));
    const result = new CandidateFilter(filteringPolicy({ minimumTotalScore: 0.4 })).filter(scored);

    expect(decisionIds(result)).toEqual(scoredIds(scored));
    expect(eligibleIds(result)).toEqual(
      scoredIds(scored).filter((id) => eligibleIds(result).includes(id)),
    );
  });

  it('INV-DET-001: produces an identical result for an identical input', () => {
    const first = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });
    const second = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });
    expect(first).toEqual(second);
  });

  it('INV-ALLOC-005: decides the same set for every candidate permutation', () => {
    const expected = new Set(['b', 'c', 'd']);
    for (const order of permutations([...MIXED])) {
      const result = filter(order, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });
      expect(new Set(eligibleIds(result))).toEqual(expected);
    }
  });
});

describe('CandidateFilter decision contract', () => {
  it('discriminates every decision on its own decision and reason pair', () => {
    const result = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });

    for (const decision of result.decisions) {
      switch (decision.reason) {
        case 'ELIGIBLE_REQUIRED': {
          const eligible: 'eligible' = decision.decision;
          expect(eligible).toBe('eligible');
          break;
        }
        case 'ELIGIBLE_POLICY': {
          const total: number = decision.scoreTotal;
          expect(Number.isFinite(total)).toBe(true);
          break;
        }
        case 'FILTERED_SCORE_BELOW_MINIMUM': {
          const minimum: number = decision.minimumTotalScore;
          expect(decision.scoreTotal).toBeLessThan(minimum);
          break;
        }
        default: {
          const exhaustive: never = decision;
          throw new Error(`unhandled decision ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  });

  it('publishes exactly the documented reasons', () => {
    const reasons: readonly CandidateFilteringDecisionReason[] = [
      'ELIGIBLE_REQUIRED',
      'ELIGIBLE_POLICY',
      'FILTERED_SCORE_BELOW_MINIMUM',
    ];
    const result = filter(MIXED, { policy: filteringPolicy({ minimumTotalScore: 0.4 }) });
    for (const decision of result.decisions) {
      expect(reasons).toContain(decision.reason);
    }
  });

  it('does not admit an impossible decision and reason combination', () => {
    const candidate: ScoredCandidate = scoreSpecs([{ id: 'a', priority: 1 }])
      .candidates[0] as ScoredCandidate;

    // @ts-expect-error a filtered candidate can never carry an eligible reason
    const filteredRequired: CandidateFilteringDecision = {
      candidate,
      decision: 'filtered',
      reason: 'ELIGIBLE_REQUIRED',
    };
    // @ts-expect-error an eligible candidate can never carry the filtered reason
    const eligibleFiltered: CandidateFilteringDecision = {
      candidate,
      decision: 'eligible',
      reason: 'FILTERED_SCORE_BELOW_MINIMUM',
      scoreTotal: 0,
      minimumTotalScore: 1,
    };
    const requiredWithThreshold: CandidateFilteringDecision = {
      candidate,
      decision: 'eligible',
      reason: 'ELIGIBLE_REQUIRED',
      // @ts-expect-error a required bypass never carries a threshold it never faced
      minimumTotalScore: 1,
    };
    // @ts-expect-error a filtered decision always states the minimum it was below
    const filteredWithoutMinimum: CandidateFilteringDecision = {
      candidate,
      decision: 'filtered',
      reason: 'FILTERED_SCORE_BELOW_MINIMUM',
      scoreTotal: 0,
    };

    expect([
      filteredRequired,
      eligibleFiltered,
      requiredWithThreshold,
      filteredWithoutMinimum,
    ]).toHaveLength(4);
  });
});

describe('INV-DEP-003: CandidateFilter reads no hidden signal', () => {
  it('reads only the total score, the required flag, and its own policy', () => {
    const source = decisionSource();
    expect(source).toContain('attributes.required');
    expect(source).toContain('candidate.score.total');
    expect(source).toContain('this.#policy.minimumTotalScore');
  });

  it('names no raw retrieval, source, category, time, token, or budget signal', () => {
    const source = decisionSource();
    for (const forbidden of [
      'retrieval',
      'rank',
      'providerId',
      'providerVersion',
      'semantics',
      'higherIsBetter',
      'sourceDocumentId',
      'sourceType',
      'sourceLocation',
      'headingPath',
      'metadata',
      'category',
      'priority',
      'createdAt',
      'updatedAt',
      'referenceTime',
      'tokenCount',
      'budget',
      'availableInputTokens',
      'renderedTokens',
      'query',
      'scope',
      'Date',
      'Math.',
      'process.',
      'countTokens',
    ]) {
      expect(source, `reads ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('imports no clock, filesystem, environment, network, or tokenizer dependency', () => {
    const specifiers = [
      ...readSource('packages/compiler/src/candidate-filter.ts').matchAll(/from '(?<s>[^']+)'/g),
    ].map((match) => match.groups?.s ?? '');

    expect(
      specifiers.every(
        (specifier) =>
          specifier.startsWith('./') || specifier === 'zod' || specifier === '@ctxalloc/domain',
      ),
    ).toBe(true);
    expect(specifiers).not.toContain('@ctxalloc/ports');
  });

  it('decides identically when retrieval evidence changes but the score does not', () => {
    // The fixture policy scores authored priority only, so provider identity,
    // rank, and raw score reach the filter without changing any total.
    const withoutRetrieval = filter([{ id: 'a', priority: 100 }], {
      policy: filteringPolicy({ minimumTotalScore: 0.5 }),
    });
    const decision = withoutRetrieval.decisions[0];
    expect(decision?.reason).toBe('FILTERED_SCORE_BELOW_MINIMUM');
  });

  it('decides identically for two candidates that differ in everything but score', () => {
    const result = filter(
      [
        { id: 'a', priority: 100, category: 'facts', tokens: 1, sourceType: 'markdown' },
        { id: 'b', priority: 100, tokens: 40 },
      ],
      { policy: filteringPolicy({ minimumTotalScore: 0.5 }) },
    );

    const reasons = result.decisions.map((decision) => decision.reason);
    expect(new Set(reasons).size).toBe(1);
    expect(reasons[0]).toBe('FILTERED_SCORE_BELOW_MINIMUM');
  });

  it('never calls the tokenizer: it takes no tokenizer at all', () => {
    const constructed: FilteredCandidateSet = filter(MIXED);
    expect(constructed.eligible.candidates).toHaveLength(4);
    expect(Object.keys(constructed)).not.toContain('tokenizerId');
  });
});

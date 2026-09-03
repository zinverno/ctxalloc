import {
  MINISEARCH_CANDIDATE_PROVIDER_ID,
  MINISEARCH_CANDIDATE_PROVIDER_VERSION,
  MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
  MiniSearchCandidateProvider,
} from '@ctxalloc/adapters';
import {
  CandidateDeduplicator,
  CandidateScorer,
  CandidateValidator,
  type RetrievalNormalizationRule,
} from '@ctxalloc/compiler';
import type { CandidateBlock } from '@ctxalloc/domain';
import { describe, expect, it } from 'vitest';
import {
  RETRIEVAL_REFERENCE_TIME,
  RETRIEVAL_SCOPE,
} from '../../benchmarks/retrieval/v1/fixtures.js';
import { retrievalCorpusV1, retrievalDocumentsV1 } from '../../benchmarks/retrieval/v1/index.js';
import { wordTokenizer } from '../adapters/minisearch-fixtures.js';

/**
 * Phase 9 scoring consumes the real provider's evidence under an explicit rule
 * (DEC-041).
 *
 * Nothing about `CandidateScorer` changes. It still normalizes a raw score only
 * when a policy owns the exact contract — provider, version, metric, direction —
 * and it still refuses one it does not (INV-SCORE-002). The adapter knows
 * nothing about `ScoringPolicy`, and this test is the seam being exercised from
 * both sides, not a coupling between them.
 */

const QUERY = 'budget allocation';

/**
 * A concrete rule covering this provider's exact contract.
 *
 * `min` and `max` are **fixed policy input**, never inferred from the batch: a
 * batch-relative range would make one candidate's score change when an unrelated
 * candidate is added, which would make compilation depend on retrieval result
 * composition (INV-DET-001). The upper bound is a policy choice about the range
 * this deployment expects, and the scorer rejects anything outside it rather
 * than clamping.
 */
function minisearchRule(overrides: Partial<RetrievalNormalizationRule> = {}) {
  return {
    ruleId: 'minisearch-bm25plus',
    providerId: MINISEARCH_CANDIDATE_PROVIDER_ID,
    providerVersion: MINISEARCH_CANDIDATE_PROVIDER_VERSION,
    semantics: MINISEARCH_RETRIEVAL_SCORE_SEMANTICS,
    higherIsBetter: true,
    min: 0,
    max: 200,
    ...overrides,
  };
}

function scoringPolicy(rules: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'retrieval-scoring',
    policyVersion: '1.0.0',
    authoredPriority: { weight: 1, min: 0, max: 1000 },
    retrieval: { weight: 1, aggregation: 'max', rules },
  };
}

async function realCandidates(): Promise<readonly CandidateBlock[]> {
  const provider = new MiniSearchCandidateProvider({ schemaVersion: 1, maxCandidates: 5 });
  return provider.getCandidates({
    scope: RETRIEVAL_SCOPE,
    query: QUERY,
    referenceTime: RETRIEVAL_REFERENCE_TIME,
    sourceDocuments: retrievalDocumentsV1(),
    blocks: retrievalCorpusV1(wordTokenizer),
  });
}

function scoreWith(candidates: readonly CandidateBlock[], policy: Record<string, unknown>) {
  const validated = new CandidateValidator(wordTokenizer).validate({
    scope: RETRIEVAL_SCOPE,
    candidates,
    sourceDocuments: retrievalDocumentsV1(),
  });
  const deduplicated = new CandidateDeduplicator().deduplicate(validated);
  return new CandidateScorer(policy).score(deduplicated, RETRIEVAL_REFERENCE_TIME);
}

describe('the real provider feeds Phase 9 scoring unchanged', () => {
  it('scores successfully under a matching normalization rule', async () => {
    const scored = scoreWith(await realCandidates(), scoringPolicy([minisearchRule()]));
    expect(scored.candidates.length).toBeGreaterThan(0);
    for (const candidate of scored.candidates) {
      expect(candidate.score.retrieval).toBeDefined();
      expect(Number.isFinite(candidate.score.total)).toBe(true);
    }
  });

  it.each([
    ['a wrong provider id', minisearchRule({ providerId: 'some-other-retriever' })],
    ['a wrong provider version', minisearchRule({ providerVersion: '1+minisearch@9.9.9' })],
    ['wrong score semantics', minisearchRule({ semantics: 'cosine-similarity' })],
    ['a wrong direction', minisearchRule({ higherIsBetter: false })],
  ])('still rejects the batch under %s', async (_label, rule) => {
    // The existing Phase 9 failure is exactly the protection wanted: a rule that
    // does not describe this provider's contract must not be used to normalize
    // its numbers.
    const candidates = await realCandidates();
    expect(() => scoreWith(candidates, scoringPolicy([rule]))).toThrow();
  });

  it('still rejects the batch when no retrieval rule is configured at all', async () => {
    const candidates = await realCandidates();
    expect(() => scoreWith(candidates, scoringPolicy([]))).toThrow();
  });

  it('still rejects a score outside the range the rule declares', async () => {
    // Nothing is clamped. A value the policy did not expect is a policy problem
    // to fix, not a number to quietly squeeze into range (INV-SCORE-004).
    const candidates = await realCandidates();
    expect(() => scoreWith(candidates, scoringPolicy([minisearchRule({ max: 0.0001 })]))).toThrow();
  });
});

describe('INV-ALLOC-002: provider rank is not compiler score order', () => {
  it('produces a compiler ranking that is computed, not copied from the provider', async () => {
    const candidates = await realCandidates();
    // Authored priority is a real component here, and the highest-priority block
    // is deliberately not the provider's first result.
    const scored = scoreWith(candidates, scoringPolicy([minisearchRule()]));

    const providerOrder = candidates.map((candidate) => candidate.block.id);
    const compilerOrder = [...scored.candidates]
      .sort((left, right) => right.score.total - left.score.total)
      .map((entry) => entry.candidate.canonicalBlock.id);

    expect(new Set(compilerOrder)).toEqual(new Set(providerOrder));
    // The scorer read the evidence; it did not adopt the provider's ordering as
    // a decision. The two orders differ because authored priority participates.
    expect(compilerOrder).not.toEqual(providerOrder);
  });

  it('the adapter creates no scored candidate of its own', async () => {
    for (const candidate of await realCandidates()) {
      expect(candidate).not.toHaveProperty('score');
      expect(candidate).not.toHaveProperty('canonicalBlock');
      expect(candidate).not.toHaveProperty('members');
      expect(Object.keys(candidate).sort()).toEqual(['block', 'retrieval', 'schemaVersion']);
    }
  });
});

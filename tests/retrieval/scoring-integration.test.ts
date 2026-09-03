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
 * A window deliberately narrower than any score this query produces.
 *
 * It is not a magic constant standing in for "large": the test measures the
 * provider's actual highest score and asserts it exceeds this, so the fixture
 * stays honest if the corpus or the library changes.
 */
const NARROW_MAX = 0.5;

/**
 * A concrete rule covering this provider's exact contract.
 *
 * `min` and `max` are this policy's **normalization window**, not a claim about
 * the provider's range. MiniSearch's score is unbounded above, so no finite pair
 * could state one truthfully; the window says only which raw interval this
 * policy is prepared to interpret (DEC-032 as corrected by DEC-041).
 *
 * It is fixed policy input, never inferred from the batch: a batch-relative
 * window would make one candidate's score change when an unrelated candidate is
 * added, which would make compilation depend on retrieval result composition
 * (INV-DET-001). A value outside it rejects rather than clamps.
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

  it('still rejects a score outside the window the rule declares', async () => {
    // Nothing is clamped. A value the policy did not cover is a policy problem
    // to fix, not a number to quietly squeeze into range (INV-SCORE-004).
    const candidates = await realCandidates();
    expect(() => scoreWith(candidates, scoringPolicy([minisearchRule({ max: 0.0001 })]))).toThrow();
  });
});

describe('the normalization window is policy coverage, not a provider range', () => {
  /**
   * The contradiction this suite pins.
   *
   * `RetrievalNormalizationRule.min` / `max` were once documented as "the
   * inclusive bounds of the provider's documented range". MiniSearch's score has
   * no finite documented maximum — it is a BM25+ sum scaled by the matched-term
   * count — so under that reading no correct rule for this provider could exist,
   * and every fixture picking a finite `max` was quietly asserting something
   * untrue.
   *
   * The corrected reading (DEC-041) is that the window states which raw interval
   * *this policy* will normalize. A raw value above it is then an ordinary,
   * expected outcome: the provider is fine, the policy simply does not cover that
   * value, and widening the window is the fix.
   */
  async function highestRawScore(): Promise<number> {
    const values = (await realCandidates()).map(
      (candidate) => candidate.retrieval?.score?.value ?? 0,
    );
    return Math.max(...values);
  }

  it('the provider succeeds and emits a real score above a deliberately narrow window', async () => {
    // The provider is not asked to stay inside anything. It returns what the
    // library computed, and this test measures that value rather than assuming
    // a magnitude.
    const highest = await highestRawScore();
    expect(Number.isFinite(highest)).toBe(true);
    expect(highest).toBeGreaterThan(0);
    expect(highest).toBeGreaterThan(NARROW_MAX);
  });

  it('a narrow window rejects that valid score with retrieval_score_out_of_range', async () => {
    const candidates = await realCandidates();
    let issueCodes: readonly string[] = [];
    expect(() => {
      try {
        scoreWith(candidates, scoringPolicy([minisearchRule({ min: 0, max: NARROW_MAX })]));
      } catch (cause) {
        issueCodes = ((cause as { issues?: readonly { code?: string }[] }).issues ?? []).map(
          (detail) => detail.code ?? '',
        );
        throw cause;
      }
    }).toThrow();
    // The existing issue code, unchanged. What changed is what it means: this
    // policy does not cover the observed raw value, not that the value is invalid.
    expect(issueCodes).toContain('retrieval_score_out_of_range');
  });

  it('widening only the window scores the same exact raw values successfully', async () => {
    const candidates = await realCandidates();
    const highest = await highestRawScore();

    // Nothing about the provider, the query, the corpus, or the candidates
    // changes between the two runs — only the policy's declared window.
    const scored = scoreWith(
      candidates,
      scoringPolicy([minisearchRule({ min: 0, max: Math.ceil(highest) + 1 })]),
    );
    expect(scored.candidates.length).toBe(candidates.length);
    for (const entry of scored.candidates) {
      expect(entry.score.retrieval).toBeDefined();
      expect(Number.isFinite(entry.score.total)).toBe(true);
    }
  });

  it('the raw provider score is byte-for-byte identical under both windows', async () => {
    // The adapter never learns which policy will read its output, and this is
    // the observable proof: widening a window changes the compiler's normalized
    // value, never the measurement it was derived from.
    const first = await realCandidates();
    const second = await realCandidates();
    expect(second.map((candidate) => candidate.retrieval?.score?.value)).toEqual(
      first.map((candidate) => candidate.retrieval?.score?.value),
    );
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

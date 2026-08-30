import { readFileSync } from 'node:fs';
import {
  CandidateDeduplicator,
  CandidateScorer,
  CandidateScoringError,
  CandidateValidator,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  ONE_DAY,
  REFERENCE_TIME,
  candidate,
  deduplicateCandidates,
  issueCodesOf,
  policy,
  rule,
  score,
  scoredRetrieval,
  secondsBeforeReference,
  wordTokenizer,
} from './scoring-fixtures.js';
import { input } from './fixtures.js';

const rootUrl = new URL('../../', import.meta.url);
const SCORER_SOURCE = readFileSync(
  new URL('packages/compiler/src/candidate-scorer.ts', rootUrl),
  'utf8',
);

const TRACE_POLICY = policy({
  retrieval: { weight: 2, aggregation: 'max', rules: [rule()] },
  authoredPriority: { weight: 1, min: 0, max: 10 },
  sourcePriority: { weight: 1, defaultValue: 0.5, bySourceDocumentId: [] },
  categoryPriority: { weight: 1, defaultValue: 0.5, byCategory: [{ category: 'a', value: 1 }] },
  recency: { weight: 1, maxAgeSeconds: ONE_DAY, missingValue: 0 },
});

describe('CandidateScorer: required status is not a score', () => {
  it('INV-SCORE-003: a required candidate may score exactly zero', () => {
    const result = score(
      [candidate({ attributes: { required: true } })],
      policy({ retrieval: { weight: 5, aggregation: 'max', rules: [rule()] } }),
    );

    expect(result.candidates[0]?.candidate.canonicalBlock.attributes.required).toBe(true);
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('INV-SCORE-003: exposes no required component and no required boost', () => {
    const required = score(
      [candidate({ attributes: { required: true } }, scoredRetrieval(0.5))],
      policy({ retrieval: { weight: 1, aggregation: 'max', rules: [rule()] } }),
    );
    const optional = score(
      [candidate({ attributes: {} }, scoredRetrieval(0.5))],
      policy({ retrieval: { weight: 1, aggregation: 'max', rules: [rule()] } }),
    );

    expect(required.candidates[0]?.score).toEqual(optional.candidates[0]?.score);
    expect(Object.keys(required.candidates[0]?.score ?? {})).not.toContain('required');
    expect(required.candidates[0]?.score.total).toBe(0.5);
    expect(Number.isFinite(required.candidates[0]?.score.total)).toBe(true);
  });

  it('preserves the canonical required status Phase 8 established', () => {
    const result = score(
      [
        candidate({ id: 'block-1', attributes: {} }),
        candidate({ id: 'block-2', attributes: { required: true } }),
      ],
      TRACE_POLICY,
    );
    const group = result.candidates[0]?.candidate;

    expect(group?.canonicalBlock.id).toBe('block-2');
    expect(group?.canonicalBlock.attributes.required).toBe(true);
    expect(group?.canonicalSelectionReason).toBe('required-block');
  });
});

describe('CandidateScorer: trace readiness', () => {
  it('INV-TRACE-005: reports the policy identity and the reference time that produced the scores', () => {
    const result = score([candidate()], TRACE_POLICY);

    expect(result.policyId).toBe('baseline');
    expect(result.policyVersion).toBe('1.0.0');
    expect(result.referenceTime).toBe(REFERENCE_TIME);
  });

  it('INV-SCORE-001: exposes every component with its evidence, weight, and contribution', () => {
    const result = score(
      [
        candidate(
          {
            attributes: { priority: 10, category: 'a' },
            updatedAt: secondsBeforeReference(ONE_DAY / 2),
          },
          scoredRetrieval(0.5),
        ),
      ],
      TRACE_POLICY,
    );
    const candidateScore = result.candidates[0]?.score;

    for (const component of [
      candidateScore?.retrieval,
      candidateScore?.authoredPriority,
      candidateScore?.sourcePriority,
      candidateScore?.categoryPriority,
      candidateScore?.recency,
    ]) {
      expect(typeof component?.normalizedValue).toBe('number');
      expect(typeof component?.weight).toBe('number');
      expect(typeof component?.contribution).toBe('number');
      expect(component?.aggregation).toBe('max');
      expect(Array.isArray(component?.evidence)).toBe(true);
    }

    expect(candidateScore?.retrieval?.evidence[0]?.ruleId).toBe('cosine');
    expect(candidateScore?.retrieval?.evidence[0]?.rawValue).toBe(0.5);
    expect(candidateScore?.authoredPriority?.evidence[0]?.priority).toBe(10);
    expect(candidateScore?.sourcePriority?.evidence[0]?.sourceDocumentId).toBe('doc-1');
    expect(candidateScore?.categoryPriority?.evidence[0]?.category).toBe('a');
    expect(candidateScore?.recency?.evidence[0]?.ageSeconds).toBe(ONE_DAY / 2);
    expect(candidateScore?.total).toBe(1 + 1 + 0.5 + 1 + 0.5);
  });

  it('serializes to JSON without losing any decision data', () => {
    const result = score(
      [candidate({ attributes: { priority: 3 } }, scoredRetrieval(0.4))],
      TRACE_POLICY,
    );
    expect(JSON.parse(JSON.stringify(result)) as unknown).toEqual(result);
  });
});

describe('CandidateScorer: no filtering and no allocation', () => {
  it('INV-TRACE-001: returns exactly one scored entry per deduplicated group', () => {
    const candidates = [
      candidate({ id: 'block-1', content: 'One.' }),
      candidate({ id: 'block-2', content: 'Two.' }),
      candidate({ id: 'block-3', content: 'Two.' }),
      candidate({ id: 'block-4', content: 'Four.' }),
    ];
    const batch = deduplicateCandidates(candidates);
    const result = new CandidateScorer(TRACE_POLICY).score(batch, REFERENCE_TIME);

    expect(result.candidates).toHaveLength(batch.candidates.length);
    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id).sort()).toEqual(
      batch.candidates.map((group) => group.canonicalBlock.id).sort(),
    );
  });

  it('INV-ALLOC-002: keeps every zero-scoring and weakly scoring candidate', () => {
    const result = score(
      [
        candidate({ id: 'block-1', content: 'Nothing configured about me.' }),
        candidate({ id: 'block-2', content: 'Very weak match.' }, scoredRetrieval(0)),
        candidate({
          id: 'block-3',
          content: 'Old and uncategorized.',
          updatedAt: '2000-01-01T00:00:00.000Z',
        }),
      ],
      TRACE_POLICY,
    );

    // No threshold, no minimum score, and no staleness rule removes any of them.
    expect(result.candidates.map((entry) => entry.candidate.canonicalBlock.id).sort()).toEqual([
      'block-1',
      'block-2',
      'block-3',
    ]);
    expect(result.candidates.every((entry) => Number.isFinite(entry.score.total))).toBe(true);
  });

  it('keeps a candidate whose every signal resolves to zero', () => {
    const result = score(
      [candidate({}, scoredRetrieval(0))],
      policy({
        retrieval: { weight: 1, aggregation: 'max', rules: [rule()] },
        recency: { weight: 1, maxAgeSeconds: ONE_DAY, missingValue: 0 },
      }),
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('reads no token budget and computes no score per token', () => {
    const short = score([candidate({ content: 'Tiny.' })], TRACE_POLICY);
    const long = score(
      [candidate({ content: 'A much longer block of content with many more words in it.' })],
      TRACE_POLICY,
    );

    expect(long.candidates[0]?.score.total).toBe(short.candidates[0]?.score.total);
    expect(SCORER_SOURCE).not.toContain('tokenCount');
    expect(SCORER_SOURCE).not.toContain('TokenBudget');
    expect(SCORER_SOURCE).not.toContain('availableInputTokens');
  });

  it('returns no inclusion or exclusion decision', () => {
    const result = score([candidate()], TRACE_POLICY);
    const serialized = JSON.stringify(result);

    for (const term of ['"included"', '"excluded"', '"evicted"', '"decision"', '"rejected"']) {
      expect(serialized, term).not.toContain(term);
    }
  });
});

describe('CandidateScorer: hidden inputs', () => {
  it('INV-DET-003, INV-DET-004: reads no clock, randomness, environment, or external system', () => {
    for (const forbidden of [
      'Date.now',
      'new Date(',
      'Math.random',
      'randomUUID',
      'crypto',
      'process.env',
      'hostname',
      'node:',
      'fetch(',
      'require(',
      'countTokens',
    ]) {
      expect(SCORER_SOURCE, forbidden).not.toContain(forbidden);
    }
    // `Date.UTC` is transient arithmetic over an explicitly supplied timestamp.
    expect(SCORER_SOURCE).toContain('Date.UTC(');
  });

  it('imports only the domain, the validation library, and its own modules', () => {
    const specifiers = [...SCORER_SOURCE.matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );
    for (const specifier of specifiers) {
      expect(
        specifier.startsWith('./') || specifier === '@ctxalloc/domain' || specifier === 'zod',
        specifier,
      ).toBe(true);
    }
  });

  it('takes no tokenizer, provider, clock, or storage dependency', () => {
    expect(() => new CandidateScorer(policy())).not.toThrow();
    expect(new CandidateScorer(policy())).toBeInstanceOf(CandidateScorer);
  });

  it('INV-ALLOC-004: mutates neither the supplied batch nor its records', () => {
    const batch = deduplicateCandidates([
      candidate({ attributes: { priority: 5, category: 'a' } }, scoredRetrieval(0.5)),
    ]);
    const snapshot = JSON.stringify(batch);

    new CandidateScorer(TRACE_POLICY).score(batch, REFERENCE_TIME);

    expect(JSON.stringify(batch)).toBe(snapshot);
  });

  it('reuses the validated records by reference rather than rewriting them', () => {
    const batch = deduplicateCandidates([candidate()]);
    const result = new CandidateScorer(policy()).score(batch, REFERENCE_TIME);

    expect(result.scope).toBe(batch.scope);
    expect(result.candidates[0]?.candidate).toBe(batch.candidates[0]);
  });
});

describe('CandidateScorer: earlier stages are unchanged', () => {
  it('CandidateValidator still returns a batch that carries no score', () => {
    const validated = new CandidateValidator(wordTokenizer).validate(input());
    const serialized = JSON.stringify(validated);

    expect(serialized).not.toContain('normalizedValue');
    expect(serialized).not.toContain('contribution');
    expect(serialized).not.toContain('"total"');
  });

  it('CandidateDeduplicator still returns groups that carry no score', () => {
    const validated = new CandidateValidator(wordTokenizer).validate(input());
    const deduplicated = new CandidateDeduplicator().deduplicate(validated);
    const serialized = JSON.stringify(deduplicated);

    expect(serialized).not.toContain('normalizedValue');
    expect(serialized).not.toContain('policyId');
    expect(Object.keys(deduplicated).sort()).toEqual(['candidates', 'scope', 'sourceDocuments']);
  });

  it('collects every scoring problem in the batch before failing', () => {
    const codes = issueCodesOf(() =>
      score(
        [
          candidate(
            { id: 'block-1', content: 'One.', attributes: { priority: 99 } },
            scoredRetrieval(5),
          ),
          candidate({ id: 'block-2', content: 'Two.', attributes: { priority: -99 } }),
        ],
        policy({
          retrieval: { weight: 1, aggregation: 'max', rules: [rule()] },
          authoredPriority: { weight: 1, min: 0, max: 10 },
        }),
      ),
    );

    expect([...codes].sort()).toEqual([
      'authored_priority_out_of_range',
      'authored_priority_out_of_range',
      'retrieval_score_out_of_range',
    ]);
  });

  it('returns no partial result when scoring fails', () => {
    let thrown: unknown;
    try {
      score(
        [
          candidate({ id: 'block-1', content: 'Fine.' }),
          candidate({ id: 'block-2', content: 'Broken.' }, scoredRetrieval(9)),
        ],
        policy({ retrieval: { weight: 1, aggregation: 'max', rules: [rule()] } }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CandidateScoringError);
    expect((thrown as CandidateScoringError).code).toBe('CANDIDATE_SCORING_FAILED');
    expect(thrown).not.toHaveProperty('candidates');
  });
});

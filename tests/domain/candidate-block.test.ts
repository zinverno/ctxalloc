import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_BLOCK_SCHEMA_VERSION,
  CandidateBlockSchema,
  ContextBlockSchema,
  safeParse,
} from '../../packages/domain/src/index.js';
import { validContextBlock } from './fixtures.js';

/**
 * The request-specific candidate wrapper (DEC-026, DEC-030).
 *
 * Fixtures are deliberately untyped input: the schema accepts `unknown`, so these
 * tests exercise the same path that real retrieval, HTTP, and persisted input
 * will take (INV-BLOCK-005).
 */

function validCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, block: validContextBlock(), ...overrides };
}

function validRetrieval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { providerId: 'sqlite-fts5', providerVersion: '1.2.3', ...overrides };
}

function parse(input: unknown): ReturnType<typeof safeParse<unknown>> {
  return safeParse(CandidateBlockSchema, input) as ReturnType<typeof safeParse<unknown>>;
}

function expectAccepted(input: unknown): Record<string, unknown> {
  const result = parse(input);
  expect(result.ok, JSON.stringify(result.ok ? null : result.issues)).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value as Record<string, unknown>;
}

function expectRejected(input: unknown): readonly { readonly pointer: string }[] {
  const result = parse(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('unreachable');
  return result.issues;
}

describe('CandidateBlockSchema: accepted shapes', () => {
  it('publishes schema version 1', () => {
    expect(CANDIDATE_BLOCK_SCHEMA_VERSION).toBe(1);
  });

  it('accepts a minimal direct candidate with no retrieval data', () => {
    const value = expectAccepted(validCandidate());
    expect(value['schemaVersion']).toBe(1);
    expect(value['block']).toBeDefined();
  });

  it('accepts a candidate with complete retrieval data', () => {
    const value = expectAccepted(
      validCandidate({
        retrieval: validRetrieval({
          rank: 3,
          score: { value: 0.84, semantics: 'cosine-similarity', higherIsBetter: true },
          metadata: { providerRowId: 'row-17', shard: 2 },
        }),
      }),
    );
    expect(value['retrieval']).toEqual({
      providerId: 'sqlite-fts5',
      providerVersion: '1.2.3',
      rank: 3,
      score: { value: 0.84, semantics: 'cosine-similarity', higherIsBetter: true },
      metadata: { providerRowId: 'row-17', shard: 2 },
    });
  });

  it('keeps an absent retrieval absent rather than injecting a default', () => {
    const value = expectAccepted(validCandidate());
    expect('retrieval' in value).toBe(false);
  });

  it('keeps absent rank, score, and metadata absent', () => {
    const value = expectAccepted(validCandidate({ retrieval: validRetrieval() }));
    const retrieval = value['retrieval'] as Record<string, unknown>;
    expect(Object.keys(retrieval).sort()).toEqual(['providerId', 'providerVersion']);
  });

  it('accepts retrieval with only a rank', () => {
    expectAccepted(validCandidate({ retrieval: validRetrieval({ rank: 0 }) }));
  });

  it('accepts retrieval with only a score', () => {
    expectAccepted(
      validCandidate({
        retrieval: validRetrieval({
          score: { value: -3.5, semantics: 'distance', higherIsBetter: false },
        }),
      }),
    );
  });

  it('accepts an empty retrieval metadata object', () => {
    const value = expectAccepted(validCandidate({ retrieval: validRetrieval({ metadata: {} }) }));
    expect((value['retrieval'] as Record<string, unknown>)['metadata']).toEqual({});
  });
});

describe('CandidateBlockSchema: rejected shapes', () => {
  it('rejects an unknown candidate field', () => {
    expect(expectRejected(validCandidate({ finalScore: 1 }))[0]?.pointer).toBe('');
  });

  it('rejects an unknown retrieval field', () => {
    expectRejected(validCandidate({ retrieval: validRetrieval({ normalizedScore: 0.5 }) }));
  });

  it('rejects an unknown score field', () => {
    expectRejected(
      validCandidate({
        retrieval: validRetrieval({
          score: { value: 1, semantics: 'bm25-score', higherIsBetter: true, weight: 2 },
        }),
      }),
    );
  });

  it('rejects a missing schemaVersion', () => {
    const candidate = validCandidate();
    delete candidate['schemaVersion'];
    expect(expectRejected(candidate)[0]?.pointer).toBe('schemaVersion');
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(expectRejected(validCandidate({ schemaVersion: 2 }))[0]?.pointer).toBe('schemaVersion');
  });

  it('rejects a missing block', () => {
    const candidate = validCandidate();
    delete candidate['block'];
    expect(expectRejected(candidate)[0]?.pointer).toBe('block');
  });

  it('rejects a block that is not a valid ContextBlock', () => {
    const block = validContextBlock();
    block['tokenCount'] = -1;
    expect(expectRejected(validCandidate({ block }))[0]?.pointer).toBe('block.tokenCount');
  });

  it('rejects null and non-object candidates', () => {
    for (const input of [null, undefined, 'candidate', 7, [], true]) {
      expect(parse(input).ok, `accepted ${JSON.stringify(input) ?? 'undefined'}`).toBe(false);
    }
  });
});

describe('INV-SCORE-002: provider identity strings are validated, never rewritten', () => {
  it.each([
    ['providerId', ''],
    ['providerId', '   '],
    ['providerId', '\t\n'],
    ['providerVersion', ''],
    ['providerVersion', '  '],
  ])('rejects a blank %s', (field, value) => {
    const issues = expectRejected(
      validCandidate({ retrieval: validRetrieval({ [field]: value }) }),
    );
    expect(issues[0]?.pointer).toBe(`retrieval.${field}`);
  });

  it('rejects blank score semantics', () => {
    const issues = expectRejected(
      validCandidate({
        retrieval: validRetrieval({ score: { value: 1, semantics: '  ', higherIsBetter: true } }),
      }),
    );
    expect(issues[0]?.pointer).toBe('retrieval.score.semantics');
  });

  it('preserves the exact supplied strings without trimming or lowercasing', () => {
    const value = expectAccepted(
      validCandidate({
        retrieval: {
          providerId: '  QMD-Provider  ',
          providerVersion: ' v2.0.0-RC1 ',
          score: { value: 1, semantics: ' Cosine-Similarity ', higherIsBetter: true },
        },
      }),
    );
    const retrieval = value['retrieval'] as Record<string, unknown>;
    expect(retrieval['providerId']).toBe('  QMD-Provider  ');
    expect(retrieval['providerVersion']).toBe(' v2.0.0-RC1 ');
    expect((retrieval['score'] as Record<string, unknown>)['semantics']).toBe(
      ' Cosine-Similarity ',
    );
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 in a provider string', () => {
    for (const field of ['providerId', 'providerVersion']) {
      const issues = expectRejected(
        validCandidate({ retrieval: validRetrieval({ [field]: `p\uD800rovider` }) }),
      );
      expect(issues[0]?.pointer).toBe(`retrieval.${field}`);
    }
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 in score semantics', () => {
    expectRejected(
      validCandidate({
        retrieval: validRetrieval({
          score: { value: 1, semantics: 'cos\uDC00ine', higherIsBetter: true },
        }),
      }),
    );
  });

  it('rejects a non-string provider identity', () => {
    for (const value of [1, null, true, {}, []]) {
      expectRejected(validCandidate({ retrieval: validRetrieval({ providerId: value }) }));
    }
  });

  it('rejects retrieval without providerId or providerVersion', () => {
    expectRejected(validCandidate({ retrieval: { providerVersion: '1' } }));
    expectRejected(validCandidate({ retrieval: { providerId: 'p' } }));
  });
});

describe('retrieval rank is provider input, not canonical ordering', () => {
  it('accepts rank zero, because providers differ between zero- and one-based ranks', () => {
    const value = expectAccepted(validCandidate({ retrieval: validRetrieval({ rank: 0 }) }));
    expect((value['retrieval'] as Record<string, unknown>)['rank']).toBe(0);
  });

  it('accepts a positive rank', () => {
    expectAccepted(validCandidate({ retrieval: validRetrieval({ rank: 42 }) }));
  });

  it('accepts the largest safe integer rank', () => {
    expectAccepted(
      validCandidate({ retrieval: validRetrieval({ rank: Number.MAX_SAFE_INTEGER }) }),
    );
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 2],
    ['numeric string', '3'],
  ])('rejects a %s rank', (_label, rank) => {
    const issues = expectRejected(validCandidate({ retrieval: validRetrieval({ rank }) }));
    expect(issues[0]?.pointer).toBe('retrieval.rank');
  });
});

describe('INV-SCORE-004: retrieval score values are validated but never normalized', () => {
  function withScore(score: unknown): Record<string, unknown> {
    return validCandidate({ retrieval: validRetrieval({ score }) });
  }

  it('accepts a finite positive score', () => {
    const value = expectAccepted(
      withScore({ value: 0.9312, semantics: 'cosine-similarity', higherIsBetter: true }),
    );
    const score = (value['retrieval'] as Record<string, unknown>)['score'] as Record<
      string,
      unknown
    >;
    expect(score['value']).toBe(0.9312);
  });

  it('accepts a zero score', () => {
    expectAccepted(withScore({ value: 0, semantics: 'bm25-score', higherIsBetter: true }));
  });

  it('accepts a negative score, because the provider scale is not normalized here', () => {
    const value = expectAccepted(
      withScore({ value: -12.75, semantics: 'distance', higherIsBetter: false }),
    );
    const score = (value['retrieval'] as Record<string, unknown>)['score'] as Record<
      string,
      unknown
    >;
    expect(score['value']).toBe(-12.75);
    expect(score['higherIsBetter']).toBe(false);
  });

  it('accepts a score far outside a zero-to-one range', () => {
    expectAccepted(withScore({ value: 91234.5, semantics: 'bm25-score', higherIsBetter: true }));
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects a %s score value', (_label, value) => {
    const issues = expectRejected(
      withScore({ value, semantics: 'cosine-similarity', higherIsBetter: true }),
    );
    expect(issues[0]?.pointer).toBe('retrieval.score.value');
  });

  it('rejects a numeric-string score value', () => {
    expectRejected(withScore({ value: '0.9', semantics: 'cosine', higherIsBetter: true }));
  });

  it('requires higherIsBetter when a score exists', () => {
    const issues = expectRejected(withScore({ value: 1, semantics: 'cosine-similarity' }));
    expect(issues[0]?.pointer).toBe('retrieval.score.higherIsBetter');
  });

  it('requires semantics when a score exists', () => {
    const issues = expectRejected(withScore({ value: 1, higherIsBetter: true }));
    expect(issues[0]?.pointer).toBe('retrieval.score.semantics');
  });

  it('rejects a non-boolean higherIsBetter', () => {
    expectRejected(withScore({ value: 1, semantics: 'cosine', higherIsBetter: 'yes' }));
  });

  it('carries provider-defined metric names without interpreting them', () => {
    for (const semantics of ['cosine-similarity', 'bm25-score', 'distance', 'l2', 'rrf']) {
      expectAccepted(withScore({ value: 1, semantics, higherIsBetter: true }));
    }
  });
});

describe('DEC-026: the wrapper never writes query-dependent data into the block', () => {
  it('leaves the wrapped block byte-identical to the supplied ContextBlock', () => {
    const block = validContextBlock();
    const value = expectAccepted(
      validCandidate({
        block,
        retrieval: validRetrieval({
          rank: 1,
          score: { value: 0.5, semantics: 'cosine-similarity', higherIsBetter: true },
        }),
      }),
    );
    const parsedBlock = safeParse(ContextBlockSchema, block);
    expect(parsedBlock.ok).toBe(true);
    if (parsedBlock.ok) expect(value['block']).toEqual(parsedBlock.value);
  });

  it('does not copy retrieval values onto the block', () => {
    const value = expectAccepted(
      validCandidate({
        retrieval: validRetrieval({
          rank: 1,
          score: { value: 0.5, semantics: 'cosine-similarity', higherIsBetter: true },
          metadata: { providerRowId: 'row-17' },
        }),
      }),
    );
    const block = value['block'] as Record<string, unknown>;
    for (const field of ['retrieval', 'rank', 'score', 'providerId', 'providerVersion']) {
      expect(field in block, `block carries ${field}`).toBe(false);
    }
    expect(block['metadata']).toEqual({ path: 'notes/architecture.md' });
  });

  it('has no candidate identifier of its own', () => {
    const value = expectAccepted(validCandidate());
    expect('id' in value).toBe(false);
    expect('candidateId' in value).toBe(false);
    expect((value['block'] as Record<string, unknown>)['id']).toBe('block-1');
  });

  it('carries no computed score, allocation decision, trace decision, or rendered text', () => {
    for (const field of [
      'relevanceScore',
      'normalizedRelevance',
      'recencyScore',
      'redundancyScore',
      'utilityScore',
      'finalScore',
      'decision',
      'included',
      'renderedText',
    ]) {
      expectRejected(validCandidate({ [field]: 1 }));
    }
  });

  it('keeps computed scores rejected on the wrapped ContextBlock too', () => {
    for (const field of ['relevanceScore', 'recencyScore', 'utilityScore']) {
      const block = validContextBlock();
      block[field] = 0.5;
      expectRejected(validCandidate({ block }));

      const attributes = validContextBlock();
      attributes['attributes'] = { required: true, [field]: 0.5 };
      expectRejected(validCandidate({ block: attributes }));
    }
  });
});

describe('INV-DET-002: candidate validation does not depend on property order', () => {
  it('accepts a reordered candidate object identically', () => {
    const ordered = validCandidate({ retrieval: validRetrieval({ rank: 2 }) });
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());
    expect(expectAccepted(reversed)).toEqual(expectAccepted(ordered));
  });

  it('accepts a reordered retrieval object identically', () => {
    const retrieval = validRetrieval({
      rank: 2,
      score: { value: 1, semantics: 'cosine-similarity', higherIsBetter: true },
    });
    const reversed = Object.fromEntries(Object.entries(retrieval).reverse());
    expect(expectAccepted(validCandidate({ retrieval: reversed }))).toEqual(
      expectAccepted(validCandidate({ retrieval })),
    );
  });

  it('returns a deep-equal value for repeated parses', () => {
    const input = validCandidate({ retrieval: validRetrieval({ rank: 1 }) });
    expect(expectAccepted(input)).toEqual(expectAccepted(input));
  });

  it('does not mutate the supplied input', () => {
    const input = validCandidate({ retrieval: validRetrieval({ rank: 1, metadata: { a: 1 } }) });
    const before = JSON.stringify(input);
    expectAccepted(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

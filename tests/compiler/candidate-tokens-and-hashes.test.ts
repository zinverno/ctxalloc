import { CandidateValidationError, CandidateValidator } from '@ctxalloc/compiler';
import { FakeTokenizer } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import { calculateNormalizedContentHash } from '../../packages/domain/src/index.js';
import {
  DEFAULT_CONTENT,
  ExplodingTokenizerError,
  SCOPE,
  SOURCE_CONTENT_HASH,
  brokenTokenizer,
  candidate,
  countWords,
  countingTokenizer,
  explodingTokenizer,
  input,
  retrieval,
  sourceDocument,
  wordTokenizer,
} from './fixtures.js';

/**
 * Exact token-count and normalized-content-hash recomputation (DEC-030).
 *
 * A mismatch rejects the batch. Nothing is rewritten, estimated, or accepted with
 * a warning (INV-BLOCK-003).
 */

const validator = new CandidateValidator(wordTokenizer);

function rejectedBy(usedValidator: CandidateValidator, batch: unknown): CandidateValidationError {
  try {
    usedValidator.validate(batch);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateValidationError);
    return error as CandidateValidationError;
  }
  throw new Error('expected CandidateValidator to reject the batch');
}

function expectRejected(batch: unknown): CandidateValidationError {
  return rejectedBy(validator, batch);
}

function codes(error: CandidateValidationError): string[] {
  return error.issues.map((issue) => issue.code);
}

/* -------------------------------------------------------------------------- */

describe('INV-BLOCK-003: the stored token count must equal the recomputed count', () => {
  it('accepts an exact stored count', () => {
    expect(() => validator.validate(input())).not.toThrow();
  });

  it('accepts an exact count from a FakeTokenizer configured for the content', () => {
    const tokenizer = new FakeTokenizer([{ text: DEFAULT_CONTENT, tokens: 11 }]);
    const strict = new CandidateValidator(tokenizer);
    expect(() =>
      strict.validate(input({ candidates: [candidate({ tokenCount: 11 })] })),
    ).not.toThrow();
  });

  it('rejects a stale low count', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ tokenCount: countWords(DEFAULT_CONTENT) - 1 })] }),
    );
    expect(error.issues[0]?.code).toBe('invalid_token_count');
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.tokenCount');
  });

  it('rejects a stale high count', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ tokenCount: countWords(DEFAULT_CONTENT) + 1000 })] }),
    );
    expect(codes(error)).toEqual(['invalid_token_count']);
  });

  it('rejects a zero count for non-empty content', () => {
    expect(codes(expectRejected(input({ candidates: [candidate({ tokenCount: 0 })] })))).toEqual([
      'invalid_token_count',
    ]);
  });

  it('does not rewrite the stored count in the returned batch', () => {
    const result = validator.validate(input());
    expect(result.candidates[0]?.block.tokenCount).toBe(countWords(DEFAULT_CONTENT));
  });

  it('names the tokenizer identity and both counts in the message', () => {
    const error = expectRejected(input({ candidates: [candidate({ tokenCount: 99 })] }));
    expect(error.issues[0]?.message).toContain('"test:word"');
    expect(error.issues[0]?.message).toContain('99');
  });

  it('does not count headingPath, metadata, or any wrapper', () => {
    // The count describes `block.content` only. Adding a long heading path and
    // heavy metadata must not change the accepted count (INV-BUDGET-002).
    const calls: string[] = [];
    const observed = new CandidateValidator(countingTokenizer(calls));
    observed.validate(
      input({
        candidates: [
          candidate(
            {
              headingPath: ['A very long heading', 'And another long one'],
              metadata: { note: 'many extra words that must not be counted at all' },
            },
            retrieval({ metadata: { blob: 'more uncounted words here' } }),
          ),
        ],
      }),
    );
    expect(calls).toEqual([DEFAULT_CONTENT]);
  });

  it('uses no character or word-length fallback when the tokenizer fails', () => {
    const failing = new CandidateValidator(explodingTokenizer);
    const error = rejectedBy(failing, input());
    expect(codes(error)).toEqual(['tokenizer_failed']);
  });
});

describe('INV-ADAPTER-003: a tokenizer failure becomes a project-owned issue', () => {
  it('wraps a thrown tokenizer error with candidate context', () => {
    const failing = new CandidateValidator(explodingTokenizer);
    const error = rejectedBy(failing, input());
    expect(error).toBeInstanceOf(CandidateValidationError);
    expect(error).not.toBeInstanceOf(ExplodingTokenizerError);
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.content');
    expect(error.issues[0]?.message).toContain('test:exploding');
  });

  it('does not let the external error class escape', () => {
    const failing = new CandidateValidator(explodingTokenizer);
    const error = rejectedBy(failing, input());
    expect(error.constructor.name).toBe('CandidateValidationError');
    expect(JSON.stringify(error.issues)).not.toContain('internal encoder state');
  });

  it('wraps a thrown non-Error value', () => {
    const weird = new CandidateValidator({
      id: 'test:weird',
      version: '1',
      countTokens: (): number => {
        throw 'a string';
      },
    });
    expect(rejectedBy(weird, input()).issues[0]?.message).toContain('non-Error');
  });

  it('reports a FakeTokenizer unknown-text failure as a project-owned issue', () => {
    const empty = new CandidateValidator(new FakeTokenizer([]));
    const error = rejectedBy(empty, input());
    expect(codes(error)).toEqual(['tokenizer_failed']);
    expect(error.constructor.name).toBe('CandidateValidationError');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['a negative count', -1],
    ['a fractional count', 2.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ['a numeric string', '5'],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s returned by the tokenizer', (_label, value) => {
    const broken = new CandidateValidator(brokenTokenizer(value));
    const error = rejectedBy(broken, input());
    expect(codes(error)).toEqual(['tokenizer_failed']);
    expect(error.issues[0]?.message).toContain('non-negative safe integer');
  });

  it('accepts a zero count returned for genuinely zero-token content', () => {
    const zero = new CandidateValidator(brokenTokenizer(0));
    expect(() =>
      zero.validate(input({ candidates: [candidate({ tokenCount: 0 })] })),
    ).not.toThrow();
  });
});

describe('INV-DET-001: repeated identical blocks produce one validation result', () => {
  it('counts identical content once but validates every wrapper', () => {
    const calls: string[] = [];
    const observed = new CandidateValidator(countingTokenizer(calls));
    const result = observed.validate(
      input({ candidates: [candidate(), candidate(), candidate()] }),
    );
    expect(result.candidates).toHaveLength(3);
    expect(calls).toEqual([DEFAULT_CONTENT]);
  });

  it('gives the same result whether or not identical wrappers repeat', () => {
    const once = validator.validate(input());
    const thrice = validator.validate(
      input({ candidates: [candidate(), candidate(), candidate()] }),
    );
    expect(thrice.candidates[0]).toEqual(once.candidates[0]);
    expect(thrice.candidates[1]).toEqual(once.candidates[0]);
    expect(thrice.candidates[2]).toEqual(once.candidates[0]);
  });

  it('reports one issue per wrapper when repeated identical blocks are stale', () => {
    const stale = candidate({ tokenCount: 99 });
    const error = expectRejected(input({ candidates: [stale, stale, stale] }));
    expect(codes(error)).toEqual([
      'invalid_token_count',
      'invalid_token_count',
      'invalid_token_count',
    ]);
    expect(error.issues.map((issue) => issue.pointer)).toEqual([
      'candidates[0].block.tokenCount',
      'candidates[1].block.tokenCount',
      'candidates[2].block.tokenCount',
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe('INV-PROV-005: the normalized content hash is recomputed, never trusted', () => {
  it('accepts a candidate whose hash matches the canonical rule', () => {
    expect(() => validator.validate(input())).not.toThrow();
  });

  it('rejects a mismatched hash', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ normalizedContentHash: `sha256:${'b'.repeat(64)}` })] }),
    );
    expect(error.issues[0]?.code).toBe('invalid_normalized_content_hash');
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.normalizedContentHash');
  });

  it('rejects a hash that belongs to different content', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({
            content: 'One body.',
            normalizedContentHash: calculateNormalizedContentHash('Another body.'),
          }),
        ],
      }),
    );
    expect(error.issues[0]?.code).toBe('invalid_normalized_content_hash');
  });

  it('does not silently rewrite the stored hash', () => {
    const supplied = calculateNormalizedContentHash(DEFAULT_CONTENT);
    const result = validator.validate(input());
    expect(result.candidates[0]?.block.normalizedContentHash).toBe(supplied);
  });

  it('accepts CRLF content carrying the shared normalized hash', () => {
    const crlf = 'First line.\r\nSecond line.\r\n';
    const lf = 'First line.\nSecond line.\n';
    expect(calculateNormalizedContentHash(crlf)).toBe(calculateNormalizedContentHash(lf));
    expect(() =>
      validator.validate(
        input({
          candidates: [
            candidate({
              content: crlf,
              normalizedContentHash: calculateNormalizedContentHash(lf),
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts lone-CR content carrying the shared normalized hash', () => {
    const cr = 'First line.\rSecond line.\r';
    expect(() =>
      validator.validate(
        input({
          candidates: [
            candidate({
              content: cr,
              normalizedContentHash: calculateNormalizedContentHash('First line.\nSecond line.\n'),
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('does not confuse SourceDocument.contentHash with block normalizedContentHash', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ contentHash: SOURCE_CONTENT_HASH })],
        candidates: [candidate({ normalizedContentHash: SOURCE_CONTENT_HASH })],
      }),
    );
    expect(error.issues[0]?.code).toBe('invalid_normalized_content_hash');
  });

  it('applies the same rule to every source type, not only Markdown', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ sourceType: 'conversation' })],
        candidates: [
          candidate({
            sourceType: 'conversation',
            sourceLocation: { kind: 'conversation-message', messageId: 'msg-1' },
            normalizedContentHash: `sha256:${'c'.repeat(64)}`,
          }),
        ],
      }),
    );
    expect(error.issues[0]?.code).toBe('invalid_normalized_content_hash');
  });

  it('INV-BLOCK-007: rejects content that is not well-formed UTF-16', () => {
    const content = `broken \uD800 content`;
    const error = expectRejected(
      input({
        candidates: [
          candidate({ content, normalizedContentHash: `sha256:${'d'.repeat(64)}`, tokenCount: 3 }),
        ],
      }),
    );
    expect(codes(error)).toEqual(['invalid_unicode']);
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.content');
  });

  it('INV-BLOCK-007: does not report derived hash or count issues for malformed content', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({
            content: `a\uDC00b`,
            normalizedContentHash: `sha256:${'e'.repeat(64)}`,
            tokenCount: 999,
          }),
        ],
      }),
    );
    expect(codes(error)).toEqual(['invalid_unicode']);
  });

  it('accepts supplementary characters in block content', () => {
    const content = 'Emoji \u{1F600} and \u{10437} here.';
    expect(() => validator.validate(input({ candidates: [candidate({ content })] }))).not.toThrow();
  });
});

describe('the batch is all or nothing', () => {
  it('returns no partial result when one candidate is invalid', () => {
    const batch = input({
      candidates: [candidate(), candidate({ id: 'block-2', content: 'X.', tokenCount: 99 })],
    });
    expect(() => validator.validate(batch)).toThrow(CandidateValidationError);
  });

  it('collects issues from several stages before failing', () => {
    const error = expectRejected({
      scope: { ...SCOPE },
      sourceDocuments: [sourceDocument(), sourceDocument()],
      candidates: [
        candidate({ tokenCount: 99 }),
        candidate({ id: 'block-2', content: 'Second body.', sourceDocumentId: 'doc-missing' }),
        candidate({
          id: 'block-3',
          content: 'Third body.',
          normalizedContentHash: `sha256:${'0'.repeat(64)}`,
        }),
      ],
    });
    expect(codes(error)).toEqual([
      'duplicate_source_document_id',
      'invalid_token_count',
      'source_not_found',
      'invalid_normalized_content_hash',
    ]);
  });

  it('reports both the hash and the count problem for one candidate', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({ normalizedContentHash: `sha256:${'1'.repeat(64)}`, tokenCount: 42 }),
        ],
      }),
    );
    expect(codes(error)).toEqual(['invalid_normalized_content_hash', 'invalid_token_count']);
  });
});

import { CandidateValidationError, CandidateValidator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  contextBlock,
  input,
  retrieval,
  sourceDocument,
  wordTokenizer,
} from './fixtures.js';

/**
 * Identifier conflicts and priority validation (DEC-030).
 *
 * Equivalent repeated block IDs pass through to the deduplication phase. One ID
 * standing for two different records is rejected (INV-BLOCK-002, INV-DEDUP-001).
 */

const validator = new CandidateValidator(wordTokenizer);

function expectRejected(batch: unknown): CandidateValidationError {
  try {
    validator.validate(batch);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateValidationError);
    return error as CandidateValidationError;
  }
  throw new Error('expected CandidateValidator to reject the batch');
}

function codes(error: CandidateValidationError): string[] {
  return error.issues.map((issue) => issue.code);
}

/* -------------------------------------------------------------------------- */

describe('INV-BLOCK-002: one block ID must stand for one canonical record', () => {
  it('accepts candidates with unique block IDs', () => {
    const result = validator.validate(
      input({
        candidates: [
          candidate(),
          candidate({ id: 'block-2', content: 'Second body here.' }),
          candidate({ id: 'block-3', content: 'Third body here now.' }),
        ],
      }),
    );
    expect(result.candidates).toHaveLength(3);
  });

  it('INV-DEDUP-001: accepts an identical canonical block repeated under the same ID', () => {
    const result = validator.validate(input({ candidates: [candidate(), candidate()] }));
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.block).toEqual(result.candidates[1]?.block);
  });

  it('INV-DEDUP-001: accepts the same block with different retrieval metadata', () => {
    const result = validator.validate(
      input({
        candidates: [
          candidate({}, retrieval({ providerId: 'provider-a', rank: 0 })),
          candidate({}, retrieval({ providerId: 'provider-b', rank: 7 })),
        ],
      }),
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.retrieval?.providerId).toBe('provider-a');
    expect(result.candidates[1]?.retrieval?.providerId).toBe('provider-b');
  });

  it('accepts the same block once with retrieval and once without', () => {
    const result = validator.validate(
      input({ candidates: [candidate(), candidate({}, retrieval())] }),
    );
    expect(result.candidates).toHaveLength(2);
  });

  it('rejects one ID attached to different content', () => {
    const error = expectRejected(
      input({ candidates: [candidate(), candidate({ content: 'Different body entirely.' })] }),
    );
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('rejects one ID attached to a different normalized hash', () => {
    // The hash is changed alone, so the content still matches its own hash for
    // neither record; the conflict is what this test pins.
    const first = candidate();
    const second = candidate();
    (second['block'] as Record<string, unknown>)['normalizedContentHash'] =
      `sha256:${'9'.repeat(64)}`;
    const error = expectRejected(input({ candidates: [first, second] }));
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('rejects one ID attached to a different source reference', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument(), sourceDocument({ id: 'doc-2' })],
        candidates: [candidate(), candidate({ sourceDocumentId: 'doc-2' })],
      }),
    );
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('rejects one ID attached to different attributes', () => {
    const error = expectRejected(
      input({ candidates: [candidate(), candidate({ attributes: { required: true } })] }),
    );
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('rejects one ID attached to a different token count', () => {
    // Both records must otherwise be valid, so the differing count is supplied
    // through content that genuinely costs a different number of tokens.
    const error = expectRejected(
      input({
        candidates: [
          candidate({ content: 'Two words.' }),
          candidate({ content: 'Three whole words.' }),
        ],
      }),
    );
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('names the block ID and every participating index', () => {
    const error = expectRejected(
      input({
        candidates: [candidate(), candidate({ content: 'Different body entirely.' }), candidate()],
      }),
    );
    const conflict = error.issues.find((issue) => issue.code === 'conflicting_block_id');
    expect(conflict?.message).toContain('"block-1"');
    expect(conflict?.message).toContain('0, 1, 2');
    expect(conflict?.pointer).toBe('candidates[0].block.id');
  });

  it('reports one issue per conflicting ID', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate(),
          candidate({ content: 'Different body entirely.' }),
          candidate({ id: 'block-2', content: 'Alpha body.' }),
          candidate({ id: 'block-2', content: 'Beta body instead.' }),
        ],
      }),
    );
    expect(error.issues.filter((issue) => issue.code === 'conflicting_block_id')).toHaveLength(2);
  });

  it('INV-DET-002: property insertion order alone does not create a false conflict', () => {
    const ordered = contextBlock();
    const reversed = Object.fromEntries(Object.entries(ordered).reverse());
    expect(() =>
      validator.validate(
        input({
          candidates: [
            { schemaVersion: 1, block: ordered },
            { schemaVersion: 1, block: reversed },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('INV-DET-002: nested metadata key order alone does not create a false conflict', () => {
    const metadata = { alpha: 1, beta: { x: 'one', y: ['a', 'b'] }, gamma: null };
    const reordered = { gamma: null, beta: { y: ['a', 'b'], x: 'one' }, alpha: 1 };
    expect(() =>
      validator.validate(
        input({ candidates: [candidate({ metadata }), candidate({ metadata: reordered })] }),
      ),
    ).not.toThrow();
  });

  it('INV-DET-002: metadata array order does create a genuine conflict', () => {
    // Array order is data, not insertion order, so reversing it is a different
    // record and must not be silently treated as equal.
    const error = expectRejected(
      input({
        candidates: [
          candidate({ metadata: { tags: ['a', 'b'] } }),
          candidate({ metadata: { tags: ['b', 'a'] } }),
        ],
      }),
    );
    expect(codes(error)).toContain('conflicting_block_id');
  });

  it('INV-DET-002: the conflict decision does not depend on candidate order', () => {
    const candidates = [candidate(), candidate({ content: 'Different body entirely.' })];
    const forward = expectRejected(input({ candidates }));
    const reversed = expectRejected(input({ candidates: [...candidates].reverse() }));
    expect(codes(forward)).toEqual(codes(reversed));
  });

  it('INV-DET-002: acceptance does not depend on candidate order', () => {
    const candidates = [
      candidate(),
      candidate({ id: 'block-2', content: 'Second body here.' }),
      candidate(),
    ];
    const forward = validator.validate(input({ candidates }));
    const reversed = validator.validate(input({ candidates: [...candidates].reverse() }));
    expect([...forward.candidates].reverse()).toEqual(reversed.candidates);
  });

  it('never deduplicates, drops, or reorders wrappers', () => {
    const result = validator.validate(
      input({
        candidates: [
          candidate({ id: 'block-2', content: 'Second body here.' }),
          candidate(),
          candidate(),
          candidate({ id: 'block-3', content: 'Third body here now.' }),
        ],
      }),
    );
    expect(result.candidates.map((entry) => entry.block.id)).toEqual([
      'block-2',
      'block-1',
      'block-1',
      'block-3',
    ]);
  });

  it('performs no content-hash deduplication across different IDs', () => {
    // Two different IDs carrying identical content are a deduplication decision,
    // not a validation failure.
    const result = validator.validate(
      input({ candidates: [candidate(), candidate({ id: 'block-2' })] }),
    );
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.block.normalizedContentHash).toBe(
      result.candidates[1]?.block.normalizedContentHash,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('priority is restricted to safe integers only at this phase', () => {
  function withPriority(priority: unknown): unknown {
    return input({ candidates: [candidate({ attributes: { priority } })] });
  }

  it('accepts an absent priority', () => {
    expect(() =>
      validator.validate(input({ candidates: [candidate({ attributes: {} })] })),
    ).not.toThrow();
  });

  it('accepts zero', () => {
    expect(() => validator.validate(withPriority(0))).not.toThrow();
  });

  it('accepts a positive safe integer', () => {
    expect(() => validator.validate(withPriority(1000))).not.toThrow();
  });

  it('accepts a negative safe integer', () => {
    expect(() => validator.validate(withPriority(-1000))).not.toThrow();
  });

  it('accepts the extremes of the safe-integer range', () => {
    expect(() => validator.validate(withPriority(Number.MAX_SAFE_INTEGER))).not.toThrow();
    expect(() => validator.validate(withPriority(Number.MIN_SAFE_INTEGER))).not.toThrow();
  });

  it('accepts a value far outside any arbitrary range such as 0..100', () => {
    // No product-specific range exists yet, so 5000 is valid. Semantic bounds are
    // deferred to the versioned CompilationPolicy (DEC-030).
    expect(() => validator.validate(withPriority(5000))).not.toThrow();
  });

  it.each([
    ['a fractional priority', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe positive integer', Number.MAX_SAFE_INTEGER + 2],
    ['an unsafe negative integer', Number.MIN_SAFE_INTEGER - 2],
    ['a numeric string', '10'],
  ])('rejects %s', (_label, priority) => {
    const error = expectRejected(withPriority(priority));
    expect(codes(error)).toEqual(['invalid_priority']);
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.attributes.priority');
  });

  it('applies no policy boost and does not alter the value', () => {
    const result = validator.validate(withPriority(-7));
    expect(result.candidates[0]?.block.attributes.priority).toBe(-7);
  });

  it('does not turn required status into a priority or a score', () => {
    const result = validator.validate(
      input({ candidates: [candidate({ attributes: { required: true } })] }),
    );
    expect(result.candidates[0]?.block.attributes).toEqual({ required: true });
  });
});

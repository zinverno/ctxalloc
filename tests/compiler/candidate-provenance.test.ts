import { CandidateValidationError, CandidateValidator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { SCOPE, candidate, input, sourceDocument, wordTokenizer } from './fixtures.js';

/**
 * Provenance consistency (DEC-030).
 *
 * Two rules that the schema and the source registry each miss on their own: a
 * block whose `sourceLocation.kind` contradicts its own `sourceType`, and a
 * candidate reference resolved against an ambiguous duplicate source record.
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

const TEXT_RANGE = { kind: 'text-range', startOffset: 0, endOffset: 10 } as const;
const CONVERSATION_MESSAGE = { kind: 'conversation-message', messageId: 'msg-1' } as const;

function batchFor(sourceType: string, sourceLocation: unknown): unknown {
  return input({
    sourceDocuments: [sourceDocument({ sourceType })],
    candidates: [candidate({ sourceType, sourceLocation })],
  });
}

/* -------------------------------------------------------------------------- */

describe('INV-PROV-002: SourceLocation kind must match the block source type', () => {
  it.each([
    ['markdown', TEXT_RANGE],
    ['text', TEXT_RANGE],
    ['conversation', CONVERSATION_MESSAGE],
  ])('accepts %s located by a compatible kind', (sourceType, sourceLocation) => {
    expect(() => validator.validate(batchFor(sourceType, sourceLocation))).not.toThrow();
  });

  it.each([
    ['markdown', CONVERSATION_MESSAGE, 'text-range'],
    ['text', CONVERSATION_MESSAGE, 'text-range'],
    ['conversation', TEXT_RANGE, 'conversation-message'],
  ])('rejects %s located by an incompatible kind', (sourceType, sourceLocation, expected) => {
    const error = expectRejected(batchFor(sourceType, sourceLocation));
    expect(codes(error)).toEqual(['source_location_type_mismatch']);
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.sourceLocation.kind');
    expect(error.issues[0]?.message).toContain(expected);
    expect(error.issues[0]?.message).toContain(sourceType);
  });

  it('accepts a block with no source location at all', () => {
    const wrapper = candidate({ sourceType: 'markdown' });
    delete (wrapper['block'] as Record<string, unknown>)['sourceLocation'];
    expect(() => validator.validate(input({ candidates: [wrapper] }))).not.toThrow();
  });

  it('accepts an absent source location for every source type', () => {
    for (const sourceType of ['markdown', 'text', 'conversation']) {
      const wrapper = candidate({ sourceType });
      delete (wrapper['block'] as Record<string, unknown>)['sourceLocation'];
      expect(() =>
        validator.validate(
          input({ sourceDocuments: [sourceDocument({ sourceType })], candidates: [wrapper] }),
        ),
      ).not.toThrow();
    }
  });

  it('does not rewrite an accepted source location', () => {
    const location = {
      kind: 'text-range',
      startOffset: 3,
      endOffset: 17,
      startLine: 2,
      endLine: 4,
    };
    const result = validator.validate(
      input({ candidates: [candidate({ sourceLocation: { ...location } })] }),
    );
    expect(result.candidates[0]?.block.sourceLocation).toEqual(location);
  });

  it('does not rewrite a rejected source location', () => {
    const batch = batchFor('markdown', { ...CONVERSATION_MESSAGE });
    const before = JSON.stringify(batch);
    expectRejected(batch);
    expect(JSON.stringify(batch)).toBe(before);
  });

  it('reports the contradiction even when the source registry itself agrees', () => {
    // The document and the block agree on `sourceType`, so the registry check is
    // satisfied; only the block-internal rule catches this.
    const error = expectRejected(batchFor('markdown', CONVERSATION_MESSAGE));
    expect(codes(error)).not.toContain('source_type_mismatch');
    expect(codes(error)).toContain('source_location_type_mismatch');
  });

  it('reports the contradiction even when the referenced source is missing', () => {
    // The rule compares two fields of the block, so it needs no source document.
    const error = expectRejected(
      input({
        candidates: [
          candidate({ sourceDocumentId: 'doc-absent', sourceLocation: CONVERSATION_MESSAGE }),
        ],
      }),
    );
    expect(codes(error)).toEqual(['source_not_found', 'source_location_type_mismatch']);
  });

  it('leaves source registry sourceType matching behaving exactly as before', () => {
    // A registry disagreement is still reported, and is still a different issue
    // from the block-internal one.
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ sourceType: 'text' })],
        candidates: [candidate({ sourceType: 'markdown', sourceLocation: TEXT_RANGE })],
      }),
    );
    expect(codes(error)).toEqual(['source_type_mismatch']);
    expect(error.issues[0]?.pointer).toBe('candidates[0].block.sourceType');
  });

  it('reports both a registry mismatch and a block-internal contradiction', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ sourceType: 'text' })],
        candidates: [candidate({ sourceType: 'markdown', sourceLocation: CONVERSATION_MESSAGE })],
      }),
    );
    expect(codes(error)).toEqual(['source_type_mismatch', 'source_location_type_mismatch']);
  });

  it('INV-DET-001: the decision does not depend on candidate order', () => {
    const good = candidate({ id: 'block-2', content: 'Second body.', sourceLocation: TEXT_RANGE });
    const bad = candidate({ sourceLocation: CONVERSATION_MESSAGE });
    expect(codes(expectRejected(input({ candidates: [good, bad] }))).sort()).toEqual(
      codes(expectRejected(input({ candidates: [bad, good] }))).sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('INV-DET-002: a duplicated source ID never becomes authoritative', () => {
  /** Two different records sharing one ID: they disagree on `sourceType`. */
  const TYPE_A = sourceDocument({ id: 'doc-x', sourceType: 'markdown' });
  const TYPE_B = sourceDocument({ id: 'doc-x', sourceType: 'text' });

  /** Two different records sharing one ID: they disagree on scope. */
  const SCOPE_A = sourceDocument({ id: 'doc-y', scope: { ...SCOPE } });
  const SCOPE_B = sourceDocument({ id: 'doc-y', scope: { ...SCOPE, projectId: 'other' } });

  function batch(documents: readonly unknown[], candidates: readonly unknown[]): unknown {
    return { scope: { ...SCOPE }, sourceDocuments: documents, candidates };
  }

  it('rejects both orders of a conflicting duplicate', () => {
    const candidates = [candidate({ sourceDocumentId: 'doc-x', sourceType: 'markdown' })];
    expect(codes(expectRejected(batch([TYPE_A, TYPE_B], candidates)))).toContain(
      'duplicate_source_document_id',
    );
    expect(codes(expectRejected(batch([TYPE_B, TYPE_A], candidates)))).toContain(
      'duplicate_source_document_id',
    );
  });

  it('does not gain or lose source_type_mismatch when the duplicate order changes', () => {
    const candidates = [candidate({ sourceDocumentId: 'doc-x', sourceType: 'markdown' })];
    const forward = codes(expectRejected(batch([TYPE_A, TYPE_B], candidates)));
    const reversed = codes(expectRejected(batch([TYPE_B, TYPE_A], candidates)));

    expect(forward).toEqual(reversed);
    expect(forward).not.toContain('source_type_mismatch');
    expect(reversed).not.toContain('source_type_mismatch');
  });

  it('does not gain or lose source_scope_mismatch when the duplicate order changes', () => {
    const candidates = [candidate({ sourceDocumentId: 'doc-y' })];
    const forward = codes(expectRejected(batch([SCOPE_A, SCOPE_B], candidates)));
    const reversed = codes(expectRejected(batch([SCOPE_B, SCOPE_A], candidates)));

    expect(forward.filter((code) => code === 'source_scope_mismatch')).toEqual(
      reversed.filter((code) => code === 'source_scope_mismatch'),
    );
    expect(forward).not.toContain('source_scope_mismatch');
  });

  it('reports no source_not_found for an ID that is present but ambiguous', () => {
    const codesFound = codes(
      expectRejected(batch([TYPE_A, TYPE_B], [candidate({ sourceDocumentId: 'doc-x' })])),
    );
    expect(codesFound).not.toContain('source_not_found');
    expect(codesFound).toContain('duplicate_source_document_id');
  });

  it('still reports source_not_found for an ID that is genuinely absent', () => {
    const codesFound = codes(
      expectRejected(batch([TYPE_A, TYPE_B], [candidate({ sourceDocumentId: 'doc-gone' })])),
    );
    expect(codesFound).toContain('source_not_found');
  });

  it('keeps candidate-independent validation running for an ambiguous reference', () => {
    // Scope, hash, token count, Unicode, and ID conflicts need no source record,
    // so an ambiguous reference must not suppress them.
    const forward = codes(
      expectRejected(
        batch(
          [TYPE_A, TYPE_B],
          [candidate({ sourceDocumentId: 'doc-x', tokenCount: 99, attributes: {} })],
        ),
      ),
    );
    const reversed = codes(
      expectRejected(
        batch(
          [TYPE_B, TYPE_A],
          [candidate({ sourceDocumentId: 'doc-x', tokenCount: 99, attributes: {} })],
        ),
      ),
    );
    expect(forward).toContain('invalid_token_count');
    expect(forward).toEqual(reversed);
  });

  it('keeps the block-internal location rule running for an ambiguous reference', () => {
    const forward = codes(
      expectRejected(
        batch(
          [TYPE_A, TYPE_B],
          [candidate({ sourceDocumentId: 'doc-x', sourceLocation: CONVERSATION_MESSAGE })],
        ),
      ),
    );
    const reversed = codes(
      expectRejected(
        batch(
          [TYPE_B, TYPE_A],
          [candidate({ sourceDocumentId: 'doc-x', sourceLocation: CONVERSATION_MESSAGE })],
        ),
      ),
    );
    expect(forward).toContain('source_location_type_mismatch');
    expect(forward).toEqual(reversed);
  });

  it('keeps a cross-scope candidate reported in both orders', () => {
    const candidates = [
      candidate({ sourceDocumentId: 'doc-x', scope: { ...SCOPE, tenantId: 'other' } }),
    ];
    const forward = codes(expectRejected(batch([TYPE_A, TYPE_B], candidates)));
    const reversed = codes(expectRejected(batch([TYPE_B, TYPE_A], candidates)));
    expect(forward).toContain('scope_mismatch');
    expect(forward).toEqual(reversed);
  });

  it('resolves an unambiguous ID normally while another ID is duplicated', () => {
    // Only the ambiguous reference is skipped; a clean neighbour still resolves.
    const error = expectRejected(
      batch(
        [TYPE_A, TYPE_B, sourceDocument({ id: 'doc-ok', sourceType: 'text' })],
        [candidate({ id: 'block-2', sourceDocumentId: 'doc-ok', sourceType: 'markdown' })],
      ),
    );
    expect(codes(error)).toContain('source_type_mismatch');
    expect(codes(error)).toContain('duplicate_source_document_id');
  });

  it('reports identical issue codes for three-way duplicates in any order', () => {
    const third = sourceDocument({ id: 'doc-x', sourceType: 'conversation' });
    const candidates = [candidate({ sourceDocumentId: 'doc-x' })];
    const orders = [
      [TYPE_A, TYPE_B, third],
      [TYPE_B, third, TYPE_A],
      [third, TYPE_A, TYPE_B],
    ];
    const results = orders.map((documents) => codes(expectRejected(batch(documents, candidates))));
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

/* -------------------------------------------------------------------------- */

describe('a schema failure short-circuits cross-record validation', () => {
  /**
   * The documented guarantee, pinned so it cannot drift silently: cross-record
   * issues are collected only once the top-level schema has passed.
   */
  it('reports schema issues only when an unknown top-level field is present', () => {
    const error = expectRejected(
      input({
        policy: {},
        candidates: [candidate({ tokenCount: 99 })],
      }),
    );
    expect(codes(error)).toEqual(['invalid_input']);
    expect(codes(error)).not.toContain('invalid_token_count');
  });

  it('reports the same cross-record issue once the unknown field is removed', () => {
    const error = expectRejected(input({ candidates: [candidate({ tokenCount: 99 })] }));
    expect(codes(error)).toEqual(['invalid_token_count']);
  });
});

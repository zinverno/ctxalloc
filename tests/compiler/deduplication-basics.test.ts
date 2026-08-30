import { CandidateDeduplicator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  contextBlock,
  omit,
  sourceDocument,
  validate,
  validateCandidates,
} from './deduplication-fixtures.js';

const deduplicator = new CandidateDeduplicator();

describe('CandidateDeduplicator: stage basics', () => {
  it('returns an empty candidate set for an empty validated batch', () => {
    const validated = validate({ candidates: [] });
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toEqual([]);
    expect(result.sourceDocuments).toHaveLength(1);
  });

  it('turns one candidate into one group carrying the original validated block', () => {
    const validated = validate();
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    const group = result.candidates[0];
    expect(group?.canonicalBlock).toEqual(validated.candidates[0]?.block);
    expect(group?.canonicalSelectionReason).toBe('single-block');
    expect(group?.members).toEqual([
      { candidate: validated.candidates[0], matchReason: 'same-block-id' },
    ]);
  });

  it('returns the validated scope unchanged', () => {
    const validated = validate();
    const result = deduplicator.deduplicate(validated);

    expect(result.scope).toEqual(validated.scope);
    expect(result.scope).toBe(validated.scope);
  });

  it('INV-DET-002: returns the same source documents in stable identifier order', () => {
    const validated = validate({
      sourceDocuments: [
        sourceDocument({ id: 'doc-c' }),
        sourceDocument({ id: 'doc-a' }),
        sourceDocument({ id: 'doc-b' }),
      ],
      candidates: [candidate({ sourceDocumentId: 'doc-b' })],
    });
    const result = deduplicator.deduplicate(validated);

    expect(result.sourceDocuments.map((document) => document.id)).toEqual([
      'doc-a',
      'doc-b',
      'doc-c',
    ]);
    // The same records, reordered and never rewritten.
    expect([...result.sourceDocuments].sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
      [...validated.sourceDocuments].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it('INV-ALLOC-004: mutates no part of the supplied validated set', () => {
    const validated = validate({
      sourceDocuments: [sourceDocument({ id: 'doc-b' }), sourceDocument({ id: 'doc-a' })],
      candidates: [
        candidate({ id: 'block-b', sourceDocumentId: 'doc-a', headingPath: ['A', 'B'] }),
        candidate({ id: 'block-a', sourceDocumentId: 'doc-b', metadata: { k: [1, 2] } }),
      ],
    });
    const before = structuredClone(validated);

    deduplicator.deduplicate(validated);

    expect(validated).toEqual(before);
    expect(validated.candidates.map((entry) => entry.block.id)).toEqual(['block-b', 'block-a']);
    expect(validated.sourceDocuments.map((document) => document.id)).toEqual(['doc-b', 'doc-a']);
  });

  it('INV-DET-002: orders groups by canonical block identifier, not by input position', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-m', content: 'mmm' }),
      candidate({ id: 'block-a', content: 'aaa' }),
      candidate({ id: 'block-z', content: 'zzz' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates.map((group) => group.canonicalBlock.id)).toEqual([
      'block-a',
      'block-m',
      'block-z',
    ]);
  });

  it('keeps distinct content in distinct groups', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-1', content: 'one' }),
      candidate({ id: 'block-2', content: 'two' }),
      candidate({ id: 'block-3', content: 'three' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(3);
    for (const group of result.candidates) {
      expect(group.canonicalSelectionReason).toBe('single-block');
      expect(group.members).toHaveLength(1);
    }
  });

  it('keeps a block whose source location is absent', () => {
    const block = omit(contextBlock(), 'sourceLocation');
    const validated = validateCandidates([{ schemaVersion: 1, block }]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.canonicalBlock.sourceLocation).toBeUndefined();
  });
});

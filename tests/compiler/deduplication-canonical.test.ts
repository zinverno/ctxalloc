import { CandidateDeduplicator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  charTokenizer,
  contextBlock,
  omit,
  sourceDocument,
  validate,
  validateCandidates,
} from './deduplication-fixtures.js';

const deduplicator = new CandidateDeduplicator();

const SHARED = 'the release ships on Tuesday';

function onlyGroup(candidates: readonly Record<string, unknown>[]): {
  canonicalId: string;
  reason: string;
  memberIds: readonly string[];
} {
  const result = deduplicator.deduplicate(validateCandidates(candidates));
  expect(result.candidates).toHaveLength(1);
  const group = result.candidates[0];
  if (group === undefined) throw new Error('expected exactly one group');
  return {
    canonicalId: group.canonicalBlock.id,
    reason: group.canonicalSelectionReason,
    memberIds: group.members.map((member) => member.candidate.block.id),
  };
}

describe('INV-DEDUP-001: canonical selection rules', () => {
  it('reports single-block when the group holds one distinct block ID', () => {
    expect(onlyGroup([candidate(), candidate(), candidate()]).reason).toBe('single-block');
  });

  it('INV-DEDUP-002: a required block beats an optional false block with a smaller ID', () => {
    const group = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: { required: false } }),
      candidate({ id: 'block-z', content: SHARED, attributes: { required: true } }),
    ]);
    expect(group.canonicalId).toBe('block-z');
    expect(group.reason).toBe('required-block');
  });

  it('INV-DEDUP-002: a required block beats a block with no required declaration', () => {
    const group = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-z', content: SHARED, attributes: { required: true } }),
    ]);
    expect(group.canonicalId).toBe('block-z');
    expect(group.reason).toBe('required-block');
  });

  it('reports required-block when exactly one of several blocks is required', () => {
    const group = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-m', content: SHARED, attributes: { required: true } }),
      candidate({ id: 'block-z', content: SHARED, attributes: { required: false } }),
    ]);
    expect(group.canonicalId).toBe('block-m');
    expect(group.reason).toBe('required-block');
  });

  it('INV-DET-005: several required blocks tie-break on the smallest required block ID', () => {
    const group = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-m', content: SHARED, attributes: { required: true } }),
      candidate({ id: 'block-z', content: SHARED, attributes: { required: true } }),
    ]);
    expect(group.canonicalId).toBe('block-m');
    expect(group.reason).toBe('required-then-stable-block-id');
  });

  it('INV-DET-005: an optional-only group tie-breaks on the smallest block ID', () => {
    const group = onlyGroup([
      candidate({ id: 'block-z', content: SHARED, attributes: { required: false } }),
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-m', content: SHARED, attributes: {} }),
    ]);
    expect(group.canonicalId).toBe('block-a');
    expect(group.reason).toBe('stable-block-id');
  });

  it('treats an explicit false and an absent required declaration as equally optional', () => {
    const explicitFalse = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: { required: false } }),
      candidate({ id: 'block-b', content: SHARED, attributes: { required: false } }),
    ]);
    const absent = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-b', content: SHARED, attributes: {} }),
    ]);
    const mixed = onlyGroup([
      candidate({ id: 'block-a', content: SHARED, attributes: { required: false } }),
      candidate({ id: 'block-b', content: SHARED, attributes: {} }),
    ]);

    expect(explicitFalse.reason).toBe('stable-block-id');
    expect(absent.reason).toBe('stable-block-id');
    expect(mixed.reason).toBe('stable-block-id');
    expect(mixed.canonicalId).toBe('block-a');
  });

  it('compares block IDs by code unit, not by locale collation', () => {
    // Under many locale collations "a" sorts before "B"; by code unit it does not.
    const group = onlyGroup([
      candidate({ id: 'a-block', content: SHARED }),
      candidate({ id: 'B-block', content: SHARED }),
    ]);
    expect(group.canonicalId).toBe('B-block');
    expect('a-block'.localeCompare('B-block')).toBeLessThan(0);
  });
});

describe('INV-SCORE-002: untrusted and policy-owned data never selects the canonical block', () => {
  const smaller = { id: 'block-a', content: SHARED } as const;
  const larger = { id: 'block-z', content: SHARED } as const;

  it('a higher retrieval score does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate(smaller, {
          providerId: 'p',
          providerVersion: '1',
          score: { value: 0.01, semantics: 'cosine-similarity', higherIsBetter: true },
        }),
        candidate(larger, {
          providerId: 'p',
          providerVersion: '1',
          score: { value: 0.99, semantics: 'cosine-similarity', higherIsBetter: true },
        }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('a better retrieval rank does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate(smaller, { providerId: 'p', providerVersion: '1', rank: 99 }),
        candidate(larger, { providerId: 'p', providerVersion: '1', rank: 0 }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('provider identity does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate(smaller),
        candidate(larger, { providerId: 'aaa-trusted-provider', providerVersion: '1' }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('a higher authored priority does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate({ ...smaller, attributes: { priority: -100 } }),
        candidate({ ...larger, attributes: { priority: 1000 } }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('a category does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate({ ...smaller, attributes: { category: 'note' } }),
        candidate({ ...larger, attributes: { category: 'decision' } }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('INV-DET-004: a newer createdAt or updatedAt does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate({
          ...smaller,
          createdAt: '2020-01-01T00:00:00.000Z',
          updatedAt: '2020-01-01T00:00:00.000Z',
        }),
        candidate({
          ...larger,
          createdAt: '2099-01-01T00:00:00.000Z',
          updatedAt: '2099-01-01T00:00:00.000Z',
        }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('a larger token count does not win', () => {
    // A CRLF copy costs one more token than the LF copy under a character
    // tokenizer while remaining the same canonical content.
    const result = deduplicator.deduplicate(
      validate(
        {
          candidates: [
            candidate({ id: 'block-z', content: 'a\nb', tokenCount: 3 }),
            candidate({ id: 'block-a', content: 'a\r\nb', tokenCount: 4 }),
          ],
        },
        charTokenizer,
      ),
    );
    const group = result.candidates[0];
    expect(group?.canonicalBlock.id).toBe('block-a');
    expect(group?.canonicalBlock.tokenCount).toBe(4);
  });

  it('richer metadata does not win', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate({ ...smaller, metadata: {} }),
        candidate({ ...larger, metadata: { author: 'x', tags: ['a', 'b'], nested: { k: 1 } } }),
      ]),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
  });

  it('a present source location does not beat an absent one', () => {
    const withoutLocation = omit(
      contextBlock({ id: 'block-a', content: SHARED }),
      'sourceLocation',
    );
    const result = deduplicator.deduplicate(
      validateCandidates([
        { schemaVersion: 1, block: withoutLocation },
        candidate({ id: 'block-z', content: SHARED }),
      ]),
    );
    const group = result.candidates[0];
    expect(group?.canonicalBlock.id).toBe('block-a');
    expect(group?.canonicalBlock.sourceLocation).toBeUndefined();
  });

  it('a different source document does not win', () => {
    const result = deduplicator.deduplicate(
      validate({
        sourceDocuments: [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })],
        candidates: [
          candidate({ id: 'block-z', sourceDocumentId: 'doc-1', content: SHARED }),
          candidate({ id: 'block-a', sourceDocumentId: 'doc-2', content: SHARED }),
        ],
      }),
    );
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
    expect(result.candidates[0]?.canonicalBlock.sourceDocumentId).toBe('doc-2');
  });

  it('input position does not win', () => {
    const first = onlyGroup([
      candidate({ id: 'block-z', content: SHARED }),
      candidate({ id: 'block-a', content: SHARED }),
    ]);
    const second = onlyGroup([
      candidate({ id: 'block-a', content: SHARED }),
      candidate({ id: 'block-z', content: SHARED }),
    ]);
    expect(first.canonicalId).toBe('block-a');
    expect(second.canonicalId).toBe('block-a');
    expect(first.memberIds).toEqual(second.memberIds);
  });
});

describe('INV-DEDUP-002: required status survives deduplication', () => {
  it('gives every group holding a required block a required canonical block', () => {
    const result = deduplicator.deduplicate(
      validateCandidates([
        candidate({ id: 'block-a', content: 'one', attributes: {} }),
        candidate({ id: 'block-z', content: 'one', attributes: { required: true } }),
        candidate({ id: 'block-b', content: 'two', attributes: { required: true } }),
        candidate({ id: 'block-y', content: 'two', attributes: { required: false } }),
        candidate({ id: 'block-c', content: 'three', attributes: {} }),
      ]),
    );

    for (const group of result.candidates) {
      const holdsRequired = group.members.some(
        (member) => member.candidate.block.attributes.required === true,
      );
      if (holdsRequired) expect(group.canonicalBlock.attributes.required).toBe(true);
    }
    expect(result.candidates.map((group) => group.canonicalBlock.id)).toEqual([
      'block-b',
      'block-c',
      'block-z',
    ]);
  });

  it('INV-ALLOC-004: never mutates a block into a required one', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-a', content: SHARED, attributes: {} }),
      candidate({ id: 'block-z', content: SHARED, attributes: { required: true } }),
    ]);
    const result = deduplicator.deduplicate(validated);

    const optional = (result.candidates[0]?.members ?? []).find(
      (member) => member.candidate.block.id === 'block-a',
    );
    expect(optional?.candidate.block.attributes).toEqual({});
    expect(optional?.candidate.block.attributes.required).toBeUndefined();
    // The canonical block is one of the group's own records, carried unchanged.
    expect(result.candidates[0]?.canonicalBlock).toBe(validated.candidates[1]?.block);
  });

  it('INV-DEDUP-003: keeps the optional duplicate and its provenance recoverable', () => {
    const validated = validate({
      sourceDocuments: [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })],
      candidates: [
        candidate({
          id: 'block-a',
          sourceDocumentId: 'doc-1',
          content: SHARED,
          headingPath: ['Notes'],
          metadata: { origin: 'inbox' },
        }),
        candidate({
          id: 'block-z',
          sourceDocumentId: 'doc-2',
          content: SHARED,
          headingPath: ['Decisions'],
          attributes: { required: true },
        }),
      ],
    });
    const result = deduplicator.deduplicate(validated);
    const group = result.candidates[0];

    expect(group?.canonicalBlock.sourceDocumentId).toBe('doc-2');
    expect(group?.canonicalBlock.headingPath).toEqual(['Decisions']);

    const optional = (group?.members ?? []).find(
      (member) => member.candidate.block.id === 'block-a',
    );
    expect(optional?.candidate.block.sourceDocumentId).toBe('doc-1');
    expect(optional?.candidate.block.headingPath).toEqual(['Notes']);
    expect(optional?.candidate.block.metadata).toEqual({ origin: 'inbox' });
    expect(optional?.candidate.block.sourceLocation).toEqual({
      kind: 'text-range',
      startOffset: 0,
      endOffset: SHARED.length,
    });
  });
});

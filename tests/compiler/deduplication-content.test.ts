import { CandidateDeduplicator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  charTokenizer,
  sourceDocument,
  validate,
  validateCandidates,
} from './deduplication-fixtures.js';

const deduplicator = new CandidateDeduplicator();

function groupCount(candidates: readonly Record<string, unknown>[]): number {
  return deduplicator.deduplicate(validateCandidates(candidates)).candidates.length;
}

describe('CandidateDeduplicator: exact normalized content equivalence', () => {
  it('INV-DEDUP-001: groups different block IDs carrying identical content', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-b', content: 'timeout = 30' }),
      candidate({ id: 'block-a', content: 'timeout = 30' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
    expect(result.candidates[0]?.members).toHaveLength(2);
  });

  it('INV-DEDUP-001: groups an LF copy and a CRLF copy of the same text', () => {
    expect(
      groupCount([
        candidate({ id: 'block-lf', content: 'first line\nsecond line' }),
        candidate({ id: 'block-crlf', content: 'first line\r\nsecond line' }),
      ]),
    ).toBe(1);
  });

  it('INV-DEDUP-001: groups a lone-CR copy and an LF copy of the same text', () => {
    expect(
      groupCount([
        candidate({ id: 'block-lf', content: 'first line\nsecond line' }),
        candidate({ id: 'block-cr', content: 'first line\rsecond line' }),
      ]),
    ).toBe(1);
  });

  it('INV-DEDUP-001: groups identical content coming from different source documents', () => {
    const validated = validate({
      sourceDocuments: [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })],
      candidates: [
        candidate({ id: 'block-1', sourceDocumentId: 'doc-1', content: 'shared paragraph' }),
        candidate({ id: 'block-2', sourceDocumentId: 'doc-2', content: 'shared paragraph' }),
      ],
    });
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(
      (result.candidates[0]?.members ?? []).map(
        (member) => member.candidate.block.sourceDocumentId,
      ),
    ).toEqual(['doc-1', 'doc-2']);
  });

  it('INV-DEDUP-001: groups identical content coming from different source types', () => {
    const validated = validate({
      sourceDocuments: [
        sourceDocument({ id: 'doc-md', sourceType: 'markdown' }),
        sourceDocument({ id: 'doc-txt', sourceType: 'text' }),
      ],
      candidates: [
        candidate({
          id: 'block-md',
          sourceDocumentId: 'doc-md',
          sourceType: 'markdown',
          content: 'shared paragraph',
        }),
        candidate({
          id: 'block-txt',
          sourceDocumentId: 'doc-txt',
          sourceType: 'text',
          content: 'shared paragraph',
        }),
      ],
    });
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(
      (result.candidates[0]?.members ?? []).map((member) => member.candidate.block.sourceType),
    ).toEqual(['markdown', 'text']);
  });

  it('marks a non-canonical block ID as matched by normalized content', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-a', content: 'shared' }),
      candidate({ id: 'block-b', content: 'shared' }),
      candidate({ id: 'block-b', content: 'shared' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    const members = result.candidates[0]?.members ?? [];
    expect(result.candidates[0]?.canonicalBlock.id).toBe('block-a');
    expect(members.map((member) => [member.candidate.block.id, member.matchReason])).toEqual([
      ['block-a', 'same-block-id'],
      ['block-b', 'same-normalized-content'],
      ['block-b', 'same-normalized-content'],
    ]);
  });

  it('INV-DEDUP-001: uses the hash only as a bucket, so equal text always groups', () => {
    // A CRLF and an LF copy count differently under a character tokenizer, so
    // the two blocks differ in `tokenCount` while sharing one canonical hash and
    // one canonical normalized content. They must still be one group.
    const validated = validate(
      {
        candidates: [
          candidate({ id: 'block-lf', content: 'a\nb', tokenCount: 3 }),
          candidate({ id: 'block-crlf', content: 'a\r\nb', tokenCount: 4 }),
        ],
      },
      charTokenizer,
    );
    expect(validated.candidates.map((entry) => entry.block.tokenCount)).toEqual([3, 4]);

    const result = deduplicator.deduplicate(validated);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.members).toHaveLength(2);
  });
});

describe('INV-DEDUP-005: textually different blocks are never collapsed', () => {
  const CASES: readonly (readonly [string, string, string])[] = [
    ['trailing spaces differ', 'value', 'value  '],
    ['blank-line counts differ', 'a\n\nb', 'a\n\n\nb'],
    ['Unicode composition differs (NFC vs NFD)', 'caf\u00E9', 'cafe\u0301'],
    ['letter case differs', 'Timeout', 'timeout'],
    ['punctuation differs', 'enabled', 'enabled.'],
    ['one text is a substring of the other', 'timeout = 30', 'timeout = 30 seconds'],
    ['same heading, different body', 'the timeout is 30', 'the timeout is 60'],
    ['configuration values contradict', 'feature enabled', 'feature disabled'],
    ['dates contradict', 'launch date is May 1', 'launch date is June 1'],
    ['a paraphrase says the same thing differently', 'the build failed', 'the build did not pass'],
    ['indentation differs', 'a\n  b', 'a\n    b'],
  ];

  it.each(CASES)('keeps separate groups when %s', (_name, left, right) => {
    expect(
      groupCount([
        candidate({ id: 'block-left', content: left }),
        candidate({ id: 'block-right', content: right }),
      ]),
    ).toBe(2);
  });

  it('keeps a same-heading pair separate even inside one source document', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-1', headingPath: ['Config'], content: 'timeout = 30' }),
      candidate({ id: 'block-2', headingPath: ['Config'], content: 'timeout = 60' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((group) => group.canonicalBlock.content)).toEqual([
      'timeout = 30',
      'timeout = 60',
    ]);
  });

  it('groups by content alone: a differing heading path does not split equal text', () => {
    const validated = validateCandidates([
      candidate({ id: 'block-1', headingPath: ['A'], content: 'shared' }),
      candidate({ id: 'block-2', headingPath: ['B'], content: 'shared' }),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(
      (result.candidates[0]?.members ?? []).map((member) => member.candidate.block.headingPath),
    ).toEqual([['A'], ['B']]);
  });
});

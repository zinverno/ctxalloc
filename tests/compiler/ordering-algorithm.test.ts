import { describe, expect, it } from 'vitest';
import {
  allocate,
  order,
  orderedIds,
  renderOrderOf,
  sourceDocument,
  type CandidateSpec,
} from './ordering-fixtures.js';

/**
 * The v1 order: source document, then position inside that document, then the
 * stable block identifier (DEC-034).
 *
 * Only canonical block fields participate. Score, required status, allocation
 * reason, category, timestamps, heading path, and input position are all absent
 * from the comparator by design.
 */

/** A text-range location at an exact offset pair. */
function at(startOffset: number, endOffset: number, lines?: readonly [number, number]) {
  return {
    kind: 'text-range',
    startOffset,
    endOffset,
    ...(lines === undefined ? {} : { startLine: lines[0], endLine: lines[1] }),
  };
}

/** A conversation-message location. */
function message(messageId: string, messageIndex?: number) {
  return {
    kind: 'conversation-message',
    messageId,
    ...(messageIndex === undefined ? {} : { messageIndex }),
  };
}

const CONVERSATION = { sourceType: 'conversation' } as const;

const TWO_DOCUMENTS = [sourceDocument(), sourceDocument({ id: 'doc-2' })];

describe('DEC-034: blocks are grouped by source document', () => {
  it('keeps one document contiguous, in code-unit order of the identifier', () => {
    const specs: CandidateSpec[] = [
      { id: 'b-two-a', sourceDocumentId: 'doc-2', sourceLocation: at(0, 5) },
      { id: 'a-one-b', sourceDocumentId: 'doc-1', sourceLocation: at(10, 15) },
      { id: 'c-two-b', sourceDocumentId: 'doc-2', sourceLocation: at(20, 25) },
      { id: 'd-one-a', sourceDocumentId: 'doc-1', sourceLocation: at(0, 5) },
    ];

    // Grouped by document first, then by position inside it. The block
    // identifiers deliberately disagree with both, so neither can be the key.
    expect(renderOrderOf(specs, { sourceDocuments: TWO_DOCUMENTS })).toEqual([
      'd-one-a',
      'a-one-b',
      'b-two-a',
      'c-two-b',
    ]);
  });

  it('orders documents by identifier, not by how many blocks they contribute', () => {
    const specs: CandidateSpec[] = [
      { id: 'z1', sourceDocumentId: 'doc-2', sourceLocation: at(0, 5) },
      { id: 'a1', sourceDocumentId: 'doc-1', sourceLocation: at(0, 5) },
      { id: 'a2', sourceDocumentId: 'doc-1', sourceLocation: at(6, 9) },
      { id: 'a3', sourceDocumentId: 'doc-1', sourceLocation: at(10, 12) },
    ];

    expect(renderOrderOf(specs, { sourceDocuments: TWO_DOCUMENTS })).toEqual([
      'a1',
      'a2',
      'a3',
      'z1',
    ]);
  });
});

describe('DEC-034: text-range blocks follow source offsets', () => {
  it('orders by startOffset ascending', () => {
    const specs: CandidateSpec[] = [
      { id: 'third', sourceLocation: at(200, 250) },
      { id: 'first', sourceLocation: at(0, 50) },
      { id: 'second', sourceLocation: at(100, 150) },
    ];
    expect(renderOrderOf(specs)).toEqual(['first', 'second', 'third']);
  });

  it('breaks an equal startOffset by endOffset ascending', () => {
    const specs: CandidateSpec[] = [
      { id: 'long', sourceLocation: at(10, 90) },
      { id: 'short', sourceLocation: at(10, 20) },
      { id: 'medium', sourceLocation: at(10, 50) },
    ];
    expect(renderOrderOf(specs)).toEqual(['short', 'medium', 'long']);
  });

  it('does not order by startLine, however strongly it disagrees with the identifier', () => {
    // Lines take no part in v1: offsets already establish position, and any rule
    // reading optional line metadata either breaks transitivity or lets metadata
    // completeness decide the layout.
    const specs: CandidateSpec[] = [
      { id: 'a-later-line', sourceLocation: at(10, 20, [9, 9]) },
      { id: 'z-earlier-line', sourceLocation: at(10, 20, [3, 3]) },
    ];
    expect(renderOrderOf(specs)).toEqual(['a-later-line', 'z-earlier-line']);
  });

  it('does not order by endLine either', () => {
    const specs: CandidateSpec[] = [
      { id: 'a-wide', sourceLocation: at(10, 20, [3, 30]) },
      { id: 'z-narrow', sourceLocation: at(10, 20, [3, 4]) },
    ];
    expect(renderOrderOf(specs)).toEqual(['a-wide', 'z-narrow']);
  });

  it('gives the same order whether or not the optional line fields are recorded', () => {
    const withLines: CandidateSpec[] = [
      { id: 'b1', sourceLocation: at(0, 10, [1, 1]) },
      { id: 'b2', sourceLocation: at(20, 30, [5, 5]) },
    ];
    const withoutLines: CandidateSpec[] = [
      { id: 'b1', sourceLocation: at(0, 10) },
      { id: 'b2', sourceLocation: at(20, 30) },
    ];
    // Optional metadata completeness must not change the layout.
    expect(renderOrderOf(withLines)).toEqual(renderOrderOf(withoutLines));
    expect(renderOrderOf(withLines)).toEqual(['b1', 'b2']);
  });

  it('lets endOffset order before the identifier, with lines present or absent', () => {
    const specs: CandidateSpec[] = [
      { id: 'a-long', sourceLocation: at(10, 90, [1, 9]) },
      { id: 'z-short', sourceLocation: at(10, 20) },
    ];
    // `z-short` ends earlier, so it precedes despite the later identifier.
    expect(renderOrderOf(specs)).toEqual(['z-short', 'a-long']);
  });

  it('orders identical offsets by block identifier whatever the line fields say', () => {
    const specs: CandidateSpec[] = [
      { id: 'a', sourceLocation: at(10, 20, [900, 900]) },
      { id: 'b', sourceLocation: at(10, 20) },
      { id: 'c', sourceLocation: at(10, 20, [1, 1]) },
    ];
    expect(renderOrderOf(specs)).toEqual(['a', 'b', 'c']);
  });

  it('INV-DET-005: breaks a complete positional tie by block identifier', () => {
    const specs: CandidateSpec[] = [
      { id: 'z', sourceLocation: at(10, 20) },
      { id: 'a', sourceLocation: at(10, 20) },
      { id: 'm', sourceLocation: at(10, 20) },
    ];
    expect(renderOrderOf(specs)).toEqual(['a', 'm', 'z']);
  });

  it('does not infer position from content, heading path, or timestamps', () => {
    const specs: CandidateSpec[] = [
      { id: 'b1', sourceLocation: at(500, 510) },
      { id: 'b2', sourceLocation: at(0, 10) },
    ];
    // `b2` sits earlier in the source and renders first, whatever its content,
    // identifier order, or anything else about it says.
    expect(renderOrderOf(specs)).toEqual(['b2', 'b1']);
  });
});

describe('DEC-034: conversation blocks follow message chronology', () => {
  const conversationDocuments = [sourceDocument({ sourceType: 'conversation' })];

  function conversation(specs: readonly CandidateSpec[]): readonly string[] {
    return renderOrderOf(
      specs.map((spec) => ({ ...spec, ...CONVERSATION })),
      { sourceDocuments: conversationDocuments },
    );
  }

  it('orders by messageIndex ascending', () => {
    expect(
      conversation([
        { id: 'c', sourceLocation: message('m-3', 2) },
        { id: 'a', sourceLocation: message('m-1', 0) },
        { id: 'b', sourceLocation: message('m-2', 1) },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does not read chronology out of the message identifier', () => {
    // Identifier order and index order disagree on purpose: `messageIndex` is
    // the chronology and wins.
    expect(
      conversation([
        { id: 'first-by-id', sourceLocation: message('aaa', 9) },
        { id: 'last-by-id', sourceLocation: message('zzz', 1) },
      ]),
    ).toEqual(['last-by-id', 'first-by-id']);
  });

  it('breaks an equal messageIndex by messageId, then by block identifier', () => {
    expect(
      conversation([
        { id: 'z', sourceLocation: message('m-b', 4) },
        { id: 'a', sourceLocation: message('m-b', 4) },
        { id: 'y', sourceLocation: message('m-a', 4) },
      ]),
    ).toEqual(['y', 'a', 'z']);
  });

  it('places an indexed message before an unindexed one', () => {
    expect(
      conversation([
        { id: 'unindexed', sourceLocation: message('aaa') },
        { id: 'indexed', sourceLocation: message('zzz', 7) },
      ]),
    ).toEqual(['indexed', 'unindexed']);
  });

  it('falls back to messageId code-unit order when neither states an index', () => {
    expect(
      conversation([
        { id: 'b3', sourceLocation: message('m-10') },
        { id: 'b1', sourceLocation: message('m-2') },
        { id: 'b2', sourceLocation: message('m-1') },
      ]),
      // Code units, not numbers: "m-10" precedes "m-2" because '1' < '2'. The
      // identifier is never parsed for an embedded sequence number.
    ).toEqual(['b2', 'b3', 'b1']);
  });

  it('breaks an equal messageId by block identifier', () => {
    expect(
      conversation([
        { id: 'z', sourceLocation: message('m-1') },
        { id: 'a', sourceLocation: message('m-1') },
      ]),
    ).toEqual(['a', 'z']);
  });
});

describe('DEC-034: an unlocated block is placed last, never inferred', () => {
  it('puts located blocks of a source before its unlocated ones', () => {
    const specs: CandidateSpec[] = [
      { id: 'a-unlocated', sourceLocation: null },
      { id: 'z-located', sourceLocation: at(900, 950) },
    ];
    expect(renderOrderOf(specs)).toEqual(['z-located', 'a-unlocated']);
  });

  it('orders unlocated blocks by identifier alone', () => {
    const specs: CandidateSpec[] = [
      { id: 'u-z', sourceLocation: null },
      { id: 'u-a', sourceLocation: null },
      { id: 'located', sourceLocation: at(0, 5) },
      { id: 'u-m', sourceLocation: null },
    ];
    expect(renderOrderOf(specs)).toEqual(['located', 'u-a', 'u-m', 'u-z']);
  });

  it('keeps unlocated blocks inside their own source, not at the very end', () => {
    const specs: CandidateSpec[] = [
      { id: 'one-unlocated', sourceDocumentId: 'doc-1', sourceLocation: null },
      { id: 'two-located', sourceDocumentId: 'doc-2', sourceLocation: at(0, 5) },
      { id: 'one-located', sourceDocumentId: 'doc-1', sourceLocation: at(0, 5) },
    ];
    expect(renderOrderOf(specs, { sourceDocuments: TWO_DOCUMENTS })).toEqual([
      'one-located',
      'one-unlocated',
      'two-located',
    ]);
  });
});

describe('DEC-034: mixed source types stay grouped by document', () => {
  it('groups a Markdown source and a conversation source independently', () => {
    const specs: CandidateSpec[] = [
      { id: 'talk-2', sourceDocumentId: 'doc-2', ...CONVERSATION, sourceLocation: message('m', 5) },
      { id: 'text-2', sourceDocumentId: 'doc-1', sourceLocation: at(100, 110) },
      { id: 'talk-1', sourceDocumentId: 'doc-2', ...CONVERSATION, sourceLocation: message('m', 1) },
      { id: 'text-1', sourceDocumentId: 'doc-1', sourceLocation: at(0, 10) },
    ];

    expect(
      renderOrderOf(specs, {
        sourceDocuments: [
          sourceDocument(),
          sourceDocument({ id: 'doc-2', sourceType: 'conversation' }),
        ],
      }),
    ).toEqual(['text-1', 'text-2', 'talk-1', 'talk-2']);
  });
});

describe('INV-ALLOC-002: render order is not allocation order', () => {
  it('lets a high-scoring block render later when its source position is later', () => {
    const specs: CandidateSpec[] = [
      { id: 'best', priority: 1000, sourceLocation: at(900, 950) },
      { id: 'worst', priority: 0, sourceLocation: at(0, 10) },
    ];
    const allocation = allocate(specs, { available: 100 });

    // Allocation ranked the high scorer first; rendering puts it last.
    expect(
      allocation.included.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    ).toEqual(['best', 'worst']);
    expect(orderedIds(order(allocation))).toEqual(['worst', 'best']);
  });

  it('lets a required block render after an optional block of the same source', () => {
    const specs: CandidateSpec[] = [
      { id: 'required-late', required: true, priority: 0, sourceLocation: at(500, 550) },
      { id: 'optional-early', priority: 900, sourceLocation: at(0, 10) },
    ];
    const allocation = allocate(specs, { available: 100 });

    expect(allocation.included[0]?.reason).toBe('INCLUDED_REQUIRED');
    expect(orderedIds(order(allocation))).toEqual(['optional-early', 'required-late']);
  });

  it('gives the same order whatever the allocation reason was', () => {
    const specs: CandidateSpec[] = [
      { id: 'c-required', required: true, priority: 0, sourceLocation: at(300, 310) },
      { id: 'b-minimum', priority: 100, category: 'facts', sourceLocation: at(200, 210) },
      { id: 'a-score', priority: 900, sourceLocation: at(100, 110) },
    ];
    const allocation = allocate(specs, {
      available: 100,
      policy: {
        schemaVersion: 1,
        policyId: 'allocation',
        policyVersion: '1.0.0',
        optionalSelection: 'score-desc-greedy',
        categoryConstraints: [{ category: 'facts', minBlocks: 1 }],
      },
    });

    expect(allocation.included.map((decision) => decision.reason)).toEqual([
      'INCLUDED_REQUIRED',
      'INCLUDED_CATEGORY_MINIMUM',
      'INCLUDED_SCORE_ORDER',
    ]);
    // Source position alone decides: the three reasons appear in reverse.
    expect(orderedIds(order(allocation))).toEqual(['a-score', 'b-minimum', 'c-required']);
  });

  it('does not order by category', () => {
    const specs: CandidateSpec[] = [
      { id: 'z-facts', category: 'facts', priority: 900, sourceLocation: at(0, 10) },
      { id: 'a-notes', category: 'notes', priority: 100, sourceLocation: at(50, 60) },
    ];
    expect(renderOrderOf(specs)).toEqual(['z-facts', 'a-notes']);
  });

  it('does not order by score even when positions tie', () => {
    const specs: CandidateSpec[] = [
      { id: 'z-high', priority: 1000, sourceLocation: at(10, 20) },
      { id: 'a-low', priority: 0, sourceLocation: at(10, 20) },
    ];
    // Identical positions fall to the identifier, not to the score.
    expect(renderOrderOf(specs)).toEqual(['a-low', 'z-high']);
  });
});

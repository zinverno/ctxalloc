import { describe, expect, it } from 'vitest';
import { candidate, policy, retrieval, score, sourceDocument } from './scoring-fixtures.js';

const SOURCES = [
  sourceDocument({ id: 'doc-1' }),
  sourceDocument({ id: 'doc-2' }),
  sourceDocument({ id: 'doc-3' }),
];

const SOURCE_POLICY = policy({
  sourcePriority: {
    weight: 1,
    defaultValue: 0.2,
    bySourceDocumentId: [
      { sourceDocumentId: 'doc-1', value: 0.6 },
      { sourceDocumentId: 'doc-2', value: 0.9 },
    ],
  },
});

const CATEGORY_POLICY = policy({
  categoryPriority: {
    weight: 1,
    defaultValue: 0.1,
    byCategory: [
      { category: 'policy', value: 0.8 },
      { category: 'Policy', value: 0.3 },
      { category: 'policy ', value: 0.4 },
      { category: 'policy/security', value: 1 },
    ],
  },
});

describe('CandidateScorer: source priority', () => {
  it('uses the exact configured value for a configured source', () => {
    const result = score([candidate({ sourceDocumentId: 'doc-2' })], SOURCE_POLICY, {
      sourceDocuments: SOURCES,
    });

    expect(result.candidates[0]?.score.sourcePriority).toEqual({
      normalizedValue: 0.9,
      weight: 1,
      contribution: 0.9,
      aggregation: 'max',
      defaultValue: 0.2,
      evidence: [
        {
          blockId: 'block-1',
          sourceDocumentId: 'doc-2',
          value: 0.9,
          valueSource: 'configured',
        },
      ],
    });
  });

  it('falls back to the explicit policy default for an unconfigured source', () => {
    const result = score([candidate({ sourceDocumentId: 'doc-3' })], SOURCE_POLICY, {
      sourceDocuments: SOURCES,
    });
    const evidence = result.candidates[0]?.score.sourcePriority?.evidence[0];

    expect(evidence?.value).toBe(0.2);
    expect(evidence?.valueSource).toBe('policy-default');
  });

  it('aggregates duplicate blocks from different sources by maximum', () => {
    const result = score(
      [
        candidate({ id: 'block-1', sourceDocumentId: 'doc-3' }),
        candidate({ id: 'block-2', sourceDocumentId: 'doc-2' }),
        candidate({ id: 'block-3', sourceDocumentId: 'doc-1' }),
      ],
      SOURCE_POLICY,
      { sourceDocuments: SOURCES },
    );
    const component = result.candidates[0]?.score.sourcePriority;

    expect(result.candidates).toHaveLength(1);
    expect(component?.normalizedValue).toBe(0.9);
    expect(component?.evidence.map((record) => [record.blockId, record.value])).toEqual([
      ['block-1', 0.2],
      ['block-2', 0.9],
      ['block-3', 0.6],
    ]);
  });

  it('does not privilege the source of the canonical block', () => {
    // `block-1` is canonical and comes from the low-priority source; the group
    // still scores by the strongest source in it.
    const result = score(
      [
        candidate({ id: 'block-1', sourceDocumentId: 'doc-3' }),
        candidate({ id: 'block-2', sourceDocumentId: 'doc-2' }),
      ],
      SOURCE_POLICY,
      { sourceDocuments: SOURCES },
    );

    expect(result.candidates[0]?.candidate.canonicalBlock.sourceDocumentId).toBe('doc-3');
    expect(result.candidates[0]?.score.sourcePriority?.normalizedValue).toBe(0.9);
  });

  it('does not multiply source evidence when one block is wrapped repeatedly', () => {
    const wrappers = Array.from({ length: 8 }, (_unused, index) =>
      candidate({ sourceDocumentId: 'doc-2' }, retrieval({ rank: index })),
    );
    const result = score(wrappers, SOURCE_POLICY, { sourceDocuments: SOURCES });

    expect(result.candidates[0]?.score.sourcePriority?.evidence).toHaveLength(1);
    expect(result.candidates[0]?.score.sourcePriority?.normalizedValue).toBe(0.9);
  });

  it('INV-SEC-001: ignores SourceDocument metadata and source type', () => {
    const withMetadata = [
      sourceDocument({ id: 'doc-3', metadata: { priority: 1, weight: 99, boost: 'high' } }),
    ];
    const plain = [sourceDocument({ id: 'doc-3' })];

    const withMeta = score([candidate({ sourceDocumentId: 'doc-3' })], SOURCE_POLICY, {
      sourceDocuments: withMetadata,
    });
    const without = score([candidate({ sourceDocumentId: 'doc-3' })], SOURCE_POLICY, {
      sourceDocuments: plain,
    });

    expect(withMeta.candidates[0]?.score).toEqual(without.candidates[0]?.score);
    expect(withMeta.candidates[0]?.score.sourcePriority?.normalizedValue).toBe(0.2);
  });

  it('INV-DET-002: does not depend on the order of the source registry', () => {
    const forwards = score([candidate({ sourceDocumentId: 'doc-2' })], SOURCE_POLICY, {
      sourceDocuments: SOURCES,
    });
    const backwards = score([candidate({ sourceDocumentId: 'doc-2' })], SOURCE_POLICY, {
      sourceDocuments: [...SOURCES].reverse(),
    });

    expect(backwards).toEqual(forwards);
    expect(forwards.sourceDocuments.map((document) => document.id)).toEqual([
      'doc-1',
      'doc-2',
      'doc-3',
    ]);
  });

  it('scores nothing from source priority when the component is not configured', () => {
    const result = score([candidate({ sourceDocumentId: 'doc-1' })], policy(), {
      sourceDocuments: SOURCES,
    });

    expect(result.candidates[0]?.score.sourcePriority).toBeUndefined();
  });
});

describe('CandidateScorer: category priority', () => {
  it('uses the exact configured value for a configured category', () => {
    const result = score([candidate({ attributes: { category: 'policy' } })], CATEGORY_POLICY);

    expect(result.candidates[0]?.score.categoryPriority).toEqual({
      normalizedValue: 0.8,
      weight: 1,
      contribution: 0.8,
      aggregation: 'max',
      defaultValue: 0.1,
      evidence: [{ blockId: 'block-1', category: 'policy', value: 0.8, valueSource: 'configured' }],
    });
  });

  it('falls back to the default for an absent category and records it as absent', () => {
    const result = score([candidate({ attributes: {} })], CATEGORY_POLICY);
    const evidence = result.candidates[0]?.score.categoryPriority?.evidence[0];

    expect(evidence).toEqual({ blockId: 'block-1', value: 0.1, valueSource: 'policy-default' });
    expect(evidence && 'category' in evidence).toBe(false);
  });

  it('falls back to the default for a declared but unconfigured category', () => {
    const result = score([candidate({ attributes: { category: 'unknown' } })], CATEGORY_POLICY);
    const evidence = result.candidates[0]?.score.categoryPriority?.evidence[0];

    expect(evidence).toEqual({
      blockId: 'block-1',
      category: 'unknown',
      value: 0.1,
      valueSource: 'policy-default',
    });
  });

  it('treats case and whitespace differences as distinct categories', () => {
    const exact = score([candidate({ attributes: { category: 'policy' } })], CATEGORY_POLICY);
    const capitalized = score([candidate({ attributes: { category: 'Policy' } })], CATEGORY_POLICY);
    const trailingSpace = score(
      [candidate({ attributes: { category: 'policy ' } })],
      CATEGORY_POLICY,
    );
    const leadingSpace = score(
      [candidate({ attributes: { category: ' policy' } })],
      CATEGORY_POLICY,
    );

    expect(exact.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.8);
    expect(capitalized.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.3);
    expect(trailingSpace.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.4);
    // Not configured, so the default applies: nothing is trimmed.
    expect(leadingSpace.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.1);
  });

  it('reads no prefix, hierarchy, or pattern into a category', () => {
    const parent = score(
      [candidate({ attributes: { category: 'policy/security' } })],
      CATEGORY_POLICY,
    );
    const unrelated = score(
      [candidate({ attributes: { category: 'policy/unknown' } })],
      CATEGORY_POLICY,
    );

    expect(parent.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(1);
    // "policy/unknown" does not inherit the value of "policy".
    expect(unrelated.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.1);
  });

  it('aggregates distinct duplicate blocks by maximum', () => {
    const result = score(
      [
        candidate({ id: 'block-1', attributes: { category: 'unknown' } }),
        candidate({ id: 'block-2', attributes: { category: 'policy' } }),
      ],
      CATEGORY_POLICY,
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.score.categoryPriority?.normalizedValue).toBe(0.8);
    expect(
      result.candidates[0]?.score.categoryPriority?.evidence.map((record) => record.blockId),
    ).toEqual(['block-1', 'block-2']);
  });

  it('scores nothing from category priority when the component is not configured', () => {
    const result = score([candidate({ attributes: { category: 'policy' } })], policy());

    expect(result.candidates[0]?.score.categoryPriority).toBeUndefined();
  });
});

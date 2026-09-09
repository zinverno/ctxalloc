import { MATRIX } from '../../benchmarks/heldout-v2/protocol.js';
/** Development-only preparation specimens. These are never saved as held-out cases. */
export function toySeeds() {
  return MATRIX.map((p) => ({
    id: p.id,
    query: 'Existing preparation test alpha and beta',
    blocks: [
      {
        key: 'a',
        content: 'Existing preparation test alpha',
        sourceType: 'text',
        priority: 4,
        required: true,
      },
      { key: 'b', content: 'Existing preparation test beta', sourceType: 'markdown', priority: 3 },
      {
        key: 'copy',
        content: 'Existing preparation test beta',
        sourceType: 'conversation',
        priority: 3,
      },
      { key: 'n', content: 'Existing preparation test noise', sourceType: 'text', priority: 0 },
    ],
    candidateOrder: ['a', 'b', 'copy', 'n'],
    exclusions: p.stratum === 'temporal-records' ? [{ blockId: 'n', reason: 'inapplicable' }] : [],
    annotations: {
      units: [
        { id: 'alpha', blockIds: ['a'], useful: true, applicability: 'applicable' },
        { id: 'beta', blockIds: ['b', 'copy'], useful: true, applicability: 'applicable' },
        {
          id: 'noise',
          blockIds: ['n'],
          useful: false,
          applicability: p.stratum === 'temporal-records' ? 'inapplicable' : 'applicable',
        },
      ],
      facts: [
        {
          id: 'beta-fact',
          description: 'Existing beta fact',
          useful: true,
          required: true,
          importance: 'critical',
          evidenceBlockGroups: [['b'], ['copy']],
        },
      ],
      requiredBlockIds: ['b'],
      runtimeObligations: [{ blockId: 'a', rationale: 'Toy caller explicitly requires alpha.' }],
      duplicateGroups: [['b', 'copy']],
      rationale: 'Unrelated development fixture for structural preparation tests only.',
    },
  }));
}

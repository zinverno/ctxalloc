import { describe, expect, it } from 'vitest';
import {
  buildTrace,
  candidateOf,
  contextBlock,
  groupFor,
  runPipeline,
  trace,
  tracePolicy,
} from './trace-fixtures.js';

/**
 * Wrapper accounting and group decisions (INV-TRACE-001, corrected by DEC-037).
 *
 * Every successfully validated wrapper appears exactly once as a member of
 * exactly one group, and every group receives exactly one current disposition.
 * No representative wrapper is invented, and duplicate multiplicity is
 * preserved.
 */

const SHARED_CONTENT = 'shared alpha beta gamma';

/** One candidate wrapper carrying the exact shared content and optional retrieval. */
function sharedCandidate(id: string, retrieval?: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    block: contextBlock({ id, content: SHARED_CONTENT }),
    ...(retrieval === undefined ? {} : { retrieval }),
  };
}

const RETRIEVAL_SCORING = tracePolicy({
  scoring: {
    schemaVersion: 1,
    policyId: 'scoring',
    policyVersion: '1.0.0',
    authoredPriority: { weight: 1, min: 0, max: 1000 },
    retrieval: {
      weight: 1,
      aggregation: 'max',
      rules: [
        {
          ruleId: 'cosine',
          providerId: 'sqlite-fts5',
          providerVersion: '1.2.3',
          semantics: 'cosine-similarity',
          higherIsBetter: true,
          min: 0,
          max: 1,
        },
      ],
    },
  },
});

describe('INV-TRACE-001: every validated wrapper is accounted for exactly once', () => {
  /**
   * A batch mixing all three duplicate shapes: two different block IDs with the
   * same content, one block ID repeated with different retrieval evidence, and
   * one byte-identical wrapper repeated.
   */
  function mixedRun(): ReturnType<typeof runPipeline> {
    const byteIdentical = sharedCandidate('dup-a');
    return runPipeline({
      policy: RETRIEVAL_SCORING,
      candidates: [
        byteIdentical,
        byteIdentical,
        sharedCandidate('dup-a', {
          providerId: 'sqlite-fts5',
          providerVersion: '1.2.3',
          rank: 4,
          score: { value: 0.5, semantics: 'cosine-similarity', higherIsBetter: true },
        }),
        sharedCandidate('dup-b'),
        candidateOf({ id: 'solo', tokens: 2 }),
      ],
    });
  }

  it('places every validated wrapper in exactly one group member', () => {
    const run = mixedRun();
    const built = buildTrace(run);

    const members = built.groups.flatMap((group) => group.members);
    expect(members).toHaveLength(run.validated.candidates.length);
    expect(members).toHaveLength(5);

    // Every validated wrapper's block ID is accounted for with its multiplicity.
    const countOf = (ids: readonly string[]): Record<string, number> =>
      ids.reduce<Record<string, number>>(
        (counts, id) => ({ ...counts, [id]: (counts[id] ?? 0) + 1 }),
        {},
      );
    expect(countOf(members.map((member) => member.blockId))).toEqual(
      countOf(run.validated.candidates.map((candidate) => candidate.block.id)),
    );
  });

  it('preserves duplicate multiplicity rather than collapsing identical wrappers', () => {
    const built = buildTrace(mixedRun());
    const group = groupFor(built, 'dup-a');

    expect(group.members).toHaveLength(4);
    // Two wrappers are byte-identical, so the trace holds two identical records.
    const withoutRetrieval = group.members.filter((member) => member.retrieval === undefined);
    expect(withoutRetrieval).toHaveLength(3);
    expect(withoutRetrieval[0]).toStrictEqual(withoutRetrieval[1]);
  });

  it('invents no representative-wrapper field and no wrapper identity', () => {
    const built = buildTrace(mixedRun());
    const group = groupFor(built, 'dup-a');

    for (const forbidden of [
      'representative',
      'representativeWrapper',
      'canonicalMember',
      'primaryMember',
      'candidateId',
      'wrapperId',
      'index',
      'position',
    ]) {
      expect(Object.keys(group), `group exposes ${forbidden}`).not.toContain(forbidden);
      for (const member of group.members) {
        expect(Object.keys(member), `member exposes ${forbidden}`).not.toContain(forbidden);
      }
    }
    const plain = group.members.find((member) => member.retrieval === undefined);
    expect(Object.keys(plain ?? {}).sort()).toEqual(['blockId', 'matchReason', 'sourceDocumentId']);
  });

  it('INV-DEDUP-001: records the exact canonical selection reason', () => {
    const built = buildTrace(mixedRun());
    // Two distinct block IDs, neither required: the stable block ID decides.
    expect(groupFor(built, 'dup-a').canonicalSelectionReason).toBe('stable-block-id');
    expect(groupFor(built, 'solo').canonicalSelectionReason).toBe('single-block');

    const required = trace({
      candidates: [
        {
          schemaVersion: 1,
          block: contextBlock({
            id: 'zzz',
            content: SHARED_CONTENT,
            attributes: { required: true },
          }),
        },
        sharedCandidate('aaa'),
      ],
    });
    // INV-DEDUP-002: required wins over the lexicographically smaller optional.
    expect(required.groups[0]?.canonical.id).toBe('zzz');
    expect(required.groups[0]?.canonicalSelectionReason).toBe('required-block');
  });

  it('INV-DEDUP-003: records the exact match reason of every member', () => {
    const built = buildTrace(mixedRun());
    const group = groupFor(built, 'dup-a');
    const reasons = group.members.map((member) => `${member.blockId}:${member.matchReason}`).sort();

    expect(reasons).toEqual([
      'dup-a:same-block-id',
      'dup-a:same-block-id',
      'dup-a:same-block-id',
      'dup-b:same-normalized-content',
    ]);
  });

  it('INV-SCORE-002: preserves retrieval identity, rank, and score without metadata', () => {
    const built = buildTrace(mixedRun());
    const member = groupFor(built, 'dup-a').members.find((entry) => entry.retrieval !== undefined);

    expect(member?.retrieval).toStrictEqual({
      providerId: 'sqlite-fts5',
      providerVersion: '1.2.3',
      rank: 4,
      score: { value: 0.5, semantics: 'cosine-similarity', higherIsBetter: true },
    });
  });

  it('omits retrieval metadata even when the provider supplied it', () => {
    const built = buildTrace(
      runPipeline({
        policy: RETRIEVAL_SCORING,
        candidates: [
          sharedCandidate('only', {
            providerId: 'sqlite-fts5',
            providerVersion: '1.2.3',
            metadata: { providerRowId: 'row-88', snippet: 'unwanted' },
          }),
        ],
      }),
    );
    const member = built.groups[0]?.members[0];

    expect(Object.keys(member?.retrieval ?? {}).sort()).toEqual(['providerId', 'providerVersion']);
    expect(JSON.stringify(built)).not.toContain('row-88');
  });

  it('omits the retrieval record entirely for a wrapper that carries none', () => {
    const built = trace({ specs: [{ id: 'plain', tokens: 2 }] });
    expect(Object.keys(built.groups[0]?.members[0] ?? {})).not.toContain('retrieval');
  });

  it('records every canonical block audit field and omits the absent ones', () => {
    const built = trace({
      specs: [
        { id: 'full', tokens: 2, priority: 42, category: 'facts', required: true },
        { id: 'bare', tokens: 2, sourceLocation: null },
      ],
    });

    const full = groupFor(built, 'full').canonical;
    expect(full.required).toBe(true);
    expect(full.priority).toBe(42);
    expect(full.category).toBe('facts');
    expect(full.sourceLocation).toEqual({
      kind: 'text-range',
      startOffset: 0,
      endOffset: 'full w0'.length,
    });

    const bare = groupFor(built, 'bare').canonical;
    expect(bare.required).toBe(false);
    for (const absent of ['priority', 'category', 'sourceLocation']) {
      expect(Object.keys(bare), `bare exposes ${absent}`).not.toContain(absent);
    }
  });
});

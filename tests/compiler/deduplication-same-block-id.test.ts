import { CandidateDeduplicator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { candidate, validateCandidates } from './deduplication-fixtures.js';

const deduplicator = new CandidateDeduplicator();

const searchRetrieval = {
  providerId: 'sqlite-fts5',
  providerVersion: '1.2.3',
  rank: 0,
  score: { value: 12.5, semantics: 'bm25-score', higherIsBetter: true },
  metadata: { providerRowId: 41 },
};

const vectorRetrieval = {
  providerId: 'qdrant',
  providerVersion: '9.9.9',
  rank: 7,
  score: { value: 0.13, semantics: 'distance', higherIsBetter: false },
};

describe('CandidateDeduplicator: repeated wrappers of one block ID', () => {
  it('INV-DEDUP-001: collapses two identical wrappers into one group', () => {
    const validated = validateCandidates([candidate(), candidate()]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.members).toHaveLength(2);
    expect(result.candidates[0]?.canonicalSelectionReason).toBe('single-block');
  });

  it('INV-DEDUP-001: collapses one block ID carried with different retrieval metadata', () => {
    const validated = validateCandidates([
      candidate({}, searchRetrieval),
      candidate({}, vectorRetrieval),
      candidate(),
    ]);
    const result = deduplicator.deduplicate(validated);

    expect(result.candidates).toHaveLength(1);
    const group = result.candidates[0];
    expect(group?.members).toHaveLength(3);
    expect(group?.canonicalSelectionReason).toBe('single-block');
    for (const member of group?.members ?? []) {
      expect(member.matchReason).toBe('same-block-id');
    }
  });

  it('INV-SCORE-002: preserves every retrieval record exactly and fabricates none', () => {
    const validated = validateCandidates([
      candidate({}, searchRetrieval),
      candidate({}, vectorRetrieval),
      candidate(),
    ]);
    const result = deduplicator.deduplicate(validated);

    const retrievals = (result.candidates[0]?.members ?? []).map(
      (member) => member.candidate.retrieval,
    );

    expect(retrievals).toContainEqual(searchRetrieval);
    expect(retrievals).toContainEqual(vectorRetrieval);
    // Retrieval absence is evidence too: it is preserved, never filled in.
    expect(retrievals.filter((entry) => entry === undefined)).toHaveLength(1);
    expect(retrievals).toHaveLength(3);

    // No merged, averaged, maximized, or otherwise synthesized retrieval object.
    const providerIds = retrievals.map((entry) => entry?.providerId);
    expect(providerIds.filter((id) => id === 'sqlite-fts5')).toHaveLength(1);
    expect(providerIds.filter((id) => id === 'qdrant')).toHaveLength(1);
  });

  it('INV-SCORE-002: preserves provider identity, rank, value, semantics, and direction', () => {
    const validated = validateCandidates([
      candidate({}, searchRetrieval),
      candidate({}, vectorRetrieval),
    ]);
    const result = deduplicator.deduplicate(validated);

    const byProvider = new Map(
      (result.candidates[0]?.members ?? []).map((member) => [
        member.candidate.retrieval?.providerId,
        member.candidate.retrieval,
      ]),
    );

    expect(byProvider.get('sqlite-fts5')?.providerVersion).toBe('1.2.3');
    expect(byProvider.get('sqlite-fts5')?.rank).toBe(0);
    expect(byProvider.get('sqlite-fts5')?.score).toEqual({
      value: 12.5,
      semantics: 'bm25-score',
      higherIsBetter: true,
    });
    expect(byProvider.get('sqlite-fts5')?.metadata).toEqual({ providerRowId: 41 });

    expect(byProvider.get('qdrant')?.rank).toBe(7);
    expect(byProvider.get('qdrant')?.score).toEqual({
      value: 0.13,
      semantics: 'distance',
      higherIsBetter: false,
    });
    expect(byProvider.get('qdrant')?.metadata).toBeUndefined();
  });

  it('INV-TRACE-001: keeps every wrapper, one per group member', () => {
    const validated = validateCandidates([
      candidate({}, searchRetrieval),
      candidate({}, vectorRetrieval),
      candidate(),
      candidate({}, searchRetrieval),
    ]);
    const result = deduplicator.deduplicate(validated);

    const members = result.candidates.flatMap((group) => group.members);
    expect(members).toHaveLength(validated.candidates.length);
    expect([...members].map((member) => member.candidate)).toEqual(
      expect.arrayContaining([...validated.candidates]),
    );
  });
});

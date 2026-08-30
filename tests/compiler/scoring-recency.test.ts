import { describe, expect, it } from 'vitest';
import {
  ONE_DAY,
  candidate,
  omit,
  policy,
  retrieval,
  score,
  secondsAfterReference,
  secondsBeforeReference,
  sourceDocument,
} from './scoring-fixtures.js';

const RECENCY = policy({ recency: { weight: 1, maxAgeSeconds: ONE_DAY, missingValue: 0.25 } });

function normalizedOf(candidates: readonly Record<string, unknown>[]): number | undefined {
  return score(candidates, RECENCY).candidates[0]?.score.recency?.normalizedValue;
}

describe('CandidateScorer: recency', () => {
  it('prefers updatedAt over createdAt', () => {
    const result = score(
      [
        candidate({
          createdAt: secondsBeforeReference(ONE_DAY),
          updatedAt: secondsBeforeReference(0),
        }),
      ],
      RECENCY,
    );
    const evidence = result.candidates[0]?.score.recency?.evidence[0];

    expect(evidence?.timestampField).toBe('updatedAt');
    expect(evidence?.normalizedValue).toBe(1);
  });

  it('falls back to createdAt when updatedAt is absent', () => {
    const result = score(
      [omit(candidate({ createdAt: secondsBeforeReference(ONE_DAY / 2) }), 'nothing')],
      RECENCY,
    );
    const evidence = result.candidates[0]?.score.recency?.evidence[0];

    expect(evidence?.timestampField).toBe('createdAt');
    expect(evidence?.normalizedValue).toBe(0.5);
  });

  it('uses the explicit policy missingValue when the block carries no timestamp', () => {
    const result = score([candidate()], RECENCY);
    const evidence = result.candidates[0]?.score.recency?.evidence[0];

    expect(evidence).toEqual({
      blockId: 'block-1',
      normalizedValue: 0.25,
      valueSource: 'policy-missing-value',
    });
    expect(evidence && 'timestamp' in evidence).toBe(false);
    expect(evidence && 'ageSeconds' in evidence).toBe(false);
  });

  it('maps age zero to one, half the maximum age to a half, and the maximum age to zero', () => {
    expect(normalizedOf([candidate({ updatedAt: secondsBeforeReference(0) })])).toBe(1);
    expect(normalizedOf([candidate({ updatedAt: secondsBeforeReference(ONE_DAY / 2) })])).toBe(0.5);
    expect(normalizedOf([candidate({ updatedAt: secondsBeforeReference(ONE_DAY) })])).toBe(0);
  });

  it('clamps content older than the maximum age to zero rather than below it', () => {
    expect(normalizedOf([candidate({ updatedAt: secondsBeforeReference(ONE_DAY * 10) })])).toBe(0);
    expect(normalizedOf([candidate({ updatedAt: '2000-01-01T00:00:00.000Z' })])).toBe(0);
  });

  it('clamps a future timestamp to age zero rather than above one', () => {
    const result = score([candidate({ updatedAt: secondsAfterReference(ONE_DAY * 365) })], RECENCY);
    const evidence = result.candidates[0]?.score.recency?.evidence[0];

    expect(evidence?.ageSeconds).toBe(0);
    expect(evidence?.normalizedValue).toBe(1);
  });

  it('aggregates distinct duplicate blocks by maximum', () => {
    const result = score(
      [
        candidate({ id: 'block-1', updatedAt: secondsBeforeReference(ONE_DAY) }),
        candidate({ id: 'block-2', updatedAt: secondsBeforeReference(ONE_DAY / 4) }),
        candidate({ id: 'block-3' }),
      ],
      RECENCY,
    );
    const component = result.candidates[0]?.score.recency;

    expect(result.candidates).toHaveLength(1);
    expect(component?.normalizedValue).toBe(0.75);
    expect(component?.evidence.map((record) => [record.blockId, record.normalizedValue])).toEqual([
      ['block-1', 0],
      ['block-2', 0.75],
      ['block-3', 0.25],
    ]);
  });

  it('does not duplicate recency evidence when one block is wrapped repeatedly', () => {
    const wrappers = Array.from({ length: 6 }, (_unused, index) =>
      candidate({ updatedAt: secondsBeforeReference(ONE_DAY / 2) }, retrieval({ rank: index })),
    );
    const result = score(wrappers, RECENCY);

    expect(result.candidates[0]?.candidate.members).toHaveLength(6);
    expect(result.candidates[0]?.score.recency?.evidence).toHaveLength(1);
    expect(result.candidates[0]?.score.recency?.normalizedValue).toBe(0.5);
  });

  it('publishes the policy that produced each normalized value', () => {
    const result = score([candidate({ updatedAt: secondsBeforeReference(ONE_DAY / 4) })], RECENCY);

    expect(result.candidates[0]?.score.recency).toEqual({
      normalizedValue: 0.75,
      weight: 1,
      contribution: 0.75,
      aggregation: 'max',
      maxAgeSeconds: ONE_DAY,
      missingValue: 0.25,
      evidence: [
        {
          blockId: 'block-1',
          timestamp: secondsBeforeReference(ONE_DAY / 4),
          timestampField: 'updatedAt',
          ageSeconds: ONE_DAY / 4,
          normalizedValue: 0.75,
          valueSource: 'timestamp',
        },
      ],
    });
  });

  it('reads no SourceDocument timestamp as a hidden fallback', () => {
    const withDocumentTimes = [
      sourceDocument({
        id: 'doc-1',
        createdAt: secondsBeforeReference(0),
        updatedAt: secondsBeforeReference(0),
      }),
    ];
    const result = score([candidate()], RECENCY, { sourceDocuments: withDocumentTimes });

    expect(result.candidates[0]?.score.recency?.normalizedValue).toBe(0.25);
    expect(result.candidates[0]?.score.recency?.evidence[0]?.valueSource).toBe(
      'policy-missing-value',
    );
  });

  it('ignores timestamps entirely when the recency component is not configured', () => {
    const fresh = score([candidate({ updatedAt: secondsBeforeReference(0) })], policy());
    const stale = score([candidate({ updatedAt: '2000-01-01T00:00:00.000Z' })], policy());

    expect(fresh.candidates[0]?.score).toEqual({ total: 0 });
    expect(stale.candidates[0]?.score).toEqual({ total: 0 });
  });
});

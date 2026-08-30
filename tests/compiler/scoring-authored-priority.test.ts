import { describe, expect, it } from 'vitest';
import { candidate, issuesOf, policy, retrieval, score } from './scoring-fixtures.js';

const AUTHORED = policy({ authoredPriority: { weight: 1, min: -10, max: 10 } });

function normalizedOf(candidates: readonly Record<string, unknown>[]): number | undefined {
  return score(candidates, AUTHORED).candidates[0]?.score.authoredPriority?.normalizedValue;
}

describe('CandidateScorer: authored priority', () => {
  it('maps the declared inclusive range onto [0, 1]', () => {
    expect(normalizedOf([candidate({ attributes: { priority: -10 } })])).toBe(0);
    expect(normalizedOf([candidate({ attributes: { priority: 0 } })])).toBe(0.5);
    expect(normalizedOf([candidate({ attributes: { priority: 10 } })])).toBe(1);
    expect(normalizedOf([candidate({ attributes: { priority: 5 } })])).toBe(0.75);
  });

  it('rejects a priority outside the policy range rather than clamping it', () => {
    for (const priority of [-11, 11, 1000, Number.MIN_SAFE_INTEGER]) {
      const issues = issuesOf(() => score([candidate({ attributes: { priority } })], AUTHORED));
      expect(
        issues.map((issue) => issue.code),
        String(priority),
      ).toEqual(['authored_priority_out_of_range']);
      expect(issues[0]?.message).toContain('[-10, 10]');
      expect(issues[0]?.pointer).toBe('candidates.block-1.blocks.block-1.attributes.priority');
    }
  });

  it('treats an absent priority as no evidence, contributing zero', () => {
    const result = score([candidate({ attributes: {} })], AUTHORED);
    const component = result.candidates[0]?.score.authoredPriority;

    expect(component?.evidence).toEqual([]);
    expect(component?.normalizedValue).toBe(0);
    expect(component?.contribution).toBe(0);
  });

  it('counts one repeated block once, however many wrappers carry it', () => {
    const wrappers = Array.from({ length: 12 }, (_unused, index) =>
      candidate({ attributes: { priority: 10 } }, retrieval({ rank: index })),
    );
    const result = score(wrappers, AUTHORED);
    const component = result.candidates[0]?.score.authoredPriority;

    expect(result.candidates[0]?.candidate.members).toHaveLength(12);
    expect(component?.evidence).toEqual([{ blockId: 'block-1', priority: 10, normalizedValue: 1 }]);
    expect(component?.normalizedValue).toBe(1);
  });

  it('aggregates distinct duplicate blocks by maximum, never by sum', () => {
    const result = score(
      [
        candidate({ id: 'block-1', attributes: { priority: 2 } }),
        candidate({ id: 'block-2', attributes: { priority: 8 } }),
        candidate({ id: 'block-3', attributes: { priority: -6 } }),
      ],
      AUTHORED,
    );
    const component = result.candidates[0]?.score.authoredPriority;

    expect(result.candidates).toHaveLength(1);
    expect(component?.normalizedValue).toBe(0.9);
    expect(component?.evidence.map((record) => [record.blockId, record.priority])).toEqual([
      ['block-1', 2],
      ['block-2', 8],
      ['block-3', -6],
    ]);
  });

  it('INV-SCORE-003: does not read required status as a priority', () => {
    const optional = score([candidate({ attributes: { priority: 3 } })], AUTHORED);
    const required = score([candidate({ attributes: { priority: 3, required: true } })], AUTHORED);

    expect(required.candidates[0]?.score).toEqual(optional.candidates[0]?.score);
  });

  it('publishes the policy range that produced each normalized value', () => {
    const result = score([candidate({ attributes: { priority: 0 } })], AUTHORED);

    expect(result.candidates[0]?.score.authoredPriority).toEqual({
      normalizedValue: 0.5,
      weight: 1,
      contribution: 0.5,
      aggregation: 'max',
      min: -10,
      max: 10,
      evidence: [{ blockId: 'block-1', priority: 0, normalizedValue: 0.5 }],
    });
  });

  it('scores nothing from authored priority when the component is not configured', () => {
    const result = score([candidate({ attributes: { priority: 10 } })], policy());

    expect(result.candidates[0]?.score.authoredPriority).toBeUndefined();
    expect(result.candidates[0]?.score.total).toBe(0);
  });

  it('does not mutate the scored ContextBlock', () => {
    const batch = score([candidate({ attributes: { priority: 4, category: 'policy' } })], AUTHORED);
    const block = batch.candidates[0]?.candidate.canonicalBlock;

    expect(block?.attributes).toEqual({ priority: 4, category: 'policy' });
  });
});

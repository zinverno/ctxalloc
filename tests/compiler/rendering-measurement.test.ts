import { ContextRenderer, ContextRenderingError } from '@ctxalloc/compiler';
import { FakeTokenizer } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  candidate,
  fixedTokenizer,
  issueCodesOf,
  issuesOf,
  linesOf,
  orderCandidates,
  orderSpecs,
  orderedBlocks,
  recordingTokenizer,
  render,
  renderingPolicy,
  sourceDocument,
  withAllocation,
} from './rendering-fixtures.js';

/**
 * Exact measurement of the complete rendered string (INV-BUDGET-002).
 *
 * The renderer tokenizes the one string it produced and publishes nothing it did
 * not measure: no sum of block counts, no sum of record counts, no separator
 * arithmetic, and no character estimate (DEC-035).
 */

/** A located block whose offsets fix its render position inside `doc-1`. */
function located(id: string, content: string, startOffset: number): Record<string, unknown> {
  return candidate({
    id,
    content,
    sourceLocation: { kind: 'text-range', startOffset, endOffset: startOffset + content.length },
  });
}

describe('INV-BUDGET-002: the complete rendered string is the measured string', () => {
  it('counts only the complete joined string, never a sum of parts', () => {
    const ordered = orderCandidates([
      located('block-a', 'alpha alpha alpha', 0),
      located('block-b', 'beta beta beta', 100),
    ]);
    const blocks = orderedBlocks(ordered);
    const draft = render(ordered, fixedTokenizer(0));
    const records = linesOf(draft);

    // Every part is separately countable, and every part has a deliberately
    // different count from the whole. Only the complete string maps to 7.
    const tokenizer = new FakeTokenizer([
      ...blocks.map((block) => ({ text: block.content, tokens: 1000 })),
      ...records.map((record) => ({ text: record, tokens: 500 })),
      { text: draft.renderedContext, tokens: 7 },
    ]);

    const result = render(ordered, tokenizer);

    expect(result.renderedTokens).toBe(7);
    expect(result.renderedTokens).not.toBe(1000 + 1000);
    expect(result.renderedTokens).not.toBe(500 + 500);
    expect(result.renderedTokens).toBe(tokenizer.countTokens(result.renderedContext));
  });

  it('calls the tokenizer exactly once, on the exact rendered string', () => {
    const calls: string[] = [];
    const ordered = orderCandidates([
      located('block-a', 'alpha content', 0),
      located('block-b', 'beta content', 100),
    ]);
    const result = render(ordered, recordingTokenizer(calls, 11));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(result.renderedContext);
  });

  it('follows every change to the static render text', () => {
    const base = orderCandidates([candidate({ content: 'stable content here' })]);
    const variants = [
      base,
      orderCandidates([candidate({ id: 'block-renamed', content: 'stable content here' })]),
      orderCandidates([candidate({ sourceType: 'text', content: 'stable content here' })], {
        sourceDocuments: [sourceDocument({ sourceType: 'text' })],
      }),
      orderCandidates([
        candidate({ headingPath: ['Guide', 'Setup'], content: 'stable content here' }),
      ]),
      orderCandidates([candidate({ content: 'stable "quoted" content\nhere' })]),
      orderCandidates([
        located('block-a', 'stable content here', 0),
        located('block-b', 'second record content', 100),
      ]),
    ];

    const strings = variants.map((ordered) => render(ordered, fixedTokenizer(0)).renderedContext);
    // Every variant produces a different complete string, and the fixture maps
    // each one to a different count, so a count that ignored any part of the
    // static text could not follow.
    expect(new Set(strings).size).toBe(strings.length);

    const tokenizer = new FakeTokenizer(
      strings.map((text, index) => ({ text, tokens: (index + 1) * 13 })),
    );
    variants.forEach((ordered, index) => {
      expect(render(ordered, tokenizer).renderedTokens).toBe((index + 1) * 13);
    });
  });
});

describe('context rendering: tokenizer failure', () => {
  const ordered = orderCandidates([candidate()]);

  it('wraps a thrown Error as a project-owned failure', () => {
    class EncoderError extends Error {
      readonly libraryDetail = 'internal encoder state';
    }
    const thrower = {
      id: 'test:exploding',
      version: '1',
      countTokens: (): number => {
        const error = new EncoderError('encoder exploded');
        error.name = 'EncoderError';
        throw error;
      },
    };

    const issues = issuesOf(() => render(ordered, thrower));
    expect(issues.map((issue) => issue.code)).toEqual(['tokenizer_failed']);
    expect(issues[0]?.pointer).toBe('renderedContext');
    expect(issues[0]?.message).toContain('EncoderError: encoder exploded');
    expect(() => render(ordered, thrower)).toThrow(ContextRenderingError);
  });

  it('wraps a thrown non-Error without leaking the value', () => {
    const thrower = {
      id: 'test:exploding',
      version: '1',
      countTokens: (): number => {
        throw { secret: 'library object' };
      },
    };

    const issues = issuesOf(() => render(ordered, thrower));
    expect(issues.map((issue) => issue.code)).toEqual(['tokenizer_failed']);
    expect(issues[0]?.message).toContain('a non-Error value (object)');
    expect(issues[0]?.message).not.toContain('library object');
  });

  it('rejects every unusable count with a focused issue code', () => {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '4', null]) {
      expect(
        issueCodesOf(() => render(ordered, fixedTokenizer(value as number))),
        `count ${String(value)}`,
      ).toEqual(['invalid_rendered_token_count']);
    }
  });

  it('returns no partial attempt when measurement fails', () => {
    let result: unknown = 'unset';
    try {
      result = render(ordered, fixedTokenizer(-1));
    } catch (error) {
      expect(error).toBeInstanceOf(ContextRenderingError);
      expect((error as ContextRenderingError).code).toBe('CONTEXT_RENDERING_FAILED');
    }
    expect(result).toBe('unset');
  });

  it('accepts a zero count and a large safe-integer count', () => {
    expect(render(ordered, fixedTokenizer(0)).renderedTokens).toBe(0);
    expect(render(ordered, fixedTokenizer(Number.MAX_SAFE_INTEGER)).renderedTokens).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe('context rendering: signed rendered token delta', () => {
  const ordered = orderCandidates([candidate()]);

  it('is positive when the rendered string costs more than the block content', () => {
    const result = render(withAllocation(ordered, { selected: 10 }), fixedTokenizer(31));
    expect(result.renderedTokenDelta).toBe(21);
  });

  it('is zero when they are equal, and never negative zero', () => {
    const result = render(withAllocation(ordered, { selected: 12 }), fixedTokenizer(12));
    expect(result.renderedTokenDelta).toBe(0);
    expect(Object.is(result.renderedTokenDelta, -0)).toBe(false);
    expect(Object.is(result.renderedTokenDelta, 0)).toBe(true);
  });

  it('is negative when the complete string counts fewer tokens than the block sum, and is not clamped', () => {
    // Tokenization is not additive: embedding content in a larger string can
    // merge boundaries, so the whole may count fewer tokens than the parts. The
    // old non-negative "rendering overhead" definition is invalid (METRICS 8.6).
    const result = render(withAllocation(ordered, { selected: 40 }), fixedTokenizer(9));

    expect(result.renderedTokenDelta).toBe(-31);
    expect(result.renderedTokens).toBe(9);
    expect(result.ordered.allocation.selectedBlockContentTokens).toBe(40);
  });

  it('reports a negative delta as success, with no error and no repair', () => {
    const tokenizer = new FakeTokenizer([{ text: '', tokens: 0 }]);
    const empty = withAllocation(orderSpecs([{ id: 'block-1', tokens: 5 }], { available: 0 }), {
      selected: 25,
    });
    const result = render(empty, tokenizer);

    expect(result.renderedContext).toBe('');
    expect(result.renderedTokens).toBe(0);
    expect(result.renderedTokenDelta).toBe(-25);
  });

  it('exposes no final compiled metric under a provisional value', () => {
    const result = render(ordered, fixedTokenizer(5));
    for (const forbidden of [
      'compiledTokens',
      'unusedTokens',
      'tokenReduction',
      'budgetUtilization',
      'renderingOverheadTokens',
      'renderingTokenDelta',
      'includedContentTokens',
    ]) {
      expect(Object.keys(result), `exposes ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('context rendering: budget observation', () => {
  const ordered = orderCandidates([candidate()]);

  it('is true one token under the available budget', () => {
    expect(
      render(withAllocation(ordered, { available: 100 }), fixedTokenizer(99))
        .fitsAvailableInputBudget,
    ).toBe(true);
  });

  it('is true at exact equality', () => {
    expect(
      render(withAllocation(ordered, { available: 100 }), fixedTokenizer(100))
        .fitsAvailableInputBudget,
    ).toBe(true);
  });

  it('is false one token over the available budget', () => {
    expect(
      render(withAllocation(ordered, { available: 100 }), fixedTokenizer(101))
        .fitsAvailableInputBudget,
    ).toBe(false);
  });

  it('is true for zero available and zero rendered', () => {
    expect(
      render(withAllocation(ordered, { available: 0 }), fixedTokenizer(0)).fitsAvailableInputBudget,
    ).toBe(true);
  });

  it('is false for zero available and a positive rendered count', () => {
    expect(
      render(withAllocation(ordered, { available: 0 }), fixedTokenizer(1)).fitsAvailableInputBudget,
    ).toBe(false);
  });

  it('returns a successful attempt when the render does not fit', () => {
    const over = render(withAllocation(ordered, { available: 1 }), fixedTokenizer(9_999));

    expect(over.fitsAvailableInputBudget).toBe(false);
    expect(over.renderedTokens).toBe(9_999);
    // No eviction, no failure, no REQUIRED_CONTENT_EXCEEDS_BUDGET.
    expect(over.ordered.orderedIncluded).toHaveLength(1);
    expect(linesOf(over)).toHaveLength(1);
  });

  it('subtracts no reserve of its own and leaves the token budget untouched', () => {
    const withBudget = withAllocation(ordered, { available: 50 });
    const before = JSON.stringify(withBudget.allocation.tokenBudget);
    const result = render(withBudget, fixedTokenizer(50));

    expect(result.fitsAvailableInputBudget).toBe(true);
    expect(JSON.stringify(result.ordered.allocation.tokenBudget)).toBe(before);
    expect(result.ordered.allocation.availableInputTokens).toBe(50);
  });
});

describe('context rendering: renderer identity', () => {
  it('publishes a stable project-owned renderer identity and version', () => {
    const result = render(orderCandidates([candidate()]), fixedTokenizer(3));

    expect(result.rendererId).toBe('ctxalloc-jsonl');
    expect(result.rendererVersion).toBe('1');
  });

  it('publishes the exact tokenizer identity that produced the count', () => {
    const tokenizer = new FakeTokenizer([], { id: 'fake', version: '9.9.9' });
    const empty = orderSpecs([{ id: 'block-1', tokens: 5 }], { available: 0 });
    const result = new ContextRenderer(renderingPolicy(), {
      ...tokenizer,
      countTokens: (text: string): number => text.length,
    }).render(empty);

    expect(result.tokenizerId).toBe('fake');
    expect(result.tokenizerVersion).toBe('9.9.9');
  });
});

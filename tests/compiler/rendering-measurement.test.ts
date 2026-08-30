import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateScorer,
  CandidateValidator,
  ContextOrderer,
  ContextRenderer,
  ContextRenderingError,
} from '@ctxalloc/compiler';
import { FakeTokenizer } from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  candidate,
  contextBlock,
  fixedTokenizer,
  issueCodesOf,
  issuesOf,
  linesOf,
  orderCandidates,
  orderSpecs,
  orderedBlocks,
  orderingPolicy,
  recordingTokenizer,
  recordsOf,
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

describe('context rendering: no token delta is published', () => {
  const ordered = orderCandidates([candidate()]);

  it('publishes the exact result fields and nothing more', () => {
    const result = render(ordered, fixedTokenizer(5));

    expect(Object.keys(result).sort()).toEqual([
      'fitsAvailableInputBudget',
      'ordered',
      'renderedContext',
      'renderedTokens',
      'rendererId',
      'rendererVersion',
      'renderingPolicyId',
      'renderingPolicyVersion',
      'tokenizerId',
      'tokenizerVersion',
    ]);
  });

  it('exposes no token delta and no final compiled metric', () => {
    const result = render(ordered, fixedTokenizer(5));

    for (const forbidden of [
      // A delta against `selectedBlockContentTokens` needs one tokenizer
      // identity behind both operands, and this stage cannot prove that.
      'renderedTokenDelta',
      'renderingTokenDelta',
      'renderingOverheadTokens',
      // Final metrics of a settled selection.
      'compiledTokens',
      'unusedTokens',
      'tokenReduction',
      'budgetUtilization',
      'includedContentTokens',
    ]) {
      expect(Object.keys(result), `exposes ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('leaves selectedBlockContentTokens reachable through the nested allocation', () => {
    // The value is not hidden: it is simply not subtracted here, because this
    // stage cannot establish that the two counts share a tokenizer.
    const result = render(ordered, fixedTokenizer(5));

    expect(result.ordered.allocation.selectedBlockContentTokens).toBe(
      ordered.allocation.selectedBlockContentTokens,
    );
  });
});

describe('context rendering: mismatched tokenizers cannot produce a bogus delta', () => {
  // A deliberately miscomposed stage chain, and the reason the attempt publishes
  // no delta (DEC-035).
  //
  //   CandidateValidator runs under tok-A, which counts the block content as 100.
  //   ContextRenderer runs under tok-B, which counts the whole rendered string
  //   as 10.
  //
  // `100 - 10` describes nothing: the operands come from two vocabularies. A
  // published `renderedTokenDelta` of `-90` would read as "rendering saved 90
  // tokens", which is false.
  const CONTENT = 'mismatched tokenizer counterexample content';

  const tokenizerA = new FakeTokenizer([{ text: CONTENT, tokens: 100 }], {
    id: 'tok-A',
    version: '1',
  });

  function compileWith(available: number): {
    readonly ordered: ReturnType<typeof orderCandidates>;
    readonly renderedContext: string;
  } {
    const validated = new CandidateValidator(tokenizerA).validate({
      scope: { tenantId: 'local', workspaceId: 'default' },
      sourceDocuments: [sourceDocument()],
      candidates: [
        { schemaVersion: 1, block: contextBlock({ content: CONTENT, tokenCount: 100 }) },
      ],
    });
    const scored = new CandidateScorer({ ...ALLOCATION_SCORING_POLICY }).score(
      new CandidateDeduplicator().deduplicate(validated),
      '2026-06-01T12:00:00.000Z',
    );
    const allocated = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(available));
    const ordered = new ContextOrderer(orderingPolicy()).order(allocated);
    // The exact string tok-B will be asked to count.
    return { ordered, renderedContext: render(ordered, fixedTokenizer(0)).renderedContext };
  }

  it("reports tok-B's count and tok-B's identity, and no delta at all", () => {
    const { ordered, renderedContext } = compileWith(1000);
    const tokenizerB = new FakeTokenizer([{ text: renderedContext, tokens: 10 }], {
      id: 'tok-B',
      version: '1',
    });

    const result = render(ordered, tokenizerB);

    // The block-content sum came from tok-A.
    expect(result.ordered.allocation.selectedBlockContentTokens).toBe(100);
    // The rendered count came from tok-B, on the exact complete string.
    expect(result.renderedTokens).toBe(10);
    expect(result.tokenizerId).toBe('tok-B');
    expect(result.tokenizerVersion).toBe('1');
    // And the misleading `100 - 10` is never published.
    expect(Object.keys(result)).not.toContain('renderedTokenDelta');
    expect(Object.values(result)).not.toContain(-90);
  });

  it('observes the budget against the rendered count, not the block-content sum', () => {
    // tok-A's 100 would not fit a budget of 50; tok-B's 10 does. The observation
    // follows the string that was actually measured.
    const { ordered, renderedContext } = compileWith(50);
    const tokenizerB = new FakeTokenizer([{ text: renderedContext, tokens: 10 }], {
      id: 'tok-B',
      version: '1',
    });

    const result = render(ordered, tokenizerB);

    expect(result.ordered.allocation.availableInputTokens).toBe(50);
    expect(result.renderedTokens).toBe(10);
    expect(result.fitsAvailableInputBudget).toBe(true);
  });

  it('renders the content unchanged regardless of which tokenizer measures it', () => {
    const { ordered, renderedContext } = compileWith(1000);
    const tokenizerB = new FakeTokenizer([{ text: renderedContext, tokens: 10 }], {
      id: 'tok-B',
      version: '1',
    });

    expect(render(ordered, tokenizerB).renderedContext).toBe(renderedContext);
    expect(recordsOf(render(ordered, tokenizerB))[0]?.['content']).toBe(CONTENT);
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

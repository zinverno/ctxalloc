import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { O200K_BASE_TOKENIZER_ID, O200kBaseTokenizer } from '@ctxalloc/tokenization';
import {
  compile,
  countWords,
  jsonlOverheadTokenizer,
  recordCount,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * Non-additive, non-monotonic tokenization (METRICS 8.6, DEC-035, DEC-038).
 *
 * The `Tokenizer` port promises the exact count of one supplied string and
 * nothing more:
 *
 * ```text
 * tokenizer(a + b)  is not necessarily  tokenizer(a) + tokenizer(b)
 * ```
 *
 * So the compiler assigns no rendered cost to any block, subtracts no guessed
 * wrapper cost, and proves nothing by summing per-block estimates. The signed
 * `renderingTokenDelta` is a diagnostic, never an attribution.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'one', tokens: 3, priority: 900 },
  { id: 'two', tokens: 3, priority: 500 },
];

describe('INV-BUDGET-002: the compiled count is not a sum of block counts', () => {
  it('measures the rendered string, not the blocks that went into it', () => {
    const result = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(4));

    expect(result.usage.includedContentTokens).toBe(6);
    expect(result.usage.compiledTokens).toBe(6 + 4 * 2);
    expect(result.usage.compiledTokens).not.toBe(result.usage.includedContentTokens);
    expect(recordCount(result.compiledContext)).toBe(2);
  });

  it('accepts a positive renderingTokenDelta', () => {
    const result = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(4));
    expect(result.usage.renderingTokenDelta).toBe(8);
    expect(result.usage.renderingTokenDelta).toBeGreaterThan(0);
  });

  it('accepts a zero renderingTokenDelta', () => {
    const result = compile({ specs: SPECS, available: 100 }, wordTokenizer);
    expect(result.usage.renderingTokenDelta).toBe(0);
  });

  it('METRICS 8.6: accepts a negative renderingTokenDelta and never clamps it', () => {
    // A rendered string may tokenize to *fewer* tokens than the sum of its
    // blocks, because boundaries move once content sits inside a larger string.
    const result = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(-1));

    expect(result.usage.compiledTokens).toBe(4);
    expect(result.usage.includedContentTokens).toBe(6);
    expect(result.usage.renderingTokenDelta).toBe(-2);
    expect(result.trace.settlement.usage.renderingTokenDelta).toBe(-2);
  });

  it('DEC-038: the delta is valid because one tokenizer identity produced both', () => {
    const result = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(-1));
    expect(result.trace.composition.tokenizerCoverage).toBe('validation-and-rendering');
    expect(result.trace.composition.tokenizer).toEqual({ id: 'test:jsonl', version: '1' });
  });

  it('INV-RENDER-004: no source path computes a per-block rendered cost', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const forbidden of [
      'renderedCost',
      'renderCost',
      'perBlockCost',
      'wrapperTokens',
      'overheadPerBlock',
      'estimate',
      'approximate',
      'countTokens(block',
      'countTokens(candidate',
    ]) {
      expect(source, `computes ${forbidden}`).not.toContain(forbidden);
    }
    // The only tokenizer call sites are the shared measurement helper and the
    // renderer the compiler injects the same tokenizer into.
    expect([...source.matchAll(/countTokensSafely\(/g)]).toHaveLength(1);
    expect(source).not.toContain('this.#tokenizer.countTokens');
  });

  it('measures only complete rendered strings, never a fragment', () => {
    const seen: string[] = [];
    const tokenizer = {
      id: 'test:auditing',
      version: '1',
      countTokens: (text: string): number => {
        seen.push(text);
        return countWords(text);
      },
    };
    compile({ specs: SPECS, available: 100 }, tokenizer);

    for (const text of seen) {
      const isBlockContent = SPECS.some((spec) => text.startsWith(`${spec.id} `));
      const isCompleteRender = text === '' || /^\{"blockId":/.test(text);
      expect(isBlockContent || isCompleteRender, `measured a fragment: ${text}`).toBe(true);
    }
  });
});

describe('DEC-038: end-to-end with the real offline tokenizer', () => {
  const tokenizer = new O200kBaseTokenizer();

  /** Blocks whose declared counts come from the real tokenizer, not from words. */
  function realSpecs(): readonly Record<string, unknown>[] {
    const contents = [
      'CtxAlloc compiles candidate context under a strict token budget.',
      'Required blocks form a separate allocation class, never a large score.',
      'Rendering is serialization, not rewriting: content round-trips exactly.',
    ];
    return contents.map((content, index) => ({
      schemaVersion: 1,
      block: {
        id: `real-${String(index)}`,
        schemaVersion: 1,
        scope: { tenantId: 'local', workspaceId: 'default' },
        sourceDocumentId: 'doc-1',
        sourceType: 'markdown',
        sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: content.length },
        content,
        normalizedContentHash: undefined,
        tokenCount: tokenizer.countTokens(content),
        attributes: index === 0 ? { required: true } : { priority: 500 - index },
        metadata: {},
      },
    }));
  }

  it('validates the blocks and measures the final context with one tokenizer', async () => {
    const { calculateNormalizedContentHash } = await import('@ctxalloc/domain');
    const candidates = realSpecs().map((candidate) => {
      const block = candidate['block'] as Record<string, unknown>;
      return {
        ...candidate,
        block: {
          ...block,
          normalizedContentHash: calculateNormalizedContentHash(block['content'] as string),
        },
      };
    });

    const result = compile({ candidates, available: 200 }, tokenizer);

    expect(result.trace.composition.tokenizer.id).toBe(O200K_BASE_TOKENIZER_ID);
    expect(result.trace.composition.tokenizerCoverage).toBe('validation-and-rendering');
    expect(result.includedBlocks).toHaveLength(3);
    // The exact final invariant: the published count is the tokenizer's count of
    // the published string.
    expect(result.usage.compiledTokens).toBe(tokenizer.countTokens(result.compiledContext));
    expect(result.usage.compiledTokens).toBeLessThanOrEqual(result.usage.availableTokens);
    expect(result.usage.unusedTokens).toBe(200 - result.usage.compiledTokens);
    // JSONL wrapping costs real tokens under a real vocabulary.
    expect(result.usage.renderingTokenDelta).toBeGreaterThan(0);
  });

  it('corrects a real over-budget render down to a real fitting one', async () => {
    const { calculateNormalizedContentHash } = await import('@ctxalloc/domain');
    const candidates = realSpecs().map((candidate) => {
      const block = candidate['block'] as Record<string, unknown>;
      return {
        ...candidate,
        block: {
          ...block,
          normalizedContentHash: calculateNormalizedContentHash(block['content'] as string),
        },
      };
    });

    const full = compile({ candidates, available: 200 }, tokenizer);
    const tight = compile({ candidates, available: full.usage.compiledTokens - 1 }, tokenizer);

    expect(tight.trace.settlement.correctionApplied).toBe(true);
    expect(tight.usage.compiledTokens).toBeLessThanOrEqual(tight.usage.availableTokens);
    expect(tight.usage.compiledTokens).toBe(tokenizer.countTokens(tight.compiledContext));
    expect(tight.includedBlocks.map((block) => block.id)).toContain('real-0');
  });
});

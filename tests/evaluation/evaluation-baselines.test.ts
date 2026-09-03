import { ContextCompiler } from '@ctxalloc/compiler';
import type { CandidateBlock } from '@ctxalloc/domain';
import {
  EVALUATION_BASELINE_RENDERER_ID,
  EVALUATION_BASELINE_RENDERER_VERSION,
} from '@ctxalloc/evaluation';
import type { Tokenizer } from '@ctxalloc/ports';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';
import {
  buildFullContextBaseline,
  buildTopKBaseline,
  buildTruncationBaseline,
  renderBaselineContext,
} from '../../packages/evaluation/src/evaluation-baselines.js';
import {
  candidateBlock,
  compilationRequest,
  compilerConfig,
  contextBlock,
  retrieval,
  wordTokenizer,
} from './evaluation-fixtures.js';

/**
 * The evaluation baselines (DEC-040, METRICS 7).
 *
 * These are exercised through their module path rather than the package entry
 * point, because they are deliberately not exported: a baseline builder is
 * mechanism, and publishing it would freeze an implementation detail a later
 * version has to be free to change (INV-ADAPTER-001).
 */

const A = contextBlock('blk:a', 'Alpha alpha alpha.');
const B = contextBlock('blk:b', 'Beta beta.', undefined, { startLine: 2 });
const C = contextBlock('blk:c', 'Gamma.', undefined, { startLine: 3 });

describe('evaluation baseline renderer: exact v1 record shape', () => {
  it('publishes its own separately versioned identity', () => {
    const build = buildFullContextBaseline([candidateBlock(A)], wordTokenizer);
    expect(build.result.applicable).toBe(true);
    if (!build.result.applicable) return;
    expect(build.result.rendererId).toBe(EVALUATION_BASELINE_RENDERER_ID);
    expect(build.result.rendererVersion).toBe(EVALUATION_BASELINE_RENDERER_VERSION);
    expect(build.result.rendererId).not.toBe('ctxalloc-jsonl');
  });

  it('renders an empty selection as the empty string', () => {
    expect(renderBaselineContext([])).toBe('');
  });

  it('renders one record with canonical key order and no trailing newline', () => {
    expect(renderBaselineContext([candidateBlock(A)])).toBe(
      '{"blockId":"blk:a","content":"Alpha alpha alpha.","sourceDocumentId":"doc:main","sourceType":"markdown"}',
    );
  });

  it('separates records with exactly one LF and adds no prefix or suffix', () => {
    const rendered = renderBaselineContext([candidateBlock(A), candidateBlock(B)]);
    expect(rendered.split('\n')).toHaveLength(2);
    expect(rendered.startsWith('{')).toBe(true);
    expect(rendered.endsWith('}')).toBe(true);
  });

  it('emits headingPath exactly when the block carries it', () => {
    const withPath = contextBlock('blk:h', 'Text.', undefined, { headingPath: ['Top', 'Sub'] });
    const empty = contextBlock('blk:e', 'Text.', undefined, { headingPath: [] });
    expect(renderBaselineContext([candidateBlock(withPath)])).toContain(
      '"headingPath":["Top","Sub"]',
    );
    // An explicitly empty path is preserved: "states no heading context" and
    // "was extracted from outside any heading" are different facts.
    expect(renderBaselineContext([candidateBlock(empty)])).toContain('"headingPath":[]');
    expect(renderBaselineContext([candidateBlock(A)])).not.toContain('headingPath');
  });

  it('escapes content exactly as JSON does, changing no byte of it', () => {
    const tricky = contextBlock('blk:x', 'Line "one"\nLine\ttwo \\ end é 🚀');
    const rendered = renderBaselineContext([candidateBlock(tricky)]);
    expect(rendered.split('\n')).toHaveLength(1);
    expect(JSON.parse(rendered)).toMatchObject({ content: tricky.content });
  });

  it('repeats an exactly duplicated wrapper', () => {
    const rendered = renderBaselineContext([candidateBlock(A), candidateBlock(A)]);
    expect(rendered.split('\n')).toHaveLength(2);
  });
});

describe('evaluation baseline renderer: golden equivalence with ContextRenderer v1', () => {
  it('produces byte-identical output for a selection where each block appears once', () => {
    // The one property that keeps a token comparison meaningful: a baseline and a
    // compiled context differ in what they contain, never in how they are
    // written. Proved against the real kernel rather than asserted.
    const tokenizer = new O200kBaseTokenizer();
    const candidates = [
      candidateBlock(contextBlock('blk:1', '# Title\n\nFirst body "quoted".', tokenizer)),
      candidateBlock(
        contextBlock('blk:2', 'Second body\twith a tab and é and 🚀.', tokenizer, {
          startLine: 4,
          headingPath: ['Title'],
        }),
      ),
      candidateBlock(contextBlock('blk:3', 'Third body.', tokenizer, { startLine: 6 })),
    ];

    const compiler = new ContextCompiler(compilerConfig(), tokenizer);
    const result = compiler.compile(compilationRequest({ candidates, totalTokens: 4000 }));
    expect(result.includedBlocks).toHaveLength(3);

    const asWrappers: readonly CandidateBlock[] = result.includedBlocks.map((block) =>
      candidateBlock(block),
    );
    expect(renderBaselineContext(asWrappers)).toBe(result.compiledContext);
  });
});

describe('full-context baseline (METRICS 7.1)', () => {
  it('includes every validated wrapper in input order, duplicates repeated', () => {
    const build = buildFullContextBaseline(
      [candidateBlock(B), candidateBlock(A), candidateBlock(A)],
      wordTokenizer,
    );
    expect(build.result.applicable).toBe(true);
    if (!build.result.applicable) return;

    expect(build.result.includedCandidateCount).toBe(3);
    // Input order, not source order: this is the context that would have been
    // sent without CtxAlloc.
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:a',
      'blk:a',
    ]);
  });

  it('tokenizes the whole rendered string once, not the sum of block counts', () => {
    const tokenizer = new O200kBaseTokenizer();
    const one = contextBlock('blk:1', 'Alpha alpha alpha.', tokenizer);
    const two = contextBlock('blk:2', 'Beta beta.', tokenizer, { startLine: 2 });
    const build = buildFullContextBaseline([candidateBlock(one), candidateBlock(two)], tokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');

    expect(build.result.contextTokens).toBe(tokenizer.countTokens(build.context));
    // The sum of the blocks' own counts omits the record framing entirely, and
    // cannot see a merge across a record boundary either (METRICS 8.1 vs 8.4).
    expect(build.result.contextTokens).toBeGreaterThan(one.tokenCount + two.tokenCount);
  });

  it('may exceed the compilation budget, which is allowed for a comparison point', () => {
    const big = contextBlock('blk:big', Array.from({ length: 200 }, () => 'word').join(' '));
    const build = buildFullContextBaseline([candidateBlock(big)], wordTokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.result.contextTokens).toBeGreaterThan(100);
  });

  it('hashes the exact context, and the hash changes with it', () => {
    const first = buildFullContextBaseline([candidateBlock(A)], wordTokenizer);
    const same = buildFullContextBaseline([candidateBlock(A)], wordTokenizer);
    const other = buildFullContextBaseline([candidateBlock(B)], wordTokenizer);
    if (!first.result.applicable || !same.result.applicable || !other.result.applicable) {
      throw new Error('expected applicable baselines');
    }
    expect(first.result.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.result.contextHash).toBe(same.result.contextHash);
    expect(first.result.contextHash).not.toBe(other.result.contextHash);
  });
});

describe('truncation baseline (METRICS 7.2)', () => {
  it('takes the longest whole-record prefix of input order that fits', () => {
    const candidates = [candidateBlock(A), candidateBlock(B), candidateBlock(C)];
    const full = buildFullContextBaseline(candidates, wordTokenizer);
    if (!full.result.applicable) throw new Error('expected an applicable baseline');

    const budget = wordTokenizer.countTokens(
      renderBaselineContext([candidateBlock(A), candidateBlock(B)]),
    );
    const build = buildTruncationBaseline(candidates, budget, wordTokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');

    expect(build.result.includedCandidateCount).toBe(2);
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:a',
      'blk:b',
    ]);
    expect(build.result.contextTokens).toBeLessThanOrEqual(budget);
  });

  it('emits no partial record, and seats nothing when even the first does not fit', () => {
    const build = buildTruncationBaseline([candidateBlock(A)], 1, wordTokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.result.includedCandidateCount).toBe(0);
    expect(build.context).toBe('');
  });

  it('measures every prefix, because tokenization is not monotonic', () => {
    // A tokenizer whose count *drops* when a third record is added. A builder
    // that stopped at the first over-budget prefix would seat one record and
    // silently truncate further than the budget requires.
    const spiky: Tokenizer = {
      id: 'spiky',
      version: '1',
      countTokens: (text: string): number => {
        const lines = text.length === 0 ? 0 : text.split('\n').length;
        return lines === 2 ? 999 : lines;
      },
    };

    const candidates = [candidateBlock(A), candidateBlock(B), candidateBlock(C)];
    expect(spiky.countTokens(renderBaselineContext(candidates.slice(0, 1)))).toBe(1);
    expect(spiky.countTokens(renderBaselineContext(candidates.slice(0, 2)))).toBe(999);
    expect(spiky.countTokens(renderBaselineContext(candidates))).toBe(3);

    const build = buildTruncationBaseline(candidates, 3, spiky);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.result.includedCandidateCount).toBe(3);
    expect(build.result.contextTokens).toBe(3);
  });
});

describe('top-k baseline (METRICS 7.3)', () => {
  const scored = (block: typeof A, value: number, rank: number, extra = {}): CandidateBlock =>
    candidateBlock(block, retrieval({ score: value, rank, ...extra }));

  it('orders by raw score descending when the provider says higher is better', () => {
    const build = buildTopKBaseline(
      [scored(A, 0.2, 2), scored(B, 0.9, 0), scored(C, 0.5, 1)],
      1000,
      wordTokenizer,
    );
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:c',
      'blk:a',
    ]);
  });

  it('orders ascending when the provider says lower is better', () => {
    const lower = (block: typeof A, value: number, rank: number): CandidateBlock =>
      candidateBlock(
        block,
        retrieval({ score: value, rank, semantics: 'l2-distance', higherIsBetter: false }),
      );
    const build = buildTopKBaseline([lower(A, 0.8, 2), lower(B, 0.1, 0)], 1000, wordTokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:a',
    ]);
  });

  it('falls back to rank when no comparable score is present', () => {
    const build = buildTopKBaseline(
      [
        candidateBlock(A, retrieval({ rank: 2 })),
        candidateBlock(B, retrieval({ rank: 0 })),
        candidateBlock(C, retrieval({ rank: 1 })),
      ],
      1000,
      wordTokenizer,
    );
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:c',
      'blk:a',
    ]);
  });

  it('breaks a score tie by rank, then by block id over code units', () => {
    const build = buildTopKBaseline(
      [scored(C, 0.5, 5), scored(A, 0.5, 1), scored(B, 0.5, 1)],
      1000,
      wordTokenizer,
    );
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:a',
      'blk:b',
      'blk:c',
    ]);
  });

  it('refuses incomparable evidence rather than inventing an order', () => {
    // A number that looks like a ranking is indistinguishable from a real one in
    // a report, so the baseline says it cannot be built (INV-SCORE-002).
    const inapplicable: readonly (readonly CandidateBlock[])[] = [
      // No evidence at all.
      [candidateBlock(A), candidateBlock(B)],
      // Evidence on only one wrapper.
      [candidateBlock(A, retrieval({ score: 0.5, rank: 0 })), candidateBlock(B)],
      // Two providers.
      [
        candidateBlock(A, retrieval({ score: 0.5, rank: 0 })),
        candidateBlock(B, retrieval({ score: 0.9, rank: 1, providerId: 'other' })),
      ],
      // Two provider versions.
      [
        candidateBlock(A, retrieval({ score: 0.5, rank: 0 })),
        candidateBlock(B, retrieval({ score: 0.9, rank: 1, providerVersion: '2' })),
      ],
      // Two metrics, and no rank to fall back to.
      [
        candidateBlock(A, retrieval({ score: 0.5 })),
        candidateBlock(B, retrieval({ score: 0.9, semantics: 'l2-distance' })),
      ],
      // Two directions, and no rank to fall back to.
      [
        candidateBlock(A, retrieval({ score: 0.5 })),
        candidateBlock(B, retrieval({ score: 0.9, higherIsBetter: false })),
      ],
      // Neither a comparable score nor a rank on every wrapper.
      [
        candidateBlock(A, retrieval({ rank: 0 })),
        candidateBlock(B, retrieval({ semantics: 'x', score: 0.4 })),
      ],
    ];

    for (const [index, candidates] of inapplicable.entries()) {
      const build = buildTopKBaseline(candidates, 1000, wordTokenizer);
      expect(build.result.applicable, `case ${String(index)}`).toBe(false);
      if (build.result.applicable) continue;
      expect(build.result.baseline).toBe('top-k');
      expect(build.result.reason).toBe('incomparable-retrieval-evidence');
    }
  });

  it('falls back to rank when the scores are incomparable but the provider agrees', () => {
    // A rank is an ordering the provider already committed to, so it needs only
    // one provider and version to mean something — unlike two raw scores from
    // two metrics, which mean nothing together.
    const build = buildTopKBaseline(
      [
        candidateBlock(A, retrieval({ rank: 2, score: 0.9 })),
        candidateBlock(B, retrieval({ rank: 0, score: 0.1, semantics: 'l2-distance' })),
      ],
      1000,
      wordTokenizer,
    );
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:a',
    ]);
  });

  it('takes the longest fitting prefix of the ranking, measuring every prefix', () => {
    const spiky: Tokenizer = {
      id: 'spiky',
      version: '1',
      countTokens: (text: string): number => {
        const lines = text.length === 0 ? 0 : text.split('\n').length;
        return lines === 2 ? 999 : lines;
      },
    };
    const build = buildTopKBaseline(
      [scored(A, 0.9, 0), scored(B, 0.5, 1), scored(C, 0.1, 2)],
      3,
      spiky,
    );
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.result.includedCandidateCount).toBe(3);
  });

  it('keeps an identically repeated wrapper adjacent and repeated', () => {
    const one = scored(A, 0.5, 0);
    const build = buildTopKBaseline([one, one, scored(B, 0.9, 1)], 1000, wordTokenizer);
    if (!build.result.applicable) throw new Error('expected an applicable baseline');
    expect(build.context.split('\n').map((line) => JSON.parse(line).blockId)).toEqual([
      'blk:b',
      'blk:a',
      'blk:a',
    ]);
  });
});

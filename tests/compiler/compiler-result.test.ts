import { readFileSync } from 'node:fs';
import { COMPILATION_RESULT_SCHEMA_VERSION } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  compile,
  countWords,
  includedIds,
  jsonlOverheadTokenizer,
  renderedIds,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The `CompilationResult` contract (ARCHITECTURE 5.7, DEC-038).
 *
 * The kernel publishes what it measured and nothing it inferred. In particular
 * it publishes no token-reduction metric: METRICS 8.7 and 8.8 are defined
 * against `baselineInputTokens`, and no baseline exists in a
 * `CompilationRequest` — baselines belong to the evaluation layer.
 */

/** Two blocks share one content, so the wrapper sum exceeds the canonical sum. */
const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 3, required: true, priority: 0 },
  { id: 'high', tokens: 3, priority: 900 },
  { id: 'low', tokens: 3, priority: 100 },
];

function result(): ReturnType<typeof compile> {
  return compile({ specs: SPECS, available: 40 }, jsonlOverheadTokenizer(2));
}

describe('CompilationResult contract', () => {
  it('publishes exactly the documented keys', () => {
    expect(Object.keys(result()).sort()).toEqual([
      'compilationId',
      'compiledContext',
      'includedBlocks',
      'requestId',
      'schemaVersion',
      'trace',
      'usage',
    ]);
    expect(Object.keys(result().usage).sort()).toEqual([
      'availableTokens',
      'candidateTokens',
      'compiledTokens',
      'includedContentTokens',
      'renderingTokenDelta',
      'unusedTokens',
    ]);
    expect(result().schemaVersion).toBe(COMPILATION_RESULT_SCHEMA_VERSION);
  });

  it('publishes no reduction, baseline, overhead, or estimated field', () => {
    const compiled = result();
    for (const absent of [
      'reductionTokens',
      'reductionRatio',
      'tokenReduction',
      'tokenReductionRatio',
      'baselineInputTokens',
      'renderingOverheadTokens',
      'estimatedTokens',
      'budgetUtilization',
      'warnings',
      'excludedBlocks',
    ]) {
      expect(Object.keys(compiled.usage), `usage exposes ${absent}`).not.toContain(absent);
      expect(Object.keys(compiled), `result exposes ${absent}`).not.toContain(absent);
    }

    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    for (const absent of ['reductionTokens', 'reductionRatio', 'baselineInputTokens']) {
      expect(source.replace(/\/\*[\s\S]*?\*\//g, ''), `computes ${absent}`).not.toContain(absent);
    }
  });

  it('METRICS 8.1: candidateTokens sums every validated wrapper, duplicates included', () => {
    const shared = 'shared content here';
    const compiled = compile(
      {
        specs: [
          { id: 'one', content: shared, priority: 900 },
          { id: 'two', content: shared, priority: 100 },
        ],
        available: 40,
      },
      wordTokenizer,
    );

    // Two wrappers of 3 tokens each; deduplication collapses them into one group
    // whose canonical block still costs 3.
    expect(compiled.usage.candidateTokens).toBe(6);
    expect(compiled.trace.totals.candidateTokens).toBe(6);
    expect(compiled.trace.totals.canonicalContentTokens).toBe(3);
    expect(compiled.usage.includedContentTokens).toBe(3);
  });

  it('METRICS 8.5: includedContentTokens sums the final canonical blocks', () => {
    const compiled = result();
    expect(compiled.usage.includedContentTokens).toBe(
      compiled.includedBlocks.reduce((total, block) => total + block.tokenCount, 0),
    );
  });

  it('METRICS 8.3: availableTokens is the exact TokenBudget ceiling', () => {
    const compiled = compile(
      {
        specs: SPECS,
        budget: {
          totalTokens: 100,
          reservedOutputTokens: 10,
          reservedSystemTokens: 5,
          reservedToolTokens: 3,
        },
      },
      wordTokenizer,
    );
    expect(compiled.usage.availableTokens).toBe(82);
  });

  it('INV-BUDGET-001: compiledTokens never exceeds availableTokens on any success', () => {
    for (const available of [12, 14, 16, 18, 20, 24, 30, 40]) {
      const compiled = compile({ specs: SPECS, available }, jsonlOverheadTokenizer(2));
      expect(compiled.usage.compiledTokens, `available ${String(available)}`).toBeLessThanOrEqual(
        available,
      );
    }
  });

  it('INV-BUDGET-006: unusedTokens is exact', () => {
    const compiled = result();
    expect(compiled.usage.unusedTokens).toBe(
      compiled.usage.availableTokens - compiled.usage.compiledTokens,
    );
  });

  it('METRICS 8.4: compiledTokens is the tokenizer count of compiledContext', () => {
    const tokenizer = jsonlOverheadTokenizer(2);
    const compiled = result();
    expect(compiled.usage.compiledTokens).toBe(tokenizer.countTokens(compiled.compiledContext));
  });

  it('publishes canonical blocks in exact render order, not candidate wrappers', () => {
    const compiled = result();

    expect(includedIds(compiled)).toEqual(renderedIds(compiled));
    for (const block of compiled.includedBlocks) {
      // Canonical `ContextBlock` records, not `CandidateBlock` wrappers.
      expect(Object.keys(block)).toContain('normalizedContentHash');
      expect(Object.keys(block)).not.toContain('retrieval');
      expect(Object.keys(block)).not.toContain('block');
    }
  });

  it('rewrites no value of the blocks it returns', () => {
    const compiled = compile({ specs: [{ id: 'one', tokens: 4 }], available: 40 }, wordTokenizer);
    const [block] = compiled.includedBlocks;

    expect(block?.content).toBe('one w0 w1 w2');
    expect(block?.tokenCount).toBe(4);
    expect(countWords(block?.content ?? '')).toBe(4);
  });

  it('INV-TRACE-006: the attached trace is settled', () => {
    expect(result().trace.settled).toBe(true);
  });

  it('cannot attach an unsettled trace at the type level', () => {
    const declarations = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    expect(declarations).toContain('readonly trace: SettledCompilationTrace;');
    expect(declarations).not.toContain('readonly trace: CompilationTrace;');
  });

  it('explains every group through the trace rather than a second list', () => {
    const compiled = compile({ specs: SPECS, available: 14 }, jsonlOverheadTokenizer(3));

    expect(compiled.trace.settlement.decisions).toHaveLength(3);
    expect(includedIds(compiled).length).toBeLessThan(3);
    // No excluded blocks are repeated on the result itself.
    expect(Object.keys(compiled)).not.toContain('excludedBlocks');
  });
});

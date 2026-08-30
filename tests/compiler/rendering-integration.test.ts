import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateScorer,
  CandidateValidator,
  ContextOrderer,
  ContextRenderer,
  type RenderedContextAttempt,
} from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  contextBlock,
  linesOf,
  orderingPolicy,
  recordsOf,
  renderingPolicy,
  sourceDocument,
} from './rendering-fixtures.js';

/**
 * One offline integration pass over the whole implemented kernel with the real
 * tokenizer adapter.
 *
 * `O200kBaseTokenizer` is composed here, in a test, exactly as the future
 * composition root will compose it: the same tokenizer identity validates block
 * counts and measures the rendered string (DEC-035). It is never imported into
 * `@ctxalloc/compiler` itself, which depends on the `Tokenizer` port alone
 * (INV-ADAPTER-001, INV-DEP-002).
 *
 * The adapter runs fully offline: it bundles the `o200k_base` ranks and makes no
 * network request (DEC-027).
 */

const CONTENTS = [
  'The compiler selects final context under a strict token budget.',
  'Rendering is serialization, not rewriting: "quoted" text and \\backslashes survive.',
  'Supplementary characters 𝕬𝖑𝖕𝖍𝖆 and emoji 🚀 round-trip through the JSON string.',
  'A line\nbreak inside content can never start a second JSONL record.',
] as const;

function compile(tokenizer: O200kBaseTokenizer): RenderedContextAttempt {
  const candidates = CONTENTS.map((content, index) => ({
    schemaVersion: 1,
    block: contextBlock({
      id: `block-${String(index)}`,
      content,
      sourceLocation: {
        kind: 'text-range',
        startOffset: index * 1000,
        endOffset: index * 1000 + content.length,
      },
      // The same tokenizer identity that will measure the rendered string also
      // validates the block counts.
      tokenCount: tokenizer.countTokens(content),
    }),
  }));

  const validated = new CandidateValidator(tokenizer).validate({
    scope: { tenantId: 'local', workspaceId: 'default' },
    sourceDocuments: [sourceDocument()],
    candidates,
  });
  const scored = new CandidateScorer({ ...ALLOCATION_SCORING_POLICY }).score(
    new CandidateDeduplicator().deduplicate(validated),
    '2026-06-01T12:00:00.000Z',
  );
  const allocated = new BudgetAllocator(allocationPolicy()).allocate(scored, budget(1000));
  const ordered = new ContextOrderer(orderingPolicy()).order(allocated);

  return new ContextRenderer(renderingPolicy(), tokenizer).render(ordered);
}

describe('context rendering: real tokenizer integration', () => {
  const tokenizer = new O200kBaseTokenizer();
  const result = compile(tokenizer);

  it('measures exactly the string it rendered', () => {
    expect(result.renderedTokens).toBe(tokenizer.countTokens(result.renderedContext));
  });

  it('publishes the real tokenizer identity', () => {
    expect(result.tokenizerId).toBe(tokenizer.id);
    expect(result.tokenizerVersion).toBe(tokenizer.version);
  });

  it('renders one physical record per included block', () => {
    expect(linesOf(result)).toHaveLength(CONTENTS.length);
    expect(result.ordered.orderedIncluded).toHaveLength(CONTENTS.length);
  });

  it('round-trips every content string exactly', () => {
    expect(recordsOf(result).map((record) => record['content'])).toEqual([...CONTENTS]);
  });

  it('reports a signed delta against the block-content sum', () => {
    expect(result.renderedTokenDelta).toBe(
      result.renderedTokens - result.ordered.allocation.selectedBlockContentTokens,
    );
    expect(Number.isSafeInteger(result.renderedTokenDelta)).toBe(true);
  });

  it('observes the budget without correcting the selection', () => {
    expect(result.fitsAvailableInputBudget).toBe(
      result.renderedTokens <= result.ordered.allocation.availableInputTokens,
    );
  });

  it('is deterministic across two independent adapters', () => {
    expect(compile(new O200kBaseTokenizer())).toEqual(result);
  });
});

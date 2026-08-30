import {
  BudgetAllocator,
  ContextOrderer,
  ContextRenderer,
  type IncludedCandidateDecision,
  type OrderedCandidateSet,
  type RenderedContextAttempt,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  candidateOf,
  contentOf,
  issueCodesOf,
  issuesOf,
  permutations,
  type CandidateSpec,
} from './allocation-fixtures.js';
import { candidate, contextBlock, sourceDocument, wordTokenizer } from './fixtures.js';
import { orderingPolicy } from './ordering-fixtures.js';
import { score } from './scoring-fixtures.js';

/**
 * Shared fixtures for the deterministic context rendering tests.
 *
 * Every batch is built through `CandidateValidator`, `CandidateDeduplicator`,
 * `CandidateScorer`, `BudgetAllocator`, and `ContextOrderer`, so the renderer is
 * exercised against a genuinely produced stage contract rather than a
 * hand-assembled structure that might not survive the earlier stages (DEC-035).
 * The two tests that must control render order directly say so explicitly.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export {
  ALLOCATION_SCORING_POLICY,
  allocationPolicy,
  budget,
  candidate,
  candidateOf,
  contentOf,
  contextBlock,
  issueCodesOf,
  issuesOf,
  orderingPolicy,
  permutations,
  sourceDocument,
  wordTokenizer,
  type CandidateSpec,
};

/** The smallest valid rendering policy: an identity and the v1 format. */
export function renderingPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'rendering',
    policyVersion: '1.0.0',
    format: 'jsonl-blocks',
    ...overrides,
  };
}

export interface OrderOptions {
  readonly available?: number;
  readonly sourceDocuments?: readonly unknown[];
}

/** Validates, deduplicates, scores, allocates, and orders raw candidate wrappers. */
export function orderCandidates(
  candidates: readonly Record<string, unknown>[],
  options: OrderOptions = {},
): OrderedCandidateSet {
  const scored = score(
    candidates,
    { ...ALLOCATION_SCORING_POLICY },
    options.sourceDocuments === undefined ? {} : { sourceDocuments: options.sourceDocuments },
  );
  const allocated = new BudgetAllocator(allocationPolicy()).allocate(
    scored,
    budget(options.available ?? 1000),
  );
  return new ContextOrderer(orderingPolicy()).order(allocated);
}

/** The same pipeline, driven by the compact allocation specs. */
export function orderSpecs(
  specs: readonly CandidateSpec[],
  options: OrderOptions = {},
): OrderedCandidateSet {
  return orderCandidates(specs.map(candidateOf), options);
}

export function render(
  ordered: OrderedCandidateSet,
  tokenizer: Tokenizer = wordTokenizer,
  policy: Record<string, unknown> = renderingPolicy(),
): RenderedContextAttempt {
  return new ContextRenderer(policy, tokenizer).render(ordered);
}

/** The physical JSONL lines; the empty string is zero records, never one. */
export function linesOf(result: RenderedContextAttempt): readonly string[] {
  return result.renderedContext === '' ? [] : result.renderedContext.split('\n');
}

/** Every rendered line parsed back into an ordinary object. */
export function recordsOf(result: RenderedContextAttempt): readonly Record<string, unknown>[] {
  return linesOf(result).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Block identifiers in render order. */
export function orderedIds(ordered: OrderedCandidateSet): readonly string[] {
  return ordered.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock.id);
}

/** The canonical blocks of an ordered selection, in render order. */
export function orderedBlocks(
  ordered: OrderedCandidateSet,
): readonly { readonly id: string; readonly content: string }[] {
  return ordered.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock);
}

/**
 * The same ordered set with a different `orderedIncluded` array.
 *
 * The nested allocation is shared by reference, so the two values differ in
 * render order and in nothing else.
 */
export function withOrder(
  ordered: OrderedCandidateSet,
  orderedIncluded: readonly IncludedCandidateDecision[],
): OrderedCandidateSet {
  return { ...ordered, orderedIncluded };
}

/** The same ordered set with overridden allocation metrics, for the budget tests. */
export function withAllocation(
  ordered: OrderedCandidateSet,
  overrides: { readonly available?: number; readonly selected?: number },
): OrderedCandidateSet {
  return {
    ...ordered,
    allocation: {
      ...ordered.allocation,
      ...(overrides.available === undefined ? {} : { availableInputTokens: overrides.available }),
      ...(overrides.selected === undefined
        ? {}
        : { selectedBlockContentTokens: overrides.selected }),
    },
  };
}

/** A tokenizer returning one fixed count for any text, for the arithmetic tests. */
export function fixedTokenizer(tokens: number): Tokenizer {
  return { id: 'test:fixed', version: '1', countTokens: (): number => tokens };
}

/** A tokenizer that records the exact texts it was asked to count. */
export function recordingTokenizer(calls: string[], tokens = 0): Tokenizer {
  return {
    id: 'test:recording',
    version: '1',
    countTokens: (text: string): number => {
      calls.push(text);
      return tokens;
    },
  };
}

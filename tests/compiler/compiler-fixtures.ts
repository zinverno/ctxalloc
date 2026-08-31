import {
  ContextCompiler,
  type CompilationResult,
  type CompilationTraceFinalDecision,
  type SettledCompilationTrace,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { compilationPolicy } from './compilation-fixtures.js';
import {
  ALLOCATION_SCORING_POLICY,
  budget,
  candidateOf,
  contentOf,
  permutations,
  type CandidateSpec,
} from './allocation-fixtures.js';
import { SCOPE, contextBlock, countWords, sourceDocument, wordTokenizer } from './fixtures.js';

/**
 * Shared fixtures for the `ContextCompiler` tests (DEC-038).
 *
 * Every compilation runs through the real component, which runs the real
 * `CompilationRequestValidator`, `CandidateValidator`, `CandidateDeduplicator`,
 * `CandidateScorer`, `CandidateFilter`, `BudgetAllocator`, `ContextOrderer`,
 * `ContextRenderer`, and `TraceBuilder`. Nothing here reimplements a stage or
 * hand-assembles a stage contract.
 *
 * Token counts and scores are both controlled exactly. Content is generated with
 * a chosen number of whitespace-separated words, and the scoring policy
 * normalizes authored priority over `[0, 1000]` with weight `1`, so a candidate
 * with priority `p` scores exactly `p / 1000`.
 *
 * Rendering overhead is controlled exactly too, by the tokenizers below. Block
 * content is always plain words, so it never contains the JSONL key marker they
 * count — which is what lets one tokenizer agree with the declared block counts
 * at validation and still disagree with their sum on the rendered string.
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export {
  ALLOCATION_SCORING_POLICY,
  budget,
  candidateOf,
  contentOf,
  contextBlock,
  countWords,
  permutations,
  sourceDocument,
  wordTokenizer,
  SCOPE,
  type CandidateSpec,
};

/** The explicit instant every compiler test measures recency against. */
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Tokenizers                                                                  */
/* -------------------------------------------------------------------------- */

/** The exact number of rendered JSONL records in a string. */
export function recordCount(text: string): number {
  return (text.match(/"blockId":/g) ?? []).length;
}

/**
 * Counts words, plus a fixed surcharge for every rendered JSONL record.
 *
 * On block content — always plain words in these fixtures — it agrees with
 * `wordTokenizer` exactly, so `CandidateValidator` accepts the declared counts.
 * On a rendered string it does not: `tokens(rendered)` is the sum of the block
 * counts plus `perRecord` for each record, which is precisely the non-additivity
 * INV-BUDGET-002 exists for.
 *
 * `perRecord` may be negative, which makes the rendered string *cheaper* than
 * the sum of its blocks and the final `renderingTokenDelta` negative. The clamp
 * at zero is fixture arithmetic keeping the tokenizer inside its port contract,
 * not compiler behavior.
 */
export function jsonlOverheadTokenizer(perRecord: number, id = 'test:jsonl'): Tokenizer {
  return {
    id,
    version: '1',
    countTokens: (text: string): number =>
      Math.max(0, countWords(text) + perRecord * recordCount(text)),
  };
}

/**
 * Counts words, plus a per-block surcharge charged only where that block is
 * actually rendered.
 *
 * This is what makes the Phase 10 counterexample real: two candidates of one
 * category can have any relation between canonical content cost and rendered
 * cost, so the cheaper-by-content candidate the allocator protects may render
 * far more expensively than the one it passed over.
 */
export function blockPenaltyTokenizer(
  penalties: Readonly<Record<string, number>>,
  id = 'test:block-penalty',
): Tokenizer {
  return {
    id,
    version: '1',
    countTokens: (text: string): number => {
      let total = countWords(text);
      for (const [blockId, penalty] of Object.entries(penalties)) {
        const marker = `"blockId":${JSON.stringify(blockId)}`;
        const occurrences = text.split(marker).length - 1;
        total += penalty * occurrences;
      }
      return Math.max(0, total);
    },
  };
}

/**
 * Counts words, plus a surcharge that depends on the **record count** of the
 * rendered string.
 *
 * This is what makes non-monotonic tokenization concrete. A legal deterministic
 * tokenizer may charge more for a one-record string than for a two-record one,
 * so `tokens(render({R})) > tokens(render({R, X}))` even though `{R}` is a
 * strict subset. Block content has zero records, so it always counts as pure
 * words and `CandidateValidator` accepts the declared counts.
 */
export function recordCountTokenizer(
  surcharge: Readonly<Record<number, number>>,
  id = 'test:record-count',
): Tokenizer {
  return {
    id,
    version: '1',
    countTokens: (text: string): number =>
      Math.max(0, countWords(text) + (surcharge[recordCount(text)] ?? 0)),
  };
}

/**
 * Counts words, plus a per-block surcharge, plus a record-count surcharge.
 *
 * Combining the two is what lets a fixture distinguish two selections of equal
 * size, which a record-count rule alone cannot do.
 */
export function mixedPenaltyTokenizer(
  penalties: Readonly<Record<string, number>>,
  surcharge: Readonly<Record<number, number>>,
  id = 'test:mixed-penalty',
): Tokenizer {
  return {
    id,
    version: '1',
    countTokens: (text: string): number => {
      let total = countWords(text) + (surcharge[recordCount(text)] ?? 0);
      for (const [blockId, penalty] of Object.entries(penalties)) {
        const marker = `"blockId":${JSON.stringify(blockId)}`;
        total += penalty * (text.split(marker).length - 1);
      }
      return Math.max(0, total);
    },
  };
}

/** A tokenizer that records the exact texts it was asked to count. */
export function recordingTokenizer(calls: string[], inner: Tokenizer = wordTokenizer): Tokenizer {
  return {
    id: inner.id,
    version: inner.version,
    countTokens: (text: string): number => {
      calls.push(text);
      return inner.countTokens(text);
    },
  };
}

/** A tokenizer that returns one fixed count for any text. */
export function fixedTokenizer(tokens: number, id = 'test:fixed'): Tokenizer {
  return { id, version: '1', countTokens: (): number => tokens };
}

/* -------------------------------------------------------------------------- */
/* Configuration and request                                                   */
/* -------------------------------------------------------------------------- */

/** The explicit compiler composition; nothing is defaulted or discovered. */
export function compilerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compilerId: 'ctxalloc-compiler',
    compilerVersion: '0.15.0',
    maxCorrectionSelections: 64,
    ...overrides,
  };
}

/** A five-slice policy whose scoring turns authored priority `p` into `p / 1000`. */
export function compilerPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return compilationPolicy({
    scoring: { ...ALLOCATION_SCORING_POLICY },
    filtering: { schemaVersion: 1, policyId: 'filtering', policyVersion: '3.0.0' },
    ...overrides,
  });
}

/** An allocation slice carrying exact category block-count constraints. */
export function allocationSlice(
  categoryConstraints: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'allocation',
    policyVersion: '4.0.0',
    optionalSelection: 'score-desc-greedy',
    categoryConstraints: [...categoryConstraints],
  };
}

export interface CompileOptions {
  readonly id?: string;
  readonly query?: string;
  readonly referenceTime?: string;
  readonly specs?: readonly CandidateSpec[];
  readonly candidates?: readonly Record<string, unknown>[];
  readonly sourceDocuments?: readonly Record<string, unknown>[];
  readonly available?: number;
  readonly budget?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
}

/** One complete, unvalidated compilation request record. */
export function requestInput(options: CompileOptions = {}): Record<string, unknown> {
  const candidates = options.candidates ?? (options.specs ?? []).map((spec) => candidateOf(spec));
  return {
    id: options.id ?? 'req-compile-1',
    schemaVersion: 1,
    scope: { ...SCOPE },
    query: options.query ?? 'which blocks explain allocation?',
    referenceTime: options.referenceTime ?? REFERENCE_TIME,
    candidates: [...candidates],
    sourceDocuments: [...(options.sourceDocuments ?? [sourceDocument()])],
    budget: options.budget ?? (budget(options.available ?? 1000) as Record<string, unknown>),
    policy: options.policy ?? compilerPolicy(),
  };
}

/** Compiles one request with one configured tokenizer, through the real component. */
export function compile(
  options: CompileOptions = {},
  tokenizer: Tokenizer = wordTokenizer,
  config: Record<string, unknown> = compilerConfig(),
): CompilationResult {
  return new ContextCompiler(config, tokenizer).compile(requestInput(options));
}

/* -------------------------------------------------------------------------- */
/* Assertions                                                                  */
/* -------------------------------------------------------------------------- */

/** Final included block identifiers, in exact render order. */
export function includedIds(result: CompilationResult): readonly string[] {
  return result.includedBlocks.map((block) => block.id);
}

/** Block identifiers parsed back out of the compiled JSONL string. */
export function renderedIds(result: CompilationResult): readonly string[] {
  return result.compiledContext === ''
    ? []
    : result.compiledContext
        .split('\n')
        .map((line) => (JSON.parse(line) as { blockId: string }).blockId);
}

/** The settlement of a settled trace. */
export function settlementOf(
  trace: SettledCompilationTrace,
): SettledCompilationTrace['settlement'] {
  return trace.settlement;
}

/** The one final decision addressing `blockId`. */
export function finalDecisionFor(
  result: CompilationResult,
  blockId: string,
): CompilationTraceFinalDecision {
  const found = result.trace.settlement.decisions.filter(
    (decision) => decision.blockId === blockId,
  );
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected exactly one final decision for ${blockId}`);
  }
  return found[0];
}

/** Every final decision as `blockId -> reason`, sorted by block identifier. */
export function finalReasons(result: CompilationResult): Record<string, string> {
  return Object.fromEntries(
    [...result.trace.settlement.decisions]
      .sort((a, b) => (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0))
      .map((decision) => [decision.blockId, decision.reason]),
  );
}

/** The structured issues of a rejected compilation. */
export function issuesOf(
  run: () => unknown,
): readonly { readonly code: string; readonly pointer: string; readonly message: string }[] {
  try {
    run();
  } catch (error) {
    return (
      (error as { issues?: readonly { code: string; pointer: string; message: string }[] })
        .issues ?? []
    );
  }
  throw new Error('expected the call to be rejected');
}

export function issueCodesOf(run: () => unknown): readonly string[] {
  return issuesOf(run).map((issue) => issue.code);
}

/** The thrown value of a rejected compilation, as a plain readable record. */
export function failureOf(run: () => unknown): {
  readonly name: string;
  readonly code: unknown;
  readonly stage: unknown;
  readonly compilationId: unknown;
  readonly trace: unknown;
  readonly issues: readonly {
    readonly code: string;
    readonly pointer: string;
    readonly message: string;
  }[];
  readonly keys: readonly string[];
} {
  try {
    run();
  } catch (error) {
    const failure = error as {
      name: string;
      code: unknown;
      stage: unknown;
      compilationId?: unknown;
      trace?: unknown;
      issues: readonly { code: string; pointer: string; message: string }[];
    };
    return {
      name: failure.name,
      code: failure.code,
      stage: failure.stage,
      compilationId: failure.compilationId,
      trace: failure.trace,
      issues: failure.issues,
      keys: Object.keys(failure),
    };
  }
  throw new Error('expected the call to be rejected');
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Phase 10 counterexample, made real by a tokenizer (DEC-033, DEC-038).
 *
 * Category `facts` requires one block, and `availableInputTokens` is 8.
 *
 * ```text
 * req    required, 2 content tokens,  0 rendered penalty tokens
 * a      facts,    1 content token,  10 rendered penalty tokens
 * b      facts,    6 content tokens,  0 rendered penalty tokens
 * ```
 *
 * `BudgetAllocator` reserves `a` for the category minimum because it minimizes
 * canonical content cost, and `b` then does not fit the 5 remaining content
 * tokens, so it is excluded. `a` is the only `facts` block left, which makes it
 * protected: `optionalEvictionOrder` is empty.
 *
 * ```text
 * {req, a}   content 3   rendered 13   over the 8 available
 * {req}      content 2   rendered  2   fits, so required content is not the cause
 * {req, b}   content 8   rendered  8   fits
 * ```
 *
 * Exhausting the eviction order therefore proves nothing. Only a render-aware
 * reconsideration of the protected category-minimum choice finds `b`.
 */
export const COUNTEREXAMPLE_SPECS: readonly CandidateSpec[] = [
  { id: 'req', tokens: 2, required: true, priority: 0 },
  { id: 'a', tokens: 1, category: 'facts', priority: 100 },
  { id: 'b', tokens: 6, category: 'facts', priority: 200 },
];

/** `availableInputTokens` for {@link COUNTEREXAMPLE_SPECS}. */
export const COUNTEREXAMPLE_AVAILABLE = 8;

/**
 * The same counterexample plus one unconstrained optional block, with one more
 * available token.
 *
 * `{req, b, extra}` renders to exactly 9 and would fit, so a fallback that
 * re-augmented the hard base could add it. Version 1 deliberately does not:
 * the settled hard base is returned as it stands (DEC-038).
 */
export const COUNTEREXAMPLE_WITH_SURPLUS_SPECS: readonly CandidateSpec[] = [
  ...COUNTEREXAMPLE_SPECS,
  { id: 'extra', tokens: 1, priority: 900 },
];

/** `availableInputTokens` for {@link COUNTEREXAMPLE_WITH_SURPLUS_SPECS}. */
export const SURPLUS_AVAILABLE = 9;

/**
 * The same shape, with **both** `facts` candidates rendering too expensively.
 *
 * Required-only fits, every policy-valid hard base is content-valid, and none
 * renders within the budget: the exhaustive hard-constraint failure.
 */
export const INFEASIBLE_SPECS: readonly CandidateSpec[] = COUNTEREXAMPLE_SPECS;

/** The tokenizer that makes `a` render expensively and `b` render cheaply. */
export const COUNTEREXAMPLE_TOKENIZER = blockPenaltyTokenizer({ a: 10 });

/** The tokenizer that makes both `facts` candidates render too expensively. */
export const INFEASIBLE_TOKENIZER = blockPenaltyTokenizer({ a: 10, b: 10 }, 'test:both-penalty');

/** One `facts` category requiring exactly one block. */
export const FACTS_MINIMUM_POLICY = compilerPolicy({
  allocation: allocationSlice([{ category: 'facts', minBlocks: 1 }]),
});

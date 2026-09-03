import type { CandidateBlock, ContextBlock } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { canonicalJson, compareCodeUnits, domainSeparatedHash } from './canonical-json.js';
import { countEvaluationTokens } from './token-measurement.js';

/**
 * Deterministic comparison baselines (DEC-040, METRICS 7).
 *
 * A baseline answers *what would have been sent without CtxAlloc?* It is an
 * evaluation strategy, not a compiler stage: no baseline deduplicates, scores,
 * filters, allocates, orders, corrects, or produces a `CompilationId`, and none
 * of them may ever be mistaken for a compilation. Putting them in the kernel
 * would give the compiler a second, unmeasured selection path.
 *
 * Every baseline renders through one separately versioned renderer whose record
 * shape matches `ContextRenderer` v1 exactly, so a token comparison between a
 * baseline and a compiled context is a comparison of context and not of two wire
 * formats. Equality is proved by a golden test rather than asserted here.
 *
 * Every token count here goes through `countEvaluationTokens`, which requires a
 * non-negative safe integer and turns a throwing tokenizer into a project-owned
 * failure. A benchmark that published `NaN`, a negative, or a fractional count
 * would be reporting a measurement nobody could have made, and a negative count
 * would additionally make a prefix "fit" any budget (INV-BUDGET-005).
 *
 * **Tokenization is not monotonic.** Adding a record to a rendered string can
 * *lower* its token count: the tokenizer merges across the boundary the new
 * record introduces. So every prefix baseline measures *every* prefix as one
 * complete rendered string and takes the longest that fits. Stopping at the
 * first over-budget prefix, or summing per-record costs, would both silently
 * under-fill a baseline and make it look better than it is (INV-BUDGET-002).
 */

/** Stable identity of the evaluation baseline renderer. */
export const EVALUATION_BASELINE_RENDERER_ID = 'ctxalloc-eval-jsonl';

/** Stable version of the behavior published under {@link EVALUATION_BASELINE_RENDERER_ID}. */
export const EVALUATION_BASELINE_RENDERER_VERSION = '1';

/** Domain separator for a baseline context hash. */
const BASELINE_CONTEXT_HASH_DOMAIN = 'ctxalloc-eval-baseline-context:1';

/** Which baseline a result describes (METRICS 7.1-7.3). */
export type EvaluationBaselineName = 'full-context' | 'truncation' | 'top-k';

/** Why a baseline could not be built. */
export type EvaluationBaselineInapplicableReason = 'incomparable-retrieval-evidence';

/**
 * One baseline outcome.
 *
 * The rendered context is deliberately **absent**: a suite report must carry no
 * source content, and a result type that held it would make leaking it the
 * default (INV-SEC-001). `contextHash` identifies the exact string instead, so
 * two runs can be compared without either publishing it.
 *
 * Only top-k can be inapplicable. Full-context and truncation are always
 * buildable once the candidate batch has validated.
 */
export type EvaluationBaselineResult =
  | {
      readonly applicable: true;
      readonly baseline: EvaluationBaselineName;
      readonly rendererId: string;
      readonly rendererVersion: string;
      readonly includedCandidateCount: number;
      readonly contextTokens: number;
      readonly contextHash: string;
    }
  | {
      readonly applicable: false;
      readonly baseline: 'top-k';
      readonly reason: EvaluationBaselineInapplicableReason;
    };

/**
 * A baseline plus the exact string it rendered.
 *
 * The string stays inside the harness: it is needed to build a model prompt and
 * is never copied into a published result.
 */
export interface EvaluationBaselineBuild {
  readonly result: EvaluationBaselineResult;
  readonly context: string;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/** The exact fields of one v1 rendered record, matching `ContextRenderer` v1. */
interface BaselineRecord {
  readonly blockId: string;
  readonly content: string;
  readonly headingPath?: readonly string[];
  readonly sourceDocumentId: string;
  readonly sourceType: string;
}

/** Exactly one LF between records: one physical line is one block. */
const RECORD_SEPARATOR = '\n';

function recordOf(block: ContextBlock): BaselineRecord {
  return {
    blockId: block.id,
    content: block.content,
    ...(block.headingPath === undefined ? {} : { headingPath: block.headingPath }),
    sourceDocumentId: block.sourceDocumentId,
    sourceType: block.sourceType,
  };
}

/**
 * Serializes candidate wrappers' blocks in the exact order given.
 *
 * Array position is authoritative: nothing is sorted, grouped, or deduplicated,
 * and an empty selection renders as the empty string with no prefix, suffix, or
 * trailing newline.
 */
export function renderBaselineContext(candidates: readonly CandidateBlock[]): string {
  return candidates
    .map((candidate) => canonicalJson(recordOf(candidate.block)))
    .join(RECORD_SEPARATOR);
}

function buildOf(
  baseline: EvaluationBaselineName,
  candidates: readonly CandidateBlock[],
  tokenizer: Tokenizer,
): EvaluationBaselineBuild {
  const context = renderBaselineContext(candidates);
  return {
    result: {
      applicable: true,
      baseline,
      rendererId: EVALUATION_BASELINE_RENDERER_ID,
      rendererVersion: EVALUATION_BASELINE_RENDERER_VERSION,
      includedCandidateCount: candidates.length,
      contextTokens: countEvaluationTokens(tokenizer, context),
      contextHash: domainSeparatedHash(BASELINE_CONTEXT_HASH_DOMAIN, context),
    },
    context,
  };
}

/* -------------------------------------------------------------------------- */
/* Baseline 1: full context                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every validated candidate wrapper, in validated input order (METRICS 7.1).
 *
 * Exact duplicate wrappers stay repeated. That is the measurement: this baseline
 * is the context that would have been sent *without* CtxAlloc, and without
 * CtxAlloc nothing deduplicates them. Collapsing them here would quietly credit
 * the baseline with the compiler's own deduplication and shrink every reported
 * saving.
 *
 * The baseline may exceed the compilation budget, and that is allowed: it is a
 * comparison point, not a compilation that has to fit.
 *
 * The whole rendered string is tokenized once. Summing per-block `tokenCount`
 * values would be a different number — it omits the record framing and cannot
 * see cross-record merges.
 */
export function buildFullContextBaseline(
  candidates: readonly CandidateBlock[],
  tokenizer: Tokenizer,
): EvaluationBaselineBuild {
  return buildOf('full-context', candidates, tokenizer);
}

/* -------------------------------------------------------------------------- */
/* Prefix selection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The longest prefix of `ordered` whose complete rendered string fits.
 *
 * Every prefix from empty to full is rendered and measured exactly once. The
 * loop deliberately does not break on the first over-budget prefix: token counts
 * are not monotonic in the number of records, so a longer prefix can fit where a
 * shorter one did not, and stopping early would silently truncate further than
 * the budget requires.
 *
 * The empty prefix always fits, so a baseline that can seat nothing reports zero
 * candidates and an empty context rather than failing.
 */
function longestFittingPrefix(
  ordered: readonly CandidateBlock[],
  availableInputTokens: number,
  tokenizer: Tokenizer,
): readonly CandidateBlock[] {
  let best: readonly CandidateBlock[] = [];
  for (let length = 1; length <= ordered.length; length += 1) {
    const prefix = ordered.slice(0, length);
    if (countEvaluationTokens(tokenizer, renderBaselineContext(prefix)) <= availableInputTokens) {
      best = prefix;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Baseline 2: truncation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The longest whole-record prefix of validated input order that fits
 * (METRICS 7.2).
 *
 * "Truncation" here is **whole-record**: the selection is always a prefix of the
 * candidate order and a record is never cut in half. Slicing through the middle
 * of a JSON record would produce a context that is not the wire format either
 * side of the comparison uses, and its token count would measure a string no
 * system would ever send. That is a deliberate implementation decision under the
 * `Tokenizer` port, recorded in DEC-040, not an approximation of byte-level
 * truncation.
 */
export function buildTruncationBaseline(
  candidates: readonly CandidateBlock[],
  availableInputTokens: number,
  tokenizer: Tokenizer,
): EvaluationBaselineBuild {
  return buildOf(
    'truncation',
    longestFittingPrefix(candidates, availableInputTokens, tokenizer),
    tokenizer,
  );
}

/* -------------------------------------------------------------------------- */
/* Baseline 3: top-k                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether the batch supports a deterministic retrieval ranking, and how.
 *
 * Two providers' raw scores are not comparable, and neither are two metrics from
 * one provider: a cosine similarity rises with relevance while a distance falls,
 * and normalizing them here would invent a comparison the evidence does not
 * support (INV-SCORE-002). So a score ranking is offered only when every wrapper
 * agrees on provider, version, metric, and direction.
 *
 * Rank is the weaker fallback: it is already an ordering the provider committed
 * to, so it needs only one provider and version to be meaningful.
 */
type TopKContract =
  | { readonly kind: 'score'; readonly higherIsBetter: boolean }
  | { readonly kind: 'rank' }
  | { readonly kind: 'none' };

function topKContractOf(candidates: readonly CandidateBlock[]): TopKContract {
  if (candidates.length === 0) return { kind: 'none' };

  const first = candidates[0]?.retrieval;
  if (first === undefined) return { kind: 'none' };

  const sameProvider = candidates.every(
    (candidate) =>
      candidate.retrieval !== undefined &&
      candidate.retrieval.providerId === first.providerId &&
      candidate.retrieval.providerVersion === first.providerVersion,
  );
  if (!sameProvider) return { kind: 'none' };

  const firstScore = first.score;
  if (
    firstScore !== undefined &&
    candidates.every(
      (candidate) =>
        candidate.retrieval?.score !== undefined &&
        candidate.retrieval.score.semantics === firstScore.semantics &&
        candidate.retrieval.score.higherIsBetter === firstScore.higherIsBetter,
    )
  ) {
    return { kind: 'score', higherIsBetter: firstScore.higherIsBetter };
  }

  if (candidates.every((candidate) => candidate.retrieval?.rank !== undefined)) {
    return { kind: 'rank' };
  }

  return { kind: 'none' };
}

/**
 * Orders one batch under a proved contract.
 *
 * Ties are broken by the provider's own rank when **both** compared wrappers
 * carry one — a rank present on only one side says nothing about their relative
 * order — and then by block identifier over UTF-16 code units, which is total
 * and locale-independent. Two wrappers that are identical under every rule keep
 * their input order, because the sort is stable, so a repeated wrapper stays
 * repeated and adjacent.
 */
function rankCandidates(
  candidates: readonly CandidateBlock[],
  contract: TopKContract,
): readonly CandidateBlock[] {
  if (contract.kind === 'none') return candidates;

  return [...candidates].sort((left, right) => {
    if (contract.kind === 'score') {
      const a = left.retrieval?.score?.value ?? 0;
      const b = right.retrieval?.score?.value ?? 0;
      if (a !== b) return contract.higherIsBetter ? b - a : a - b;
    } else {
      const a = left.retrieval?.rank ?? 0;
      const b = right.retrieval?.rank ?? 0;
      if (a !== b) return a - b;
    }

    const leftRank = left.retrieval?.rank;
    const rightRank = right.retrieval?.rank;
    if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    return compareCodeUnits(left.block.id, right.block.id);
  });
}

/**
 * The longest prefix of the deterministic retrieval ranking that fits
 * (METRICS 7.3).
 *
 * When the batch carries no comparable retrieval evidence the baseline reports
 * itself inapplicable rather than inventing an order. A ranking built from
 * incomparable evidence would still produce a number, and that number would look
 * exactly like a real one in the report.
 */
export function buildTopKBaseline(
  candidates: readonly CandidateBlock[],
  availableInputTokens: number,
  tokenizer: Tokenizer,
): EvaluationBaselineBuild {
  const contract = topKContractOf(candidates);
  if (contract.kind === 'none') {
    return {
      result: {
        applicable: false,
        baseline: 'top-k',
        reason: 'incomparable-retrieval-evidence',
      },
      context: '',
    };
  }

  const ordered = rankCandidates(candidates, contract);
  return buildOf(
    'top-k',
    longestFittingPrefix(ordered, availableInputTokens, tokenizer),
    tokenizer,
  );
}

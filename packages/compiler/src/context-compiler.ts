import {
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type ContextBlockId,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
import {
  BudgetAllocationError,
  BudgetAllocator,
  type AllocatedCandidateSet,
  type BudgetAllocationPolicy,
} from './budget-allocator.js';
import { CandidateDeduplicator } from './candidate-deduplicator.js';
import { CandidateFilter, type FilteredCandidateSet } from './candidate-filter.js';
import {
  CandidateScorer,
  CandidateScoringError,
  type ScoredCandidate,
} from './candidate-scorer.js';
import { CandidateValidationError, CandidateValidator } from './candidate-validator.js';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';
import { calculateCompilationId, type CompilationId } from './compilation-id.js';
import {
  CompilationRequestError,
  CompilationRequestValidator,
  type CompilationRequest,
} from './compilation-request.js';
import {
  CompilationTraceError,
  TraceBuilder,
  hashRenderedContext,
  settleCompilationTrace,
  type CompilationTraceFinalDecision,
  type CompilationTraceHardMinimumSearch,
  type CompilationTraceSettlement,
  type SettledCompilationTrace,
  type UnsettledCompilationTrace,
} from './compilation-trace.js';
import { ContextOrderer, orderCandidatesForRendering } from './context-orderer.js';
import {
  CONTEXT_RENDERER_ID,
  CONTEXT_RENDERER_VERSION,
  ContextRenderer,
  ContextRenderingError,
  renderOrderedCandidates,
  type RenderedContextAttempt,
} from './context-renderer.js';
import { fingerprintCompilationRequest } from './request-fingerprint.js';
import { collectTokenizerPortIssues, countTokensSafely } from './tokenizer-port.js';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * The composition root of the deterministic compiler kernel (DEC-038).
 *
 * `ContextCompiler` is the one component that joins the named topology, settles
 * the rendered budget, and returns a `CompilationResult`:
 *
 * ```text
 * CompilationRequestValidator
 *   -> CandidateValidator      (the one configured Tokenizer)
 *   -> CandidateDeduplicator
 *   -> CandidateScorer         (request.referenceTime)
 *   -> CandidateFilter
 *   -> BudgetAllocator         (request.budget)
 *   -> ContextOrderer
 *   -> ContextRenderer         (the same configured Tokenizer)
 *   -> TraceBuilder            (observational snapshot)
 *   -> render-aware settlement
 *   -> SettledCompilationTrace
 *   -> CompilationResult
 * ```
 *
 * No stage is skipped because the first render happens to fit, and no stage is
 * reimplemented here: each component keeps its own rules, and this one composes
 * them (INV-DEP-003).
 *
 * ## One tokenizer, injected once
 *
 * The compiler owns exactly one configured `Tokenizer` object and uses that same
 * object for candidate block-count validation, for the initial render
 * measurement, and for every render-aware correction measurement. It constructs
 * no tokenizer of its own and accepts no second one, which is what finally makes
 * `tokenizerCoverage: 'validation-and-rendering'` provable and the signed
 * `renderingTokenDelta` of METRICS 8.6 a defined quantity (DEC-035, DEC-037).
 *
 * ## Rendered tokenization is neither additive nor monotonic
 *
 * The `Tokenizer` port promises the exact count of one supplied string and
 * nothing more. `tokens(A + B)` need not equal `tokens(A) + tokens(B)`, and a
 * selection being over budget does not make every superset of it over budget.
 * The correction therefore assigns **no rendered cost to any block**, subtracts
 * no guessed wrapper cost, and proves no infeasibility by summing per-block
 * estimates. Every selection whose rendered feasibility is decided is ordered,
 * rendered, and tokenized as one complete string (INV-BUDGET-002,
 * INV-RENDER-004).
 *
 * ## It is synchronous, deterministic, and offline
 *
 * It reads no clock, no random value, no file, no environment variable, no
 * database, and no network resource, consults no `package.json` and no git
 * revision, and calls no model, no retrieval provider, and no source reader
 * (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). Every identity it
 * records is configured or is a project-owned constant.
 *
 * It treats the request and every stage result as immutable. No candidate,
 * block, attribute, metadata object, source document, score, decision, or array
 * is mutated or reordered in place; corrections build new arrays and new
 * decision records (INV-ALLOC-004).
 */

/* -------------------------------------------------------------------------- */
/* Public contract: configuration                                              */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link ContextCompilerConfig} (INV-STORE-004). */
export const CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION = 1;

/** Current schema version of {@link CompilationResult} (INV-STORE-004). */
export const COMPILATION_RESULT_SCHEMA_VERSION = 1;

/** The name of the correction strategy implemented here. */
export const RENDER_AWARE_CORRECTION_STRATEGY = 'render-aware-v1';

/** Current version of the {@link RENDER_AWARE_CORRECTION_STRATEGY} behavior. */
export const RENDER_AWARE_CORRECTION_VERSION = 1;

/**
 * The explicit composition the compiler is configured with.
 *
 * Nothing is defaulted and nothing is discovered. A compiler identity read from
 * a manifest, a git revision, or an environment variable would differ between a
 * source checkout, a published package, and a container, and it is recorded in
 * every trace and bound into every compilation identifier (INV-DET-003,
 * INV-TRACE-005).
 */
export interface ContextCompilerConfig {
  readonly schemaVersion: typeof CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION;
  readonly compilerId: string;
  readonly compilerVersion: string;

  /**
   * The maximum number of hard-minimum candidate combinations the correction
   * fallback may **visit** before returning a structured search-limit failure.
   *
   * It is required, it is a safe integer of at least one, and it has no default.
   * The bound keeps pathological input from hanging the compiler, and it is a
   * decision input rather than a performance knob: it can change whether the
   * search proves a result or stops without one, so it participates in the
   * compilation identifier (DEC-038).
   */
  readonly maxHardMinimumCombinations: number;
}

/* -------------------------------------------------------------------------- */
/* Public contract: result                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The exact final token usage of one settled compilation.
 *
 * ```text
 * unusedTokens        = availableTokens - compiledTokens
 * renderingTokenDelta = compiledTokens - includedContentTokens
 * ```
 *
 * `candidateTokens` sums every validated `CandidateBlock` wrapper, duplicates
 * included (METRICS 8.1). `includedContentTokens` sums the final selected
 * canonical blocks' own counts (METRICS 8.5). `compiledTokens` is the tokenizer
 * count of `compiledContext` and of nothing else (METRICS 8.4).
 * `availableTokens` is `availableInputTokens(request.budget)` (METRICS 8.3).
 *
 * `renderingTokenDelta` is signed and never clamped. It is reportable because
 * both operands were measured under one tokenizer identity, which this component
 * owns (METRICS 8.6).
 *
 * **No reduction metrics appear.** `tokenReduction` and `tokenReductionRatio`
 * (METRICS 8.7, 8.8) are defined against `baselineInputTokens`, and no baseline
 * exists in a `CompilationRequest`: baselines belong to the evaluation layer.
 * Substituting `candidateTokens`, `canonicalContentTokens`, `availableTokens`,
 * or `totalTokens` for a baseline would publish a different quantity under a
 * documented metric's name (DEC-038).
 */
export interface CompilationResultUsage {
  readonly candidateTokens: number;
  readonly includedContentTokens: number;
  readonly compiledTokens: number;
  readonly availableTokens: number;
  readonly unusedTokens: number;
  readonly renderingTokenDelta: number;
}

/**
 * One successful compilation (ARCHITECTURE 5.7).
 *
 * `compiledContext` is the exact string that was tokenized for
 * `usage.compiledTokens`, and `includedBlocks` are the canonical `ContextBlock`
 * records of that string in exact render order — canonical blocks, not candidate
 * wrappers, carried by reference and never rewritten.
 *
 * Excluded blocks are not repeated here. `trace.settlement.decisions` explains
 * every deduplicated group exactly once, so a second list would be a place for
 * one truth to disagree with itself (INV-DEP-003).
 *
 * `trace` is a `SettledCompilationTrace` at the type level: an unsettled trace
 * cannot be attached to a success (INV-TRACE-006, DEC-038).
 */
export interface CompilationResult {
  readonly schemaVersion: typeof COMPILATION_RESULT_SCHEMA_VERSION;
  readonly compilationId: CompilationId;
  readonly requestId: string;

  readonly compiledContext: string;
  readonly includedBlocks: readonly ContextBlock[];

  readonly usage: CompilationResultUsage;
  readonly trace: SettledCompilationTrace;
}

/* -------------------------------------------------------------------------- */
/* Public contract: failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where one compilation failed.
 *
 * The vocabulary names every point at which the pipeline can stop, so a consumer
 * can route a failure without parsing a message. `deduplication`, `filtering`,
 * and `ordering` are listed for completeness of the contract: those stages
 * consume proved stage contracts under a validated policy and have no failure
 * mode of their own today.
 */
export type ContextCompilationStage =
  | 'configuration'
  | 'request-validation'
  | 'candidate-validation'
  | 'deduplication'
  | 'scoring'
  | 'filtering'
  | 'allocation'
  | 'ordering'
  | 'rendering'
  | 'trace'
  | 'correction'
  | 'result';

/**
 * Machine-readable categories this component raises in its own right.
 *
 * A failure inside a stage keeps the stage's own focused code — `invalid_policy`,
 * `required_content_exceeds_budget`, `tokenizer_failed`, and the rest — because
 * losing the exact reason to a generic wrapper would make the error less useful
 * than the one it replaced. These codes cover only what orchestration itself
 * decides.
 *
 * `required_content_exceeds_budget` is the **rendered** form of INV-BUDGET-004
 * and is documented under the category `REQUIRED_CONTENT_EXCEEDS_BUDGET`. It is
 * deliberately the same code `BudgetAllocator` raises for the block-content form
 * of the same impossibility: one product-level failure category, reported at
 * whichever boundary can prove it.
 *
 * `rendered_hard_constraints_exceed_budget` is a **different** failure: the
 * required blocks fit on their own, and no policy-valid category-minimum base
 * renders within the budget. Category minima are policy constraints, not
 * required-block attributes, so calling that a required-content failure would
 * misdirect the caller to the wrong fix.
 *
 * `correction_search_limit_exceeded` claims nothing about feasibility. The
 * search stopped at its configured bound; a feasible hard base may well exist
 * beyond it.
 */
export type ContextCompilationIssueCode =
  | 'invalid_config'
  | 'invalid_tokenizer'
  | 'required_content_exceeds_budget'
  | 'rendered_hard_constraints_exceed_budget'
  | 'correction_search_limit_exceeded'
  | 'invalid_correction_result'
  | 'invalid_compilation_result';

/**
 * The single error this component raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, nested stage error object,
 * or tokenizer-library exception escapes this boundary: a stage failure is
 * re-addressed as issues under its stage pointer, never re-thrown or attached
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 *
 * `compilationId` is present for every failure after the request validated,
 * because the identifier names the deterministic invocation rather than a
 * successful output. An invalid raw request has none: no validated request
 * fingerprint exists to bind.
 *
 * `trace` is the coherent unsettled snapshot, present when the pipeline reached
 * the point of building one — that is, for a correction or result failure. It is
 * never a settled trace, and no partial `CompilationResult` is ever returned.
 */
export class ContextCompilationError extends Error {
  readonly code = 'CONTEXT_COMPILATION_FAILED';
  readonly stage: ContextCompilationStage;
  readonly issues: readonly ValidationIssue[];

  // `declare` so the class defines no property for an absent value. A field
  // declaration would create `compilationId: undefined` and `trace: undefined`
  // on every failure, which reads as "there is one, and it is nothing" — the
  // opposite of the contract: an invalid raw request has **no** identifier, and
  // a failure before rendering has **no** trace.
  declare readonly compilationId?: CompilationId;
  declare readonly trace?: UnsettledCompilationTrace;

  constructor(
    stage: ContextCompilationStage,
    issues: readonly ValidationIssue[],
    context: {
      readonly compilationId?: CompilationId;
      readonly trace?: UnsettledCompilationTrace;
    } = {},
  ) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Context compilation failed at ${stage}: ${summary}`);
    this.name = 'ContextCompilationError';
    this.stage = stage;
    this.issues = issues;
    if (context.compilationId !== undefined) {
      Object.defineProperty(this, 'compilationId', {
        value: context.compilationId,
        enumerable: true,
      });
    }
    if (context.trace !== undefined) {
      Object.defineProperty(this, 'trace', { value: context.trace, enumerable: true });
    }
  }
}

function issue(
  code: ContextCompilationIssueCode,
  path: IssuePath,
  message: string,
): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/**
 * Re-addresses one stage issue under the stage that produced it.
 *
 * The nested path is prefixed rather than replaced and the exact code is kept,
 * so a failure keeps the reason its owning stage gave it and gains only where it
 * happened. The pointer is re-rendered through the shared helper so a composed
 * pointer is spelled like every other compiler pointer (INV-DEP-003).
 */
function underStage(stage: ContextCompilationStage, stageIssue: ValidationIssue): ValidationIssue {
  const path: IssuePath = [stage, ...stageIssue.path];
  return { code: stageIssue.code, path, pointer: pointerFor(path), message: stageIssue.message };
}

/* -------------------------------------------------------------------------- */
/* Configuration schema                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A configured identity is preserved exactly: validated, never rewritten.
 *
 * No trimming, lowercasing, or canonicalization is applied, exactly as every
 * policy identity in this kernel is preserved. Malformed UTF-16 is rejected with
 * the shared domain helper (INV-BLOCK-007).
 */
const identityString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * The runtime boundary of the injected configuration.
 *
 * Unknown fields are rejected rather than stripped, nothing is coerced, and no
 * default is injected — least of all a search bound, which decides whether a
 * failure is a proof or a stopping point (INV-BLOCK-005, INV-DET-003).
 */
const ContextCompilerConfigSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION),
  compilerId: identityString,
  compilerVersion: identityString,
  maxHardMinimumCombinations: z
    .number()
    .refine((value) => Number.isSafeInteger(value) && value >= 1, {
      message: 'must be a safe integer greater than or equal to 1',
    }),
});

/* -------------------------------------------------------------------------- */
/* Internal selection view                                                     */
/* -------------------------------------------------------------------------- */

/** One eligible group reduced to the facts the correction may read. */
interface CorrectionCandidate {
  readonly scored: ScoredCandidate;
  readonly block: ContextBlock;
  readonly id: ContextBlockId;
  readonly contentTokens: number;
  readonly required: boolean;
  readonly category: string | undefined;
  readonly total: number;
}

function correctionCandidateOf(scored: ScoredCandidate): CorrectionCandidate {
  const block = scored.candidate.canonicalBlock;
  return {
    scored,
    block,
    id: block.id,
    contentTokens: block.tokenCount,
    required: block.attributes.required === true,
    category: block.attributes.category,
    total: scored.score.total,
  };
}

/** A total order over numbers, used only to compose the comparators below. */
function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The allocator's own hard-minimum preference, restated for the fallback search:
 * token count ascending, then score descending, then block identifier ascending.
 *
 * It is deliberately identical to `BudgetAllocator`'s minimum-cost comparator, so
 * the **first** hard base the enumerator visits is exactly the category-minimum
 * choice the allocator preferred. The fallback then walks away from that choice
 * in a defined direction rather than starting somewhere unrelated (DEC-033,
 * DEC-038).
 */
function compareMinimumPreference(a: CorrectionCandidate, b: CorrectionCandidate): number {
  return (
    compareNumbers(a.contentTokens, b.contentTokens) ||
    compareNumbers(b.total, a.total) ||
    compareCodeUnits(a.id, b.id)
  );
}

/** One measured selection: the exact string and the exact count of that string. */
interface RenderMeasurement {
  readonly blocks: readonly ContextBlock[];
  readonly renderedContext: string;
  readonly renderedTokens: number;
}

/** The settled outcome of the render-aware correction. */
interface Settlement {
  readonly measurement: RenderMeasurement;
  readonly correctionApplied: boolean;
  readonly evictedBlockIds: readonly ContextBlockId[];
  readonly search: CompilationTraceHardMinimumSearch;
  /** The final inclusion reason of every block in the settled selection. */
  readonly inclusionReasons: ReadonlyMap<string, CompilationTraceFinalIncludedReason>;
  /** True once the fallback rebuilt the selection from `filtered.eligible`. */
  readonly rebuilt: boolean;
}

type CompilationTraceFinalIncludedReason =
  'INCLUDED_REQUIRED' | 'INCLUDED_CATEGORY_MINIMUM' | 'INCLUDED_SCORE_ORDER';

/* -------------------------------------------------------------------------- */
/* Compiler                                                                    */
/* -------------------------------------------------------------------------- */

export class ContextCompiler {
  readonly #config: ContextCompilerConfig;
  readonly #tokenizer: Tokenizer;
  readonly #validator: CandidateValidator;
  readonly #deduplicator = new CandidateDeduplicator();
  readonly #traceBuilder: TraceBuilder;

  /**
   * Validates the configuration and the injected tokenizer.
   *
   * Both are checked before either is stored, so one call reports every
   * dependency problem rather than one per construction attempt. The tokenizer
   * is checked through the same package-internal rule `ContextRenderer` uses, so
   * the two cannot disagree about what a usable tokenizer is (INV-DEP-003).
   *
   * The `CandidateValidator` and the `TraceBuilder` are built here, from this
   * configuration and this tokenizer. The policy-dependent stages are built per
   * compilation, because their policies arrive with the request.
   *
   * @throws {ContextCompilationError} when the configuration or the tokenizer is
   * not valid.
   */
  constructor(config: unknown, tokenizer: Tokenizer) {
    const parsed = safeParse(ContextCompilerConfigSchema, config);
    const issues: ValidationIssue[] = parsed.ok
      ? []
      : parsed.issues.map((parsedIssue) => ({
          ...parsedIssue,
          code: 'invalid_config' satisfies ContextCompilationIssueCode,
        }));
    issues.push(
      ...collectTokenizerPortIssues(
        tokenizer,
        'invalid_tokenizer' satisfies ContextCompilationIssueCode,
        ['tokenizer'],
      ),
    );
    if (!parsed.ok || issues.length > 0) {
      throw new ContextCompilationError('configuration', issues);
    }

    this.#config = parsed.value;
    this.#tokenizer = tokenizer;
    // The one configured tokenizer, injected into candidate validation here and
    // into every rendered measurement below. Nothing else constructs one.
    this.#validator = new CandidateValidator(tokenizer);
    this.#traceBuilder = new TraceBuilder({
      compilerId: parsed.value.compilerId,
      compilerVersion: parsed.value.compilerVersion,
    });
  }

  /**
   * Compiles one request into a settled result, all or nothing.
   *
   * Every stage runs, in the fixed order of the named topology, and none is
   * skipped because the first render happened to fit. The request and every
   * value reachable from it are treated as immutable.
   *
   * @throws {ContextCompilationError} when any stage fails, when the rendered
   * budget cannot be satisfied, or when the assembled result would contradict
   * itself. No partial `CompilationResult` is ever returned.
   */
  compile(input: unknown): CompilationResult {
    const request = this.#validateRequest(input);
    const compilationId = this.#compilationIdOf(request);
    const at = <T>(stage: ContextCompilationStage, run: () => T): T =>
      this.#stage(stage, run, { compilationId });

    const validated = at('candidate-validation', () =>
      this.#validator.validate({
        scope: request.scope,
        sourceDocuments: request.sourceDocuments,
        candidates: request.candidates,
      }),
    );
    const deduplicated = at('deduplication', () => this.#deduplicator.deduplicate(validated));
    const scored = at('scoring', () =>
      new CandidateScorer(request.policy.scoring).score(deduplicated, request.referenceTime),
    );
    const filtered = at('filtering', () =>
      new CandidateFilter(request.policy.filtering).filter(scored),
    );
    const allocated = at('allocation', () =>
      new BudgetAllocator(request.policy.allocation).allocate(filtered.eligible, request.budget),
    );
    const ordered = at('ordering', () =>
      new ContextOrderer(request.policy.ordering).order(allocated),
    );
    const rendered = at('rendering', () =>
      new ContextRenderer(request.policy.rendering, this.#tokenizer).render(ordered),
    );
    const snapshot = at('trace', () =>
      this.#traceBuilder.build({ request, validated, deduplicated, filtered, rendered }),
    );

    const run: CompilationRun = {
      compilationId,
      requestId: request.id,
      allocationPolicy: request.policy.allocation,
      availableTokens: allocated.availableInputTokens,
      candidateTokens: sumTokens(validated.candidates.map((wrapper) => wrapper.block.tokenCount)),
      filtered,
      allocated,
      rendered,
      snapshot,
    };

    return this.#assemble(run, this.#settle(run));
  }

  /* ------------------------------------------------------------------------ */
  /* Stage plumbing                                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * Validates the raw request, wrapping its structured issues.
   *
   * A request that never validated has no fingerprint, so it has no compilation
   * identifier and no trace to attach: both are genuinely absent rather than
   * invented (DEC-038).
   */
  #validateRequest(input: unknown): CompilationRequest {
    try {
      return new CompilationRequestValidator().validate(input);
    } catch (error: unknown) {
      if (error instanceof CompilationRequestError) {
        throw new ContextCompilationError(
          'request-validation',
          error.issues.map((stageIssue) => underStage('request-validation', stageIssue)),
        );
      }
      throw error;
    }
  }

  /**
   * Runs one stage, converting its project-owned error into this component's.
   *
   * The stage's own focused issue codes and paths survive: they are re-addressed
   * under the stage that raised them, never replaced by a generic wrapper, and
   * the stage error object itself never escapes (INV-ADAPTER-003).
   *
   * Only the kernel's own stage errors are unwrapped. Anything else propagates
   * unchanged, because inventing a compilation stage for an unrelated
   * implementation fault would hide a real defect behind a structured failure.
   */
  #stage<T>(
    stage: ContextCompilationStage,
    run: () => T,
    context: { readonly compilationId: CompilationId; readonly trace?: UnsettledCompilationTrace },
  ): T {
    try {
      return run();
    } catch (error: unknown) {
      if (
        error instanceof CandidateValidationError ||
        error instanceof CandidateScoringError ||
        error instanceof BudgetAllocationError ||
        error instanceof ContextRenderingError ||
        error instanceof CompilationTraceError
      ) {
        throw new ContextCompilationError(
          stage,
          error.issues.map((stageIssue) => underStage(stage, stageIssue)),
          context,
        );
      }
      throw error;
    }
  }

  /**
   * Binds the request fingerprint to every explicit composition input.
   *
   * The correction strategy and its version participate because a different
   * correction can settle a different selection from identical stage evidence,
   * and `maxHardMinimumCombinations` participates because it can change whether
   * the search proves a result at all (DEC-038).
   */
  #compilationIdOf(request: CompilationRequest): CompilationId {
    return calculateCompilationId(fingerprintCompilationRequest(request), {
      compilerId: this.#config.compilerId,
      compilerVersion: this.#config.compilerVersion,
      tokenizerId: this.#tokenizer.id,
      tokenizerVersion: this.#tokenizer.version,
      rendererId: CONTEXT_RENDERER_ID,
      rendererVersion: CONTEXT_RENDERER_VERSION,
      correctionStrategy: RENDER_AWARE_CORRECTION_STRATEGY,
      correctionVersion: RENDER_AWARE_CORRECTION_VERSION,
      maxHardMinimumCombinations: this.#config.maxHardMinimumCombinations,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Render-aware correction                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Settles the rendered budget for one compilation (DEC-038).
   *
   * The strategy has exactly two paths and one goal each:
   *
   * 1. **Cheap path.** Preserve the allocator's selection and give back only the
   *    surplus the allocator itself declared safe, one `optionalEvictionOrder`
   *    entry at a time, re-rendering and re-measuring after every removal. The
   *    first prefix that fits wins.
   * 2. **Fallback.** When the protected hard-constraint base is itself the
   *    problem, prove the required blocks fit on their own, then search the
   *    policy-valid category-minimum bases in a fixed deterministic order for one
   *    that renders within the budget.
   *
   * It is not an optimizer. There is no knapsack, no score-per-token ratio, no
   * beam search, and no claim of maximum utility, token utilization, block count,
   * or information retained. It satisfies the hard constraints and the hard
   * rendered budget, deterministically and auditably (DEC-033, DEC-038).
   *
   * Every feasibility decision measures one exact complete rendered string. No
   * per-block rendered cost is computed, cached, or subtracted, because
   * tokenization is neither additive nor monotonic.
   *
   * @throws {ContextCompilationError} at stage `correction` when the required
   * blocks alone do not render within the budget, when no policy-valid hard base
   * does, or when the configured search bound is reached first.
   */
  #settle(run: CompilationRun): Settlement {
    const { allocated, rendered, filtered } = run;
    const available = run.availableTokens;
    const maxCombinations = this.#config.maxHardMinimumCombinations;
    const noSearch: CompilationTraceHardMinimumSearch = {
      used: false,
      combinationsVisited: 0,
      maxCombinations,
    };

    const eligible = filtered.eligible.candidates.map(correctionCandidateOf);
    const eligibleById = new Map<string, CorrectionCandidate>();
    for (const candidate of eligible) eligibleById.set(candidate.id, candidate);

    const measured = new Map<string, RenderMeasurement>();
    const measure = (blocks: readonly ContextBlock[]): RenderMeasurement =>
      this.#measure(blocks, measured, run);

    // Render attempt 0 is the existing `ContextRenderer` attempt, reused rather
    // than repeated: the renderer already tokenized this exact selection with
    // this exact tokenizer, and counting it again would be one wasted
    // measurement and one more chance to disagree with itself.
    const initial: RenderMeasurement = {
      blocks: rendered.ordered.orderedIncluded.map(
        (decision) => decision.candidate.candidate.canonicalBlock,
      ),
      renderedContext: rendered.renderedContext,
      renderedTokens: rendered.renderedTokens,
    };
    measured.set(selectionKey(initial.blocks), initial);

    const allocatorReasons = new Map<string, CompilationTraceFinalIncludedReason>();
    for (const decision of allocated.included) {
      allocatorReasons.set(decision.candidate.candidate.canonicalBlock.id, decision.reason);
    }

    if (initial.renderedTokens <= available) {
      return {
        measurement: initial,
        correctionApplied: false,
        evictedBlockIds: [],
        search: noSearch,
        inclusionReasons: allocatorReasons,
        rebuilt: false,
      };
    }

    /* Cheap path: the exact published eviction order, prefix by prefix. */
    const current = new Map<string, CorrectionCandidate>();
    for (const decision of allocated.included) {
      const block = decision.candidate.candidate.canonicalBlock;
      const candidate = eligibleById.get(block.id) ?? correctionCandidateOf(decision.candidate);
      current.set(block.id, candidate);
    }

    const evicted: ContextBlockId[] = [];
    for (const blockId of allocated.optionalEvictionOrder) {
      // The order is consumed exactly as published: never sorted, never
      // reordered, never skipped to try a later entry first. Every prefix is
      // safe by construction — it removes no required block and drops no
      // configured category below its minimum (INV-ALLOC-006, INV-BUDGET-003).
      current.delete(blockId);
      evicted.push(blockId);
      const attempt = measure([...current.values()].map((candidate) => candidate.block));
      if (attempt.renderedTokens <= available) {
        return {
          measurement: attempt,
          correctionApplied: true,
          evictedBlockIds: evicted,
          search: noSearch,
          inclusionReasons: allocatorReasons,
          rebuilt: false,
        };
      }
    }

    return this.#searchHardBase(run, {
      eligible,
      measure,
      evictedBlockIds: evicted,
      maxCombinations,
    });
  }

  /**
   * Proves, or fails to prove, that some policy-valid hard base renders within
   * the budget.
   *
   * Exhausting `optionalEvictionOrder` is **not** a feasibility proof. It shows
   * only that no more currently selected optional surplus can be given back under
   * the current hard constraints; the allocator minimized canonical block
   * *content* cost when it chose which candidates satisfy each category minimum,
   * and rendering overhead varies per block, so a protected cheaper-by-content
   * block may render more expensively than an unselected candidate of the same
   * category that satisfies the same minimum (DEC-033).
   *
   * The required-only selection is measured first, because its failure is
   * definitive: required blocks may never be removed, so no other selection can
   * be smaller (INV-BUDGET-003, INV-BUDGET-004).
   */
  #searchHardBase(
    run: CompilationRun,
    context: {
      readonly eligible: readonly CorrectionCandidate[];
      readonly measure: (blocks: readonly ContextBlock[]) => RenderMeasurement;
      readonly evictedBlockIds: readonly ContextBlockId[];
      readonly maxCombinations: number;
    },
  ): Settlement {
    const available = run.availableTokens;
    const { eligible, measure, maxCombinations } = context;
    const required = eligible.filter((candidate) => candidate.required);
    const optional = eligible.filter((candidate) => !candidate.required);

    const requiredOnly = measure(required.map((candidate) => candidate.block));
    if (requiredOnly.renderedTokens > available) {
      throw this.#correctionFailure(
        run,
        'required_content_exceeds_budget',
        ['requiredBlocks'],
        `REQUIRED_CONTENT_EXCEEDS_BUDGET: the ${String(required.length)} required block(s) alone render to ${String(requiredOnly.renderedTokens)} token(s) with ${String(available)} available; required blocks are never removed to repair a budget overrun`,
      );
    }

    const groups = this.#minimumGroups(run, required, optional);
    let visited = 0;

    for (const picks of cartesian(groups.map((group) => group.combinations))) {
      // The bound counts **visited** combinations, including those skipped for
      // content cost below. Stopping is not a feasibility claim, so it is
      // reported under its own code (DEC-038).
      if (visited === maxCombinations) {
        throw this.#correctionFailure(
          run,
          'correction_search_limit_exceeded',
          ['hardMinimumSearch'],
          `the hard-minimum replacement search reached its configured maximum of ${String(maxCombinations)} combination(s) after visiting ${String(visited)}; this is a search limit, not a proof that no hard base fits`,
        );
      }
      visited += 1;

      const selection = [...required, ...picks.flat()];
      // The allocation policy's exact content-budget contract still holds: a
      // rendered measurement is not a licence to exceed the ceiling the
      // allocator enforces on canonical block content (DEC-033).
      const contentTokens = sumTokens(selection.map((candidate) => candidate.contentTokens));
      if (contentTokens > available) continue;

      const attempt = measure(selection.map((candidate) => candidate.block));
      if (attempt.renderedTokens > available) continue;

      const inclusionReasons = new Map<string, CompilationTraceFinalIncludedReason>();
      for (const candidate of required) inclusionReasons.set(candidate.id, 'INCLUDED_REQUIRED');
      for (const candidate of picks.flat()) {
        inclusionReasons.set(candidate.id, 'INCLUDED_CATEGORY_MINIMUM');
      }

      // No optional re-augmentation in v1. The settled hard base is returned as
      // it stands: the common path already preserves the greedy allocation and
      // removes only the minimum safe prefix, this fallback exists because the
      // protected minima rendered poorly, and filling the remaining budget again
      // under non-additive tokenization would need a render-aware optimization
      // policy the current `CompilationPolicy` does not have (DEC-038).
      return {
        measurement: attempt,
        correctionApplied: true,
        evictedBlockIds: context.evictedBlockIds,
        search: {
          used: true,
          combinationsVisited: visited,
          maxCombinations,
          chosenHardBaseBlockIds: [...selection]
            .map((candidate) => candidate.id)
            .sort(compareCodeUnits),
        },
        inclusionReasons,
        rebuilt: true,
      };
    }

    throw this.#correctionFailure(
      run,
      'rendered_hard_constraints_exceed_budget',
      ['hardMinimumSearch'],
      `RENDERED_HARD_CONSTRAINTS_EXCEED_BUDGET: the required blocks render within the ${String(available)} available token(s), but none of the ${String(visited)} policy-valid category-minimum base(s) does`,
    );
  }

  /**
   * The per-category candidate lists and index combinations the search walks.
   *
   * Constrained categories are traversed in project-owned code-unit order, never
   * by locale and never by policy array position. Inside a category the optional
   * candidates are sorted by the allocator's own hard-minimum preference, and the
   * combinations of size `deficit` are enumerated in lexicographic **index**
   * order over that sorted list. The Cartesian product then varies the last
   * category fastest, so the very first combination is exactly the choice
   * `BudgetAllocator` preferred (INV-DET-002, INV-DET-005).
   *
   * A category is disjoint from every other, because a canonical block declares
   * at most one exact category.
   */
  #minimumGroups(
    run: CompilationRun,
    required: readonly CorrectionCandidate[],
    optional: readonly CorrectionCandidate[],
  ): readonly {
    readonly category: string;
    readonly combinations: readonly (readonly CorrectionCandidate[])[];
  }[] {
    const constraints = run.allocationPolicy.categoryConstraints ?? [];
    const categories = [...constraints]
      .filter((constraint) => constraint.minBlocks !== undefined)
      .map((constraint) => constraint.category)
      .sort(compareCodeUnits);

    return categories.flatMap((category) => {
      const minBlocks = constraints.find(
        (constraint) => constraint.category === category,
      )?.minBlocks;
      if (minBlocks === undefined) return [];
      const requiredCount = required.filter((candidate) => candidate.category === category).length;
      const deficit = Math.max(0, minBlocks - requiredCount);
      if (deficit === 0) return [];

      const pool = optional
        .filter((candidate) => candidate.category === category)
        .sort(compareMinimumPreference);
      if (pool.length < deficit) {
        // `BudgetAllocator` rejects an unreachable category minimum before any
        // budget is spent, so reaching this is an internal contradiction rather
        // than something to repair by relaxing the constraint (INV-ALLOC-003).
        throw this.#correctionFailure(
          run,
          'invalid_correction_result',
          ['categoryConstraints', category, 'minBlocks'],
          `category ${quote(category)} needs ${String(deficit)} more eligible optional candidate(s) to satisfy its minimum and the eligible set supplies ${String(pool.length)}`,
        );
      }
      return [{ category, combinations: combinations(pool, deficit) }];
    });
  }

  /**
   * Orders, renders, and tokenizes one complete selection.
   *
   * The ordering comparator and the JSONL serialization are the ones
   * `ContextOrderer` and `ContextRenderer` publish, reached through their shared
   * package-internal helpers, so a corrected selection renders byte-for-byte as
   * the public stages would render it (INV-DEP-003).
   *
   * The result is cached by a canonical block-identifier set key, so the same
   * exact selection is never tokenized twice inside one compilation. The cache
   * holds **complete** measurements only: no per-block rendered cost is stored,
   * because no such quantity exists (INV-RENDER-004).
   */
  #measure(
    blocks: readonly ContextBlock[],
    cache: Map<string, RenderMeasurement>,
    run: CompilationRun,
  ): RenderMeasurement {
    const key = selectionKey(blocks);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const ordered = orderCandidatesForRendering(blocks, (block) => block);
    const renderedContext = renderOrderedCandidates(ordered);
    const counted = countTokensSafely(this.#tokenizer, renderedContext, CORRECTION_SUBJECT);
    if (!counted.ok) {
      throw this.#correctionFailure(
        run,
        'invalid_correction_result',
        ['renderedContext'],
        counted.message,
      );
    }

    const measurement: RenderMeasurement = {
      blocks: ordered,
      renderedContext,
      renderedTokens: counted.tokens,
    };
    cache.set(key, measurement);
    return measurement;
  }

  #correctionFailure(
    run: CompilationRun,
    code: ContextCompilationIssueCode,
    path: IssuePath,
    message: string,
  ): ContextCompilationError {
    return new ContextCompilationError(
      'correction',
      [underStage('correction', issue(code, path, message))],
      { compilationId: run.compilationId, trace: run.snapshot },
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Result                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Settles the trace, assembles the result, and proves both before returning.
   *
   * The settled trace is a **new** value: the observational snapshot is never
   * mutated, and every original filtering decision, allocation decision,
   * allocator summary, and measured attempt travels through untouched. The
   * settlement states separately what the correction did (DEC-038).
   *
   * @throws {ContextCompilationError} at stage `result` when the assembled
   * result would contradict itself.
   */
  #assemble(run: CompilationRun, settlement: Settlement): CompilationResult {
    const includedBlocks = settlement.measurement.blocks;
    const compiledContext = settlement.measurement.renderedContext;
    const compiledTokens = settlement.measurement.renderedTokens;
    const includedContentTokens = sumTokens(includedBlocks.map((block) => block.tokenCount));

    const usage: CompilationResultUsage = {
      candidateTokens: run.candidateTokens,
      includedContentTokens,
      compiledTokens,
      availableTokens: run.availableTokens,
      unusedTokens: run.availableTokens - compiledTokens,
      // Signed and never clamped: one tokenizer identity produced both operands
      // (METRICS 8.6).
      renderingTokenDelta: compiledTokens - includedContentTokens,
    };

    const traceSettlement: CompilationTraceSettlement = {
      strategy: RENDER_AWARE_CORRECTION_STRATEGY,
      correctionApplied: settlement.correctionApplied,
      initialRenderedTokens: run.rendered.renderedTokens,
      evictedBlockIds: [...settlement.evictedBlockIds],
      hardMinimumSearch: settlement.search,
      decisions: finalDecisions(run, settlement, includedBlocks),
      ordering: { orderedBlockIds: includedBlocks.map((block) => block.id) },
      rendering: {
        renderedContextHash: hashRenderedContext(compiledContext),
        compiledTokens,
      },
      usage: {
        availableInputTokens: run.availableTokens,
        includedContentTokens,
        unusedTokens: usage.unusedTokens,
        renderingTokenDelta: usage.renderingTokenDelta,
      },
    };

    const result: CompilationResult = {
      schemaVersion: COMPILATION_RESULT_SCHEMA_VERSION,
      compilationId: run.compilationId,
      requestId: run.requestId,
      compiledContext,
      includedBlocks,
      usage,
      trace: settleCompilationTrace(run.snapshot, run.compilationId, traceSettlement),
    };

    const issues = verifyResult(run, result).map((resultIssue) =>
      underStage('result', resultIssue),
    );
    if (issues.length > 0) {
      throw new ContextCompilationError('result', issues, {
        compilationId: run.compilationId,
        trace: run.snapshot,
      });
    }
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Internal run context                                                        */
/* -------------------------------------------------------------------------- */

/** Everything one compilation carries past the render attempt, named once. */
interface CompilationRun {
  readonly compilationId: CompilationId;
  readonly requestId: string;
  readonly allocationPolicy: BudgetAllocationPolicy;
  readonly availableTokens: number;
  readonly candidateTokens: number;
  readonly filtered: FilteredCandidateSet;
  readonly allocated: AllocatedCandidateSet;
  readonly rendered: RenderedContextAttempt;
  readonly snapshot: UnsettledCompilationTrace;
}

/** Names the measured string in a correction tokenizer failure message. */
const CORRECTION_SUBJECT = 'a render-aware correction attempt';

/**
 * A deterministic key for one complete selection, by block identity alone.
 *
 * Identifiers are sorted with the project-owned code-unit comparison, so the key
 * does not depend on `Map` or `Set` insertion, on allocation chronology, or on
 * render order (INV-DET-002). Canonical block identifiers are unique across
 * groups, which is what makes the key well defined.
 */
function selectionKey(blocks: readonly ContextBlock[]): string {
  return canonicalJson([...blocks.map((block) => block.id)].sort(compareCodeUnits));
}

/**
 * Sums token counts, refusing to publish an unsafe integer.
 *
 * Token counts are correctness data, and a total that cannot be compared or
 * subtracted exactly is not a total (INV-BUDGET-005). An unsafe sum returns
 * `Number.NaN`, which every downstream check rejects rather than publishes.
 */
function sumTokens(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return Number.NaN;
    total += value;
    if (!Number.isSafeInteger(total)) return Number.NaN;
  }
  return total;
}

/**
 * Every combination of exactly `size` items, in lexicographic index order.
 *
 * The enumeration walks index tuples, never values, so the order depends only on
 * the position of a candidate in the already-sorted pool and never on its
 * content, score, or identifier spelling beyond that sort (INV-DET-002).
 */
function combinations<TItem>(pool: readonly TItem[], size: number): readonly (readonly TItem[])[] {
  if (size === 0) return [[]];
  if (size > pool.length) return [];

  const result: TItem[][] = [];
  const indices: number[] = Array.from({ length: size }, (_, offset) => offset);
  for (;;) {
    result.push(indices.map((index) => pool[index] as TItem));
    let cursor = size - 1;
    while (cursor >= 0 && (indices[cursor] as number) === pool.length - size + cursor) cursor -= 1;
    if (cursor < 0) return result;
    indices[cursor] = (indices[cursor] as number) + 1;
    for (let next = cursor + 1; next < size; next += 1) {
      indices[next] = (indices[next - 1] as number) + 1;
    }
  }
}

/**
 * The Cartesian product of the per-category combination lists.
 *
 * The first list varies slowest, so the first tuple takes each category's first
 * combination — the allocator's own preference — and the search then walks away
 * from it in one fixed direction (INV-DET-002).
 *
 * It is a generator so that a bounded search visits only what it needs: a
 * pathological policy must not build every tuple in memory before the bound can
 * stop it.
 */
function* cartesian<TItem>(
  lists: readonly (readonly TItem[])[],
): Generator<readonly TItem[], void, undefined> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [first, ...rest] = lists;
  for (const item of first ?? []) {
    for (const tail of cartesian(rest)) yield [item, ...tail];
  }
}

/* -------------------------------------------------------------------------- */
/* Final decisions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Projects exactly one final decision onto every deduplicated group.
 *
 * Group order follows the trace's own group order, which follows deduplication
 * order, so the settlement reads beside the snapshot it settles. The original
 * allocator verdicts are read, never rewritten: they stay exactly where the
 * snapshot recorded them (INV-TRACE-001, INV-TRACE-006).
 *
 * Filtered groups keep `FILTERED_POLICY`: the correction never reconsiders them,
 * because eligibility is a precondition of selection.
 *
 * An exclusion is attributed to whichever decision actually made it. On the
 * initial-fit and cheap-eviction paths the allocator's own exclusions stand as
 * `EXCLUDED_INITIAL_ALLOCATION`, and only a block the correction evicted becomes
 * `EXCLUDED_RENDER_AWARE_CORRECTION`. Once the fallback has rebuilt the selection
 * from `FilteredCandidateSet.eligible`, the correction has decided every eligible
 * optional candidate itself, so each one it did not select is a correction
 * exclusion — with the allocator's original reason still carried alongside where
 * it had one.
 */
function finalDecisions(
  run: CompilationRun,
  settlement: Settlement,
  includedBlocks: readonly ContextBlock[],
): readonly CompilationTraceFinalDecision[] {
  const renderPositions = new Map<string, number>();
  includedBlocks.forEach((block, index) => renderPositions.set(block.id, index));

  return run.snapshot.groups.map((group): CompilationTraceFinalDecision => {
    const blockId = group.canonical.id;
    if (group.filtering.decision === 'filtered') {
      return { blockId, disposition: 'filtered', reason: 'FILTERED_POLICY' };
    }

    const renderPosition = renderPositions.get(blockId);
    if (renderPosition !== undefined) {
      return {
        blockId,
        disposition: 'included',
        reason: settlement.inclusionReasons.get(blockId) ?? 'INCLUDED_SCORE_ORDER',
        renderPosition,
      };
    }

    const allocation = group.allocation;
    const allocatorExclusion =
      allocation !== undefined && allocation.decision === 'excluded'
        ? allocation.reason
        : undefined;
    const reason =
      allocatorExclusion !== undefined && !settlement.rebuilt
        ? 'EXCLUDED_INITIAL_ALLOCATION'
        : 'EXCLUDED_RENDER_AWARE_CORRECTION';
    return {
      blockId,
      disposition: 'excluded',
      reason,
      ...(allocatorExclusion === undefined ? {} : { initialAllocationReason: allocatorExclusion }),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Result reconciliation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Proves the assembled result satisfies everything a success claims.
 *
 * These checks defend against a future edit rather than validate caller input: a
 * budget-accounting, selection, or trace-reconciliation defect must fail loudly
 * instead of returning a `CompilationResult` whose numbers a consumer could not
 * reconcile (INV-BUDGET-001, INV-BUDGET-006, INV-TRACE-003, INV-TRACE-004).
 * Nothing here changes a decision, and nothing repairs one.
 */
function verifyResult(run: CompilationRun, result: CompilationResult): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (path: IssuePath, message: string): void => {
    issues.push(issue('invalid_compilation_result', path, message));
  };

  const { usage, includedBlocks, compiledContext, trace } = result;
  const includedIds = includedBlocks.map((block) => block.id);
  const includedIdSet = new Set<string>(includedIds);

  /* 1-3, 11: exact budget arithmetic. */
  if (!Number.isSafeInteger(usage.compiledTokens) || usage.compiledTokens < 0) {
    fail(['usage', 'compiledTokens'], 'must be a finite non-negative safe integer');
  }
  if (usage.compiledTokens > usage.availableTokens) {
    fail(
      ['usage', 'compiledTokens'],
      `must not exceed the ${String(usage.availableTokens)} available input token(s), measured ${String(usage.compiledTokens)}`,
    );
  }
  if (usage.unusedTokens !== usage.availableTokens - usage.compiledTokens) {
    fail(['usage', 'unusedTokens'], 'must equal availableTokens minus compiledTokens exactly');
  }
  if (!Number.isSafeInteger(usage.renderingTokenDelta)) {
    fail(['usage', 'renderingTokenDelta'], 'must be a signed safe integer');
  }
  if (usage.renderingTokenDelta !== usage.compiledTokens - usage.includedContentTokens) {
    fail(
      ['usage', 'renderingTokenDelta'],
      'must equal compiledTokens minus includedContentTokens exactly',
    );
  }
  if (!Number.isSafeInteger(usage.candidateTokens) || usage.candidateTokens < 0) {
    fail(['usage', 'candidateTokens'], 'must be a finite non-negative safe integer');
  }
  const contentSum = sumTokens(includedBlocks.map((block) => block.tokenCount));
  if (usage.includedContentTokens !== contentSum) {
    fail(
      ['usage', 'includedContentTokens'],
      "must equal the exact sum of the final selected blocks' token counts",
    );
  }
  /* 7: the allocator's content ceiling still binds the corrected selection. */
  if (!(contentSum <= usage.availableTokens)) {
    fail(
      ['includedBlocks'],
      `final canonical content must not exceed the ${String(usage.availableTokens)} available input token(s), calculated ${String(contentSum)}`,
    );
  }

  /* 8, 10, 20: the final order holds each selected group exactly once. */
  if (includedIdSet.size !== includedIds.length) {
    fail(['includedBlocks'], 'must not include one canonical group more than once');
  }

  /* 5, 19: everything selected came from the eligible set. */
  const eligibleById = new Map<string, CorrectionCandidate>();
  for (const candidate of run.filtered.eligible.candidates) {
    const view = correctionCandidateOf(candidate);
    eligibleById.set(view.id, view);
  }
  for (const id of includedIds) {
    if (!eligibleById.has(id)) {
      fail(['includedBlocks'], `block ${quote(id)} is not an eligible candidate`);
    }
  }

  /* 4, 18: every required eligible group survived every correction. */
  for (const [id, candidate] of [...eligibleById].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (candidate.required && !includedIdSet.has(id)) {
      fail(['includedBlocks'], `required block ${quote(id)} is absent from the final selection`);
    }
  }

  /* 6: category minimums and maximums still hold. */
  const selectedByCategory = new Map<string, number>();
  for (const id of includedIds) {
    const category = eligibleById.get(id)?.category;
    if (category === undefined) continue;
    selectedByCategory.set(category, (selectedByCategory.get(category) ?? 0) + 1);
  }
  for (const constraint of [...(run.allocationPolicy.categoryConstraints ?? [])].sort((a, b) =>
    compareCodeUnits(a.category, b.category),
  )) {
    const selected = selectedByCategory.get(constraint.category) ?? 0;
    if (constraint.minBlocks !== undefined && selected < constraint.minBlocks) {
      fail(
        ['includedBlocks'],
        `category ${quote(constraint.category)} requires at least ${String(constraint.minBlocks)} block(s) and the final selection holds ${String(selected)}`,
      );
    }
    if (constraint.maxBlocks !== undefined && selected > constraint.maxBlocks) {
      fail(
        ['includedBlocks'],
        `category ${quote(constraint.category)} allows at most ${String(constraint.maxBlocks)} block(s) and the final selection holds ${String(selected)}`,
      );
    }
  }

  /* 9: the returned string is exactly the string that was measured. */
  const rerendered = renderOrderedCandidates(includedBlocks);
  if (rerendered !== compiledContext) {
    fail(
      ['compiledContext'],
      'must be exactly the rendering of includedBlocks in their published order',
    );
  }

  /* 12-17: the settled trace reconciles with the returned result. */
  if (!trace.settled) fail(['trace', 'settled'], 'must be true for a successful compilation');
  if (trace.compilationId !== result.compilationId) {
    fail(['trace', 'compilationId'], 'must equal the compilation identifier of the result');
  }
  if (trace.composition.tokenizerCoverage !== 'validation-and-rendering') {
    fail(['trace', 'composition', 'tokenizerCoverage'], 'must be validation-and-rendering');
  }
  const settlement = trace.settlement;
  if (canonicalJson(settlement.ordering.orderedBlockIds) !== canonicalJson(includedIds)) {
    fail(
      ['trace', 'settlement', 'ordering', 'orderedBlockIds'],
      'must equal the final render order of includedBlocks',
    );
  }
  if (settlement.rendering.compiledTokens !== usage.compiledTokens) {
    fail(['trace', 'settlement', 'rendering', 'compiledTokens'], 'must equal usage.compiledTokens');
  }
  if (settlement.rendering.renderedContextHash !== hashRenderedContext(compiledContext)) {
    fail(
      ['trace', 'settlement', 'rendering', 'renderedContextHash'],
      'must be the digest of the exact final compiled context',
    );
  }
  if (
    settlement.usage.availableInputTokens !== usage.availableTokens ||
    settlement.usage.includedContentTokens !== usage.includedContentTokens ||
    settlement.usage.unusedTokens !== usage.unusedTokens ||
    settlement.usage.renderingTokenDelta !== usage.renderingTokenDelta
  ) {
    fail(['trace', 'settlement', 'usage'], 'must equal the usage of the result');
  }

  /* 19-20, INV-TRACE-001: one final decision per group, positions complete. */
  const decided = settlement.decisions.map((decision) => decision.blockId);
  if (
    decided.length !== run.snapshot.groups.length ||
    new Set(decided).size !== decided.length ||
    !run.snapshot.groups.every((group) => decided.includes(group.canonical.id))
  ) {
    fail(
      ['trace', 'settlement', 'decisions'],
      'must hold exactly one decision for each deduplicated group',
    );
  }
  const positions = settlement.decisions
    .filter((decision) => decision.disposition === 'included')
    .map((decision) => decision.renderPosition);
  const distinct = new Set(positions);
  if (
    positions.length !== includedIds.length ||
    distinct.size !== includedIds.length ||
    positions.some((position) => position < 0 || position >= includedIds.length)
  ) {
    fail(
      ['trace', 'settlement', 'decisions'],
      `final render positions must cover 0 to ${String(includedIds.length - 1)} exactly once`,
    );
  }
  for (const decision of settlement.decisions) {
    if (decision.disposition === 'filtered' && includedIdSet.has(decision.blockId)) {
      fail(
        ['trace', 'settlement', 'decisions'],
        `filtered block ${quote(decision.blockId)} must not be included in the final selection`,
      );
    }
  }

  return issues;
}

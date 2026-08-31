import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextOrderer,
  ContextRenderer,
  TraceBuilder,
  type AllocatedCandidateSet,
  type CompilationRequest,
  type CompilationTrace,
  type CompilationTraceBuildInput,
  type CompilationTraceGroup,
  type DeduplicatedCandidateSet,
  type FilteredCandidateSet,
  type OrderedCandidateSet,
  type RenderedContextAttempt,
  type ScoredCandidateSet,
  type ValidatedCandidateSet,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { compilationPolicy } from './compilation-fixtures.js';
import {
  ALLOCATION_SCORING_POLICY,
  budget,
  candidateOf,
  contentOf,
  omit,
  permutations,
  type CandidateSpec,
} from './allocation-fixtures.js';
import { SCOPE, contextBlock, countWords, sourceDocument, wordTokenizer } from './fixtures.js';

/**
 * Shared fixtures for the compilation trace tests.
 *
 * Every trace is built from evidence the **real** Phase 7-13 components produced:
 * `CompilationRequestValidator`, `CandidateValidator`, `CandidateDeduplicator`,
 * `CandidateScorer`, `CandidateFilter`, `BudgetAllocator`, `ContextOrderer`, and
 * `ContextRenderer` are composed by hand here, exactly as `pipeline.test.ts`
 * composes them, so `TraceBuilder` is exercised against genuinely produced stage
 * contracts rather than hand-assembled structures that might not survive the
 * pipeline (DEC-037).
 *
 * One tokenizer validates block counts and measures the rendered string, which is
 * the composition requirement DEC-035 records.
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
  omit,
  permutations,
  sourceDocument,
  wordTokenizer,
  SCOPE,
  type CandidateSpec,
};

/** The explicit instant every trace test measures recency against. */
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

/** The compiler identity the tests inject; nothing discovers one (DEC-037). */
export const TRACE_CONFIG = { compilerId: 'ctxalloc-compiler', compilerVersion: '0.14.0' } as const;

/**
 * A five-slice policy whose scoring turns authored priority `p` into `p / 1000`.
 *
 * Filtering has no threshold unless a test states one, so "nothing is filtered"
 * is a stated no-op rather than an accident.
 */
export function tracePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return compilationPolicy({
    scoring: { ...ALLOCATION_SCORING_POLICY },
    filtering: { schemaVersion: 1, policyId: 'filtering', policyVersion: '3.0.0' },
    ...overrides,
  });
}

export interface TraceRunOptions {
  readonly id?: string;
  readonly query?: string;
  readonly referenceTime?: string;
  readonly scope?: Record<string, unknown>;
  readonly specs?: readonly CandidateSpec[];
  readonly candidates?: readonly Record<string, unknown>[];
  readonly sourceDocuments?: readonly Record<string, unknown>[];
  readonly available?: number;
  readonly budget?: Record<string, unknown>;
  readonly policy?: Record<string, unknown>;
  readonly tokenizer?: Tokenizer;
}

/** One complete, unvalidated compilation request record. */
export function requestInput(options: TraceRunOptions = {}): Record<string, unknown> {
  const candidates = options.candidates ?? (options.specs ?? []).map((spec) => candidateOf(spec));
  return {
    id: options.id ?? 'req-trace-1',
    schemaVersion: 1,
    scope: options.scope ?? { ...SCOPE },
    query: options.query ?? 'which blocks explain allocation?',
    referenceTime: options.referenceTime ?? REFERENCE_TIME,
    candidates: [...candidates],
    sourceDocuments: [...(options.sourceDocuments ?? [sourceDocument()])],
    budget: options.budget ?? (budget(options.available ?? 1000) as Record<string, unknown>),
    policy: options.policy ?? tracePolicy(),
  };
}

/** Every stage result of one composed pipeline run. */
export interface TraceRun {
  readonly request: CompilationRequest;
  readonly validated: ValidatedCandidateSet;
  readonly deduplicated: DeduplicatedCandidateSet;
  readonly scored: ScoredCandidateSet;
  readonly filtered: FilteredCandidateSet;
  readonly allocated: AllocatedCandidateSet;
  readonly ordered: OrderedCandidateSet;
  readonly rendered: RenderedContextAttempt;
  readonly input: CompilationTraceBuildInput;
}

/**
 * Runs the named pipeline once and returns every stage result.
 *
 * ```text
 * CompilationRequest validation
 *   -> CandidateValidator -> CandidateDeduplicator -> CandidateScorer
 *   -> CandidateFilter -> BudgetAllocator -> ContextOrderer -> ContextRenderer
 * ```
 */
export function runPipeline(options: TraceRunOptions = {}): TraceRun {
  const tokenizer = options.tokenizer ?? wordTokenizer;
  const request = new CompilationRequestValidator().validate(requestInput(options));

  const validated = new CandidateValidator(tokenizer).validate({
    scope: request.scope,
    sourceDocuments: request.sourceDocuments,
    candidates: request.candidates,
  });
  const deduplicated = new CandidateDeduplicator().deduplicate(validated);
  const scored = new CandidateScorer(request.policy.scoring).score(
    deduplicated,
    request.referenceTime,
  );
  const filtered = new CandidateFilter(request.policy.filtering).filter(scored);
  const allocated = new BudgetAllocator(request.policy.allocation).allocate(
    filtered.eligible,
    request.budget,
  );
  const ordered = new ContextOrderer(request.policy.ordering).order(allocated);
  const rendered = new ContextRenderer(request.policy.rendering, tokenizer).render(ordered);

  return {
    request,
    validated,
    deduplicated,
    scored,
    filtered,
    allocated,
    ordered,
    rendered,
    input: { request, validated, deduplicated, filtered, rendered },
  };
}

/** Builds one trace from a composed run. */
export function buildTrace(
  run: TraceRun,
  config: Record<string, unknown> = { ...TRACE_CONFIG },
): CompilationTrace {
  return new TraceBuilder(config).build(run.input);
}

/** Runs the pipeline and traces it in one call. */
export function trace(options: TraceRunOptions = {}): CompilationTrace {
  return buildTrace(runPipeline(options));
}

/** The one group addressing `blockId`, for evidence assertions. */
export function groupFor(built: CompilationTrace, blockId: string): CompilationTraceGroup {
  const found = built.groups.filter((group) => group.canonical.id === blockId);
  if (found.length !== 1 || found[0] === undefined) {
    throw new Error(`expected exactly one group for ${blockId}, found ${String(found.length)}`);
  }
  return found[0];
}

/** Every group's disposition as `blockId -> disposition`, in trace order. */
export function dispositionsOf(built: CompilationTrace): Record<string, string> {
  return Object.fromEntries(
    built.groups.map((group) => [group.canonical.id, group.currentDisposition]),
  );
}

/** The structured issues of a rejected build. */
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

export function issuePointersOf(run: () => unknown): readonly string[] {
  return issuesOf(run).map((issue) => issue.pointer);
}

/* -------------------------------------------------------------------------- */
/* Evidence surgery, for the coherence tests                                   */
/* -------------------------------------------------------------------------- */

/** The same render attempt with a patched nested allocation. */
export function withAllocation(
  rendered: RenderedContextAttempt,
  patch: Partial<AllocatedCandidateSet>,
): RenderedContextAttempt {
  return {
    ...rendered,
    ordered: { ...rendered.ordered, allocation: { ...rendered.ordered.allocation, ...patch } },
  };
}

/** The same render attempt with a patched nested ordering. */
export function withOrdered(
  rendered: RenderedContextAttempt,
  patch: Partial<OrderedCandidateSet>,
): RenderedContextAttempt {
  return { ...rendered, ordered: { ...rendered.ordered, ...patch } };
}

/* -------------------------------------------------------------------------- */
/* Tokenizers                                                                  */
/* -------------------------------------------------------------------------- */

/** A tokenizer that records every text it was asked to count. */
export function recordingTokenizer(calls: string[]): Tokenizer {
  return {
    id: 'test:recording',
    version: '2',
    countTokens: (text: string): number => {
      calls.push(text);
      return countWords(text);
    },
  };
}

/** A tokenizer that returns one fixed huge count, for the overflow test. */
export function hugeTokenizer(tokens: number): Tokenizer {
  return { id: 'test:huge', version: '1', countTokens: (): number => tokens };
}

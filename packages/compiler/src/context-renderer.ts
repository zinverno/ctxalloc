import {
  findLoneSurrogate,
  safeParse,
  type ContextBlock,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
import type { OrderedCandidateSet } from './context-orderer.js';
import { canonicalJson } from './canonical-json.js';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * Deterministic context rendering and exact render measurement (DEC-035).
 *
 * `ContextRenderer` is the sixth stage of the compiler kernel. It turns an
 * `OrderedCandidateSet`, one narrow versioned `ContextRenderingPolicy`, and one
 * project-owned `Tokenizer` into a `RenderedContextAttempt`: the current
 * selection serialized as one deterministic, boundary-safe string, plus the
 * token count of exactly that string.
 *
 * It exists because a sum of block token counts is not a compiled size.
 * INV-BUDGET-002 makes the rendered string the source of truth, and until some
 * stage tokenizes an actual rendered string, no part of the kernel has measured
 * what the model would receive.
 *
 * **A render attempt is not a successful compilation.** This stage measures one
 * selection; it does not correct it. `renderedTokens` may exceed
 * `availableInputTokens`, and that is not an error here: it is reported as
 * `fitsAvailableInputBudget: false` and handed to the future orchestration loop,
 * which owns eviction, re-ordering, re-rendering, render-aware replacement of
 * protected category-minimum choices, and the proof of final infeasibility. This
 * stage therefore evicts nothing, drops nothing, replaces nothing, calls no
 * earlier stage, and never raises `REQUIRED_CONTENT_EXCEEDS_BUDGET`
 * (INV-ALLOC-002, INV-BUDGET-003).
 *
 * **Rendering is serialization, not rewriting.** No content is trimmed,
 * normalized, re-encoded, truncated, or summarized, and no canonical block is
 * mutated or cloned: every rendered line parses back to exactly the content the
 * block carries (INV-PROV-004, INV-RENDER-005, DEC-014).
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model, no retrieval provider, no renderer of its own, and no
 * tokenizer implementation it constructed itself (INV-DET-001, INV-DET-003,
 * INV-DET-004, INV-DEP-002).
 */

/* -------------------------------------------------------------------------- */
/* Public contract: renderer identity                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stable identity of this renderer implementation.
 *
 * A future trace records which renderer produced a string (INV-TRACE-005), and
 * two counts are comparable only when the renderer and the tokenizer that
 * produced them match. The value is a project-owned constant: it is never
 * derived from the package manager, from git, from the clock, or from an
 * environment variable, all of which would make the recorded identity depend on
 * where the code happened to run (INV-DET-003, INV-DET-004).
 */
export const CONTEXT_RENDERER_ID = 'ctxalloc-jsonl';

/** Stable version of the rendering behavior published under {@link CONTEXT_RENDERER_ID}. */
export const CONTEXT_RENDERER_VERSION = '1';

/* -------------------------------------------------------------------------- */
/* Public contract: policy                                                     */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link ContextRenderingPolicy} (INV-STORE-004). */
export const CONTEXT_RENDERING_POLICY_SCHEMA_VERSION = 1;

/**
 * One narrow versioned rendering policy, owned by this compiler stage.
 *
 * As in DEC-032, DEC-033, and DEC-034, the broad future `CompilationPolicy` of
 * ARCHITECTURE 5.6 is not built here: only the rendering slice exists, because
 * only the rendering stage exists.
 *
 * `format` names the wire shape explicitly rather than leaving it implicit, so a
 * second format — Markdown sections, XML-like wrappers, human-readable source
 * titles — arrives as a policy value under a new schema version rather than as a
 * silent change of what this one means.
 */
export interface ContextRenderingPolicy {
  readonly schemaVersion: typeof CONTEXT_RENDERING_POLICY_SCHEMA_VERSION;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly format: 'jsonl-blocks';
}

/* -------------------------------------------------------------------------- */
/* Public contract: result                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One exact measurement of one selection: an ephemeral compiler-stage result,
 * never persisted, so it carries no schema version.
 *
 * It is deliberately **not** a `CompilationResult`, and its names say so.
 * `renderedTokens` is not `compiledTokens` (METRICS 8.4) and
 * `renderedTokenDelta` is not `renderingTokenDelta` (METRICS 8.6): those are
 * final metrics of a settled selection, and this selection may still change. For
 * the same reason no `unusedTokens`, `tokenReduction`, or `budgetUtilization`
 * appears here — each is defined against `compiledTokens`, which does not exist
 * until the correction loop has finished.
 *
 * The ordered set is nested rather than flattened, exactly as
 * `OrderedCandidateSet` nests the allocation: every earlier fact stays reachable,
 * unchanged, and stated once (INV-DEP-003).
 */
export interface RenderedContextAttempt {
  readonly ordered: OrderedCandidateSet;

  readonly renderingPolicyId: string;
  readonly renderingPolicyVersion: string;

  /** Identity of the renderer that produced `renderedContext` (INV-TRACE-005). */
  readonly rendererId: string;
  readonly rendererVersion: string;

  /**
   * Identity of the tokenizer that produced `renderedTokens` (INV-TRACE-005).
   *
   * Counts from different tokenizers are not comparable. Nothing in the stage
   * contracts carries a tokenizer identity from `CandidateValidator` through to
   * here, so this stage publishes its own rather than claiming an agreement it
   * cannot verify; enforcing one identity across the stages belongs to the
   * future composition root (DEC-035).
   */
  readonly tokenizerId: string;
  readonly tokenizerVersion: string;

  /** The complete rendered string, and the only thing that was tokenized. */
  readonly renderedContext: string;

  /**
   * `tokenizer.countTokens(renderedContext)`, a finite non-negative safe integer.
   *
   * It is never a sum of block counts, record counts, or separator counts, and
   * never an estimate from string length (INV-BUDGET-002, INV-BUDGET-005).
   */
  readonly renderedTokens: number;

  /**
   * `renderedTokens - allocation.selectedBlockContentTokens`: a **signed** delta.
   *
   * It may be negative, zero, or positive, and it is diagnostic only. It is not
   * an additive attribution of wrapper, separator, or source-label tokens,
   * because tokenization is not additive: `tokenizer(a + b)` need not equal
   * `tokenizer(a) + tokenizer(b)`, so embedding content in a larger string can
   * move token boundaries in either direction (DEC-035, METRICS 8.6).
   */
  readonly renderedTokenDelta: number;

  /**
   * `renderedTokens <= allocation.availableInputTokens`, observational only.
   *
   * `false` is a successful measurement of an over-budget attempt, not a
   * failure. No reserve is subtracted here, no model context window is guessed,
   * and the `TokenBudget` is not modified.
   */
  readonly fitsAvailableInputBudget: boolean;
}

/* -------------------------------------------------------------------------- */
/* Public contract: failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable categories of a context rendering problem.
 *
 * Serialization itself cannot fail: the ordered set is a stage contract the
 * earlier stages have already proved, and JSON encoding of validated JSON-safe
 * strings is total. Every code here therefore describes an injected dependency —
 * the policy, or the tokenizer and what it returned.
 */
export type ContextRenderingIssueCode =
  'invalid_policy' | 'invalid_tokenizer' | 'tokenizer_failed' | 'invalid_rendered_token_count';

/**
 * The single error this component raises.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or tokenizer-library
 * exception escapes this boundary: a thrown value is described by name and
 * message and the object itself is never re-thrown or attached
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class ContextRenderingError extends Error {
  readonly code = 'CONTEXT_RENDERING_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Context rendering failed: ${summary}`);
    this.name = 'ContextRenderingError';
    this.issues = issues;
  }
}

function issue(code: ContextRenderingIssueCode, path: IssuePath, message: string): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/* -------------------------------------------------------------------------- */
/* Policy schema                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A policy string is configuration, not content: it is validated and never
 * rewritten.
 *
 * No trimming, lowercasing, or canonicalization is applied. Malformed UTF-16 is
 * rejected with the shared domain helper, exactly as the scoring, allocation,
 * and ordering policies reject it (INV-BLOCK-007).
 */
const policyString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

const ContextRenderingPolicySchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_RENDERING_POLICY_SCHEMA_VERSION),
  policyId: policyString,
  policyVersion: policyString,
  // The one format of schema version 1. A future format is a new accepted value
  // under a new schema version, never a silent change of this one.
  format: z.literal('jsonl-blocks'),
});

/* -------------------------------------------------------------------------- */
/* Tokenizer validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The tokenizer is an injected dependency whose count is correctness data, so
 * its port shape is checked once at construction rather than trusted from the
 * compile-time type alone: this stage is reachable from a runtime boundary where
 * the compile-time type proves nothing.
 *
 * Identity values are checked for blankness and never rewritten: a trace records
 * them verbatim, and trimming here would publish a value the caller never
 * configured (INV-TRACE-005).
 */
function validateTokenizer(tokenizer: Tokenizer): readonly ValidationIssue[] {
  if (typeof tokenizer !== 'object' || tokenizer === null) {
    return [issue('invalid_tokenizer', ['tokenizer'], 'must be a Tokenizer')];
  }
  const issues: ValidationIssue[] = [];
  if (typeof tokenizer.id !== 'string' || tokenizer.id.trim().length === 0) {
    issues.push(
      issue('invalid_tokenizer', ['tokenizer', 'id'], 'must not be empty or whitespace-only'),
    );
  }
  if (typeof tokenizer.version !== 'string' || tokenizer.version.trim().length === 0) {
    issues.push(
      issue('invalid_tokenizer', ['tokenizer', 'version'], 'must not be empty or whitespace-only'),
    );
  }
  if (typeof tokenizer.countTokens !== 'function') {
    issues.push(issue('invalid_tokenizer', ['tokenizer', 'countTokens'], 'must be a function'));
  }
  return issues;
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `a non-Error value (${typeof error})`;
}

/* -------------------------------------------------------------------------- */
/* Record serialization                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The exact fields of one v1 rendered record.
 *
 * The set is closed on purpose. `score`, retrieval data, allocation reason,
 * required status, category, priority, timestamps, block metadata, source
 * metadata, source title, `tokenCount`, `normalizedContentHash`, and policy
 * internals are compiler control and provenance data, not model context: they
 * spend budget, invite the model to reason about the compiler's own decisions,
 * and would put untrusted source metadata into the prompt for no stated purpose
 * (INV-SEC-001).
 *
 * `sourceDocumentId` is the v1 source label (INV-RENDER-003). It exists on every
 * trusted canonical block, it is stable project-owned identity (DEC-028), it
 * needs no registry lookup, and it cannot drift from an optional title. A
 * human-readable title is a future rendering-policy version, not a v1 default.
 */
interface RenderedBlockRecord {
  readonly blockId: string;
  readonly content: string;
  readonly headingPath?: readonly string[];
  readonly sourceDocumentId: string;
  readonly sourceType: string;
}

/** Exactly one LF between records: one physical line is one block. */
const RECORD_SEPARATOR = '\n';

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

export class ContextRenderer {
  readonly #policy: ContextRenderingPolicy;
  readonly #tokenizer: Tokenizer;

  /**
   * Validates the rendering policy and the injected tokenizer.
   *
   * Both are checked before either is stored, so one call reports every
   * dependency problem rather than one per construction attempt.
   *
   * @throws {ContextRenderingError} when the policy or the tokenizer is not valid.
   */
  constructor(policy: unknown, tokenizer: Tokenizer) {
    const parsed = safeParse(ContextRenderingPolicySchema, policy);
    const issues: ValidationIssue[] = parsed.ok
      ? []
      : parsed.issues.map((parsedIssue) => ({
          ...parsedIssue,
          code: 'invalid_policy' satisfies ContextRenderingIssueCode,
        }));
    issues.push(...validateTokenizer(tokenizer));
    if (!parsed.ok || issues.length > 0) throw new ContextRenderingError(issues);

    this.#policy = parsed.value;
    this.#tokenizer = tokenizer;
  }

  /**
   * Renders one ordered selection and measures the exact string it produced.
   *
   * The ordered set is a stage contract the earlier stages have already proved,
   * so nothing in it is revalidated, re-counted, re-hashed, re-sorted, or
   * repaired. The supplied set and everything reachable from it are treated as
   * immutable: no decision, block, attribute, metadata object, source document,
   * score, or array is mutated, and `ordered` is returned by reference
   * (INV-ALLOC-004).
   *
   * @throws {ContextRenderingError} when the tokenizer fails or returns a value
   * that is not a usable count. No partial attempt is returned.
   */
  render(input: OrderedCandidateSet): RenderedContextAttempt {
    // Array position is authoritative. `ContextOrderer` owns render order, so
    // this stage neither sorts nor groups nor consults source location, score,
    // required status, or `optionalEvictionOrder` (DEC-034, INV-RENDER-001).
    const renderedContext = input.orderedIncluded
      .map((decision) => canonicalJson(recordOf(decision.candidate.candidate.canonicalBlock)))
      .join(RECORD_SEPARATOR);

    const renderedTokens = this.#count(renderedContext);
    const delta = renderedTokens - input.allocation.selectedBlockContentTokens;

    return {
      ordered: input,
      renderingPolicyId: this.#policy.policyId,
      renderingPolicyVersion: this.#policy.policyVersion,
      rendererId: CONTEXT_RENDERER_ID,
      rendererVersion: CONTEXT_RENDERER_VERSION,
      tokenizerId: this.#tokenizer.id,
      tokenizerVersion: this.#tokenizer.version,
      renderedContext,
      renderedTokens,
      // `-0` is canonicalized to `0`: the two are distinguishable through
      // `Object.is` and through a canonical serialization, so publishing either
      // one would make an equality check depend on how the value was reached.
      renderedTokenDelta: delta === 0 ? 0 : delta,
      fitsAvailableInputBudget: renderedTokens <= input.allocation.availableInputTokens,
    };
  }

  /**
   * Counts the one complete rendered string, exactly once per render.
   *
   * The full string is the source of truth (INV-BUDGET-002). Summing per-block
   * or per-record counts is not equivalent and is never done: tokenization is
   * not additive, so boundaries shift when content is embedded in a larger
   * string, and separators and JSON escaping are part of what the model
   * receives (INV-RENDER-004).
   *
   * A returned value that is not a usable count is a failure, never a value to
   * repair, and no character or word estimate substitutes for it (DEC-027).
   */
  #count(renderedContext: string): number {
    let tokens: number;
    try {
      tokens = this.#tokenizer.countTokens(renderedContext);
    } catch (error: unknown) {
      throw new ContextRenderingError([
        issue(
          'tokenizer_failed',
          ['renderedContext'],
          `tokenizer ${quote(this.#tokenizer.id)} version ${quote(this.#tokenizer.version)} failed to count the rendered context: ${describeThrown(error)}`,
        ),
      ]);
    }
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
      throw new ContextRenderingError([
        issue(
          'invalid_rendered_token_count',
          ['renderedContext'],
          `tokenizer ${quote(this.#tokenizer.id)} version ${quote(this.#tokenizer.version)} returned ${String(tokens)} for the rendered context: expected a non-negative safe integer`,
        ),
      ]);
    }
    return tokens;
  }
}

/**
 * Projects one canonical block onto the v1 record.
 *
 * `headingPath` is emitted exactly when the block carries it: an absent path
 * omits the key entirely, and an explicitly empty array is preserved as `[]`,
 * because "this source states no heading context" and "this block was extracted
 * from outside any heading" are different facts. Nothing is synthesized from
 * content or source location, and the path is never turned into Markdown heading
 * text in v1 (INV-PROV-002).
 *
 * The block itself is only read. Content is copied by reference into a fresh
 * record; no field is trimmed, normalized, re-encoded, or written back.
 */
function recordOf(block: ContextBlock): RenderedBlockRecord {
  return {
    blockId: block.id,
    content: block.content,
    ...(block.headingPath === undefined ? {} : { headingPath: block.headingPath }),
    sourceDocumentId: block.sourceDocumentId,
    sourceType: block.sourceType,
  };
}

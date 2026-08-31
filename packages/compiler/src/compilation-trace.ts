import {
  availableInputTokens,
  findLoneSurrogate,
  safeParse,
  type ContentHash,
  type ContextBlock,
  type ContextBlockId,
  type Scope,
  type SourceDocument,
  type SourceDocumentId,
  type SourceLocation,
  type SourceType,
  type Timestamp,
  type TokenBudget,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { z } from 'zod';
import type {
  AllocatedCandidateSet,
  ExcludedCandidateDecision,
  IncludedCandidateDecision,
} from './budget-allocator.js';
import type { CandidateFilteringDecision, FilteredCandidateSet } from './candidate-filter.js';
import type {
  CanonicalSelectionReason,
  DeduplicatedCandidate,
  DeduplicatedCandidateSet,
  DuplicateMatchReason,
} from './candidate-deduplicator.js';
import type { CandidateScore, ScoredCandidate } from './candidate-scorer.js';
import type { ValidatedCandidateSet } from './candidate-validator.js';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';
import type { CompilationId } from './compilation-id.js';
import type { CompilationRequest } from './compilation-request.js';
import type { RenderedContextAttempt } from './context-renderer.js';
import { domainSeparatedDigest } from './digest.js';
import {
  fingerprintCompilationRequest,
  type CompilationRequestFingerprint,
} from './request-fingerprint.js';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * Deterministic privacy-minimized compilation traces (DEC-037).
 *
 * `TraceBuilder` observes evidence the compiler components have **already
 * produced** and projects it into one serializable `CompilationTrace`. It is
 * observational, and that is the whole of its contract: it does not validate
 * candidates, deduplicate, score, filter, allocate, order, render, tokenize,
 * evict, reallocate, correct a budget overrun, or select a final outcome. Trace
 * collection cannot change a compiler decision (INV-TRACE-006).
 *
 * What it may do is copy stage evidence into a persistence-oriented record,
 * calculate deterministic digests, count and sum already-validated numbers, and
 * refuse to serialize evidence that contradicts itself. It never repairs such
 * evidence: a caller who mixed outputs from two different runs gets a structured
 * failure, because a trace that quietly reconciled two runs would be a false
 * audit record.
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, consults
 * no `package.json` and no git revision, and calls no model, no retrieval
 * provider, and no tokenizer (INV-DET-001, INV-DET-003, INV-DET-004,
 * INV-DEP-002). Its only injected dependency is an explicit compiler identity.
 *
 * ## The builder never settles a compilation
 *
 * The traced `RenderedContextAttempt` may report `fitsAvailableInputBudget:
 * false`. That is still a valid snapshot of a measured attempt, so
 * `TraceBuilder` always emits an `UnsettledCompilationTrace`: the stage evidence
 * is traced, the render attempt is measured, and no orchestration has settled
 * the compilation. An unsettled trace must never be attached to a successful
 * `CompilationResult`, and schema version 2 makes that unrepresentable rather
 * than merely forbidden (INV-TRACE-006).
 *
 * Nothing here therefore carries a final outcome, a final included list,
 * `compiledTokens`, `unusedTokens`, `renderingTokenDelta`, or a compilation
 * identifier. Those live in `CompilationTraceSettlement`, which only
 * `ContextCompiler` can prove and only after its render-aware correction has
 * finished (ARCHITECTURE 7.2, METRICS 8.4, 8.6, 8.10, DEC-038).
 *
 * ## Wrappers are accounted for; groups are decided
 *
 * INV-TRACE-001 is satisfied at two levels, because the pipeline has two units.
 * Every successfully validated `CandidateBlock` wrapper appears exactly once as a
 * member of exactly one trace group, and every deduplicated group receives
 * exactly one current filtering/allocation disposition. No arbitrary
 * "representative wrapper" is invented: byte-identical wrappers can be
 * observationally indistinguishable, and choosing one of them by input position
 * would be a determinism bug (INV-DET-002, DEC-031).
 *
 * A candidate rejected as invalid is not part of this trace at all.
 * `CandidateValidator` is all-or-nothing, so a failed batch produces no
 * `ValidatedCandidateSet` and the post-validation chain never runs. Validation
 * failures stay structured validation errors; wrapping them in a terminal
 * failure trace belongs to the future `ContextCompiler` (DEC-030, DEC-037).
 *
 * ## Nothing sensitive is representable in schema version 2
 *
 * Full source content is not configurable in this schema version — it is simply
 * absent, which is the safest reading of INV-SEC-003. Block content, the raw
 * query, the rendered context, the final compiled context, source metadata,
 * block metadata, and retrieval metadata have no field to travel in, in either
 * trace variant. Identities, digests, scope, source types, source locations,
 * decision reasons, score components, and token counts do (INV-SEC-001,
 * INV-SEC-003).
 */

/* -------------------------------------------------------------------------- */
/* Public contract: schema version                                             */
/* -------------------------------------------------------------------------- */

/**
 * Current schema version of `CompilationTrace` (INV-STORE-004).
 *
 * Unlike the ephemeral stage-result wrappers, a trace is persistence-oriented:
 * it is meant to be stored and read back by a consumer that did not produce it,
 * so an unsupported future shape must fail clearly rather than be reinterpreted.
 *
 * **Version 2 adds the settlement overlay (DEC-038).** Version 1 recorded the
 * filtering decision, the allocation decision, the allocator summary, the
 * allocation's render order, and the measured render attempt — and named its
 * per-group verdict `currentDisposition`, not `finalDisposition`, precisely
 * because a render-aware correction may settle a different selection. Flipping a
 * version 1 record's `settled` boolean to `true` would therefore publish a false
 * audit record: it would still say the initial allocator selection was the
 * selection that settled.
 *
 * `settled` being a boolean avoided a schema change merely to flip finality; it
 * never meant the correction evidence could be omitted. Representing both the
 * original stage evidence and the final settlement needs new persisted fields,
 * so the version is bumped rather than the meaning of version 1 changed. No
 * persistence adapter and no stored trace exist yet, which makes this the
 * correct moment to bump (INV-STORE-004).
 */
export const COMPILATION_TRACE_SCHEMA_VERSION = 2;

/** Preimage version of `CompilationTraceRequest.queryHash`. */
const QUERY_HASH_VERSION = 1;

/** Preimage version of `CompilationTraceRendering.renderedContextHash`. */
const RENDERED_CONTEXT_HASH_VERSION = 1;

const QUERY_HASH_LABEL = 'ctxalloc-compilation-request-query';
const RENDERED_CONTEXT_HASH_LABEL = 'ctxalloc-rendered-context';

/**
 * The one domain-separated digest of a rendered context string.
 *
 * Two components publish such a digest — this builder for the measured attempt,
 * and `ContextCompiler` for the settled final string — and two implementations
 * of one preimage would be free to drift, so the rule is owned once, here
 * (INV-DEP-003, DEC-038). A consumer comparing an attempt digest with a
 * settlement digest is therefore comparing like with like.
 *
 * It is internal to the compiler kernel: the package entry point never
 * re-exports it, and no public declaration names it (INV-ADAPTER-001).
 */
export function hashRenderedContext(renderedContext: string): string {
  return domainSeparatedDigest(
    RENDERED_CONTEXT_HASH_LABEL,
    RENDERED_CONTEXT_HASH_VERSION,
    renderedContext,
  );
}

/* -------------------------------------------------------------------------- */
/* Public contract: trace shape                                                */
/* -------------------------------------------------------------------------- */

/** One component's stable identity and version, as it was actually configured. */
export interface TraceIdentity {
  readonly id: string;
  readonly version: string;
}

/**
 * The request the compilation was asked to satisfy, by identity rather than by
 * content.
 *
 * The raw `query` is deliberately absent: a query can carry anything the caller
 * typed, and a persisted trace is exactly the wrong place for it (INV-SEC-003).
 * `queryHash` keeps the audit question answerable — *was this the same query?* —
 * without storing the text.
 *
 * `budget` is the validated `TokenBudget` verbatim, so an audit consumer sees
 * exactly which reserves the caller configured and which they omitted.
 */
export interface CompilationTraceRequest {
  readonly id: string;
  readonly fingerprint: CompilationRequestFingerprint;
  readonly scope: Scope;
  readonly referenceTime: Timestamp;
  readonly queryHash: string;
  readonly budget: TokenBudget;
  readonly candidateCount: number;
  readonly sourceDocumentCount: number;
}

/**
 * The five stage policy identities and the composition that binds them.
 *
 * `compilation` is the broad `CompilationPolicy` identity; the other five are the
 * identities the stages actually published. The coherence checks prove each stage
 * identity equals the request policy's corresponding slice, so one recorded value
 * states both without giving a consumer two fields that could disagree.
 */
export interface CompilationTracePolicyIdentities {
  readonly compilation: TraceIdentity;
  readonly scoring: TraceIdentity;
  readonly filtering: TraceIdentity;
  readonly allocation: TraceIdentity;
  readonly ordering: TraceIdentity;
  readonly rendering: TraceIdentity;
}

/**
 * Which token quantities the recorded tokenizer identity actually explains
 * (DEC-037).
 *
 * `rendering-attempt-only` — the identity is proven for
 * `rendering.renderedTokens` and for nothing else. The block-content totals under
 * `totals` reconcile exactly among themselves, but the tokenizer that produced
 * the `ContextBlock.tokenCount` values they sum is **unknown at this trace
 * boundary**.
 *
 * `validation-and-rendering` — the same tokenizer identity and version produced
 * the validated block counts and the rendered measurement, so it explains every
 * token quantity in the trace. Only a composition root that injects the tokenizer
 * into `CandidateValidator` and `ContextRenderer` itself can establish this.
 * `ContextCompiler` is that root and owns both injections, so a settled trace
 * carries this value and an unsettled one never can (DEC-038).
 */
export type CompilationTraceTokenizerCoverage =
  'rendering-attempt-only' | 'validation-and-rendering';

/**
 * The composition inputs the request itself does not carry (INV-TRACE-005).
 *
 * `compiler` comes from explicit `TraceBuilderConfig`, never from a manifest, a
 * git revision, or an environment variable. `tokenizer` and `renderer` come from
 * the `RenderedContextAttempt`, which is the one stage that publishes them
 * (DEC-035).
 *
 * ## The tokenizer identity is scoped, not global
 *
 * `tokenizer` is the tokenizer the **renderer** was given. It proves exactly one
 * thing: which tokenizer turned `renderedContext` into `renderedTokens`. It does
 * **not** prove which tokenizer produced the `ContextBlock.tokenCount` values
 * `CandidateValidator` accepted, because no stage contract from
 * `ValidatedCandidateSet` through `OrderedCandidateSet` carries a tokenizer
 * identity for `TraceBuilder` to read (DEC-035, DEC-036).
 *
 * A manual composition may legitimately validate under one tokenizer and render
 * under another. The trace would then name the renderer's tokenizer beside a
 * `candidateTokens` total the other tokenizer produced, and a reader could
 * reasonably take the one named identity to explain both. That inference would be
 * false, and `TraceBuilder` cannot detect the mismatch: its inputs do not carry
 * the earlier identity.
 *
 * `tokenizerCoverage` closes that hole by stating the scope of the claim rather
 * than widening it. Phase 14 always publishes `rendering-attempt-only`.
 *
 * The coverage is never inferred from evidence. Matching identifiers or matching
 * numbers prove nothing — two tokenizers may agree on one batch and diverge on
 * the next — and a caller-supplied assertion would be worth less still, since the
 * manual caller is exactly the party who might miscompose the stages. Only a
 * component that owns the construction can claim `validation-and-rendering`.
 *
 * Complete policy JSON is not recorded in schema version 1. Identities are what
 * an audit needs to state which rules ran, and copying whole policies would put
 * configuration in a record whose privacy boundary was drawn for decisions.
 */
export interface CompilationTraceComposition {
  readonly compiler: TraceIdentity;
  readonly policy: CompilationTracePolicyIdentities;
  readonly tokenizer: TraceIdentity;
  readonly tokenizerCoverage: CompilationTraceTokenizerCoverage;
  readonly renderer: TraceIdentity;
}

/**
 * The composition of an unsettled snapshot: rendering coverage only.
 *
 * `TraceBuilder` observes one render attempt, which is the only place a
 * tokenizer identity is visible from its input, so the recorded identity
 * explains `rendering.renderedTokens` and nothing else. The literal is part of
 * the type rather than a runtime convention, so an unsettled trace cannot claim
 * the stronger coverage even by mistake (DEC-037, DEC-038).
 */
export interface UnsettledCompilationTraceComposition extends CompilationTraceComposition {
  readonly tokenizerCoverage: 'rendering-attempt-only';
}

/**
 * The composition of a settled trace: one tokenizer explains every quantity.
 *
 * `ContextCompiler` constructs `CandidateValidator` and `ContextRenderer` from
 * the one configured tokenizer it owns, and measures every render-aware
 * correction attempt with that same object, so the identity recorded here
 * explains the validated block counts, the rendered attempt, and the settled
 * `compiledTokens` alike. That is what makes the signed `renderingTokenDelta` of
 * METRICS 8.6 a defined quantity rather than the gap between two vocabularies
 * (DEC-038).
 */
export interface SettledCompilationTraceComposition extends CompilationTraceComposition {
  readonly tokenizerCoverage: 'validation-and-rendering';
}

/**
 * One minimal source reference (INV-PROV-001).
 *
 * Title, metadata, timestamps, and content are all absent. A source is
 * identified, not described: the identity plus the content hash is what lets an
 * auditor find the original and prove it has not changed since.
 */
export interface CompilationTraceSource {
  readonly id: SourceDocumentId;
  readonly sourceType: SourceType;
  readonly contentHash: ContentHash;
}

/**
 * The canonical block of one duplicate group, reduced to audit fields.
 *
 * `content` and `metadata` are absent (INV-SEC-003). `required` is normalized to
 * an explicit boolean because required status is a separate allocation class an
 * auditor must be able to read directly, while `priority`, `category`, and
 * `sourceLocation` stay absent exactly when the block declared none.
 */
export interface CompilationTraceCanonicalBlock {
  readonly id: ContextBlockId;
  readonly sourceDocumentId: SourceDocumentId;
  readonly sourceType: SourceType;
  readonly tokenCount: number;
  readonly normalizedContentHash: ContentHash;
  readonly required: boolean;
  readonly priority?: number;
  readonly category?: string;
  readonly sourceLocation?: SourceLocation;
}

/** One provider score, carried with the contract that makes it readable. */
export interface CompilationTraceRetrievalScore {
  readonly value: number;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
}

/**
 * What one retrieval provider reported about one wrapper.
 *
 * `metadata` is absent: it is arbitrary provider-supplied data, and this schema
 * version represents no arbitrary metadata at all (INV-SEC-001, INV-SEC-003).
 */
export interface CompilationTraceRetrieval {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly rank?: number;
  readonly score?: CompilationTraceRetrievalScore;
}

/**
 * One validated candidate wrapper, preserved as group membership evidence
 * (INV-DEDUP-003, INV-TRACE-001).
 *
 * The wrapper has no identity of its own, and none is invented here. Two
 * byte-identical wrappers therefore produce two identical member records:
 * multiplicity is the evidence, and distinguishing them would require choosing
 * an order that carries no meaning.
 */
export interface CompilationTraceMember {
  readonly blockId: ContextBlockId;
  readonly sourceDocumentId: SourceDocumentId;
  readonly matchReason: DuplicateMatchReason;
  readonly retrieval?: CompilationTraceRetrieval;
}

/** A required group, admitted without consulting its score (INV-SCORE-003). */
export interface CompilationTraceRequiredEligibleDecision {
  readonly decision: 'eligible';
  readonly reason: 'ELIGIBLE_REQUIRED';
}

/** An optional group the filtering policy admitted, with its exact evidence. */
export interface CompilationTracePolicyEligibleDecision {
  readonly decision: 'eligible';
  readonly reason: 'ELIGIBLE_POLICY';
  readonly scoreTotal: number;
  readonly minimumTotalScore?: number;
}

/** An optional group the threshold excluded, with both exact operands. */
export interface CompilationTraceFilteredDecision {
  readonly decision: 'filtered';
  readonly reason: 'FILTERED_SCORE_BELOW_MINIMUM';
  readonly scoreTotal: number;
  readonly minimumTotalScore: number;
}

/**
 * The one filtering decision every group carries, with the candidate object
 * stripped and the machine-readable evidence preserved exactly.
 *
 * The union is discriminated on `decision` and `reason` together, so an
 * impossible pairing cannot be constructed here any more than it can at the
 * stage that produced it (DEC-036).
 */
export type CompilationTraceFilteringDecision =
  | CompilationTraceRequiredEligibleDecision
  | CompilationTracePolicyEligibleDecision
  | CompilationTraceFilteredDecision;

/** A group the allocator selected, with only an inclusion reason. */
export interface CompilationTraceIncludedDecision {
  readonly decision: 'included';
  readonly reason: 'INCLUDED_REQUIRED' | 'INCLUDED_CATEGORY_MINIMUM' | 'INCLUDED_SCORE_ORDER';
}

/** A group the allocator did not select, with only an exclusion reason. */
export interface CompilationTraceExcludedDecision {
  readonly decision: 'excluded';
  readonly reason: 'EXCLUDED_CATEGORY_MAXIMUM' | 'EXCLUDED_BUDGET_EXHAUSTED';
}

/** The one allocation decision every eligible group carries (INV-TRACE-002). */
export type CompilationTraceAllocationDecision =
  CompilationTraceIncludedDecision | CompilationTraceExcludedDecision;

/**
 * Where one group currently stands, for **this** traced selection.
 *
 * It is deliberately not called `finalDisposition`. Phase 14 traces one measured
 * attempt, and a future correction loop may settle a different selection
 * (ARCHITECTURE 7.2).
 */
export type CompilationTraceDisposition = 'filtered' | 'included' | 'excluded';

/**
 * One deduplicated candidate group: its canonical block, every wrapper that
 * belongs to it, and every decision made about it.
 *
 * `allocation` is absent exactly when `filtering` filtered the group: a filtered
 * group never reached the allocator, so publishing an allocation decision for it
 * would describe a comparison that never happened (DEC-036).
 *
 * `renderPosition` is present exactly when `currentDisposition` is `included`.
 */
export interface CompilationTraceGroup {
  readonly canonical: CompilationTraceCanonicalBlock;
  readonly canonicalSelectionReason: CanonicalSelectionReason;
  readonly members: readonly CompilationTraceMember[];
  readonly score: CandidateScore;
  readonly filtering: CompilationTraceFilteringDecision;
  readonly allocation?: CompilationTraceAllocationDecision;
  readonly currentDisposition: CompilationTraceDisposition;
  readonly renderPosition?: number;
}

/**
 * The allocator's own summary, copied exactly.
 *
 * `includedBlockIds` follows allocation chronology and `excludedBlockIds`
 * optional traversal order; neither is render order. `optionalEvictionOrder` is
 * the allocator's safe removal order and is neither sorted nor reinterpreted
 * here — it answers what may be given back if rendering overruns, which is a
 * different question from what renders first (DEC-033, DEC-034).
 */
export interface CompilationTraceAllocation {
  readonly availableInputTokens: number;
  readonly selectedBlockContentTokens: number;
  readonly unallocatedBlockContentTokens: number;
  readonly includedBlockIds: readonly ContextBlockId[];
  readonly excludedBlockIds: readonly ContextBlockId[];
  readonly optionalEvictionOrder: readonly ContextBlockId[];
}

/** The render order of the traced selection: exactly `orderedIncluded`. */
export interface CompilationTraceOrdering {
  readonly orderedBlockIds: readonly ContextBlockId[];
}

/**
 * The measured render attempt, by digest and count.
 *
 * The rendered string itself is absent: it contains every included block's
 * content verbatim, which is exactly what a persisted trace must not carry by
 * default (INV-SEC-003). No `compiledTokens`, `unusedTokens`, or
 * `renderingTokenDelta` appears, because none of them is defined until a
 * selection has settled (METRICS 8.4, 8.6, 8.10).
 */
export interface CompilationTraceRendering {
  readonly renderedContextHash: string;
  readonly renderedTokens: number;
  readonly fitsAvailableInputBudget: boolean;
}

/**
 * Exact reconciliation totals for the **current** selection (INV-TRACE-003).
 *
 * ```text
 * candidateCount                  = sum(group.members.length)
 * duplicateWrapperCount           = candidateCount - deduplicatedGroupCount
 * eligibleGroupCount              = includedGroupCount + allocationExcludedGroupCount
 * deduplicatedGroupCount          = filteredGroupCount + eligibleGroupCount
 *
 * candidateTokens                 = canonicalContentTokens + duplicateCandidateTokens
 * excludedCanonicalContentTokens  = filteredContentTokens + allocationExcludedContentTokens
 * canonicalContentTokens          = includedContentTokens + excludedCanonicalContentTokens
 * ```
 *
 * `candidateTokens` sums every validated wrapper, and `canonicalContentTokens`
 * sums each group's canonical block exactly once, so `duplicateCandidateTokens`
 * is the group-level difference between them and is never negative. No
 * "duplicate member" wrapper is chosen or subtracted, because choosing one among
 * indistinguishable wrappers would be arbitrary (DEC-031, DEC-037).
 *
 * These are trace-snapshot totals, **not** the final metrics whose names they
 * resemble. `includedContentTokens` here is the current allocation's content,
 * not METRICS 8.5 of a settled selection, and rendering counts never participate
 * in these equations: `renderedTokens` is reported separately, under
 * `rendering`.
 *
 * Their **tokenizer identity is unknown at this trace boundary**. They sum
 * `ContextBlock.tokenCount` values `CandidateValidator` accepted, and no stage
 * contract carries the identity of the tokenizer that produced them, so
 * `composition.tokenizer` does not explain them — see
 * `composition.tokenizerCoverage`. The totals still reconcile exactly among
 * themselves, because every one of them sums the same already-validated
 * numbers.
 */
export interface CompilationTraceTotals {
  readonly candidateCount: number;
  readonly deduplicatedGroupCount: number;
  readonly duplicateWrapperCount: number;

  readonly filteredGroupCount: number;
  readonly eligibleGroupCount: number;
  readonly includedGroupCount: number;
  readonly allocationExcludedGroupCount: number;

  readonly candidateTokens: number;
  readonly canonicalContentTokens: number;
  readonly duplicateCandidateTokens: number;

  readonly filteredContentTokens: number;
  readonly includedContentTokens: number;
  readonly allocationExcludedContentTokens: number;
  readonly excludedCanonicalContentTokens: number;
}

/* -------------------------------------------------------------------------- */
/* Public contract: final settlement                                           */
/* -------------------------------------------------------------------------- */

/**
 * How one group finally stands, for the selection that was actually returned.
 *
 * This is deliberately a different vocabulary from `CompilationTraceDisposition`
 * even though the three words coincide: that one describes the traced attempt,
 * this one describes the settlement. Keeping them apart is the whole point of
 * schema version 2 (DEC-038).
 */
export type CompilationTraceFinalDisposition = 'filtered' | 'included' | 'excluded';

/**
 * A group the filtering policy removed before allocation ever saw it.
 *
 * Correction cannot bring such a group back: eligibility is a precondition of
 * selection, and every candidate the correction may choose comes from
 * `FilteredCandidateSet.eligible` (INV-ALLOC-002).
 */
export interface CompilationTraceFinalFilteredDecision {
  readonly blockId: ContextBlockId;
  readonly disposition: 'filtered';
  readonly reason: 'FILTERED_POLICY';
}

/**
 * A group in the settled selection, with its exact position in the final render.
 *
 * `renderPosition` addresses the **final** rendered string, not the traced
 * attempt: the two differ whenever a correction was applied. Positions cover
 * `0 ... n - 1` exactly once across every final inclusion (INV-TRACE-004).
 */
export interface CompilationTraceFinalIncludedDecision {
  readonly blockId: ContextBlockId;
  readonly disposition: 'included';
  /**
   * Why this group is in the settled selection.
   *
   * The first three mirror the allocator's own vocabulary and are used when the
   * settled selection is the allocator's, or the allocator's minus a safe
   * eviction prefix, or a hard base whose non-required members were chosen
   * specifically to satisfy a category minimum.
   *
   * `INCLUDED_RENDER_AWARE_CORRECTION` is used for a non-required group the
   * **rescue** search selected. A rescue selection may carry optional surplus
   * beyond every category minimum, and asking which of its members "is" the
   * minimum has no non-arbitrary answer, so the correction claims all of them
   * as its own rather than attributing one to a rule it did not apply
   * (DEC-038).
   */
  readonly reason:
    | 'INCLUDED_REQUIRED'
    | 'INCLUDED_CATEGORY_MINIMUM'
    | 'INCLUDED_SCORE_ORDER'
    | 'INCLUDED_RENDER_AWARE_CORRECTION';
  readonly renderPosition: number;
}

/**
 * A group absent from the settled selection, and which decision left it out.
 *
 * `EXCLUDED_INITIAL_ALLOCATION` — `BudgetAllocator` did not select it and the
 * correction never reconsidered it. `EXCLUDED_RENDER_AWARE_CORRECTION` — the
 * correction itself decided against it, either by evicting an allocator
 * inclusion or by settling a hard base that does not contain it.
 *
 * Neither is `EXCLUDED_BUDGET_EXHAUSTED`. That code belongs to the allocator's
 * canonical block-content decision and would be false here: a correction
 * exclusion is a statement about the exact rendered string, and the content
 * budget may have had room to spare (DEC-033, DEC-038).
 *
 * `initialAllocationReason` is present exactly when the allocator itself
 * excluded the group, so its original verdict stays readable beside the final
 * one instead of being overwritten by it.
 */
export interface CompilationTraceFinalExcludedDecision {
  readonly blockId: ContextBlockId;
  readonly disposition: 'excluded';
  readonly reason: 'EXCLUDED_INITIAL_ALLOCATION' | 'EXCLUDED_RENDER_AWARE_CORRECTION';
  readonly initialAllocationReason?: 'EXCLUDED_CATEGORY_MAXIMUM' | 'EXCLUDED_BUDGET_EXHAUSTED';
}

/**
 * The one final decision every deduplicated group carries (INV-TRACE-001).
 *
 * The union is discriminated on `disposition` and `reason` together, so an
 * impossible pairing — a filtered group carrying a render position, an inclusion
 * carrying an exclusion reason — is not expressible.
 */
export type CompilationTraceFinalDecision =
  | CompilationTraceFinalFilteredDecision
  | CompilationTraceFinalIncludedDecision
  | CompilationTraceFinalExcludedDecision;

/**
 * Which phase of the bounded fallback search settled a selection, when one did.
 *
 * `hard-base` — a minimal policy-valid base: every required group plus exactly
 * enough non-required candidates to satisfy each category minimum, and no
 * surplus. This phase runs first and preserves the allocator's own preference
 * order.
 *
 * `policy-selection-rescue` — a policy-valid selection that is not minimal. It
 * runs only after **every** hard base has failed, because tokenization is not
 * monotonic: a strict superset of an over-budget selection may render within the
 * budget (DEC-038).
 */
export type CompilationTraceFallbackPhase = 'hard-base' | 'policy-selection-rescue';

/**
 * What the bounded fallback search did, if it ran.
 *
 * `selectionsVisited` counts **unique** selections the fallback visited, keyed
 * by their exact canonical block-identifier set. A selection whose canonical
 * content sum exceeds the ceiling is counted and never rendered; a selection the
 * fallback reaches twice — a hard base the rescue enumeration also produces, for
 * instance — is counted once. `maxSelections` is the configured bound.
 *
 * `phase` and `chosenBlockIds` are absent when the fallback did not run or did
 * not settle a result, and present together when it did. The identifiers are
 * ordered ascending, never by `Map` or `Set` insertion, so the record is
 * reproducible (INV-DET-002).
 */
export interface CompilationTraceFallbackSearch {
  readonly used: boolean;
  readonly selectionsVisited: number;
  readonly maxSelections: number;
  readonly phase?: CompilationTraceFallbackPhase;
  readonly chosenBlockIds?: readonly ContextBlockId[];
}

/** The render order of the settled selection, by stable block identifier. */
export interface CompilationTraceSettlementOrdering {
  readonly orderedBlockIds: readonly ContextBlockId[];
}

/**
 * The settled rendering, by digest and count.
 *
 * The final string itself is absent for the same reason the attempt's is: it
 * contains every included block's content verbatim, which a persisted trace must
 * not carry by default (INV-SEC-003). It lives only in
 * `CompilationResult.compiledContext`.
 *
 * `compiledTokens` is METRICS 8.4 exactly: the tokenizer count of the final
 * complete rendered string, never a sum of block counts.
 */
export interface CompilationTraceSettlementRendering {
  readonly renderedContextHash: string;
  readonly compiledTokens: number;
}

/**
 * The final token usage of the settled selection.
 *
 * ```text
 * unusedTokens        = availableInputTokens - compiledTokens
 * renderingTokenDelta = compiledTokens - includedContentTokens
 * ```
 *
 * `renderingTokenDelta` is signed and is never clamped (METRICS 8.6). It is a
 * defined quantity here only because `ContextCompiler` proved one tokenizer
 * identity produced both operands — `composition.tokenizerCoverage` is
 * `validation-and-rendering` on every settled trace.
 */
export interface CompilationTraceSettlementUsage {
  readonly availableInputTokens: number;
  readonly includedContentTokens: number;
  readonly unusedTokens: number;
  readonly renderingTokenDelta: number;
}

/**
 * The complete evidence of the render-aware settlement (DEC-038).
 *
 * It is an **overlay**, not a replacement. The original filtering decisions, the
 * original allocation decisions, the allocator summary, the allocation's render
 * order, and the measured initial attempt all stay exactly where schema
 * version 1 put them; this record states separately what the correction then
 * did. Deleting the allocator's evidence because the final selection differs
 * would destroy the very comparison an audit needs.
 *
 * `evictedBlockIds` is the exact prefix of `allocation.optionalEvictionOrder`
 * the correction removed, in that order — never sorted, never reordered.
 */
export interface CompilationTraceSettlement {
  readonly strategy: 'render-aware-v1';
  readonly correctionApplied: boolean;

  /** `rendering.renderedTokens` of the traced attempt, restated for readability. */
  readonly initialRenderedTokens: number;

  readonly evictedBlockIds: readonly ContextBlockId[];
  readonly fallbackSearch: CompilationTraceFallbackSearch;

  /** Exactly one decision per deduplicated group, in trace group order. */
  readonly decisions: readonly CompilationTraceFinalDecision[];

  readonly ordering: CompilationTraceSettlementOrdering;
  readonly rendering: CompilationTraceSettlementRendering;
  readonly usage: CompilationTraceSettlementUsage;
}

/* -------------------------------------------------------------------------- */
/* Public contract: the trace record                                           */
/* -------------------------------------------------------------------------- */

/**
 * Everything both trace variants carry: the stage evidence of one compilation.
 *
 * The record survives `JSON.parse(JSON.stringify(trace))` with deep equality. No
 * `Date`, `Map`, `Set`, class instance, `Error`, function, or external SDK type
 * appears anywhere in it, and an absent optional property is genuinely absent
 * rather than present with an `undefined` value.
 */
export interface CompilationTraceBase {
  readonly schemaVersion: typeof COMPILATION_TRACE_SCHEMA_VERSION;

  readonly request: CompilationTraceRequest;
  readonly sources: readonly CompilationTraceSource[];

  readonly groups: readonly CompilationTraceGroup[];

  readonly allocation: CompilationTraceAllocation;
  readonly ordering: CompilationTraceOrdering;
  readonly rendering: CompilationTraceRendering;
  readonly totals: CompilationTraceTotals;
}

/**
 * A snapshot of one measured attempt that nothing has settled.
 *
 * `TraceBuilder` emits exactly this, always. `settlement` and `compilationId`
 * are declared as optional `never` rather than merely omitted, so an unsettled
 * value cannot acquire settlement evidence by a structural assignment and cannot
 * be passed where a settled trace is required (INV-TRACE-006, DEC-038).
 */
export interface UnsettledCompilationTrace extends CompilationTraceBase {
  readonly settled: false;
  readonly composition: UnsettledCompilationTraceComposition;
  readonly compilationId?: never;
  readonly settlement?: never;
}

/**
 * The trace of a selection `ContextCompiler` proved, rendered, and returned.
 *
 * Both `compilationId` and `settlement` are required: a settled trace with no
 * settlement evidence, or with no identity for the invocation that produced it,
 * is exactly the false audit record schema version 2 exists to prevent.
 */
export interface SettledCompilationTrace extends CompilationTraceBase {
  readonly settled: true;
  readonly compilationId: CompilationId;
  readonly composition: SettledCompilationTraceComposition;
  readonly settlement: CompilationTraceSettlement;
}

/**
 * One complete compilation trace: a versioned, serializable snapshot.
 *
 * The union is discriminated on `settled`, so a consumer that narrows on it
 * reaches the settlement evidence with no cast, and a successful
 * `CompilationResult` can require the settled variant at the type level.
 */
export type CompilationTrace = UnsettledCompilationTrace | SettledCompilationTrace;

/* -------------------------------------------------------------------------- */
/* Public contract: configuration and input                                    */
/* -------------------------------------------------------------------------- */

/**
 * The compiler identity a trace records (INV-TRACE-005).
 *
 * Compiler version is an explicit composition input, not request data (DEC-036),
 * and it is **injected**. Nothing here reads a `package.json` version, a git
 * revision, an environment variable, or a build-time constant: a trace must
 * state the identity the composition root actually chose, and a value discovered
 * from the surroundings would differ between a source checkout, a published
 * package, and a container (INV-DET-003).
 *
 * A future `ContextCompiler` will own this configured identity.
 */
export interface TraceBuilderConfig {
  readonly compilerId: string;
  readonly compilerVersion: string;
}

/**
 * The smallest non-redundant bundle of successful-pipeline evidence.
 *
 * Nothing is repeated, because everything else is reachable: `scored` is
 * `filtered.scored`, the allocation is `rendered.ordered.allocation`, the
 * ordering is `rendered.ordered`, and the render attempt is `rendered` itself.
 * Supplying those again would create two places for one fact and let them
 * disagree (INV-DEP-003).
 *
 * `validated` is a successful `ValidatedCandidateSet`. A `CandidateValidationError`
 * is not accepted in its place: `CandidateValidator` is all-or-nothing, so a
 * failed batch has no post-validation evidence to trace, and fabricating a
 * post-validation trace for one would be a false record (DEC-030, DEC-037).
 *
 * There is no `ContextCompiler` in front of this. The caller composes the stages
 * and hands over what they produced.
 */
export interface CompilationTraceBuildInput {
  readonly request: CompilationRequest;
  readonly validated: ValidatedCandidateSet;
  readonly deduplicated: DeduplicatedCandidateSet;
  readonly filtered: FilteredCandidateSet;
  readonly rendered: RenderedContextAttempt;
}

/* -------------------------------------------------------------------------- */
/* Public contract: failure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Machine-readable categories of a trace construction problem (INV-TRACE-002).
 *
 * `invalid_config` — the injected compiler identity is not valid.
 * `inconsistent_request_evidence` — the stage evidence does not describe the
 * supplied request.
 * `inconsistent_stage_evidence` — two stages' evidence contradict each other.
 * `invalid_trace_result` — the projected totals do not reconcile, or a count is
 * not a finite non-negative safe integer.
 */
export type CompilationTraceIssueCode =
  | 'invalid_config'
  | 'inconsistent_request_evidence'
  | 'inconsistent_stage_evidence'
  | 'invalid_trace_result';

/**
 * The single error this component raises, for construction and for building
 * alike.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, or nested stage error object
 * escapes this boundary, and no partial trace is ever returned
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */
export class CompilationTraceError extends Error {
  readonly code = 'COMPILATION_TRACE_BUILD_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Compilation trace build failed: ${summary}`);
    this.name = 'CompilationTraceError';
    this.issues = issues;
  }
}

function issue(code: CompilationTraceIssueCode, path: IssuePath, message: string): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
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
 * default is injected: a compiler identity nobody configured would be a value
 * the trace invented (INV-BLOCK-005, INV-DET-003).
 */
const TraceBuilderConfigSchema = z.strictObject({
  compilerId: identityString,
  compilerVersion: identityString,
});

/* -------------------------------------------------------------------------- */
/* Internal evidence view                                                      */
/* -------------------------------------------------------------------------- */

/** The stage results reachable from one build input, named once. */
interface Evidence {
  readonly request: CompilationRequest;
  readonly validated: ValidatedCandidateSet;
  readonly deduplicated: DeduplicatedCandidateSet;
  readonly filtered: FilteredCandidateSet;
  readonly rendered: RenderedContextAttempt;
  readonly allocation: AllocatedCandidateSet;
}

function evidenceOf(input: CompilationTraceBuildInput): Evidence {
  return {
    request: input.request,
    validated: input.validated,
    deduplicated: input.deduplicated,
    filtered: input.filtered,
    rendered: input.rendered,
    // The traced allocation is the one the render attempt was measured over,
    // reached through the nested contracts rather than supplied again.
    allocation: input.rendered.ordered.allocation,
  };
}

/** Canonical multiset of structurally compared records. */
function multisetOf(values: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = canonicalJson(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Structural multiset equality.
 *
 * Multiplicity is compared, not just membership: a batch that lost one of two
 * byte-identical wrappers is a different batch, and losing it silently is
 * exactly the failure INV-TRACE-001 forbids.
 */
function multisetsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const left = multisetOf(a);
  const right = multisetOf(b);
  if (left.size !== right.size) return false;
  for (const [key, count] of left) {
    if (right.get(key) !== count) return false;
  }
  return true;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalIdOf(candidate: ScoredCandidate): ContextBlockId {
  return candidate.candidate.canonicalBlock.id;
}

/**
 * Counts occurrences of each block identifier.
 *
 * Coverage checks compare these counts rather than sets, so a stage that
 * decided one group twice is a failure rather than a silently deduplicated
 * success.
 */
function countById(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function coversExactlyOnce(actual: readonly string[], expected: readonly string[]): boolean {
  const counts = countById(actual);
  if (counts.size !== expected.length || actual.length !== expected.length) return false;
  return expected.every((id) => counts.get(id) === 1);
}

/* -------------------------------------------------------------------------- */
/* Coherence checks                                                            */
/* -------------------------------------------------------------------------- */

const REQUEST = 'inconsistent_request_evidence';
const STAGE = 'inconsistent_stage_evidence';

/**
 * Proves the stage evidence describes the supplied request.
 *
 * These are the checks a caller who mixed two runs fails first: a request whose
 * scope, registry, candidates, budget, or configured policy identities do not
 * match the evidence did not produce that evidence, and serializing the pair
 * would publish a trace that names one request and describes another.
 *
 * Nothing here re-runs a stage. Token counting, hashing, scoring, filtering,
 * allocation, ordering, and rendering are all copied, never recomputed
 * (INV-TRACE-006).
 */
function checkRequestEvidence(evidence: Evidence): ValidationIssue[] {
  const { request, validated, filtered, allocation, rendered } = evidence;
  const issues: ValidationIssue[] = [];

  if (!structurallyEqual(request.scope, validated.scope)) {
    issues.push(
      issue(
        REQUEST,
        ['validated', 'scope'],
        'must equal the scope of the traced compilation request',
      ),
    );
  }
  if (!multisetsEqual(request.sourceDocuments, validated.sourceDocuments)) {
    issues.push(
      issue(
        REQUEST,
        ['validated', 'sourceDocuments'],
        `must hold exactly the ${String(request.sourceDocuments.length)} source documents of the traced compilation request`,
      ),
    );
  }
  if (!multisetsEqual(request.candidates, validated.candidates)) {
    issues.push(
      issue(
        REQUEST,
        ['validated', 'candidates'],
        `must hold exactly the ${String(request.candidates.length)} candidates of the traced compilation request`,
      ),
    );
  }

  issues.push(
    ...checkIdentity(
      ['filtered', 'scored'],
      'scoring policy',
      { id: filtered.scored.policyId, version: filtered.scored.policyVersion },
      { id: request.policy.scoring.policyId, version: request.policy.scoring.policyVersion },
    ),
  );
  if (filtered.scored.referenceTime !== request.referenceTime) {
    issues.push(
      issue(
        REQUEST,
        ['filtered', 'scored', 'referenceTime'],
        `must equal the request reference time ${quote(request.referenceTime)}, received ${quote(filtered.scored.referenceTime)}`,
      ),
    );
  }
  issues.push(
    ...checkIdentity(
      ['filtered'],
      'filtering policy',
      { id: filtered.filteringPolicyId, version: filtered.filteringPolicyVersion },
      { id: request.policy.filtering.policyId, version: request.policy.filtering.policyVersion },
    ),
    ...checkIdentity(
      ['rendered', 'ordered', 'allocation'],
      'allocation policy',
      { id: allocation.allocationPolicyId, version: allocation.allocationPolicyVersion },
      { id: request.policy.allocation.policyId, version: request.policy.allocation.policyVersion },
    ),
  );
  if (!structurallyEqual(allocation.tokenBudget, request.budget)) {
    issues.push(
      issue(
        REQUEST,
        ['rendered', 'ordered', 'allocation', 'tokenBudget'],
        'must equal the token budget of the traced compilation request',
      ),
    );
  } else {
    // The ceiling the allocator spent against is arithmetic over the request's
    // own validated budget: total minus the explicitly configured reserves, and
    // nothing else. This subtracts no hidden reserve and re-allocates nothing —
    // it is the same domain helper the allocator itself used (METRICS 8.3,
    // INV-BUDGET-001). It runs only once the budgets are known equal, so a
    // budget mismatch reports one cause rather than two.
    const available = availableInputTokens(request.budget);
    if (allocation.availableInputTokens !== available) {
      issues.push(
        issue(
          REQUEST,
          ['rendered', 'ordered', 'allocation', 'availableInputTokens'],
          `must equal the available input tokens of the request budget (${String(available)}), received ${String(allocation.availableInputTokens)}`,
        ),
      );
    }
  }
  issues.push(
    ...checkIdentity(
      ['rendered', 'ordered'],
      'ordering policy',
      { id: rendered.ordered.orderingPolicyId, version: rendered.ordered.orderingPolicyVersion },
      { id: request.policy.ordering.policyId, version: request.policy.ordering.policyVersion },
    ),
    ...checkIdentity(
      ['rendered'],
      'rendering policy',
      { id: rendered.renderingPolicyId, version: rendered.renderingPolicyVersion },
      { id: request.policy.rendering.policyId, version: request.policy.rendering.policyVersion },
    ),
  );

  return issues;
}

function checkIdentity(
  path: IssuePath,
  label: string,
  actual: TraceIdentity,
  expected: TraceIdentity,
): ValidationIssue[] {
  if (actual.id === expected.id && actual.version === expected.version) return [];
  return [
    issue(
      REQUEST,
      path,
      `must have run under the request's ${label} ${quote(expected.id)} version ${quote(expected.version)}, received ${quote(actual.id)} version ${quote(actual.version)}`,
    ),
  ];
}

/**
 * One envelope field a stage contract carries forward unchanged.
 *
 * `structural` compares canonical serializations, for the scope record and the
 * source registry; the rest are exact string equality over identities and
 * timestamps.
 */
interface EnvelopeField {
  readonly name: string;
  readonly actual: unknown;
  readonly expected: unknown;
  readonly structural?: boolean;
}

/**
 * Proves a stage carried its predecessor's envelope forward unchanged.
 *
 * Every stage from `CandidateScorer` onward copies scope, the source registry,
 * and the identities it was given, changing only the candidates. A field that
 * differs therefore means the two results did not come from one pipeline, and
 * serializing them together would publish a trace describing a run that never
 * happened.
 *
 * The two-sided case is why this matters. A caller who changed a policy version
 * on the filtered set *and* on the allocation would satisfy every check that
 * compares those two to each other; only comparing each stage to the one before
 * it catches drift that is internally consistent but wrong (DEC-037).
 *
 * Fields are checked in the fixed order given, so the issue set never depends on
 * property iteration order (INV-DET-002).
 */
function checkEnvelope(
  path: IssuePath,
  predecessor: string,
  fields: readonly EnvelopeField[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of fields) {
    const equal =
      field.structural === true
        ? structurallyEqual(field.actual, field.expected)
        : field.actual === field.expected;
    if (equal) continue;
    issues.push(
      issue(
        STAGE,
        [...path, field.name],
        `must equal the ${field.name} the ${predecessor} carries${
          typeof field.expected === 'string' && typeof field.actual === 'string'
            ? ` (${quote(field.expected)}), received ${quote(field.actual)}`
            : ''
        }`,
      ),
    );
  }
  return issues;
}

/**
 * Proves each stage's evidence is the evidence of the stage before it.
 *
 * Every check compares published stage data structurally. Where a stage contract
 * preserves object references, structural equality is implied by identity, so
 * the weaker comparison is used deliberately: object identity is not part of the
 * persisted meaning of a trace, and requiring it would reject a caller who
 * legitimately serialized a stage result between components.
 */
function checkStageEvidence(evidence: Evidence): ValidationIssue[] {
  const { validated, deduplicated, filtered, allocation, rendered } = evidence;
  const issues: ValidationIssue[] = [];
  const groups = deduplicated.candidates;

  /* Validation -> deduplication. */
  if (!structurallyEqual(deduplicated.scope, validated.scope)) {
    issues.push(issue(STAGE, ['deduplicated', 'scope'], 'must equal the validated scope'));
  }
  if (!multisetsEqual(deduplicated.sourceDocuments, validated.sourceDocuments)) {
    issues.push(
      issue(
        STAGE,
        ['deduplicated', 'sourceDocuments'],
        'must hold exactly the validated source documents',
      ),
    );
  }

  groups.forEach((group, index) => {
    if (group.members.length === 0) {
      issues.push(
        issue(
          STAGE,
          ['deduplicated', 'candidates', index, 'members'],
          'must hold at least one member',
        ),
      );
      return;
    }
    const canonical = canonicalJson(group.canonicalBlock);
    if (!group.members.some((member) => canonicalJson(member.candidate.block) === canonical)) {
      issues.push(
        issue(
          STAGE,
          ['deduplicated', 'candidates', index, 'canonicalBlock'],
          `must be one of the group's own member blocks, received ${quote(group.canonicalBlock.id)}`,
        ),
      );
    }
  });

  const groupIds = groups.map((group) => group.canonicalBlock.id);
  const groupIdCounts = countById(groupIds);
  for (const [id, count] of [...groupIdCounts].sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (count > 1) {
      issues.push(
        issue(
          STAGE,
          ['deduplicated', 'candidates'],
          `canonical block ID ${quote(id)} represents ${String(count)} groups; a canonical block identifies exactly one group`,
        ),
      );
    }
  }

  const memberWrappers = groups.flatMap((group) => group.members.map((member) => member.candidate));
  if (!multisetsEqual(memberWrappers, validated.candidates)) {
    issues.push(
      issue(
        STAGE,
        ['deduplicated', 'candidates'],
        `must account for exactly the ${String(validated.candidates.length)} validated candidate wrappers, once each`,
      ),
    );
  }

  /* Deduplication -> scoring. */
  const scored = filtered.scored.candidates;
  const groupByCanonicalId = new Map<string, DeduplicatedCandidate>();
  for (const group of groups) groupByCanonicalId.set(group.canonicalBlock.id, group);

  if (!coversExactlyOnce(scored.map(canonicalIdOf), groupIds)) {
    issues.push(
      issue(
        STAGE,
        ['filtered', 'scored', 'candidates'],
        `must score exactly the ${String(groups.length)} deduplicated groups, once each`,
      ),
    );
  }
  scored.forEach((candidate, index) => {
    const group = groupByCanonicalId.get(canonicalIdOf(candidate));
    if (group !== undefined && !structurallyEqual(candidate.candidate, group)) {
      issues.push(
        issue(
          STAGE,
          ['filtered', 'scored', 'candidates', index],
          `scores a group that differs from the deduplicated group ${quote(canonicalIdOf(candidate))}`,
        ),
      );
    }
  });

  issues.push(
    ...checkEnvelope(['filtered', 'scored'], 'deduplicated set', [
      {
        name: 'scope',
        actual: filtered.scored.scope,
        expected: deduplicated.scope,
        structural: true,
      },
      {
        name: 'sourceDocuments',
        actual: filtered.scored.sourceDocuments,
        expected: deduplicated.sourceDocuments,
        structural: true,
      },
    ]),
  );

  /* Scoring -> filtering. */
  const scoredIds = scored.map(canonicalIdOf);
  const scoredByCanonicalId = new Map<string, ScoredCandidate>();
  for (const candidate of scored) scoredByCanonicalId.set(canonicalIdOf(candidate), candidate);

  const decisionIds = filtered.decisions.map((decision) => canonicalIdOf(decision.candidate));
  if (!coversExactlyOnce(decisionIds, scoredIds)) {
    issues.push(
      issue(
        STAGE,
        ['filtered', 'decisions'],
        `must decide exactly the ${String(scored.length)} scored candidates, once each`,
      ),
    );
  }
  filtered.decisions.forEach((decision, index) => {
    issues.push(
      ...checkScoredCandidate(
        ['filtered', 'decisions', index, 'candidate'],
        decision.candidate,
        scoredByCanonicalId,
      ),
    );
  });

  const expectedEligibleIds = filtered.decisions
    .filter((decision) => decision.decision === 'eligible')
    .map((decision) => canonicalIdOf(decision.candidate));
  const eligibleIds = filtered.eligible.candidates.map(canonicalIdOf);
  if (
    eligibleIds.length !== expectedEligibleIds.length ||
    eligibleIds.some((id, index) => id !== expectedEligibleIds[index])
  ) {
    issues.push(
      issue(
        STAGE,
        ['filtered', 'eligible', 'candidates'],
        'must be exactly the candidates its eligible decisions describe, in the same order',
      ),
    );
  }

  // `CandidateFilter` publishes the scored envelope unchanged and narrows only
  // `candidates` (DEC-036), so every other field must still be the scorer's.
  issues.push(
    ...checkEnvelope(['filtered', 'eligible'], 'scored set', [
      {
        name: 'scope',
        actual: filtered.eligible.scope,
        expected: filtered.scored.scope,
        structural: true,
      },
      {
        name: 'sourceDocuments',
        actual: filtered.eligible.sourceDocuments,
        expected: filtered.scored.sourceDocuments,
        structural: true,
      },
      { name: 'policyId', actual: filtered.eligible.policyId, expected: filtered.scored.policyId },
      {
        name: 'policyVersion',
        actual: filtered.eligible.policyVersion,
        expected: filtered.scored.policyVersion,
      },
      {
        name: 'referenceTime',
        actual: filtered.eligible.referenceTime,
        expected: filtered.scored.referenceTime,
      },
    ]),
  );

  /* Filtering -> allocation. */
  const allocationDecisions: readonly (IncludedCandidateDecision | ExcludedCandidateDecision)[] = [
    ...allocation.included,
    ...allocation.excluded,
  ];
  if (
    !coversExactlyOnce(
      allocationDecisions.map((d) => canonicalIdOf(d.candidate)),
      eligibleIds,
    )
  ) {
    issues.push(
      issue(
        STAGE,
        ['rendered', 'ordered', 'allocation'],
        `must decide exactly the ${String(eligibleIds.length)} eligible candidates, once each`,
      ),
    );
  }
  const eligibleIdSet = new Set(eligibleIds);
  allocationDecisions.forEach((decision, index) => {
    const id = canonicalIdOf(decision.candidate);
    if (!eligibleIdSet.has(id)) {
      issues.push(
        issue(
          STAGE,
          ['rendered', 'ordered', 'allocation', index],
          `decides ${quote(id)}, which the filter did not make eligible`,
        ),
      );
    }
    issues.push(
      ...checkScoredCandidate(
        ['rendered', 'ordered', 'allocation', index, 'candidate'],
        decision.candidate,
        scoredByCanonicalId,
      ),
    );
  });

  // `BudgetAllocator` carries the eligible envelope forward and adds its own
  // allocation identity, so everything it inherited must still match (DEC-033).
  issues.push(
    ...checkEnvelope(['rendered', 'ordered', 'allocation'], 'eligible set', [
      {
        name: 'scope',
        actual: allocation.scope,
        expected: filtered.eligible.scope,
        structural: true,
      },
      {
        name: 'sourceDocuments',
        actual: allocation.sourceDocuments,
        expected: filtered.eligible.sourceDocuments,
        structural: true,
      },
      {
        name: 'scoringPolicyId',
        actual: allocation.scoringPolicyId,
        expected: filtered.eligible.policyId,
      },
      {
        name: 'scoringPolicyVersion',
        actual: allocation.scoringPolicyVersion,
        expected: filtered.eligible.policyVersion,
      },
      {
        name: 'referenceTime',
        actual: allocation.referenceTime,
        expected: filtered.eligible.referenceTime,
      },
    ]),
    ...checkAllocationAccounting(allocation),
  );

  /* Allocation -> ordering. */
  const includedIds = allocation.included.map((decision) => canonicalIdOf(decision.candidate));
  const orderedIds = rendered.ordered.orderedIncluded.map((decision) =>
    canonicalIdOf(decision.candidate),
  );
  if (!coversExactlyOnce(orderedIds, includedIds)) {
    issues.push(
      issue(
        STAGE,
        ['rendered', 'ordered', 'orderedIncluded'],
        `must hold exactly the ${String(includedIds.length)} included allocation decisions, once each`,
      ),
    );
  } else {
    const includedByCanonicalId = new Map<string, IncludedCandidateDecision>();
    for (const decision of allocation.included) {
      includedByCanonicalId.set(canonicalIdOf(decision.candidate), decision);
    }
    rendered.ordered.orderedIncluded.forEach((decision, index) => {
      const included = includedByCanonicalId.get(canonicalIdOf(decision.candidate));
      if (included !== undefined && !structurallyEqual(decision, included)) {
        issues.push(
          issue(
            STAGE,
            ['rendered', 'ordered', 'orderedIncluded', index],
            `differs from the allocation decision it claims to order (${quote(canonicalIdOf(decision.candidate))})`,
          ),
        );
      }
    });
  }

  /* Ordering -> rendering. */
  if (
    rendered.fitsAvailableInputBudget !==
    rendered.renderedTokens <= allocation.availableInputTokens
  ) {
    issues.push(
      issue(
        STAGE,
        ['rendered', 'fitsAvailableInputBudget'],
        'must state whether the measured rendered tokens fit the allocation budget',
      ),
    );
  }

  return issues;
}

/**
 * Proves one decision's candidate is the scored candidate it claims to be.
 *
 * The comparison covers the group and its score together, so a decision carrying
 * a candidate from another run — or the right group with another run's score —
 * is rejected rather than copied into the trace.
 */
function checkScoredCandidate(
  path: IssuePath,
  candidate: ScoredCandidate,
  scoredByCanonicalId: ReadonlyMap<string, ScoredCandidate>,
): ValidationIssue[] {
  const id = canonicalIdOf(candidate);
  const expected = scoredByCanonicalId.get(id);
  if (expected === undefined) {
    return [issue(STAGE, path, `references ${quote(id)}, which is not a scored candidate`)];
  }
  if (structurallyEqual(candidate, expected)) return [];
  return [issue(STAGE, path, `differs from the scored candidate ${quote(id)}`)];
}

/**
 * Proves the allocator's published accounting does not contradict itself.
 *
 * The trace persists the allocation summary *and* the content totals, so it must
 * not serialize an allocator that says one thing in its decisions and another in
 * its totals. A reader reconciling `selectedBlockContentTokens` against the
 * included blocks would otherwise find a discrepancy the record gives no way to
 * explain.
 *
 * Every comparison uses values the allocator already published. Nothing here
 * re-runs allocation, re-counts a token, calls a tokenizer, or re-evaluates a
 * category rule: it checks that `contentTokens` is the canonical block's own
 * count, that the selected sum is the sum of the inclusions, that the remainder
 * is the budget minus that sum, and that each inclusion's budget transition
 * spends exactly its own cost (DEC-033, INV-TRACE-006).
 */
function checkAllocationAccounting(allocation: AllocatedCandidateSet): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (...rest: readonly (string | number)[]): IssuePath => [
    'rendered',
    'ordered',
    'allocation',
    ...rest,
  ];

  const checkCost = (
    decision: IncludedCandidateDecision | ExcludedCandidateDecision,
    path: IssuePath,
  ): void => {
    const expected = decision.candidate.candidate.canonicalBlock.tokenCount;
    if (decision.contentTokens !== expected) {
      issues.push(
        issue(
          STAGE,
          [...path, 'contentTokens'],
          `must equal the canonical block's own token count (${String(expected)}), received ${String(decision.contentTokens)}`,
        ),
      );
    }
  };

  allocation.included.forEach((decision, index) => {
    checkCost(decision, at('included', index));
    // The transition spends exactly this block's cost and nothing else.
    if (decision.remainingBefore - decision.contentTokens !== decision.remainingAfter) {
      issues.push(
        issue(
          STAGE,
          at('included', index, 'remainingAfter'),
          `must equal remainingBefore minus contentTokens (${String(decision.remainingBefore)} - ${String(decision.contentTokens)}), received ${String(decision.remainingAfter)}`,
        ),
      );
    }
  });
  allocation.excluded.forEach((decision, index) => {
    checkCost(decision, at('excluded', index));
  });

  const selected = safeSum(allocation.included.map((decision) => decision.contentTokens));
  if (selected === undefined) {
    issues.push(
      issue(
        'invalid_trace_result',
        at('selectedBlockContentTokens'),
        'the included content cost leaves the exact non-negative safe integer range',
      ),
    );
    return issues;
  }
  if (allocation.selectedBlockContentTokens !== selected) {
    issues.push(
      issue(
        STAGE,
        at('selectedBlockContentTokens'),
        `must equal the sum of its included decisions' contentTokens (${String(selected)}), received ${String(allocation.selectedBlockContentTokens)}`,
      ),
    );
  }

  const unallocated = safeDifference(allocation.availableInputTokens, selected);
  if (unallocated === undefined) {
    issues.push(
      issue(
        'invalid_trace_result',
        at('unallocatedBlockContentTokens'),
        'the unallocated remainder leaves the exact non-negative safe integer range',
      ),
    );
    return issues;
  }
  if (allocation.unallocatedBlockContentTokens !== unallocated) {
    issues.push(
      issue(
        STAGE,
        at('unallocatedBlockContentTokens'),
        `must equal availableInputTokens minus selectedBlockContentTokens (${String(unallocated)}), received ${String(allocation.unallocatedBlockContentTokens)}`,
      ),
    );
  }

  return issues;
}

/* -------------------------------------------------------------------------- */
/* Overflow-safe arithmetic                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sums token counts, refusing to publish an unsafe integer.
 *
 * Each addend and each running total is checked, so a sum that leaves the exact
 * integer range is reported rather than published as an approximation. Token
 * counts are correctness data, and a total that cannot be compared or subtracted
 * exactly is not a total (INV-BUDGET-005).
 */
function safeSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function safeDifference(a: number, b: number): number | undefined {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return undefined;
  const difference = a - b;
  if (!Number.isSafeInteger(difference) || difference < 0) return undefined;
  return difference;
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                  */
/* -------------------------------------------------------------------------- */

function traceSource(document: SourceDocument): CompilationTraceSource {
  return { id: document.id, sourceType: document.sourceType, contentHash: document.contentHash };
}

/**
 * Projects the canonical block onto its audit fields.
 *
 * `content` and `metadata` have no field to travel in. An absent optional
 * attribute stays absent rather than becoming an explicit `undefined`, so the
 * record survives a JSON round trip unchanged.
 */
function traceCanonicalBlock(block: ContextBlock): CompilationTraceCanonicalBlock {
  const { priority, category } = block.attributes;
  return {
    id: block.id,
    sourceDocumentId: block.sourceDocumentId,
    sourceType: block.sourceType,
    tokenCount: block.tokenCount,
    normalizedContentHash: block.normalizedContentHash,
    required: block.attributes.required === true,
    ...(priority === undefined ? {} : { priority }),
    ...(category === undefined ? {} : { category }),
    ...(block.sourceLocation === undefined ? {} : { sourceLocation: block.sourceLocation }),
  };
}

function traceMember(member: DeduplicatedCandidate['members'][number]): CompilationTraceMember {
  const { block, retrieval } = member.candidate;
  return {
    blockId: block.id,
    sourceDocumentId: block.sourceDocumentId,
    matchReason: member.matchReason,
    ...(retrieval === undefined
      ? {}
      : {
          retrieval: {
            providerId: retrieval.providerId,
            providerVersion: retrieval.providerVersion,
            ...(retrieval.rank === undefined ? {} : { rank: retrieval.rank }),
            ...(retrieval.score === undefined
              ? {}
              : {
                  score: {
                    value: retrieval.score.value,
                    semantics: retrieval.score.semantics,
                    higherIsBetter: retrieval.score.higherIsBetter,
                  },
                }),
          },
        }),
  };
}

/** Strips the candidate object, preserving the exact machine-readable evidence. */
function traceFilteringDecision(
  decision: CandidateFilteringDecision,
): CompilationTraceFilteringDecision {
  switch (decision.reason) {
    case 'ELIGIBLE_REQUIRED':
      return { decision: 'eligible', reason: 'ELIGIBLE_REQUIRED' };
    case 'ELIGIBLE_POLICY':
      return {
        decision: 'eligible',
        reason: 'ELIGIBLE_POLICY',
        scoreTotal: decision.scoreTotal,
        ...(decision.minimumTotalScore === undefined
          ? {}
          : { minimumTotalScore: decision.minimumTotalScore }),
      };
    case 'FILTERED_SCORE_BELOW_MINIMUM':
      return {
        decision: 'filtered',
        reason: 'FILTERED_SCORE_BELOW_MINIMUM',
        scoreTotal: decision.scoreTotal,
        minimumTotalScore: decision.minimumTotalScore,
      };
  }
}

/** The decisions and positions the projection joins onto one group. */
interface GroupEvidence {
  readonly filtering: ReadonlyMap<string, CandidateFilteringDecision>;
  readonly allocation: ReadonlyMap<string, IncludedCandidateDecision | ExcludedCandidateDecision>;
  readonly renderPosition: ReadonlyMap<string, number>;
  readonly score: ReadonlyMap<string, CandidateScore>;
}

/**
 * Projects one deduplicated group and everything decided about it.
 *
 * The score, the filtering reason, and the allocation reason are copied from the
 * stages that produced them; none is re-derived from a policy (INV-TRACE-006).
 *
 * The lookups always succeed once the coherence checks have passed. They are
 * still guarded rather than narrowed with a type assertion, so a future caller
 * reaching this function another way fails explicitly instead of publishing a
 * trace built from a missing decision.
 */
function traceGroup(
  group: DeduplicatedCandidate,
  index: number,
  evidence: GroupEvidence,
): CompilationTraceGroup {
  const canonicalId = group.canonicalBlock.id;
  const at = (...rest: readonly (string | number)[]): IssuePath => [
    'deduplicated',
    'candidates',
    index,
    ...rest,
  ];

  const filtering = evidence.filtering.get(canonicalId);
  const score = evidence.score.get(canonicalId);
  if (filtering === undefined || score === undefined) {
    throw new CompilationTraceError([
      issue(STAGE, at(), `has no score or filtering decision for ${quote(canonicalId)}`),
    ]);
  }

  // A filtered group never reached the allocator, so it carries no allocation
  // decision at all rather than a manufactured exclusion (DEC-036).
  if (filtering.decision === 'filtered') {
    return {
      canonical: traceCanonicalBlock(group.canonicalBlock),
      canonicalSelectionReason: group.canonicalSelectionReason,
      members: group.members.map(traceMember),
      score,
      filtering: traceFilteringDecision(filtering),
      currentDisposition: 'filtered',
    };
  }

  const allocated = evidence.allocation.get(canonicalId);
  if (allocated === undefined) {
    throw new CompilationTraceError([
      issue(STAGE, at(), `has no allocation decision for eligible group ${quote(canonicalId)}`),
    ]);
  }

  const common = {
    canonical: traceCanonicalBlock(group.canonicalBlock),
    canonicalSelectionReason: group.canonicalSelectionReason,
    members: group.members.map(traceMember),
    score,
    filtering: traceFilteringDecision(filtering),
  };

  if (allocated.decision === 'excluded') {
    return {
      ...common,
      allocation: { decision: 'excluded', reason: allocated.reason },
      currentDisposition: 'excluded',
    };
  }

  const renderPosition = evidence.renderPosition.get(canonicalId);
  return {
    ...common,
    allocation: { decision: 'included', reason: allocated.reason },
    currentDisposition: 'included',
    // Absent only when the ordering evidence lost the block, which
    // `checkRenderPositions` reports rather than papering over.
    ...(renderPosition === undefined ? {} : { renderPosition }),
  };
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                     */
/* -------------------------------------------------------------------------- */

export class TraceBuilder {
  readonly #config: TraceBuilderConfig;

  /**
   * Validates the injected compiler identity.
   *
   * @throws {CompilationTraceError} when the configuration is not valid.
   */
  constructor(config: unknown) {
    const parsed = safeParse(TraceBuilderConfigSchema, config);
    if (!parsed.ok) {
      throw new CompilationTraceError(
        parsed.issues.map((parsedIssue) => ({
          ...parsedIssue,
          code: 'invalid_config' satisfies CompilationTraceIssueCode,
        })),
      );
    }
    this.#config = parsed.value;
  }

  /**
   * Builds one trace from evidence the compiler already produced.
   *
   * Coherence is checked first, all of it, in one fixed order: request evidence,
   * then stage evidence. Every problem is collected before failing, so a caller
   * who mixed two runs learns the whole contradiction rather than its first
   * symptom. On any problem no trace is returned and nothing is repaired
   * (INV-ADAPTER-003).
   *
   * The projection that follows only copies, digests, counts, and sums. Token
   * counting, normalized hashing, scoring, filtering, allocation, ordering, and
   * rendering are all read from the evidence and never re-run, so building a
   * trace cannot change what the compiler decided (INV-TRACE-006).
   *
   * The supplied evidence and everything reachable from it are treated as
   * immutable: no set, group, block, attribute, metadata object, retrieval
   * record, source document, decision, score, or array is mutated or reordered
   * in place (INV-ALLOC-004).
   *
   * @throws {CompilationTraceError} when the evidence contradicts itself or the
   * projected totals do not reconcile.
   */
  build(input: CompilationTraceBuildInput): UnsettledCompilationTrace {
    const evidence = evidenceOf(input);

    const coherence = [...checkRequestEvidence(evidence), ...checkStageEvidence(evidence)];
    if (coherence.length > 0) throw new CompilationTraceError(coherence);

    const { request, deduplicated, filtered, allocation, rendered } = evidence;

    const filteringByCanonicalId = new Map<string, CandidateFilteringDecision>();
    for (const decision of filtered.decisions) {
      filteringByCanonicalId.set(canonicalIdOf(decision.candidate), decision);
    }
    const allocationByCanonicalId = new Map<
      string,
      IncludedCandidateDecision | ExcludedCandidateDecision
    >();
    for (const decision of [...allocation.included, ...allocation.excluded]) {
      allocationByCanonicalId.set(canonicalIdOf(decision.candidate), decision);
    }
    const renderPositionByCanonicalId = new Map<string, number>();
    rendered.ordered.orderedIncluded.forEach((decision, index) => {
      renderPositionByCanonicalId.set(canonicalIdOf(decision.candidate), index);
    });

    const scoreByCanonicalId = new Map<string, CandidateScore>();
    for (const candidate of filtered.scored.candidates) {
      scoreByCanonicalId.set(canonicalIdOf(candidate), candidate.score);
    }

    const issues: ValidationIssue[] = [];
    const groups = deduplicated.candidates.map((group, index) =>
      traceGroup(group, index, {
        filtering: filteringByCanonicalId,
        allocation: allocationByCanonicalId,
        renderPosition: renderPositionByCanonicalId,
        score: scoreByCanonicalId,
      }),
    );

    const totals = calculateTotals(groups, deduplicated, issues);
    if (issues.length > 0 || totals === undefined) {
      throw new CompilationTraceError(issues);
    }

    const trace: UnsettledCompilationTrace = {
      schemaVersion: COMPILATION_TRACE_SCHEMA_VERSION,
      // The builder traces one measured attempt and nothing more. Settling a
      // compilation belongs to `ContextCompiler`, which owns the correction and
      // the same-tokenizer composition (ARCHITECTURE 7.2, DEC-038).
      settled: false,
      request: {
        id: request.id,
        fingerprint: fingerprintCompilationRequest(request),
        scope: request.scope,
        referenceTime: request.referenceTime,
        queryHash: domainSeparatedDigest(QUERY_HASH_LABEL, QUERY_HASH_VERSION, request.query),
        budget: request.budget,
        candidateCount: request.candidates.length,
        sourceDocumentCount: request.sourceDocuments.length,
      },
      composition: {
        compiler: { id: this.#config.compilerId, version: this.#config.compilerVersion },
        policy: {
          compilation: { id: request.policy.policyId, version: request.policy.policyVersion },
          scoring: { id: filtered.scored.policyId, version: filtered.scored.policyVersion },
          filtering: {
            id: filtered.filteringPolicyId,
            version: filtered.filteringPolicyVersion,
          },
          allocation: {
            id: allocation.allocationPolicyId,
            version: allocation.allocationPolicyVersion,
          },
          ordering: {
            id: rendered.ordered.orderingPolicyId,
            version: rendered.ordered.orderingPolicyVersion,
          },
          rendering: { id: rendered.renderingPolicyId, version: rendered.renderingPolicyVersion },
        },
        tokenizer: { id: rendered.tokenizerId, version: rendered.tokenizerVersion },
        // Always `rendering-attempt-only`. The render attempt is the only place a
        // tokenizer identity is observable from this input, so the identity above
        // explains `rendering.renderedTokens` and nothing else. Claiming more
        // needs a composition root that injected one tokenizer into
        // `CandidateValidator` and `ContextRenderer` alike, which is
        // `ContextCompiler` and not this builder (DEC-035, DEC-036, DEC-037).
        tokenizerCoverage: 'rendering-attempt-only',
        renderer: { id: rendered.rendererId, version: rendered.rendererVersion },
      },
      // The registry is ordered by stable identity with the project-owned
      // code-unit comparison, never by locale (INV-DET-002).
      sources: [...request.sourceDocuments]
        .sort((a, b) => compareCodeUnits(a.id, b.id))
        .map(traceSource),
      groups,
      allocation: {
        availableInputTokens: allocation.availableInputTokens,
        selectedBlockContentTokens: allocation.selectedBlockContentTokens,
        unallocatedBlockContentTokens: allocation.unallocatedBlockContentTokens,
        includedBlockIds: allocation.included.map((decision) => canonicalIdOf(decision.candidate)),
        excludedBlockIds: allocation.excluded.map((decision) => canonicalIdOf(decision.candidate)),
        // Copied exactly: it is neither sorted nor reinterpreted as render order.
        optionalEvictionOrder: [...allocation.optionalEvictionOrder],
      },
      ordering: {
        orderedBlockIds: rendered.ordered.orderedIncluded.map((decision) =>
          canonicalIdOf(decision.candidate),
        ),
      },
      rendering: {
        renderedContextHash: hashRenderedContext(rendered.renderedContext),
        renderedTokens: rendered.renderedTokens,
        fitsAvailableInputBudget: rendered.fitsAvailableInputBudget,
      },
      totals,
    };

    return trace;
  }
}

/**
 * Calculates the reconciliation totals of the current selection.
 *
 * Every value is a sum or a difference of numbers earlier stages already
 * validated; nothing is measured, estimated, or rounded here. Rendering counts
 * deliberately take no part: `renderedTokens` measures a string, while these
 * totals account for block content, and mixing them would report two different
 * quantities under one name (METRICS 8.6).
 */
function calculateTotals(
  groups: readonly CompilationTraceGroup[],
  deduplicated: DeduplicatedCandidateSet,
  issues: ValidationIssue[],
): CompilationTraceTotals | undefined {
  const wrapperTokens = deduplicated.candidates.flatMap((group) =>
    group.members.map((member) => member.candidate.block.tokenCount),
  );
  const byDisposition = (disposition: CompilationTraceDisposition): CompilationTraceGroup[] =>
    groups.filter((group) => group.currentDisposition === disposition);

  const filteredGroups = byDisposition('filtered');
  const includedGroups = byDisposition('included');
  const excludedGroups = byDisposition('excluded');
  const tokensOf = (subset: readonly CompilationTraceGroup[]): number[] =>
    subset.map((group) => group.canonical.tokenCount);

  const candidateCount = safeSum(groups.map((group) => group.members.length));
  const deduplicatedGroupCount = groups.length;
  const candidateTokens = safeSum(wrapperTokens);
  const canonicalContentTokens = safeSum(tokensOf(groups));
  const filteredContentTokens = safeSum(tokensOf(filteredGroups));
  const includedContentTokens = safeSum(tokensOf(includedGroups));
  const allocationExcludedContentTokens = safeSum(tokensOf(excludedGroups));

  if (
    candidateCount === undefined ||
    candidateTokens === undefined ||
    canonicalContentTokens === undefined ||
    filteredContentTokens === undefined ||
    includedContentTokens === undefined ||
    allocationExcludedContentTokens === undefined
  ) {
    issues.push(
      issue(
        'invalid_trace_result',
        ['totals'],
        'token totals leave the exact non-negative safe integer range and cannot be published',
      ),
    );
    return undefined;
  }

  const duplicateWrapperCount = safeDifference(candidateCount, deduplicatedGroupCount);
  const duplicateCandidateTokens = safeDifference(candidateTokens, canonicalContentTokens);
  const excludedCanonicalContentTokens = safeSum([
    filteredContentTokens,
    allocationExcludedContentTokens,
  ]);

  if (
    duplicateWrapperCount === undefined ||
    duplicateCandidateTokens === undefined ||
    excludedCanonicalContentTokens === undefined
  ) {
    issues.push(
      issue(
        'invalid_trace_result',
        ['totals'],
        'derived totals leave the exact non-negative safe integer range and cannot be published',
      ),
    );
    return undefined;
  }

  const totals: CompilationTraceTotals = {
    candidateCount,
    deduplicatedGroupCount,
    duplicateWrapperCount,
    filteredGroupCount: filteredGroups.length,
    eligibleGroupCount: includedGroups.length + excludedGroups.length,
    includedGroupCount: includedGroups.length,
    allocationExcludedGroupCount: excludedGroups.length,
    candidateTokens,
    canonicalContentTokens,
    duplicateCandidateTokens,
    filteredContentTokens,
    includedContentTokens,
    allocationExcludedContentTokens,
    excludedCanonicalContentTokens,
  };

  issues.push(...checkTotals(totals), ...checkRenderPositions(groups));
  return totals;
}

/**
 * Proves the published totals reconcile exactly (INV-TRACE-003).
 *
 * The equations are checked rather than assumed, because a trace that stated
 * inconsistent totals would be worse than no trace: a reader cannot tell a
 * reporting bug from a compiler bug.
 */
function checkTotals(totals: CompilationTraceTotals): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const [field, value] of Object.entries(totals).sort(([a], [b]) => compareCodeUnits(a, b))) {
    if (!Number.isSafeInteger(value) || value < 0) {
      issues.push(
        issue(
          'invalid_trace_result',
          ['totals', field],
          `must be a finite non-negative safe integer, received ${String(value)}`,
        ),
      );
    }
  }

  const equations: readonly (readonly [string, number, number])[] = [
    [
      'candidateCount = deduplicatedGroupCount + duplicateWrapperCount',
      totals.candidateCount,
      totals.deduplicatedGroupCount + totals.duplicateWrapperCount,
    ],
    [
      'eligibleGroupCount = includedGroupCount + allocationExcludedGroupCount',
      totals.eligibleGroupCount,
      totals.includedGroupCount + totals.allocationExcludedGroupCount,
    ],
    [
      'deduplicatedGroupCount = filteredGroupCount + eligibleGroupCount',
      totals.deduplicatedGroupCount,
      totals.filteredGroupCount + totals.eligibleGroupCount,
    ],
    [
      'candidateTokens = canonicalContentTokens + duplicateCandidateTokens',
      totals.candidateTokens,
      totals.canonicalContentTokens + totals.duplicateCandidateTokens,
    ],
    [
      'excludedCanonicalContentTokens = filteredContentTokens + allocationExcludedContentTokens',
      totals.excludedCanonicalContentTokens,
      totals.filteredContentTokens + totals.allocationExcludedContentTokens,
    ],
    [
      'canonicalContentTokens = includedContentTokens + excludedCanonicalContentTokens',
      totals.canonicalContentTokens,
      totals.includedContentTokens + totals.excludedCanonicalContentTokens,
    ],
  ];

  for (const [equation, left, right] of equations) {
    if (left !== right) {
      issues.push(
        issue(
          'invalid_trace_result',
          ['totals'],
          `must satisfy ${equation}: ${String(left)} does not equal ${String(right)}`,
        ),
      );
    }
  }

  return issues;
}

/**
 * Proves the render positions are a permutation of `0 ... includedCount - 1`.
 *
 * A position that repeated or skipped a slot would describe a rendered order
 * that does not exist (INV-TRACE-004).
 */
function checkRenderPositions(groups: readonly CompilationTraceGroup[]): ValidationIssue[] {
  const includedCount = groups.filter((group) => group.currentDisposition === 'included').length;
  const positions = groups
    .map((group) => group.renderPosition)
    .filter((position): position is number => position !== undefined);
  const distinct = new Set(positions);

  const covers =
    positions.length === includedCount &&
    distinct.size === includedCount &&
    positions.every(
      (position) => Number.isInteger(position) && position >= 0 && position < includedCount,
    );

  if (covers) return [];
  return [
    issue(
      'invalid_trace_result',
      ['groups'],
      `render positions must cover 0 to ${String(includedCount - 1)} exactly once, one for each included group`,
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Settlement                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Projects one unsettled snapshot plus proven settlement evidence into a settled
 * trace (DEC-038).
 *
 * The snapshot is **not mutated**. A new value is built from its fields, so the
 * caller's record — and any consumer already holding it — is unchanged
 * (INV-ALLOC-004). Every stage fact travels through untouched: the original
 * filtering and allocation decisions, the allocator summary, the allocation's
 * render order, the measured attempt, and the reconciliation totals all keep
 * exactly the values `TraceBuilder` observed. Only three things change:
 * `settled` becomes `true`, the compilation identity is bound, and the
 * settlement overlay is added.
 *
 * `tokenizerCoverage` is upgraded to `validation-and-rendering` because only
 * `ContextCompiler` calls this, and only after it has validated candidate blocks
 * and measured every rendered selection with the one tokenizer it owns. The
 * upgrade is never inferred from matching identifiers or matching numbers: it is
 * a property of the composition, not of the evidence (DEC-037).
 *
 * This function decides nothing. It performs no correction, no measurement, no
 * ordering, and no tokenization; the caller supplies evidence it has already
 * proven (INV-TRACE-006).
 *
 * Settlement deliberately does **not** become a public `TraceBuilder` method:
 * the builder is observational, and the correction that produces this evidence
 * belongs to orchestration. The helper is internal to the compiler kernel — the
 * package entry point never re-exports it, and no public declaration names it
 * (INV-ADAPTER-001).
 */
export function settleCompilationTrace(
  snapshot: UnsettledCompilationTrace,
  compilationId: CompilationId,
  settlement: CompilationTraceSettlement,
): SettledCompilationTrace {
  return {
    schemaVersion: snapshot.schemaVersion,
    settled: true,
    compilationId,
    request: snapshot.request,
    composition: {
      compiler: snapshot.composition.compiler,
      policy: snapshot.composition.policy,
      tokenizer: snapshot.composition.tokenizer,
      tokenizerCoverage: 'validation-and-rendering',
      renderer: snapshot.composition.renderer,
    },
    sources: snapshot.sources,
    groups: snapshot.groups,
    allocation: snapshot.allocation,
    ordering: snapshot.ordering,
    rendering: snapshot.rendering,
    totals: snapshot.totals,
    settlement,
  };
}

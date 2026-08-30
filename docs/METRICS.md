# Metrics and Evaluation Specification

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Document type: Metrics and evaluation specification
* Status: Active
* Applies to: MVP development, benchmarking, regression testing, and release acceptance

This document defines how CtxAlloc performance and product value are measured.

A context compilation method must not be evaluated by token reduction alone.

Every optimization result must be interpreted together with information preservation, answer quality, correctness, latency, and reliability.

---

# 1. Evaluation Objectives

The evaluation system must answer the following questions:

1. Does CtxAlloc reduce the number of input tokens?
2. Does the compiled context retain required information?
3. Does the downstream model still answer correctly?
4. Does the compiler stay inside the configured budget?
5. Are compilation decisions deterministic?
6. Can every decision be explained?
7. Is compilation fast enough for practical use?
8. Does the system behave correctly on invalid and adversarial inputs?
9. Does the system provide value compared with simpler baselines?
10. Does a new algorithm improve the system without introducing hidden regressions?

---

# 2. Core Evaluation Principle

CtxAlloc optimizes multiple objectives.

The primary objective is not:

```text id="klsr33"
minimize tokens
```

The actual objective is:

```text id="1qct9p"
minimize tokens
subject to:
  required information is preserved
  answer quality remains acceptable
  the token budget is never exceeded
  provenance remains intact
  decisions remain explainable
```

A result that achieves high token reduction but loses required information is a failure.

---

## 2.1 Three Different Meanings of "Score"

Three unrelated numbers are called a score in this project. They are never comparable and must never be aggregated together or reported under one label.

**Retrieval provider score.** A raw, provider-defined value carried on a `CandidateBlock` wrapper, with its own `semantics` and `higherIsBetter` direction. It is untrusted external input on an unknown scale: a cosine similarity, a vector distance, a BM25 score, or something else entirely, and two providers or two provider versions do not share a scale. It is reported with retrieval metrics (section 16) and is what the Top-K baseline (section 7.3) sorts by.

**Compiler candidate score.** The `CandidateScore.total` that `CandidateScorer` calculates from explicitly configured, normalized signals under one `CandidateScoringPolicy` (DEC-032). It is a policy-relative utility, not a probability, and is not bounded by one: weights need not sum to one. Two totals are comparable only when they come from the same run under the same `policyId` and `policyVersion`. It is a compiler metric (sections 3.1 and 13) and an input to allocation, never an answer-quality measurement.

**Answer quality score.** The 0–4 dimensional rating of a model's answer defined in section 11.5. It measures the downstream model's output, not the compiler's decision.

A report that mixes them — for example ranking compilations by an average of provider scores, or presenting a compiler candidate score as evidence of answer quality — is invalid (section 16, "Retrieval metrics must not be combined with compiler metrics into one unexplained score").

---

# 3. Evaluation Levels

Evaluation is divided into four levels.

## 3.1 Compiler Unit Evaluation

Tests deterministic compiler behavior without retrieval or an LLM.

Measures:

* budget correctness;
* selection correctness;
* ordering;
* deduplication;
* trace completeness;
* determinism;
* error behavior.

## 3.2 Context Evaluation

Measures whether the compiled context itself contains the information required to answer the query.

No downstream model is required.

Measures:

* required-block recall;
* required-fact coverage;
* irrelevant-block exclusion;
* duplicate removal;
* provenance coverage.

## 3.3 Answer Evaluation

Sends baseline and compiled contexts to the same downstream model.

Measures:

* answer correctness;
* factual completeness;
* unsupported claims;
* citation or source accuracy;
* quality loss compared with baseline.

## 3.4 End-to-End Evaluation

Includes:

* source ingestion;
* chunking;
* candidate retrieval;
* compilation;
* model execution.

Measures the complete user-visible system.

Compiler metrics and retrieval metrics must still be reported separately.

---

# 4. Evaluation Dataset Structure

Each evaluation case must use a versioned schema.

```ts id="cd8n2e"
interface EvaluationCase {
  id: string;
  schemaVersion: number;
  datasetSplit: "development" | "validation" | "regression";

  scope: Scope;
  query: string;

  candidates: CandidateBlock[];
  sourceDocuments: SourceDocument[];

  budget: {
    totalTokens: number;
    reservedOutputTokens: number;
    reservedSystemTokens?: number;
    reservedToolTokens?: number;
    reservedProtocolTokens?: number;
  };

  requiredBlockIds?: string[];
  requiredFacts?: RequiredFact[];
  relevantBlockIds?: string[];
  irrelevantBlockIds?: string[];
  duplicateGroups?: DuplicateGroup[];

  expectedFailure?: {
    code: string;
  };

  answerCriteria?: AnswerCriterion[];

  tags: string[];
}
```

`candidates` are `CandidateBlock` wrappers, and `sourceDocuments` is the explicit
registry their source references are validated against, because that is what the
compiler's candidate validation stage actually receives (DEC-030). A case that
omitted the registry could not be compiled.

`EvaluationCase` is a specification, not an implemented schema. The evaluation
harness is a later phase.

Required facts should have stable identifiers.

```ts id="nz9zwe"
interface RequiredFact {
  id: string;
  description: string;
  acceptableEvidence: string[];
  sourceBlockIds: string[];
  importance: "critical" | "major" | "minor";
}
```

---

# 5. Dataset Splits

## 5.1 Development Set

Used to:

* develop algorithms;
* tune scoring weights;
* inspect traces;
* design policies;
* debug failures.

Results from this set must not be used as final evidence of generalization.

## 5.2 Validation Set

Used to evaluate release candidates.

Compiler policy weights must not be manually tuned against individual validation failures.

## 5.3 Regression Set

Contains:

* previously discovered bugs;
* edge cases;
* production failures;
* invariant violations;
* adversarial cases.

Regression cases may grow continuously.

A regression case must not be removed because it lowers aggregate scores.

---

# 6. Required Dataset Categories

The MVP benchmark must include cases from each category.

## 6.1 Straightforward Relevance

A small number of clearly relevant blocks among unrelated blocks.

## 6.2 Distributed Facts

The correct answer requires facts from multiple blocks or sources.

## 6.3 Duplicate Context

The same information appears in several blocks.

## 6.4 Conflicting Context

Old and new values describe the same subject.

## 6.5 Long Documents

Relevant information is a small part of a large document set.

## 6.6 Conversation Continuity

The query depends on recent turns plus an older decision.

## 6.7 Required Large Block

A required block consumes a substantial portion of the budget.

## 6.8 Impossible Budget

Required content cannot fit.

## 6.9 Scope Isolation

Candidates from another tenant, workspace, or project are included in the input.

## 6.10 Unicode and Structured Content

Cases include:

* supplementary Unicode characters;
* Markdown headings;
* code blocks;
* tables;
* nested lists;
* source offsets.

## 6.11 Prompt Injection in Source Content

A retrieved block contains instructions attempting to modify compiler behavior.

## 6.12 Retrieval Noise

The candidate list includes high-scoring but irrelevant blocks.

## 6.13 Input Ordering

The same candidates are provided in different permutations.

---

# 7. Baselines

Every meaningful benchmark must compare CtxAlloc with one or more baselines.

## 7.1 Full Context Baseline

All valid candidates are rendered without selection.

Use when the full context fits inside the model window.

Purpose:

* estimate maximum available evidence;
* measure token savings;
* compare answer quality.

## 7.2 Truncation Baseline

Candidates are concatenated in input order and cut at the token budget.

Purpose:

* compare against the simplest budget enforcement strategy.

## 7.3 Top-K Baseline

Candidates are sorted by retrieval or relevance score and included until the budget is exhausted.

Purpose:

* determine whether CtxAlloc adds value beyond standard retrieval ranking.

## 7.4 Recent-Only Baseline

For conversation cases, include only the most recent messages that fit.

Purpose:

* compare against common chat history handling.

## 7.5 Required-Plus-Top-K Baseline

Include required blocks first, then add top-scoring optional blocks.

Purpose:

* compare the complete allocator against a simple deterministic strategy.

The MVP must report at least:

* full context baseline;
* truncation baseline;
* top-K baseline;
* CtxAlloc result.

---

# 8. Token Metrics

## 8.1 Candidate Tokens

```text id="c9lry4"
candidateTokens
  = sum of token counts for all validated candidates
```

This value excludes rejected invalid candidates unless a separate raw input metric is reported.

## 8.2 Raw Input Tokens

```text id="a6vqsk"
rawInputTokens
  = tokens in every candidate received before validation
```

This metric is optional but useful for diagnosing invalid or duplicated input.

## 8.3 Available Input Tokens

```text id="wvyb1v"
availableInputTokens
  = totalTokens
  - reservedOutputTokens
  - reservedSystemTokens
  - reservedToolTokens
  - reservedProtocolTokens
```

Unset optional reserve values equal zero.

## 8.4 Compiled Tokens

```text id="0m6ugv"
compiledTokens
  = tokenizer(finalRenderedContext)
```

The final rendered string is the source of truth.

## 8.4.1 Provisional Block-Content Metrics

`BudgetAllocator` (ARCHITECTURE 6.4) runs before anything is rendered, so it
cannot report 8.4 or 8.10. It reports three intermediate values instead:

```text id="p10bcm"
availableInputTokens
  = the value of 8.3, from the validated TokenBudget

selectedBlockContentTokens
  = exact sum of the included canonical blocks' tokenCount

unallocatedBlockContentTokens
  = availableInputTokens - selectedBlockContentTokens
```

The stage guarantees `selectedBlockContentTokens <= availableInputTokens`
exactly.

These are **not**:

* `compiledTokens` (8.4), which is the tokenized final rendered context;
* `unusedTokens` (8.10), which is measured against `compiledTokens`;
* `renderingTokenDelta` (8.6), which the allocator neither measures nor
  estimates.

`selectedBlockContentTokens` is a provisional value of the same shape as
`includedContentTokens` (8.5) for the currently selected set; it becomes that
metric only once the final selection is settled. Reporting a provisional value
under a final metric name is a reporting error.

The definitions in 8.4, 8.5, 8.6, 8.9, 8.10, and 8.11 remain the responsibility
of the compiler orchestration that settles the final selection.

## 8.4.2 Render-Attempt Metrics

`ContextRenderer` (ARCHITECTURE 6.6) renders and tokenizes **one** selection. The
selection may still change, so its measurement is reported under attempt names.
There are exactly two:

```text id="v4t7ns"
renderedTokens
  = tokenizer(renderedContext)

fitsAvailableInputBudget
  = renderedTokens <= availableInputTokens
```

`renderedTokens` is the exact count of the one complete rendered string, never a
sum of block counts, record counts, or separator counts (INV-BUDGET-002).

`fitsAvailableInputBudget` is observational. A `false` value is a valid
measurement of an over-budget attempt, not a budget violation: 8.11 counts only
*successful compilations* whose `compiledTokens` exceed the budget, and a render
attempt is not a compilation.

**No attempt-level token delta is reported.** `selectedBlockContentTokens`
(8.4.1) stays reachable through the nested allocation, and the render stage
deliberately does not subtract it from `renderedTokens`.

The reason is the same-tokenizer precondition of 8.6. `renderedTokens` comes from
the tokenizer injected into the renderer; `selectedBlockContentTokens` sums block
`tokenCount` values validated under whichever tokenizer ran at candidate
validation. No stage contract from `ValidatedCandidateSet` through
`OrderedCandidateSet` carries a tokenizer identity, so the render stage cannot
establish that its two operands share a unit. Subtracting them anyway would
publish the difference between two vocabularies as though it described rendering.

That is why `renderingTokenDelta` stays an orchestration metric: the component
that guarantees one tokenizer across the stages is the component that may report
it.

These are **not** 8.4, 8.6, 8.7, 8.9, or 8.10. A render attempt becomes those
final metrics only once the correction loop has settled the final selection, at
which point `renderedTokens` of the last attempt *is* `compiledTokens`.

## 8.5 Included Content Tokens

```text id="d6pedc"
includedContentTokens
  = sum of selected block content tokens
```

This excludes rendering overhead.

## 8.6 Rendering Token Delta

```text id="2lp2ux"
renderingTokenDelta
  = compiledTokens - includedContentTokens
```

This is a **signed** integer. It may be negative, zero, or positive.

Until DEC-035 this metric was named `renderingOverheadTokens` and was required to
be non-negative. That definition was wrong, and the requirement is withdrawn.

The `Tokenizer` port (ARCHITECTURE 3.3) promises one thing: the exact count of
one supplied string. It does **not** promise that tokenization is additive:

```text id="8kqf2r"
tokenizer(a + b)
  is not necessarily
tokenizer(a) + tokenizer(b)
```

A subword vocabulary can merge or split differently once content sits inside a
larger string, so embedding a block in a rendered record can move token
boundaries in either direction. The difference between the compiled total and the
sum of the individual block counts is therefore a **signed tokenization delta**,
not an isolated count of static rendering text.

Read it as a diagnostic only:

* it is **not** an additive attribution of wrapper, separator, source-label, or
  heading tokens;
* no exact token count may be attributed separately to labels, separators,
  content, or wrappers, because no such attribution exists;
* all rendering text is nevertheless part of `compiledTokens`, which is what
  INV-RENDER-004 requires;
* the only source of truth for the budget is `tokenizer(finalRenderedContext)`
  (8.4, INV-BUDGET-002).

### Validity precondition: one tokenizer identity

`renderingTokenDelta` is **defined only when `compiledTokens` and
`includedContentTokens` were measured under the same tokenizer identity and
version.**

Counts from different tokenizers are not comparable, so their difference is not a
quantity at all — it is the gap between two vocabularies wearing the units of
one. The final `ContextCompiler` must guarantee that precondition, by composing
one configured tokenizer for candidate-block validation and for final rendered
measurement alike, **before** reporting this metric.

If the tokenizer identity behind either operand cannot be proven, the metric
**must not be reported**. Omitting it is correct; reporting an unverified value
is a reporting error.

`ContextRenderer` (8.4.2) therefore publishes no attempt-level equivalent: it
receives no tokenizer identity from the earlier stages and so cannot discharge
the precondition.

## 8.7 Token Reduction

```text id="9pusjr"
tokenReduction
  = baselineInputTokens - compiledTokens
```

## 8.8 Token Reduction Ratio

```text id="y3lomn"
tokenReductionRatio
  = tokenReduction / baselineInputTokens
```

Report as a percentage.

Example:

```text id="xr06d8"
baselineInputTokens = 10,000
compiledTokens = 4,000

tokenReductionRatio = 60%
```

## 8.9 Budget Utilization

```text id="ch0bko"
budgetUtilization
  = compiledTokens / availableInputTokens
```

High utilization is not automatically better.

A valid compiler may leave budget unused when no useful candidates remain.

## 8.10 Unused Tokens

```text id="ep08vw"
unusedTokens
  = availableInputTokens - compiledTokens
```

## 8.11 Budget Violation Count

```text id="gm0htw"
budgetViolationCount
  = number of successful results where
    compiledTokens > availableInputTokens
```

Required target:

```text id="igjhlz"
budgetViolationCount = 0
```

---

## 8.12 Trace Reconciliation Totals

A `CompilationTrace` reports the totals that reconcile one traced selection
(INV-TRACE-003, DEC-037). They are **content-token totals**: every one of them
sums `ContextBlock.tokenCount` values, and no rendering count takes part.

```text id="t14rec"
candidateTokens
  = sum(block.tokenCount) across EVERY validated CandidateBlock wrapper

canonicalContentTokens
  = sum(canonicalBlock.tokenCount) across EVERY deduplicated group exactly once

duplicateCandidateTokens
  = candidateTokens - canonicalContentTokens

filteredContentTokens
  = sum(canonicalBlock.tokenCount) for groups filtered by CandidateFilter

allocationExcludedContentTokens
  = sum(canonicalBlock.tokenCount) for eligible groups excluded by BudgetAllocator

includedContentTokens
  = sum(canonicalBlock.tokenCount) for currently included groups

excludedCanonicalContentTokens
  = filteredContentTokens + allocationExcludedContentTokens
```

They reconcile exactly:

```text id="t14eqs"
candidateTokens
  = canonicalContentTokens + duplicateCandidateTokens

canonicalContentTokens
  = includedContentTokens + excludedCanonicalContentTokens
```

`candidateTokens` is 8.1 measured over wrappers, so a batch that repeats one
piece of content counts it once per wrapper. `canonicalContentTokens` counts each
group's canonical block once. The difference is therefore the cost the
deduplicator removed, and it is a **group-level difference**: no "duplicate
member" wrapper is chosen and subtracted, because repeated wrappers can be
indistinguishable and picking one would be arbitrary (DEC-031).

Because every group holds at least one validated member and its canonical block is
one of the group's own blocks, `duplicateCandidateTokens` is never negative.

The corresponding counts reconcile the same way:

```text id="t14cnt"
candidateCount
  = sum(group.members.length)

duplicateWrapperCount
  = candidateCount - deduplicatedGroupCount

eligibleGroupCount
  = includedGroupCount + allocationExcludedGroupCount

deduplicatedGroupCount
  = filteredGroupCount + eligibleGroupCount
```

All values are finite non-negative safe integers, and the arithmetic is
overflow-safe: a total that leaves the exact integer range is a structured trace
failure, never a published approximation (INV-BUDGET-005).

### These are not the final metrics whose names they resemble

A trace carries `settled`. While it is `false`, its totals describe the
**current** selection of one measured render attempt, and a later correction loop
may settle a different one.

```text id="t14sep"
trace.totals.includedContentTokens   current allocation content, NOT 8.5 of a
                                     settled selection

trace.rendering.renderedTokens       the current render attempt (8.4.2), NOT
                                     compiledTokens (8.4)

trace.settled === false              no compilation has been settled
```

The final `includedContentTokens` of 8.5, `compiledTokens` of 8.4,
`renderingTokenDelta` of 8.6, `budgetUtilization` of 8.9, and `unusedTokens` of
8.10 keep their existing definitions and remain the responsibility of the
compiler orchestration that settles a selection. Reporting an unsettled trace
total under one of those names is a reporting error.

A trace with `settled: false` must never be attached to a successful
`CompilationResult`.

---

# 9. Information Preservation Metrics

## 9.1 Required-Block Recall

```text id="wm5z78"
requiredBlockRecall
  = includedRequiredBlocks / totalRequiredBlocks
```

A compilation failure caused by impossible required content must not be counted as a successful zero-recall result.

It must be reported separately.

MVP target:

```text id="1nob03"
requiredBlockRecall >= 0.95
```

For valid budgets where all required blocks fit:

```text id="k59z6r"
requiredBlockRecall = 1.00
```

## 9.2 Relevant-Block Recall

```text id="xn23aq"
relevantBlockRecall
  = includedRelevantBlocks / totalRelevantBlocks
```

This metric is useful but less important than required-fact coverage because several blocks may contain equivalent evidence.

## 9.3 Required-Fact Coverage

```text id="tfszri"
requiredFactCoverage
  = preservedRequiredFacts / totalRequiredFacts
```

A fact is preserved when the compiled context contains sufficient evidence according to the evaluation case.

Coverage may be weighted by importance.

Suggested weights:

```text id="x1q2un"
critical = 3
major = 2
minor = 1
```

Weighted coverage:

```text id="6e746m"
weightedFactCoverage
  = sum(weights of preserved facts)
    / sum(weights of all required facts)
```

MVP target:

```text id="g6pz83"
weightedFactCoverage >= 0.95
```

Critical facts should target:

```text id="0qjyok"
criticalFactCoverage = 1.00
```

## 9.4 Evidence Redundancy

```text id="pyzwvz"
evidenceRedundancy
  = included blocks providing duplicate evidence
    / included evidence blocks
```

Lower values are generally preferred when fact coverage remains constant.

## 9.5 Provenance Coverage

```text id="3lsnzs"
provenanceCoverage
  = included blocks with valid provenance
    / all included blocks
```

Required target:

```text id="m6h9nx"
provenanceCoverage = 1.00
```

## 9.6 Irrelevant-Block Exclusion Rate

```text id="nrdq72"
irrelevantExclusionRate
  = excludedKnownIrrelevantBlocks
    / totalKnownIrrelevantBlocks
```

This metric must not be optimized at the expense of required fact coverage.

---

# 10. Deduplication Metrics

## 10.1 Exact Duplicate Removal Rate

```text id="hzndgd"
exactDuplicateRemovalRate
  = removedExactDuplicates
    / totalNonCanonicalExactDuplicates
```

Target:

```text id="f8vbu0"
exactDuplicateRemovalRate = 1.00
```

## 10.2 Duplicate False Positive Rate

```text id="0sc34x"
duplicateFalsePositiveRate
  = incorrectlyCollapsedBlocks
    / allBlocksCollapsedAsDuplicates
```

Target for exact deterministic deduplication:

```text id="wzy1ij"
duplicateFalsePositiveRate = 0
```

## 10.3 Provenance Retention After Deduplication

```text id="2f4vve"
duplicateProvenanceRetention
  = duplicate source references preserved in trace
    / all duplicate source references
```

Target:

```text id="5g4zh5"
duplicateProvenanceRetention = 1.00
```

---

# 11. Answer Quality Metrics

Answer evaluation compares model output generated from baseline context with output generated from compiled context.

Both runs must use identical:

* query;
* model;
* temperature;
* system prompt;
* output format;
* tool configuration;
* maximum output tokens.

Only the supplied context strategy may differ.

## 11.1 Exact Answer Accuracy

Use when a case has a known exact answer.

```text id="np8dly"
exactAnswerAccuracy
  = correctAnswers / totalExactAnswerCases
```

## 11.2 Required Answer Fact Coverage

```text id="hbxevq"
answerFactCoverage
  = required facts present in answer
    / required answer facts
```

## 11.3 Unsupported Claim Rate

```text id="ywh917"
unsupportedClaimRate
  = unsupported factual claims
    / all factual claims
```

## 11.4 Source Attribution Accuracy

```text id="95zjqo"
sourceAttributionAccuracy
  = correctly attributed claims
    / all attributed claims
```

Use only when the answer format requires source references.

## 11.5 Answer Quality Score

For open-ended tasks, use a versioned rubric.

Recommended dimensions:

* factual correctness;
* completeness;
* relevance;
* instruction compliance;
* source grounding.

Each dimension may be scored from 0 to 4.

```text id="rn7w0n"
0 = failed
1 = major problems
2 = partially acceptable
3 = good
4 = fully correct
```

Normalized score:

```text id="s5t0p8"
answerQualityScore
  = awardedPoints / maximumPoints
```

## 11.6 Quality Loss

```text id="gdc13x"
qualityLoss
  = baselineQualityScore - compiledQualityScore
```

Report both:

* absolute difference;
* percentage-point difference.

MVP acceptance target:

```text id="j7o4ea"
median quality loss <= 0.05
```

This means no more than 5 percentage points.

The benchmark must also report the lower-tail distribution.

Median alone must not hide severe failures.

---

# 12. Quality Evaluation Methods

## 12.1 Deterministic Rule-Based Evaluation

Preferred where possible.

Examples:

* expected phrase or value;
* JSON field comparison;
* required citation;
* source identifier validation;
* numeric tolerance;
* exact answer set.

## 12.2 Human Evaluation

Use for ambiguous or high-value cases.

The evaluator must not know which answer came from baseline or compiled context.

## 12.3 LLM-as-Judge Evaluation

May be used as a secondary signal.

Requirements:

* fixed judge model and version;
* fixed rubric;
* randomized answer order;
* no information about which system produced the answer;
* raw judge outputs stored;
* periodic comparison against human judgments.

LLM judge scores must not be the only acceptance criterion.

---

# 13. Compiler Correctness Metrics

## 13.1 Successful Compilation Rate

```text id="1lwpth"
successfulCompilationRate
  = successfulValidRequests / totalValidRequests
```

## 13.2 Expected Failure Accuracy

```text id="0in242"
expectedFailureAccuracy
  = requests returning expected error code
    / total expected-failure requests
```

## 13.3 Trace Completeness

Completeness is measured at the two levels INV-TRACE-001 defines, because the
pipeline decides groups while preserving wrappers (DEC-037).

```text id="xpkvrp"
wrapperAccountingCompleteness
  = validated wrappers appearing exactly once
    across all trace group members
    / all validated wrappers

groupDecisionCompleteness
  = deduplicated groups with exactly one disposition
    / all deduplicated groups
```

Target:

```text id="s4el8u"
wrapperAccountingCompleteness = 1.00
groupDecisionCompleteness     = 1.00
```

Invalid candidates are not in the denominator of either: a rejected batch produces
no validated set and no post-validation trace, and its failure is reported as
expected-failure accuracy (13.2) instead.

## 13.4 Decision Reason Coverage

```text id="0fnjwz"
decisionReasonCoverage
  = decisions with machine-readable reason code
    / all decisions
```

Target:

```text id="os8h8d"
decisionReasonCoverage = 1.00
```

## 13.5 Trace Reconciliation Accuracy

A trace reconciles when:

* the token totals satisfy every equation of 8.12;
* included decisions match rendered blocks;
* excluded decisions do not appear in rendered output;
* usage fields match final tokenization.

For an unsettled trace the last condition is read against the traced render
attempt rather than a settled compilation.

```text id="nmzv6a"
traceReconciliationRate
  = reconciledTraces / allSuccessfulTraces
```

Target:

```text id="uxo8f7"
traceReconciliationRate = 1.00
```

---

# 14. Determinism Metrics

## 14.1 Repeat Determinism Rate

Run the same compilation multiple times.

```text id="vqnt98"
repeatDeterminismRate
  = identicalRepeatedResults
    / totalRepeatedComparisons
```

Target:

```text id="yfcn9n"
repeatDeterminismRate = 1.00
```

## 14.2 Input Permutation Stability

Provide candidates in several different orders.

```text id="hcx4qf"
permutationStabilityRate
  = permutations producing canonical result
    / total tested permutations
```

Target:

```text id="qysx3x"
permutationStabilityRate = 1.00
```

## 14.3 Cross-Process Stability

Run selected cases in fresh processes.

The compiled result and fingerprint must remain identical.

## 14.4 Cross-Machine Stability

Recommended before release.

Differences caused by:

* operating system;
* CPU architecture;
* locale;
* filesystem ordering;

must be detected.

---

# 15. Scope and Security Metrics

## 15.1 Cross-Scope Inclusion Count

```text id="69vh6p"
crossScopeInclusionCount
  = included blocks whose scope does not satisfy request scope
```

Required target:

```text id="398b7k"
crossScopeInclusionCount = 0
```

## 15.2 Scope Violation Detection Rate

```text id="igxt8o"
scopeViolationDetectionRate
  = detected cross-scope candidates
    / total cross-scope candidates
```

Target:

```text id="lpvck2"
scopeViolationDetectionRate = 1.00
```

## 15.3 Source Instruction Escape Count

Count cases where untrusted source text changes compiler policy or execution behavior.

Target:

```text id="jw3fk6"
sourceInstructionEscapeCount = 0
```

## 15.4 Secret Exposure Count

Count sensitive values unexpectedly written into:

* traces;
* logs;
* evaluation reports;
* errors.

Target:

```text id="bpm6u3"
secretExposureCount = 0
```

---

# 16. Retrieval Metrics

Retrieval is outside the compiler kernel but must be evaluated for end-to-end scenarios.

## 16.1 Recall at K

```text id="j0x15m"
Recall@K
  = relevant blocks in top K
    / total relevant blocks
```

Initial targets:

```text id="j0ah2o"
Recall@5 >= 0.80
Recall@10 >= 0.90
```

These are initial targets and may vary by dataset.

## 16.2 Required Fact Retrieval Recall

Measures whether at least one evidence block for each required fact was retrieved.

```text id="raglo1"
requiredFactRetrievalRecall
  = required facts with retrieved evidence
    / total required facts
```

## 16.3 Mean Reciprocal Rank

```text id="oup25b"
MRR
  = average(1 / rank of first relevant result)
```

## 16.4 Retrieval Noise Ratio

```text id="j987vb"
retrievalNoiseRatio
  = irrelevant retrieved blocks
    / all retrieved blocks
```

## 16.5 Retrieval Scope Violation Count

Target:

```text id="kpoxkl"
retrievalScopeViolationCount = 0
```

Retrieval metrics must not be combined with compiler metrics into one unexplained score.

---

# 17. Performance Metrics

Performance must be measured separately for each stage.

## 17.1 Compilation Latency

Time from validated request entry to completed compilation result.

Report:

* p50;
* p95;
* p99;
* maximum;
* mean.

## 17.2 Tokenization Latency

Measure:

* candidate token validation;
* final rendering tokenization;
* cache hit and miss performance where applicable.

## 17.3 Deduplication Latency

Report by number of candidates and total content size.

## 17.4 Allocation Latency

Report by:

* candidate count;
* number of categories;
* budget size;
* required block count.

## 17.5 End-to-End Context Preparation Latency

Includes:

* candidate retrieval;
* validation;
* deduplication;
* allocation;
* rendering;
* trace persistence.

## 17.6 Model Latency

Reported separately from compiler latency.

## 17.7 Initial MVP Performance Target

On the documented reference environment:

```text id="v7j4gf"
warm compilation p95 <= 500 ms
```

For the complete local retrieval plus compilation path:

```text id="tgzj2g"
warm retrieval and compilation p95 <= 2,500 ms
```

These are engineering targets, not public service guarantees.

The reference hardware and dataset size must be reported with results.

---

# 18. Resource Metrics

Measure:

* peak resident memory;
* steady-state memory;
* CPU time per compilation;
* trace storage size;
* index size;
* average bytes per block;
* tokenization cache size.

For real retrieval providers, also measure:

* indexing duration;
* incremental update duration;
* storage growth;
* startup time.

---

# 19. Cost Metrics

When a paid model is used, report:

## 19.1 Input Token Cost

```text id="u5tl0p"
inputCost
  = inputTokens * providerInputPrice
```

## 19.2 Output Token Cost

```text id="6i43ja"
outputCost
  = outputTokens * providerOutputPrice
```

## 19.3 Total Request Cost

```text id="bz3a5v"
totalRequestCost
  = inputCost + outputCost + auxiliaryModelCost
```

## 19.4 Cost Savings

```text id="yu3p5o"
costSavings
  = baselineTotalCost - compiledTotalCost
```

## 19.5 Cost Savings Ratio

```text id="ydxat7"
costSavingsRatio
  = costSavings / baselineTotalCost
```

Provider pricing must be stored with:

* provider;
* model;
* pricing date;
* currency;
* input price;
* output price;
* cached input price where relevant.

Cost results become stale when pricing changes.

---

# 20. Aggregate Reporting

Aggregate reports must include:

* case count;
* dataset version;
* compiler version;
* policy version;
* tokenizer version;
* retrieval provider version;
* model and model version;
* judge model where applicable;
* reference hardware;
* execution date;
* configuration hash.

For ratio metrics, report:

* median;
* mean;
* p10;
* p90;
* minimum;
* maximum.

Do not report only the mean.

---

# 21. Segmented Reporting

Results must be segmented by case tags.

Recommended segments:

* source type;
* context size;
* budget pressure;
* required fact count;
* conversation versus documents;
* duplicates present;
* conflicts present;
* retrieval noise level;
* language;
* code content;
* structured Markdown;
* local source versus external source.

An overall score must not hide failure in a critical segment.

---

# 22. MVP Acceptance Gates

The MVP release candidate must satisfy all hard gates.

## 22.1 Hard Correctness Gates

```text id="rs11vx"
budget violations = 0
silent required-block removals = 0
cross-scope inclusions = 0
missing provenance for included blocks = 0
candidates missing final trace decision = 0
unexplained decisions = 0
determinism failures = 0
```

## 22.2 Information Preservation Gates

On valid cases where required content fits:

```text id="uzhh84"
required-block recall = 100%
critical fact coverage = 100%
weighted required-fact coverage >= 95%
```

## 22.3 Token Reduction Gates

Across the approved validation dataset:

```text id="dss09e"
median token reduction >= 35%
```

For cases tagged `long-context`:

```text id="1z5vby"
median token reduction >= 50%
```

## 22.4 Answer Quality Gate

```text id="h9e7hq"
median answer quality loss <= 5 percentage points
```

Additionally:

* no critical case may lose more than the approved severe-loss threshold;
* severe quality regressions must be listed individually.

Initial severe-loss threshold:

```text id="yow372"
20 percentage points
```

## 22.5 Performance Gate

On the reference environment:

```text id="97cu40"
warm compiler p95 <= 500 ms
```

Performance failures may block release when they make the product impractical, but correctness must never be weakened to pass the latency target.

---

# 23. Comparison Rules

A new compiler policy or algorithm may replace the current default only when:

1. all hard correctness gates pass;
2. required fact coverage does not decrease materially;
3. severe quality failures do not increase;
4. median token reduction improves or remains equivalent;
5. latency remains within the approved limit;
6. trace explainability is not reduced.

A change must not be accepted based on one improved aggregate metric.

---

# 24. Regression Policy

Every confirmed bug must create:

* a regression fixture;
* an invariant reference;
* the expected behavior;
* the failing behavior before the fix;
* the compiler or adapter version where it occurred.

Regression tests must remain in the repository.

A regression fixture may be updated only when the product contract or an invariant intentionally changes.

---

# 25. Benchmark Reproducibility

A benchmark run must produce a manifest.

```ts id="8l06oi"
interface BenchmarkManifest {
  runId: string;
  datasetVersion: string;
  compilerVersion: string;
  policyVersion: string;
  tokenizerId: string;
  tokenizerVersion: string;
  retrievalProvider?: string;
  modelProvider?: string;
  model?: string;
  judgeModel?: string;
  configurationHash: string;
  commitSha: string;
  runtimeVersion: string;
  operatingSystem: string;
  hardwareDescription: string;
  startedAt: string;
}
```

The repository should provide a command similar to:

```bash id="y4dqhh"
ctxalloc eval run --dataset validation
```

And produce:

```text id="vbzop9"
evaluation-results/
  run-manifest.json
  aggregate.json
  cases.jsonl
  failures.json
  report.md
```

---

# 26. Recommended Development Dashboard

The initial report should show:

```text id="1rgdik"
Core
  budget violations
  determinism
  trace completeness

Context
  token reduction
  required-block recall
  required-fact coverage
  irrelevant exclusion

Answer
  baseline quality
  compiled quality
  quality loss
  unsupported claim rate

Performance
  compiler p50
  compiler p95
  retrieval p95
  total latency

Failures
  impossible budgets
  scope violations
  missing facts
  severe quality regressions
```

A web dashboard is not required for the MVP.

A generated Markdown or HTML report is sufficient.

---

# 27. Initial Benchmark Size

The first benchmark may begin small but must be balanced.

Recommended initial development dataset:

```text id="ocrugi"
20 to 30 cases
```

Recommended first validation dataset:

```text id="ox49yw"
30 to 50 cases
```

Before claiming general product effectiveness:

```text id="wrdwf9"
at least 100 diverse validation cases
```

Case diversity matters more than producing many nearly identical examples.

---

# 28. Metric Interpretation Warnings

## 28.1 High Reduction Can Be Misleading

A 90 percent token reduction is not useful when critical fact coverage drops.

## 28.2 Full Context Is Not Always a Perfect Baseline

Large context may reduce answer quality through distraction.

CtxAlloc may sometimes outperform the full-context baseline.

Such cases must still be inspected for fairness.

## 28.3 Retrieval Failure Is Not Compiler Failure

When required evidence never reaches the compiler, classify the failure as retrieval or ingestion failure.

## 28.4 Compiler Success Is Not Answer Success

A context may contain all required facts while the model still answers incorrectly.

Report context quality and answer quality separately.

## 28.5 Model Variance Can Hide Compiler Effects

Use deterministic or low-temperature model settings where possible.

Repeat selected answer evaluations.

## 28.6 Tokenizers Differ

Results must state which tokenizer was used.

Token counts from different tokenizers must not be compared as identical measurements.

---

# 29. Release Report Requirements

Every MVP release report must include:

1. executive summary;
2. dataset description;
3. baseline definitions;
4. hard gate results;
5. token reduction distribution;
6. information preservation results;
7. answer quality results;
8. latency results;
9. failure analysis;
10. known limitations;
11. configuration and version manifest;
12. examples of successful traces;
13. examples of failed cases;
14. decision on whether the product hypothesis is supported.

The conclusion must be one of:

```text id="ys43gc"
supported
partially supported
not supported
inconclusive
```

The report must not claim success when hard correctness gates fail.

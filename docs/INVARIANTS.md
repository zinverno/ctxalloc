# System Invariants

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Document type: System invariants
* Status: Active
* Applies to: All compiler implementations, adapters, interfaces, and tests

This document defines properties that must always remain true.

An implementation that violates an invariant is incorrect, even when it appears to work in common scenarios.

Invariants take priority over convenience, performance optimizations, external library behavior, and backward compatibility with incorrect implementations.

---

## 1. Purpose

CtxAlloc compiles a larger set of candidate context blocks into a smaller context package under a strict token budget.

The system is considered correct only when it preserves the guarantees defined in this document.

Every invariant must be supported by one or more of:

* runtime validation;
* unit tests;
* property-based tests;
* integration tests;
* database constraints;
* static dependency checks;
* evaluation assertions.

An invariant must not rely only on documentation or developer discipline.

---

# 2. Budget Invariants

## INV-BUDGET-001: The Final Context Never Exceeds the Available Budget

For every successful compilation:

```text
compiledTokens <= availableInputTokens
```

Where:

```text
availableInputTokens
  = totalTokens
  - reservedOutputTokens
  - reservedSystemTokens
  - reservedToolTokens
  - reservedProtocolTokens
```

Only explicitly configured reserve fields are subtracted.

The compiler must not silently guess missing reserve values.

If the final rendered output exceeds the available budget, the compilation must not return success.

**Discharged by `ContextCompiler` (DEC-038).** It validates `compiledTokens <=
availableTokens` against the exact final rendered string before returning a
`CompilationResult`, and raises a structured failure instead of returning one
that would violate this. No earlier stage may claim it: `BudgetAllocator` proves
only the canonical block-content ceiling, and a `RenderedContextAttempt` that
does not fit is a valid measurement rather than a success.

---

## INV-BUDGET-002: The Rendered Result Is the Source of Truth

Budget validation must use the final rendered context, including:

* block contents;
* source labels;
* headings;
* separators;
* wrappers;
* metadata included in the output;
* fixed prefixes and suffixes.

The sum of precomputed block token counts is not sufficient for final validation.

The complete rendered string must be tokenized before success is returned.

**Discharged by `ContextCompiler` (DEC-038).** Every selection whose rendered
feasibility is decided — the initial attempt, every eviction prefix, the
required-only probe, and every hard-minimum base — is ordered, rendered, and
tokenized as **one complete string**. No per-block rendered cost is computed,
cached, or subtracted, because tokenization is neither additive nor monotonic
(METRICS 8.6).

---

## INV-BUDGET-003: Required Blocks Are Never Silently Removed

A block marked as required must be either:

1. included in the final context; or
2. reported as the cause of a structured compilation failure.

A required block must not be excluded to repair a token budget overrun.

**Preserved through every correction path (DEC-038).**
`optionalEvictionOrder` contains no required block, so no eviction prefix can
remove one; every hard-minimum base contains every required eligible group by
construction; and the result validation rejects a selection missing one.

---

## INV-BUDGET-004: Impossible Required Budgets Fail Explicitly

When required content exceeds the available budget, the compiler must return a structured error.

Required content includes:

* required blocks;
* required rendering overhead;
* required source labels;
* required fixed compiler text.

Expected error category:

```text
REQUIRED_CONTENT_EXCEEDS_BUDGET
```

The compiler must not return a partial result as a successful compilation.

**Both forms are now reported (DEC-038).** `BudgetAllocator` raises the
block-content form, where required `tokenCount` alone exceeds the ceiling; adding
rendering overhead can only make that worse, so it is definitive before anything
is rendered. `ContextCompiler` raises the **rendered** form: after every safe
optional eviction, it measures the exact required-only selection, and a
required-only render over the budget fails with the same issue code under the
same category. The converse never held — required content that fits the content
ceiling is not proof of rendered feasibility, which is why the rendered test
exists.

A failure of the category minimums is a **different** failure
(`rendered_hard_constraints_exceed_budget`): category minimums are policy
constraints, not required-block attributes, and calling one a required-content
failure would misdirect the caller.

---

## INV-BUDGET-005: Budget Arithmetic Uses Non-Negative Integers

All token budget values must be finite non-negative integers.

Invalid values include:

* negative numbers;
* fractional values;
* `NaN`;
* `Infinity`;
* numeric strings accepted without validation.

If reserves exceed the total budget, the request is invalid.

---

## INV-BUDGET-006: Unused Budget Is Reported Exactly

For every successful compilation:

```text
unusedTokens = availableInputTokens - compiledTokens
```

The value must not be estimated.

**Producer: `ContextCompiler` (DEC-038).** It publishes the exact difference on
`CompilationResult.usage` and on the settled trace, and verifies both against the
measured `compiledTokens` before returning.

---

# 3. Determinism Invariants

## INV-DET-001: Identical Inputs Produce Identical Outputs

Given identical:

* compilation request;
* candidates;
* policy version;
* tokenizer implementation and version;
* compiler version;
* supplied reference time;

the compiler must produce identical:

* included block identifiers;
* excluded block identifiers;
* block order;
* rendered context;
* token usage;
* decision reasons;
* request fingerprint.

---

## INV-DET-002: Compiler Decisions Do Not Depend on Runtime Ordering

Compiler output must not depend on:

* filesystem traversal order;
* database row order;
* object insertion order from adapters;
* asynchronous completion order;
* network response timing;
* process identifier;
* machine hostname.

Candidates must be normalized into a stable ordering before rules that require ordered traversal are applied.

---

## INV-DET-003: No Hidden Randomness

The compiler kernel must not use:

* `Math.random`;
* random UUID generation during decision-making;
* nondeterministic sampling;
* stochastic scoring.

Request identifiers may be generated outside the kernel.

Two deterministic identities exist, and they answer different questions
(DEC-037, DEC-038):

* the **request fingerprint** is derived from canonical request data, and from
  nothing else. It identifies the exact validated caller request value.
* the **compilation identifier** binds that request fingerprint **plus** the
  explicit composition inputs that can affect compilation: the compiler identity
  and version, the tokenizer identity and version, the renderer identity and
  version, the correction strategy and version, and the configured search bound.

A compilation identifier cannot be request-only. Identical requests compiled
under different tokenizer or compiler configuration are different deterministic
inputs, and a request-only identifier would collide across them.

Neither identity may derive from a random value, a clock, a git revision, a
hostname, a process identifier, or any other environment state. This adds
precision; it weakens no part of the no-randomness rule.

---

## INV-DET-004: Time Is Explicit Input

The compiler must not directly read the current system time for:

* recency scoring;
* expiration;
* ordering;
* filtering;
* trace decisions.

Time-dependent behavior must use a reference timestamp provided by the request or an injected deterministic clock.

---

## INV-DET-005: Tie-Breaking Is Complete

Every ordering or selection operation must define a final stable tie-breaker.

The final tie-breaker should normally be the stable block identifier.

No two blocks may remain unordered when allocation depends on their order.

---

# 4. Scope and Isolation Invariants

## INV-SCOPE-001: Every Request Has an Explicit Scope

Every compilation request must contain:

* `tenantId`;
* `workspaceId`;
* optional `projectId`.

Local execution uses explicit local values.

The absence of scope is invalid.

---

## INV-SCOPE-002: Every Candidate Belongs to a Scope

Every `ContextBlock` must contain its own scope.

Scope must not be inferred only from:

* request context;
* storage partition;
* file path;
* adapter instance.

---

## INV-SCOPE-003: Candidate Scope Must Match Request Scope

A candidate may be compiled only when it belongs to the request scope according to the active scope policy.

The default MVP rule is exact matching:

```text
candidate.tenantId == request.tenantId
candidate.workspaceId == request.workspaceId
candidate.projectId == request.projectId
```

A future hierarchical scope policy must be explicit and versioned.

---

## INV-SCOPE-004: Cross-Scope Candidates Are Rejected, Not Ignored Silently

When a candidate from another scope is provided, the system must:

* reject the request; or
* create an explicit exclusion decision.

The behavior must be defined by policy.

Silent cross-scope removal is not allowed because it can hide an upstream security failure.

---

## INV-SCOPE-005: Retrieval Adapters Must Receive Scope

Every real candidate or retrieval provider request must include scope.

An unscoped retrieval API must not be used in server mode.

For local-only adapters without native metadata filtering, physical index separation must provide equivalent isolation.

---

# 5. Provenance Invariants

## INV-PROV-001: Every Included Block Has a Source

Every included block must reference a valid `sourceDocumentId`.

A source-less block must not be included as ordinary trusted source context.

Synthetic application instructions must use a separate explicit block type.

---

## INV-PROV-002: Content Transformation Preserves Lineage

When content is normalized, chunked, trimmed, or rendered, the resulting block must preserve enough information to locate or identify its origin.

Depending on source type, this may include:

* source path;
* heading path;
* character offsets;
* line range;
* page number;
* slide number;
* message identifier;
* source content hash.

---

## INV-PROV-003: Retrieval Scores Do Not Replace Provenance

A retrieval score is metadata.

It does not qualify as evidence of source origin.

---

## INV-PROV-004: Rewritten Content Must Be Explicitly Marked

The deterministic MVP preserves extractive source wording.

If future implementations introduce summaries or generated rewrites, each transformed block must retain:

* original source references;
* transformation type;
* transformation provider;
* transformation version;
* original or recoverable evidence.

Generated text must not be presented as a verbatim source block.

---

## INV-PROV-005: Source Hashes Are Content-Derived

Content hashes must be calculated from canonical content using a documented algorithm.

Hashes must not depend on:

* absolute machine-specific paths;
* current time;
* random identifiers;
* database row IDs.

---

# 6. ContextBlock Invariants

## INV-BLOCK-001: Block Identifiers Are Stable

A block identifier must remain stable when the source content and relevant source location have not changed.

Re-indexing the same unchanged source must not generate different block identifiers.

---

## INV-BLOCK-002: Block Identifiers Are Unique Within Scope

Two active blocks in the same scope must not share an identifier unless they represent the same logical block.

Conflicting identifiers must produce an explicit error.

---

## INV-BLOCK-003: Token Count Matches Block Content

The stored `tokenCount` must match the configured tokenizer applied to the block content representation defined by policy.

A stale or incorrect token count must be detected before allocation.

The compiler may either:

* reject the candidate; or
* recompute the count and record a warning.

The selected behavior must be consistent.

---

## INV-BLOCK-004: Empty Blocks Are Not Ordinary Candidates

A block with empty or whitespace-only content must not enter ordinary allocation.

It may be rejected or excluded with an explicit reason.

---

## INV-BLOCK-005: Required Attributes Are Runtime Validated

TypeScript compile-time types are not sufficient.

Persisted or external block data must pass runtime schema validation before compilation.

---

## INV-BLOCK-006: Source Boundaries Must Be Valid

When source offsets are provided:

```text
0 <= startOffset <= endOffset <= sourceLength
```

Overlapping or reconstructed boundaries must follow the source adapter contract.

Invalid boundaries must not be silently corrected by the compiler.

---

## INV-BLOCK-007: Unicode Content Must Remain Valid

Chunking, trimming, hashing, and rendering must not create:

* lone UTF-16 surrogates;
* broken code points;
* invalid string boundaries.

Source content reconstruction tests must cover supplementary Unicode characters.

---

# 7. Deduplication Invariants

## INV-DEDUP-001: Deduplication Is Deterministic

The same duplicate group must always produce the same canonical block.

Canonical selection rules must be explicit and ordered.

---

## INV-DEDUP-002: Required Information Wins Over Optional Duplicates

When required and optional blocks contain equivalent content, the required block must become canonical unless doing so would violate a stronger provenance rule.

The required status must survive deduplication.

---

## INV-DEDUP-003: Deduplication Does Not Lose Provenance

When duplicate blocks are collapsed, the trace must record:

* the canonical block;
* duplicate block identifiers;
* source references of duplicates;
* the rule that selected the canonical block.

The system may preserve multiple provenance references on the canonical decision.

---

## INV-DEDUP-004: Near-Duplicate Logic Must Be Conservative

The MVP must not remove blocks based on semantic similarity alone.

Any near-duplicate rule must be:

* deterministic;
* explainable;
* tested against false-positive cases;
* configurable;
* disabled by default until validated.

---

## INV-DEDUP-005: Conflicting Blocks Are Not Duplicates

Blocks that discuss the same subject but contain different values must not be collapsed as duplicates.

Examples:

* old and new dates;
* different configuration values;
* contradictory requirements;
* different versions of a decision.

Conflict handling is separate from deduplication.

---

# 8. Scoring Invariants

## INV-SCORE-001: Score Components Are Visible

The trace must record all score components that affected allocation.

Possible components include:

* provider relevance;
* source priority;
* category priority;
* recency;
* required status;
* policy boost;
* penalty.

A single unexplained final score is insufficient.

---

## INV-SCORE-002: External Scores Are Untrusted Inputs

Retrieval scores must be:

* validated;
* normalized according to provider contract;
* bounded or transformed by explicit policy.

The compiler must not assume scores from different providers share the same scale.

---

## INV-SCORE-003: Required Status Is Not Just a Large Score

Required blocks are handled as a separate allocation class.

They must not be represented only by assigning an arbitrarily large numeric score.

---

## INV-SCORE-004: Invalid Scores Are Rejected

Invalid values include:

* `NaN`;
* `Infinity`;
* negative values when prohibited by the schema;
* values outside the documented provider range.

---

# 9. Allocation Invariants

## INV-ALLOC-001: Required Blocks Are Resolved Before Optional Blocks

The allocator must determine the complete required allocation before selecting optional blocks.

---

## INV-ALLOC-002: Only the Allocator Owns Final Inclusion

Retrieval providers, renderers, source adapters, and model providers must not independently decide final inclusion.

They may:

* propose candidates;
* validate format;
* render selected blocks;
* reject invalid input.

Final optional block selection belongs to the budget allocator.

A compiler kernel policy stage may establish which candidates are *eligible* for allocation before the allocator runs, and `CandidateFilter` is that stage (DEC-036). Eligibility is not selection: the filter must not choose among eligible candidates, read the token budget, evict, resolve or override required status, or decide that anything is included. It removes a candidate from consideration under a stated policy rule and records why, and everything reaching the allocator is then selected — or not — by the allocator alone.

---

## INV-ALLOC-003: Category Limits Are Enforced

When policy defines category minimums or maximums, allocation must enforce them or return a structured failure when they are impossible.

---

## INV-ALLOC-004: Allocation Cannot Mutate Source Content

The allocator selects blocks.

It does not rewrite their content.

Trimming or alternate representations require a separate explicit transformation stage and trace entry.

---

## INV-ALLOC-005: Selection Is Stable Under Equivalent Input Ordering

Reordering the input candidate array must not change the selected result.

---

## INV-ALLOC-006: Optional Blocks Are Removed in Policy Order

If final rendering exceeds the budget, optional blocks must be removed according to the documented eviction order.

The removal order must be deterministic and recorded.

---

# 10. Rendering Invariants

## INV-RENDER-001: Rendering Is Stable

The same ordered blocks and rendering policy must produce the same string.

---

## INV-RENDER-002: Rendering Preserves Block Boundaries

The rendered result must allow the system and model to distinguish one context block from another.

Separators must not be ambiguous with normal content.

---

## INV-RENDER-003: Source Labels Are Stable and Escaped

Source labels must not allow source content or metadata to break the rendering format.

Untrusted source metadata must be escaped or serialized safely.

---

## INV-RENDER-004: Rendering Overhead Is Measured

All static rendering text must be included in final token measurement.

---

## INV-RENDER-005: Rendering Does Not Hide Truncation

If any content is shortened, the output and trace must explicitly indicate that shortening occurred.

Silent string slicing is forbidden.

---

# 11. Trace Invariants

## INV-TRACE-001: Every Candidate Is Accounted For and Every Group Is Decided

No candidate may disappear between stages.

The accounting has **two levels**, because the pipeline has two units. Exact
deduplication collapses several `CandidateBlock` wrappers into one group with one
canonical block, and every policy, filtering, and allocation decision after that
point is made about the **group**, while every original wrapper is retained as
group membership and provenance evidence (DEC-031, DEC-037).

**1. Wrapper accounting.**

Every successfully validated `CandidateBlock` wrapper must appear exactly once as
a member of exactly one deduplicated trace group.

Multiplicity is part of the accounting: two byte-identical wrappers produce two
identical member records. No "representative wrapper" may be selected so that one
wrapper can be called included and the rest deduplicated. Repeated wrappers can be
observationally indistinguishable, and choosing one of them by input position
would be a determinism violation (INV-DET-002).

**2. Group disposition.**

Every deduplicated candidate group must receive exactly one current
filtering/allocation disposition for the traced selection:

* filtered;
* included;
* excluded.

For a **terminal** `CompilationResult` trace, every group must additionally carry
exactly one final included/excluded disposition, and every validated wrapper
remains accounted for through its group membership.

**Invalid candidates are not part of a post-validation trace.**

A candidate rejected as invalid never became a validated candidate.
`CandidateValidator` is all-or-nothing: when candidate validation fails, no
`ValidatedCandidateSet` exists and the post-validation compiler chain does not
run (DEC-030). Validation failures remain explicit structured validation errors. A
future `ContextCompiler` may wrap those errors in a terminal failure trace, but no
component may fabricate a post-validation trace for a batch that produced no
validated set.

---

## INV-TRACE-002: Every Decision Has a Reason Code

Human-readable text may be included, but machine-readable reason codes are required.

Example reason codes:

```text
INCLUDED_REQUIRED
INCLUDED_HIGH_PRIORITY
INCLUDED_CATEGORY_MINIMUM
EXCLUDED_DUPLICATE
EXCLUDED_SCOPE_MISMATCH
EXCLUDED_LOW_PRIORITY
EXCLUDED_BUDGET_EXHAUSTED
REJECTED_INVALID_TOKEN_COUNT
```

---

## INV-TRACE-003: Trace Token Totals Reconcile

The earlier formula subtracted rejected candidates from a successful trace and
ignored deduplication entirely, so it could not reconcile the implemented
pipeline: `candidateTokens` is defined over **all validated candidate wrappers**
(METRICS 8.1), exact deduplication collapses several wrappers to one canonical
group, allocation works on one canonical block per group, and invalid candidates
are not part of a successful post-validation trace at all. It is corrected here
(DEC-037).

A successful trace must satisfy:

```text
candidateTokens
  = canonicalContentTokens
  + duplicateCandidateTokens

canonicalContentTokens
  = includedContentTokens
  + excludedCanonicalContentTokens

excludedCanonicalContentTokens
  = filteredContentTokens
  + allocationExcludedContentTokens
```

Definitions (METRICS 8.12):

```text
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
```

Every group holds at least one validated member and its canonical block is one of
the group's own validated blocks, so `duplicateCandidateTokens` is never negative.
It is a **group-level difference**, never a chosen "duplicate member" wrapper
subtracted by identity: selecting one among indistinguishable wrappers would be
arbitrary.

All counts and totals must be finite non-negative safe integers, and the
arithmetic must be overflow-safe. A total that leaves the exact integer range is a
structured failure, never a published approximation (INV-BUDGET-005).

Rendering counts do not participate. `renderedTokens` measures a string and is
reported separately; `renderingTokenDelta` remains defined against a settled
`compiledTokens` (METRICS 8.6) and is unchanged.

For an **unsettled** trace these are current-selection reconciliation totals, not
final `CompilationResult` metrics: a later correction may settle a different
selection.

A **settled** trace carries these unchanged — they still describe the initial
selection — plus a separate set of final usage values under `settlement`, which
equal `CompilationResult.usage` exactly (METRICS 8.12.1, DEC-038). Keeping both
is what lets an auditor read what the allocator chose beside what the correction
settled; collapsing them would destroy that comparison.

---

## INV-TRACE-004: Trace Matches the Returned Context

Every rendered source block must correspond to an included trace decision.

Every included trace decision must appear in the rendered output unless policy explicitly marks it as non-rendering metadata.

For an **unsettled** trace the rule applies to the attempt that was traced: every
block in the current rendered attempt corresponds to a group whose
`currentDisposition` is included, and every currently included group appears in
that attempt.

For a **settled** trace the same rule applies additionally to the settlement and
the returned result (DEC-038): every block in `CompilationResult.compiledContext`
corresponds to a settlement decision whose disposition is included; every such
decision appears in that string; `settlement.ordering.orderedBlockIds` equals
`CompilationResult.includedBlocks` in order; and the final render positions cover
`0 ... n - 1` exactly once. The unsettled rule still holds over the initial
attempt the same trace records, so the two selections are both reconcilable and
distinguishable.

The current rendering policy defines no non-rendering metadata, so the exception
above has no instance today and none may be invented for one.

---

## INV-TRACE-005: Trace Contains Version Information

Every trace must contain:

* compiler version;
* policy identifier and version;
* tokenizer identifier and version;
* schema version;
* renderer identifier and version.

**Recorded identities must state their provenance coverage.**

When token quantities in one trace originate at different compiler boundaries,
the trace must state the provenance coverage of the recorded tokenizer identity.
A tokenizer identity observed only at rendering must not be presented as though
it also explains content token counts.

This adds a requirement; it removes none. The identifier and version are still
mandatory. What is forbidden is publishing them bare beside quantities they were
never proven to produce, which would let a reader of a persisted record infer an
attribution the compiler never established (DEC-035, DEC-037).

---

## INV-TRACE-006: Trace Generation Cannot Change Decisions

Trace collection is observational.

Enabling or disabling persistence or telemetry must not alter compiler output.

---

# 12. Adapter Invariants

## INV-ADAPTER-001: Adapters Do Not Leak External Types Into the Kernel

Port methods must use CtxAlloc domain types.

The compiler kernel must not import types from:

* QMD;
* Qdrant;
* SQLite libraries;
* model SDKs;
* Obsidian;
* HTTP frameworks.

---

## INV-ADAPTER-002: Adapters Preserve Stable Identifiers

An adapter must not replace project block identifiers with provider-specific identifiers.

Provider identifiers may be stored as additional metadata.

---

## INV-ADAPTER-003: Adapter Failure Is Explicit

An adapter must not return an empty successful result when the underlying system failed.

The distinction between:

* no matching candidates;
* provider unavailable;
* timeout;
* invalid provider response;

must be preserved.

---

## INV-ADAPTER-004: Optional Adapters Cannot Corrupt Core State

A failed external integration must not:

* partially mutate a compilation request;
* leave invalid persisted compiler traces;
* mark incomplete indexing as complete;
* remove valid existing source data.

---

## INV-ADAPTER-005: Adapter Behavior Is Contract-Tested

Every implementation of the same port must pass a shared contract test suite.

---

# 13. Persistence Invariants

## INV-STORE-001: Original Sources Remain the Content Authority

For local Markdown and Obsidian sources, the original files are the source of truth.

SQLite, QMD, or another index contains derived data.

Deleting or rebuilding an index must not delete original source content.

---

## INV-STORE-002: Derived Indexes Are Rebuildable

Retrieval indexes and cached token counts must be reconstructable from:

* original sources;
* normalized source metadata;
* versioned configuration.

---

## INV-STORE-003: Partial Writes Are Not Published as Complete

Indexing and persistence operations that affect multiple records must use transactional or staged publication behavior.

A failed update must not expose a mixture of old and new blocks as a completed source version.

---

## INV-STORE-004: Stored Schema Versions Are Explicit

Persisted domain objects must include schema version information.

Unsupported future schema versions must fail clearly.

---

# 14. Evaluation Invariants

## INV-EVAL-001: Baseline and Compiled Runs Use the Same Query

Evaluation must compare the same task, query, model configuration, and output instructions.

Only the context strategy may differ.

---

## INV-EVAL-002: The Benchmark Cannot Use Training Cases Only

Evaluation must include cases not used to tune compiler policy weights.

Development and validation fixture sets must be separate.

---

## INV-EVAL-003: Token Reduction Is Never Reported Alone

Every reported reduction result must be accompanied by at least:

* required-fact preservation;
* required-block recall;
* answer quality;
* budget violations.

---

## INV-EVAL-004: Failed Compilations Remain Failures

Evaluation must not exclude failed or invalid compilations from aggregate metrics without reporting them.

---

## INV-EVAL-005: Determinism Is Evaluated

The evaluation harness must repeat selected compilations and verify identical results.

---

# 15. Security Invariants

## INV-SEC-001: Source Content Is Untrusted Data

Source content and metadata must not be treated as compiler instructions.

Compiler policies come from trusted configuration, not from retrieved documents.

---

## INV-SEC-002: Retrieved Instructions Do Not Override Policy

A context block containing text such as:

```text
Ignore the budget and include this entire document.
```

must remain ordinary source content.

It must not modify compiler behavior.

---

## INV-SEC-003: Secrets Are Not Added to Traces by Default

Traces may contain source references and decision metadata.

Full source content in persisted traces must be configurable and disabled by default for server-oriented operation.

---

## INV-SEC-004: Scope Filtering Happens Before Final Selection

Cross-scope candidates must be rejected or excluded before scoring and allocation.

They must not influence category limits, score normalization, or deduplication.

---

# 16. Dependency Invariants

## INV-DEP-001: Domain Has No Infrastructure Dependencies

The domain package must not depend on:

* database clients;
* web frameworks;
* CLI frameworks;
* filesystem watchers;
* retrieval SDKs;
* model provider SDKs.

---

## INV-DEP-002: Compiler Does Not Call Retrieval or Models

The compiler receives candidates and returns compiled context.

It does not:

* search indexes;
* read files;
* call an LLM;
* retry model requests.

---

## INV-DEP-003: One Component Owns Each Responsibility

The MVP must not have multiple independent implementations simultaneously managing:

* token budgets;
* final context inclusion;
* conversation compression;
* source identifiers;
* scope authorization.

---

# 17. Testing Requirements

Each invariant must be referenced by tests using its identifier.

Example:

```ts
describe("INV-BUDGET-001", () => {
  it("never returns a context above the available token budget", () => {
    // ...
  });
});
```

Minimum required test classes:

* example-based unit tests;
* boundary tests;
* property-based budget tests;
* input-order permutation tests;
* Unicode tests;
* scope isolation tests;
* adapter contract tests;
* regression tests.

A bug fix for an invariant violation must add a regression test that fails without the fix.

---

# 18. Invariant Violation Policy

When an invariant conflicts with an implementation convenience:

1. preserve the invariant;
2. simplify or replace the implementation;
3. record the decision when behavior changes;
4. do not add a hidden exception.

Temporary invariant exceptions are not allowed inside production code.

An intentionally revised invariant requires:

* an architectural decision record;
* updated tests;
* updated documentation;
* a migration plan when persisted data is affected.

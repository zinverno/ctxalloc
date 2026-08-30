# MVP Scope

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Document type: MVP scope
* Status: Active
* Applies to: First validated product release

This document defines the implementation boundary of the MVP.

Anything not explicitly included is considered out of scope unless the scope is intentionally updated.

---

## 1. MVP Objective

The MVP must validate one core hypothesis:

> A deterministic context compiler can reduce the number of input tokens sent to an LLM while preserving required facts and maintaining acceptable answer quality.

The MVP is not intended to validate every future product capability.

It must validate the compiler before the project invests in:

* scalable retrieval infrastructure;
* long-term memory;
* multi-provider routing;
* enterprise authentication;
* billing;
* a complete SaaS platform.

---

## 2. MVP Vertical Slice

The first complete vertical slice is:

```text
Markdown or conversation source
        |
        v
Normalized ContextBlock records
        |
        v
Candidate provider
        |
        v
Validation and deterministic deduplication
        |
        v
Token budget allocation
        |
        v
Context compilation
        |
        v
Compilation trace
        |
        v
Optional single LLM request
        |
        v
Evaluation against baseline
```

The vertical slice must work before optional document formats, external retrieval systems, or user interfaces are added.

---

## 3. Included Capabilities

### 3.1 Core Domain Model

The MVP includes stable schemas for:

* Scope;
* SourceDocument;
* SourceLocation;
* ContextBlock;
* CandidateBlock;
* CompilationRequest;
* CompilationPolicy;
* CompilationResult;
* IncludedBlockDecision;
* ExcludedBlockDecision;
* CompilationTrace;
* TokenUsage;
* EvaluationCase;
* EvaluationResult.

Schemas must be runtime validated.

Recommended implementation:

* TypeScript types;
* Zod schemas;
* schema version fields where persistence is involved.

---

### 3.2 Token Counting

The MVP includes:

* a Tokenizer interface;
* one real tokenizer implementation;
* one deterministic fake tokenizer for tests;
* per-block token counts;
* total candidate token count;
* compiled token count;
* reserved token budget;
* remaining token budget;
* hard rejection of impossible budget configurations.

Token counting must be performed before final compilation.

Character count must not be used as the primary production token count when a real tokenizer is available.

---

### 3.3 Candidate Validation

The MVP validates:

* block identifiers;
* source identifiers;
* scope;
* token count;
* content;
* content hash;
* source location;
* required metadata;
* duplicated identifiers;
* invalid priorities.

Candidates arrive as `CandidateBlock` wrappers, and source references are
validated against an explicit `SourceDocument` registry supplied with the batch.
A block's source is proven by membership in that registry and by nothing else:
not by a path, not by metadata, not by the adapter that produced it, and not by
array position. Source document identifiers must be unique inside the registry,
and every referenced document must agree with the block on both scope and source
type. A duplicated identifier resolves to no record at all, so no duplicate
becomes authoritative and the reported issues cannot depend on registry order.

A block's `sourceLocation` kind must also be compatible with its own source type:
`markdown` and `text` blocks are located by a character range, `conversation`
blocks by a message. An absent source location remains valid.

Token counts and normalized content hashes are recomputed and compared exactly; a
mismatch is a rejection, not a repair.

Impossible required-block budgets are **not** validated here. That decision
depends on the complete required allocation and its rendering overhead, so it
belongs to token budget allocation (section 3.6) and to INV-BUDGET-004.

Invalid candidates must produce explicit errors or trace entries. In the
implemented phase, an invalid batch fails explicitly and in full: any problem
rejects the whole batch, and no candidate is silently removed or repaired. A
schema failure reports the schema issues alone; once the schema passes, every
cross-record problem is collected before failing. Translating such issues into
rejected-candidate trace decisions belongs to the trace phase.

See DEC-030.

---

### 3.4 Deterministic Deduplication

Deterministic exact deduplication by block identifier and by content is
implemented. `CandidateDeduplicator` consumes a `ValidatedCandidateSet` and
returns groups of exact duplicates, each with one canonical block.

Two candidates are duplicates when the canonical normalized form of their content
is exactly equal. Correctness rests on that text, not on the hash alone: the
validated `normalizedContentHash` only selects a bucket, and membership is
decided by comparing the normalized strings, so no duplicate decision depends on
digest collision resistance. Line endings are the only difference the rule
ignores, so an LF copy and a CRLF copy of one text are duplicates while trailing
spaces, blank-line runs, indentation, letter case, punctuation, and Unicode
composition remain significant.

Canonical selection uses two ordered rules: a required block wins over optional
duplicates, and the lexicographically smallest block identifier breaks the
remaining tie. The canonical block is always one of the group's own records,
carried unchanged, so required status survives without any block being mutated,
merged, or synthesized.

Deduplication preserves evidence. Every candidate wrapper survives inside exactly
one group, including repeated identifiers, wrappers from different providers,
differing ranks and provider scores, wrappers with no retrieval data, and
duplicates from different source documents. No retrieval record is merged and no
score is compared, normalized, or selected. Group order, member order, and the
returned source registry order are stable and independent of input order.

Embedding-based deduplication is not required for the first core implementation.
Near-duplicate rules are absent rather than disabled: no similarity threshold,
edit distance, stemming, containment, or heading heuristic exists, and no
configuration flag is offered for a capability that is not implemented.

Policy filtering is separate and remains future work: it requires a versioned
`CompilationPolicy`, so no candidate is excluded here for its category, source,
timestamp, authored priority, retrieval score or rank, provider, relevance,
freshness, or size.

Further canonical selection rules remain possible once policy exists:

1. required block over optional block — implemented;
2. higher source priority — requires `CompilationPolicy`;
3. newer source — requires an explicit recency policy and reference time;
4. more complete provenance — requires policy;
5. stable lexical identifier tie-break — implemented.

See DEC-031.

---

### 3.5 Deterministic Candidate Scoring

Deterministic candidate scoring is implemented. `CandidateScorer` consumes a
`DeduplicatedCandidateSet` and an explicit reference time, and returns a
`ScoredCandidateSet` in which every deduplicated group carries one transparent
`CandidateScore`.

Scoring is driven by one narrow versioned `CandidateScoringPolicy`, not by the
broad future `CompilationPolicy`. It carries a schema version, a policy identity
and version, and five optional components: retrieval relevance, authored
priority, source priority, category priority, and recency. A policy that
configures none of them is valid and gives every candidate a total of exactly
zero.

Policy validation is strict and is a runtime boundary, because a policy is
external configuration. Unknown fields are rejected rather than stripped, nothing
is coerced, no default is injected, exact strings are preserved, and duplicate
rule identifiers, duplicate provider contracts, duplicate source entries, and
duplicate category entries are all rejected rather than resolved by array order.
Lookups are compiled only after validation, so the order in which the policy
declares its rules cannot change a result.

**Raw provider scores are never compared across contracts.** A retrieval score
affects scoring only when the policy owns an exact rule for the tuple
`providerId`, `providerVersion`, `semantics`, `higherIsBetter`, together with a
fixed inclusive range. Ranges are policy input and are never inferred from the
provider, from a rank, or from the values present in the current batch: a
batch-relative range would make one candidate's score depend on which unrelated
candidates happened to be retrieved. A value outside its declared range rejects
rather than clamps, and a scored record with no exact rule rejects rather than
being read as zero or silently dropped. A retrieval record carrying no score is
valid and contributes no relevance; rank alone and provider identity alone are
never treated as relevance.

Every enabled component publishes a normalized value in `[0, 1]`, the policy
weight, the contribution (normalized value times weight), its aggregation rule,
and explicit evidence explaining the calculation. Authored priority is normalized
over the policy's inclusive safe-integer range, and an out-of-range value
rejects. Source priority uses exact source document rules with an explicit
default, and never reads source metadata or source type. Category priority uses
exact string rules with an explicit default, and applies no case folding,
trimming, prefix matching, or hierarchy. Recency uses `updatedAt ?? createdAt`
against the supplied reference time, with an explicit missing value when a block
carries neither timestamp and age clamped to zero for a future one.

**Duplicate evidence cannot inflate a score.** Every component aggregates its
group by maximum — over normalized retrieval evidence, and over the distinct
blocks of the group for the other four. Nothing is summed, averaged, or counted,
and no wrapper is preferred for being canonical, lowest-ranked, or from a
particular provider. The same content wrapped twenty times scores exactly as it
does wrapped once, and all evidence stays visible.

The total is the arithmetic sum of the present contributions in one fixed
component order. Weights need not sum to one, so a total is a policy-relative
utility rather than a probability, and is comparable only within one run of one
policy identity and version. A non-finite contribution or total rejects the
batch.

**Required status is not a score.** There is no required component, no boost, and
no large constant: required blocks stay a separate allocation class that the
allocator resolves first, and a required candidate may legitimately score zero
while an optional one scores higher.

The result is ranked by total descending, then by the stable block identifier
compared by code unit. Required status does not change that order.

**No candidate is filtered and nothing is allocated.** Every deduplicated
candidate appears exactly once in the result unless scoring fails as a whole, and
no minimum score threshold exists. No token budget is read, no token cost is
subtracted from a score, no score-per-token is computed, and no inclusion,
exclusion, or eviction decision is made.

The stage reads no clock, calls no tokenizer, retrieval provider, or model, and
implements no lexical, BM25, embedding, or LLM relevance scorer of its own: query
relevance arrives through `CandidateRetrieval` under an explicit provider
contract. No redundancy or near-duplicate score exists.

Policy filtering remains future work and requires the broader versioned
`CompilationPolicy`.

See DEC-032.

---

### 3.6 Token Budget Allocation

Deterministic budget allocation is implemented. `BudgetAllocator` consumes a
`ScoredCandidateSet`, an explicit `TokenBudget`, and one narrow versioned
`BudgetAllocationPolicy`, and returns an `AllocatedCandidateSet` in which every
scored candidate carries exactly one machine-readable allocation decision.

**This stage enforces the canonical block-content budget, not the final rendered
budget.** It proves `sum(included canonicalBlock.tokenCount) <=
availableInputTokens` exactly, and makes no claim about `compiledTokens`.
Rendering overhead — source labels, headings, separators, wrappers, emitted
metadata, fixed prefixes and suffixes — is **not** measured by the allocator,
because `ContextRenderer` does not exist yet. Its two published metrics,
`selectedBlockContentTokens` and `unallocatedBlockContentTokens`, are provisional
block-content values rather than final compiled tokens and unused tokens, and no
hidden rendering reserve is added to compensate. A final hard-budget guarantee
arrives with the renderer and its render/evict/re-render loop, which will consume
the deterministic eviction order this stage precomputes.

The budget is validated with the existing `TokenBudget` contract and its ceiling
comes from the existing `availableInputTokens()` helper. The model context window
is never guessed and no reserve is defaulted or injected.

Policy validation is strict and is a runtime boundary, because a policy is
external configuration. Unknown fields are rejected rather than stripped, nothing
is coerced, no default is injected, exact strings are preserved, a constraint must
declare at least one bound with `minBlocks <= maxBlocks`, and two constraints
owning the same exact category are rejected rather than resolved by array order.

**Category minimums and maximums are block counts in schema version 1.** They are
spelled `minBlocks` and `maxBlocks` and mean at least or at most that many
independently selectable canonical blocks of one exact category. They are not
token quotas, percentage shares, or byte quotas; a token-share quota remains
possible in a later policy schema version. A category is the canonical block's own
`attributes.category`, matched by exact string equality with no case folding,
trimming, prefix matching, or hierarchy, and an absent category is unconstrained.
Duplicate members are provenance, never additional selectable blocks.

**Required blocks are a separate allocation class.** They are resolved before
every optional block, in stable block-identifier order, and are never boosted by a
score, never silently removed, and never evictable. They count toward both
category bounds and consume block-content budget. Required block content that
alone exceeds the available ceiling fails with a structured error, because
rendering overhead could only make it worse; required content over a category
maximum fails the same way rather than relaxing the maximum.

**Category minimums use the minimum-content-cost selection.** Required blocks
count toward a minimum, so only the shortfall is reserved from optional
candidates, chosen by token count ascending, then score descending, then block
identifier. Taking the cheapest blocks that reach the count minimizes the content
cost of satisfying it, and categories are disjoint, so the union is minimum cost
overall: when it does not fit, the failure is a real block-content infeasibility
rather than an artifact of traversal order.

**Optional selection is `score-desc-greedy`.** Remaining candidates are
considered by score descending, then block identifier ascending. A category
maximum is checked before the budget, so a blocked candidate spends nothing, and a
candidate that does not fit is skipped rather than ending the traversal. No score
is divided by a token count, no token cost is subtracted from a score, and no
knapsack, dynamic programming, integer programming, or total-utility optimization
is performed.

Every candidate leaves with one of `INCLUDED_REQUIRED`,
`INCLUDED_CATEGORY_MINIMUM`, `INCLUDED_SCORE_ORDER`, `EXCLUDED_CATEGORY_MAXIMUM`,
or `EXCLUDED_BUDGET_EXHAUSTED`, together with its exact content tokens and budget
transition. The included order is allocation chronology, not render order.

A deterministic optional eviction order is precomputed for the future
render-correction loop: required blocks never appear, and a block enters the order
only when removing it would keep its category at or above its minimum, so every
prefix is safe to remove from the current selection.

That order is a safe removal order, **not** a proof of rendered infeasibility.
Exhausting it shows only that no more currently selected optional surplus can be
removed under the current hard constraints. Because hard minimums are satisfied at
minimum block-content cost while the rendered budget counts per-block overhead
that may differ between blocks, a protected block may render more expensively than
an unselected candidate of the same category. Future orchestration must therefore
be able to reconsider those hard-minimum choices against actual rendered cost, or
otherwise prove no allocation fits, before failing (DEC-033).

Failures are structured and all-or-nothing, and no partial result is ever
returned. Ordering, rendering, final rendered token validation, trace generation,
and compiler orchestration remain later phases.

See DEC-033.

---

### 3.7 Context Compilation

The MVP compiler must:

* receive validated candidate blocks;
* apply scope filtering;
* apply policy filtering;
* remove duplicates;
* allocate the token budget;
* order included blocks;
* render compiled context;
* produce a complete trace;
* return warnings and errors.

The compiler must not call an LLM.

Implemented so far: candidate reception and validation with scope filtering
(section 3.4), duplicate removal (section 3.4), scoring (section 3.5), token
budget allocation over canonical block content (section 3.6), and **stable
ordering of the included blocks** (below).

Policy filtering, rendering, final rendered-token validation, the
render/evict/re-render correction, trace generation, and the compiler
orchestration that joins these stages remain future work.

**Stable ordering is implemented.** `ContextOrderer` consumes an
`AllocatedCandidateSet` and one narrow versioned `ContextOrderingPolicy`, and
returns an `OrderedCandidateSet` whose `orderedIncluded` is the render order of
the current selection.

It changes no decision. The ordered sequence holds exactly the included decision
objects the allocator produced, by reference, permuted: every one appears once,
no excluded decision appears, and no reason changes. Nothing is rendered,
tokenized, or measured.

Schema version 1 orders by source document, then by position inside that source,
then by the stable block identifier. Text and Markdown blocks follow their
character offsets; conversation blocks follow `messageIndex`, with `messageId`
only as a deterministic code-unit fallback that is never parsed for an embedded
time or sequence number; a block with no source location is placed after the
located blocks of its own source and ordered by identifier alone, because
position is never guessed.

Score, required status, allocation reason, and category do **not** order. A
high-scoring or required block renders late when its source position is late.
Allocation chronology, the score ranking, and the optional eviction order are
three different sequences, and none of them is render order.

See DEC-034.

---

### 3.8 Compilation Trace

The trace must contain:

* compiler version;
* policy version;
* tokenizer identifier;
* request scope;
* original token count;
* available token budget;
* compiled token count;
* unused token budget;
* included blocks;
* excluded blocks;
* decision reasons;
* source references;
* warnings;
* errors;
* deterministic request fingerprint.

The trace must be serializable as JSON.

---

### 3.9 Core Test Providers

The MVP includes:

* FakeCandidateProvider;
* FakeTokenizer;
* FakeModelProvider;
* InMemoryControlStore.

These implementations allow the complete compiler and evaluation suite to run without external infrastructure.

---

### 3.10 First Supported Sources

The MVP supports:

* Markdown documents;
* plain text documents;
* conversation messages.

Obsidian is treated as a Markdown source with additional metadata.

Initial Obsidian metadata may include:

* vault identifier;
* relative file path;
* heading path;
* tags;
* frontmatter;
* source offsets;
* modified timestamp.

The MVP does not require a full graphical Obsidian plugin.

A CLI or local service integration is sufficient.

---

### 3.11 Markdown Chunking

The MVP includes the existing project-owned Markdown chunker or its extracted reusable implementation.

It must preserve:

* Unicode correctness;
* source boundaries;
* heading hierarchy;
* fenced code blocks;
* tables where practical;
* source reconstruction properties;
* stable block identifiers;
* content hashes.

Chunking must remain independent from the retrieval backend.

---

### 3.12 Candidate Retrieval

The compiler core must initially work without a real retrieval backend.

The first implementation sequence is:

1. static benchmark fixtures;
2. FakeCandidateProvider;
3. technical spike for real retrieval;
4. one selected real retrieval provider.

Candidate real providers include:

* a small project-owned SQLite FTS5 implementation;
* QMD;
* another local retrieval system that passes the adapter contract.

QMD is a candidate, not a required dependency.

The MVP must not integrate both QMD and Qdrant.

---

### 3.13 Single Model Provider

The MVP may include one model provider for end-to-end evaluation.

The model provider is outside the compiler kernel.

Requirements:

* one configured provider;
* one configured model;
* structured token usage capture when available;
* request and response latency;
* provider failure handling;
* no automatic model routing.

The compiler must remain fully testable without the provider.

---

### 3.14 Evaluation Harness

The MVP includes an evaluation harness that compares:

* full-context baseline;
* compiled-context result.

Each evaluation case may define:

* query;
* candidate blocks;
* required facts;
* required blocks;
* irrelevant blocks;
* budget;
* expected exclusions;
* answer evaluation criteria.

The harness must measure:

* original tokens;
* compiled tokens;
* token reduction;
* required-block recall;
* required-fact preservation;
* answer quality;
* compilation latency;
* total request latency;
* budget violations;
* determinism failures.

---

### 3.15 CLI

The MVP includes a minimal CLI for development and validation.

Required commands:

```text
ctxalloc compile
ctxalloc trace
ctxalloc eval
ctxalloc inspect-blocks
ctxalloc version
```

Optional commands after the core works:

```text
ctxalloc source add
ctxalloc index
ctxalloc search
```

The CLI is not required to provide a polished interactive interface.

---

### 3.16 Minimal HTTP API

The MVP may expose:

```text
POST /v1/context/compile
POST /v1/evaluations/run
GET  /v1/traces/:id
GET  /health
GET  /ready
```

The API must call the same application services used by the CLI.

Business logic must not be implemented inside HTTP route handlers.

---

### 3.17 Local Persistence

SQLite may be used for:

* compiler traces;
* source records;
* evaluation runs;
* configuration metadata;
* indexing state.

The compiler domain must not import SQLite-specific code.

Filesystem storage may be used for:

* fixtures;
* cached normalized documents;
* generated reports.

---

## 4. Explicitly Excluded From the MVP

The following capabilities are out of scope.

### 4.1 Retrieval Infrastructure

* Qdrant production integration;
* distributed vector search;
* retrieval clusters;
* multiple simultaneous retrieval backends;
* large-scale vector migrations;
* cross-region retrieval.

### 4.2 Memory Systems

* autonomous memory extraction;
* user profile generation;
* episodic memory lifecycle;
* contradiction resolution;
* memory consolidation;
* LLM-generated long-term memory;
* Mem0, Zep, Letta, or ContextOS integration.

Conversation messages may be passed as ordinary candidate blocks.

### 4.3 Generative Compression

* LLM summarization of documents;
* LLM summarization of conversation history;
* query expansion through an LLM;
* generative rewriting of source blocks;
* semantic compression through a secondary LLM.

These features may be evaluated after the deterministic baseline exists.

### 4.4 Model Gateway Features

* OpenAI-compatible proxy;
* automatic provider selection;
* model fallback routing;
* load balancing;
* prompt caching orchestration;
* provider billing aggregation;
* multiple provider adapters.

### 4.5 Tool Management

* tool pruning;
* tool namespaces;
* tool permission routing;
* MCP toolkit loading;
* agent execution loop management.

### 4.6 Full Document Conversion

The first vertical slice does not require:

* PDF;
* DOCX;
* PPTX;
* XLSX;
* OCR;
* image understanding;
* audio transcription.

MarkItDown may be added only after the Markdown vertical slice passes its acceptance criteria.

### 4.7 SaaS Platform

* user registration;
* organization management;
* OAuth;
* role-based access control UI;
* billing;
* subscriptions;
* quotas;
* production multi-tenancy;
* admin dashboard;
* Kubernetes;
* horizontal autoscaling.

The domain schemas must still include Scope from the beginning.

### 4.8 Polished User Interfaces

* full web dashboard;
* polished desktop application;
* marketplace integrations;
* advanced Obsidian UI;
* visual context graph.

A development report or basic trace viewer is sufficient.

---

## 5. External Dependency Policy

The MVP may use external libraries for narrow technical functions.

Examples:

* schema validation;
* tokenization;
* SQLite access;
* HTTP server;
* command-line parsing;
* test execution.

A larger external system may be integrated only after a technical spike proves:

1. it accepts the project domain model through a small adapter;
2. it does not control the compiler budget;
3. it does not replace project-owned identifiers;
4. it supports incremental updates;
5. it supports explicit scope filters or can be safely isolated;
6. it returns sufficient source metadata;
7. it can be replaced without changing the kernel;
8. the adapter does not require generated shadow files or extensive synchronization code.

A failed spike must result in rejection of the dependency, not in a permanent workaround.

---

## 6. MVP Deliverables

The completed MVP repository must contain:

```text
docs/
  PRODUCT_CONTRACT.md
  MVP_SCOPE.md
  ARCHITECTURE.md
  INVARIANTS.md
  METRICS.md
  DECISIONS.md

packages/
  domain/
  compiler/
  application/
  tokenization/
  evaluation/
  ports/
  testing/

apps/
  cli/
  api/

tests/
  fixtures/
  integration/
  regression/
```

Final structure may vary, but domain and infrastructure boundaries must remain explicit.

---

## 7. Acceptance Criteria

The MVP is accepted only when all criteria are satisfied.

### 7.1 Compiler Correctness

* zero token budget overruns;
* zero silent required-block removals;
* deterministic result for identical inputs;
* valid source reference for every included block;
* trace reason for every candidate decision.

### 7.2 Testability

* the compiler test suite runs without network access;
* no real LLM is required for core tests;
* no retrieval service is required for core tests;
* property or randomized tests cover budget boundaries;
* regression fixtures cover previous failures.

### 7.3 Product Validation

On the approved evaluation dataset:

* median context reduction is at least 35 percent;
* target reduction on long-context cases is at least 50 percent;
* required-block recall is at least 95 percent;
* answer quality loss is no more than 5 percentage points;
* budget violations equal zero.

Initial thresholds may be revised only through the decision log after examining real benchmark evidence.

### 7.4 Integration

* Markdown source works end to end;
* conversation source works end to end;
* one CLI compilation workflow works;
* one HTTP compilation workflow works;
* one optional LLM evaluation workflow works;
* one real retrieval provider is either integrated cleanly or explicitly rejected after a documented spike.

### 7.5 Documentation

* setup instructions work from a clean environment;
* architecture boundaries are documented;
* known limitations are documented;
* benchmark methodology is documented;
* unsupported capabilities are clearly listed.

---

## 8. Development Order

The implementation order is:

1. documentation and invariants;
2. domain schemas;
3. fake providers;
4. token counting;
5. validation;
6. deduplication;
7. budget allocation;
8. context compilation;
9. trace generation;
10. evaluation fixtures;
11. Markdown integration;
12. CLI;
13. optional LLM evaluation;
14. retrieval technical spike;
15. one real retrieval adapter;
16. HTTP API;
17. local persistence;
18. Docker or VPS staging.

A later item must not be implemented to compensate for an unfinished earlier item.

---

## 9. Scope Change Rule

A new feature may enter the MVP only when it is required to validate the core product hypothesis.

A feature is not sufficient justification by itself because it is:

* useful later;
* common in competing products;
* technically interesting;
* easy for an AI coding agent to generate;
* expected in a future SaaS product.

Every scope addition must identify:

* which MVP hypothesis it validates;
* which acceptance criterion requires it;
* its implementation and maintenance cost;
* which current work will be delayed.

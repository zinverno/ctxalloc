# Architecture Decision Log

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Document type: Architecture decision log
* Status: Active
* Applies to: MVP architecture and development process

This document records accepted, rejected, deferred, and superseded decisions.

Its purpose is to prevent repeated debates, hidden architectural drift, and accidental reintroduction of previously rejected approaches.

Implementation details may evolve, but changes to accepted decisions must be documented.

---

# 1. Decision Statuses

Each decision uses one of the following statuses.

## Proposed

The decision is under consideration and must not yet be treated as an implementation requirement.

## Accepted

The decision is active and must guide implementation.

## Rejected

The option was considered and intentionally not selected.

## Deferred

The option may become useful later but is outside the current implementation stage.

## Superseded

A newer decision has replaced the previous one.

---

# 2. Decision Summary

| ID      | Decision                                                     | Status   |
| ------- | ------------------------------------------------------------ | -------- |
| DEC-001 | Use the product name CtxAlloc                                | Accepted |
| DEC-002 | Build a deterministic context compiler                       | Accepted |
| DEC-003 | Use TypeScript and Node.js for the core                      | Accepted |
| DEC-004 | Start with a modular monolith                                | Accepted |
| DEC-005 | Keep the compiler independent from retrieval                 | Accepted |
| DEC-006 | Use project-owned ContextBlock schemas                       | Accepted |
| DEC-007 | Begin without a real retrieval dependency                    | Accepted |
| DEC-008 | Treat QMD as a candidate adapter, not a foundation           | Accepted |
| DEC-009 | Defer Qdrant until server requirements justify it            | Deferred |
| DEC-010 | Use SQLite for local control data                            | Accepted |
| DEC-011 | Keep original files as the source of truth                   | Accepted |
| DEC-012 | Preserve the existing Markdown chunker                       | Accepted |
| DEC-013 | Defer MarkItDown until after the Markdown vertical slice     | Deferred |
| DEC-014 | Do not use generative compression in the MVP compiler        | Accepted |
| DEC-015 | Use one model provider for evaluation only                   | Accepted |
| DEC-016 | Do not build a memory engine in the MVP                      | Accepted |
| DEC-017 | Do not build a model gateway in the MVP                      | Accepted |
| DEC-018 | Do not assemble the product from multiple context frameworks | Accepted |
| DEC-019 | Include Scope in the domain model from the beginning         | Accepted |
| DEC-020 | Require complete compilation traces                          | Accepted |
| DEC-021 | Evaluate against simple baselines                            | Accepted |
| DEC-022 | Use external systems only through contract-tested adapters   | Accepted |
| DEC-023 | Write documentation in English                               | Accepted |
| DEC-024 | Use Claude Code as the main implementation environment       | Accepted |
| DEC-025 | Use stronger models selectively for reviews                  | Accepted |

---

# 3. Accepted Decisions

## DEC-001: Use the Product Name CtxAlloc

### Status

Accepted

### Decision

The product is named:

```text
CtxAlloc
```

Expanded meaning:

```text
Context Allocation Engine
```

Recommended description:

```text
Deterministic context compiler for AI systems.
```

### Context

The previous working name, Token OS, conflicted with an existing project in the same technical area.

Squeeze OS was considered but rejected because:

* the name already exists in another software ecosystem;
* it overemphasizes compression;
* the product performs selection and allocation, not only compression;
* the `OS` suffix creates expectations of a full agent runtime.

### Consequences

Use:

```text
Repository: ctxalloc
CLI: ctxalloc
Configuration: ctxalloc.config.ts
Local state: .ctxalloc/
Package scope: @ctxalloc/*
```

Internal class names should continue to describe responsibilities:

```text
ContextCompiler
TokenBudgetAllocator
CandidateValidator
```

Not every class should include the product name.

---

## DEC-002: Build a Deterministic Context Compiler

### Status

Accepted

### Decision

The core product is a deterministic compiler that receives candidate context blocks and produces a smaller rendered context under a strict token budget.

### Context

Existing systems already provide:

* vector search;
* agent memory;
* model gateways;
* conversation summarization;
* tool pruning;
* context frameworks.

The product must not compete by duplicating every surrounding component.

The differentiated core is:

* strict budget allocation;
* required information preservation;
* deterministic selection;
* provenance;
* inclusion and exclusion tracing;
* measurable comparison against baselines.

### Consequences

The compiler:

* does not retrieve data;
* does not call an LLM;
* does not read source files;
* does not generate embeddings;
* does not autonomously create memory;
* does not route between models.

---

## DEC-003: Use TypeScript and Node.js for the Core

### Status

Accepted

### Decision

The core implementation uses TypeScript and Node.js.

### Context

Reasons:

* the existing Markdown chunker is written in TypeScript;
* the initial integration environment is AI and developer tooling;
* strong type support is useful for domain schemas and trace structures;
* Node.js works well for CLI, HTTP APIs, filesystem integrations, and SDKs;
* Claude Code performs well in TypeScript repositories;
* the future product may expose a TypeScript SDK.

### Alternatives Considered

#### Python

Advantages:

* large AI ecosystem;
* many retrieval and document-processing libraries.

Rejected for the core because:

* it would require porting the existing chunker;
* it provides no clear advantage for deterministic compiler logic;
* Node.js is sufficient for the MVP.

Python may be used later in isolated workers such as document conversion.

#### Rust

Advantages:

* high performance;
* strong correctness guarantees;
* efficient memory use.

Rejected for the MVP because:

* higher development cost;
* slower iteration;
* unnecessary before performance data demonstrates a need.

### Consequences

Performance-critical components may be moved behind ports later without changing the core domain model.

---

## DEC-004: Start With a Modular Monolith

### Status

Accepted

### Decision

The MVP is implemented as a modular monolith.

### Context

The system does not yet require:

* independently scalable services;
* distributed queues;
* separate deployment teams;
* cross-region availability;
* service-level isolation.

Microservices would add:

* network failures;
* deployment complexity;
* duplicate configuration;
* tracing complexity;
* slower local development.

### Consequences

Initial execution may use one Node.js process containing:

* CLI or HTTP interface;
* application services;
* compiler kernel;
* local storage adapters;
* optional model adapter.

Package boundaries must remain clear so selected components can later become separate processes.

---

## DEC-005: Keep the Compiler Independent From Retrieval

### Status

Accepted

### Decision

Retrieval happens before compilation.

The compiler receives candidates through a domain-level request.

### Context

Retrieval answers:

```text
Which blocks might be relevant?
```

Compilation answers:

```text
Which blocks should enter the final context under this policy and budget?
```

Combining these responsibilities would bind the product to one search engine and make evaluation difficult.

### Consequences

The compiler must be fully testable with static fixtures.

Retrieval scores are treated as untrusted candidate metadata.

---

## DEC-006: Use Project-Owned ContextBlock Schemas

### Status

Accepted

### Decision

CtxAlloc owns the canonical schemas for:

* Scope;
* SourceDocument;
* SourceLocation;
* ContextBlock;
* CompilationRequest;
* CompilationPolicy;
* CompilationResult;
* CompilationTrace.

### Context

External retrieval or memory products use different internal representations.

Using an external representation as the canonical domain model would make replacement difficult.

### Consequences

Adapters translate external records into CtxAlloc domain records.

External SDK types must not enter the compiler kernel.

---

## DEC-007: Begin Without a Real Retrieval Dependency

### Status

Accepted

### Decision

The first compiler implementation uses:

* static fixtures;
* FakeCandidateProvider;
* manually scored candidates.

### Context

The core hypothesis can be tested without retrieval:

* budget enforcement;
* deduplication;
* allocation;
* rendering;
* traces;
* fact preservation.

Starting with a retrieval product would make failures difficult to classify.

### Consequences

The first end-to-end compiler tests require no network, embeddings, or external services.

A real retrieval adapter is added only after the compiler core works.

---

## DEC-008: Treat QMD as a Candidate Adapter, Not a Foundation

### Status

Accepted

### Decision

QMD may become the first real local retrieval adapter only after a technical spike.

### Context

QMD offers:

* local search;
* BM25;
* semantic search;
* hybrid retrieval;
* Markdown support.

However, possible risks include:

* conflict with the project-owned chunker;
* file-oriented indexing;
* duplicated identifiers;
* generated shadow files;
* synchronization complexity;
* internal chunking behavior.

### Spike Acceptance Criteria

QMD is accepted only if it supports, directly or through a small clean adapter:

* stable project-owned block identifiers;
* incremental updates;
* source deletion;
* source metadata;
* explicit scope isolation or equivalent physical separation;
* retrieval scores;
* clean error handling;
* removal without kernel changes.

### Rejection Rule

If integration requires extensive workaround logic, QMD must be rejected instead of permanently patched around.

---

## DEC-009: Defer Qdrant Until Server Requirements Justify It

### Status

Deferred

### Decision

Qdrant is not part of the local MVP.

### Context

Qdrant is better suited for:

* remote shared indexes;
* large corpora;
* concurrent users;
* payload filters;
* tenant-aware server retrieval;
* replication;
* independent scaling.

The initial MVP does not require those capabilities.

### Consequences

A future `QdrantCandidateProvider` may implement the same candidate provider port.

The kernel must not require changes.

---

## DEC-010: Use SQLite for Local Control Data

### Status

Accepted

### Decision

SQLite is the initial persistence implementation for local operational data.

### Intended Data

SQLite may store:

* compilation traces;
* source metadata;
* block metadata;
* evaluation runs;
* indexing state;
* configuration metadata.

### Context

SQLite provides:

* simple local deployment;
* transactions;
* strong development tooling;
* no external service requirement;
* easy backup and inspection.

### Consequences

The domain must depend on storage ports, not SQLite APIs.

PostgreSQL may replace SQLite in a future server deployment.

---

## DEC-011: Keep Original Files as the Source of Truth

### Status

Accepted

### Decision

Original Markdown and Obsidian files remain authoritative.

Indexes and databases contain derived data.

### Context

Allowing a retrieval index to become the source of truth would complicate:

* rebuilds;
* recovery;
* synchronization;
* source editing;
* provenance.

### Consequences

Deleting `.ctxalloc/` or a retrieval index must not delete original documents.

Derived records must be rebuildable.

---

## DEC-012: Preserve the Existing Markdown Chunker

### Status

Accepted

### Decision

The project continues using its project-owned Markdown chunker.

### Context

The chunker already supports important correctness properties:

* Unicode-safe boundaries;
* ATX headings;
* Setext headings;
* exact source offsets;
* source reconstruction;
* metadata validation;
* overlap safeguards.

Replacing it with generic retrieval chunking would lose control over block identity and provenance.

### Consequences

Retrieval providers must accept project-generated blocks or operate at a separate document retrieval stage.

The chunker remains independent from retrieval.

---

## DEC-013: Defer MarkItDown Until After the Markdown Vertical Slice

### Status

Deferred

### Decision

MarkItDown is not required for the first complete MVP path.

### Context

MarkItDown is useful for normalizing:

* PDF;
* DOCX;
* PPTX;
* HTML;
* EPUB.

It does not directly solve token allocation.

Adding it early would introduce:

* Python runtime requirements;
* file conversion failures;
* format-specific edge cases;
* additional caching and security concerns.

### Consequences

The first supported source types are:

* Markdown;
* plain text;
* conversations.

MarkItDown may later run as an isolated converter adapter or worker.

---

## DEC-014: Do Not Use Generative Compression in the MVP Compiler

### Status

Accepted

### Decision

The compiler uses deterministic extractive selection.

It does not summarize or rewrite blocks through an LLM.

### Context

Generative compression introduces:

* additional cost;
* latency;
* nondeterminism;
* possible hallucinations;
* information loss;
* harder provenance;
* more difficult evaluation.

The MVP must establish a deterministic baseline first.

### Consequences

The compiler may:

* include blocks;
* exclude blocks;
* deduplicate blocks;
* reorder blocks.

It does not rewrite source text.

Future generative transformations require separate explicit decisions and evaluation.

---

## DEC-015: Use One Model Provider for Evaluation Only

### Status

Accepted

### Decision

The MVP may include one external model provider to compare baseline and compiled answers.

### Context

An LLM is needed to measure downstream answer quality, but model execution is not part of the compiler kernel.

### Consequences

The model provider:

* lives behind a port;
* may be replaced by a fake in tests;
* does not influence compilation;
* does not own budget allocation;
* does not require multi-provider routing.

---

## DEC-016: Do Not Build a Memory Engine in the MVP

### Status

Accepted

### Decision

Conversation history and memory-like content are represented as ordinary candidate blocks.

### Context

Dedicated memory products already handle:

* fact extraction;
* supersession;
* contradiction resolution;
* user profiles;
* episodic memory;
* deletion.

Those capabilities are outside the core hypothesis.

### Consequences

CtxAlloc may later consume candidates from memory systems through adapters.

It does not create or manage autonomous memory in the MVP.

---

## DEC-017: Do Not Build a Model Gateway in the MVP

### Status

Accepted

### Decision

The MVP does not implement:

* OpenAI-compatible proxying;
* model routing;
* retries across providers;
* provider load balancing;
* fallback models;
* billing aggregation.

### Context

These capabilities are already available in established gateway products and do not validate the context allocation hypothesis.

### Consequences

One direct model adapter is sufficient for evaluation.

---

## DEC-018: Do Not Assemble the Product From Multiple Context Frameworks

### Status

Accepted

### Decision

CtxAlloc must not become a composition of several large frameworks that independently manage overlapping responsibilities.

### Rejected Composition Example

```text
QMD
+ ContextChef
+ Mem0
+ Mastra
+ another model gateway
+ project synchronization code
```

### Context

Such a design would create:

* overlapping token-budget ownership;
* conflicting memory behavior;
* duplicated persistence;
* incompatible identifiers;
* independent lifecycle failures;
* difficult debugging;
* high upgrade cost.

### Consequences

Large external projects may be used as:

* research references;
* evaluation baselines;
* optional adapters.

Their internal components must not be copied into the kernel or tightly coupled together.

---

## DEC-019: Include Scope From the Beginning

### Status

Accepted

### Decision

All source, block, request, retrieval, and trace operations include explicit scope.

### Minimum Scope

```ts
interface Scope {
  tenantId: string;
  workspaceId: string;
  projectId?: string;
}
```

### Context

Adding tenant boundaries after building an unscoped system would require changes across:

* identifiers;
* storage;
* retrieval;
* traces;
* caches;
* authorization.

### Consequences

Local mode uses explicit values:

```text
tenantId: local
workspaceId: default
```

This does not mean full multi-tenancy is implemented in the MVP.

---

## DEC-020: Require Complete Compilation Traces

### Status

Accepted

### Decision

Every validated candidate receives exactly one final decision.

### Context

The product must explain:

* inclusion;
* exclusion;
* deduplication;
* rejection;
* budget transitions;
* score components.

Without trace completeness, the product becomes another opaque ranking system.

### Consequences

Trace creation is part of compiler correctness, not optional telemetry.

Trace persistence remains optional.

---

## DEC-021: Evaluate Against Simple Baselines

### Status

Accepted

### Decision

CtxAlloc must be compared against simpler methods.

Required baselines:

* full context;
* naive truncation;
* top-K selection;
* required blocks plus top-K.

### Context

A complex allocator has no value if it performs no better than score sorting.

### Consequences

New algorithms must demonstrate measurable improvement without weakening correctness.

---

## DEC-022: Use External Systems Only Through Contract-Tested Adapters

### Status

Accepted

### Decision

Every implementation of a port must pass a shared contract test suite.

### Context

Type-compatible interfaces do not guarantee equivalent behavior.

Adapters may differ in:

* update semantics;
* errors;
* identifier handling;
* filtering;
* result ordering;
* deletion behavior.

### Consequences

Examples:

```text
describeCandidateProviderContract(...)
describeTraceStoreContract(...)
describeModelProviderContract(...)
```

A provider that cannot pass the contract is not supported.

---

## DEC-023: Write Project Documentation in English

### Status

Accepted

### Decision

Repository documentation, code comments, public schemas, and architectural files use English.

### Context

English improves:

* compatibility with coding models;
* open-source participation;
* package documentation;
* future international use;
* consistency with TypeScript ecosystem terminology.

### Consequences

User-facing explanations during development may still be discussed in Russian.

---

## DEC-024: Use Claude Code as the Main Implementation Environment

### Status

Accepted

### Decision

Claude Code is the primary coding environment for the MVP.

The main working model may be selected according to available subscription and credit limits.

### Context

The project will be developed through small, reviewable changes rather than one large autonomous generation.

### Development Pattern

```text
one scoped task
then implementation
then tests
then diff review
then commit
```

### Consequences

Claude Code must read the project documents before major implementation work.

Large unreviewed repository-wide changes are discouraged.

---

## DEC-025: Use Stronger Models Selectively for Reviews

### Status

Accepted

### Decision

More expensive or limited models are used for high-value reviews, not routine implementation.

### Suitable Review Tasks

* architecture review;
* invariant audit;
* complex cross-module debugging;
* benchmark methodology review;
* final MVP audit.

### Context

Independent review has higher value than using the strongest model for every simple coding task.

### Consequences

Routine implementation can use the primary Claude Code model.

Remaining GPT or higher-tier model limits should be reserved for critical independent checks.

---

# 4. Rejected Decisions

## REJ-001: Build a Full AI Operating System

### Status

Rejected

### Reason

The scope would include unrelated systems:

* agent runtime;
* memory;
* model routing;
* tool execution;
* retrieval;
* document conversion;
* billing;
* UI.

This would make the MVP impossible to validate cleanly.

---

## REJ-002: Make QMD the Canonical Data Model

### Status

Rejected

### Reason

The project must own block identifiers, provenance, scope, and compilation semantics.

QMD may remain a retrieval adapter candidate.

---

## REJ-003: Use QMD and Qdrant Simultaneously in the MVP

### Status

Rejected

### Reason

This would add synchronization cost and provide no necessary validation benefit.

Only one real retrieval implementation should be active in the MVP.

---

## REJ-004: Let Retrieval Enforce the Final Token Budget

### Status

Rejected

### Reason

Retrieval ranking and final context allocation are separate responsibilities.

The compiler must retain final inclusion control.

---

## REJ-005: Use LLM Summaries as the Initial Compression Strategy

### Status

Rejected

### Reason

This would hide whether value comes from deterministic selection or generated rewriting.

It would also weaken reproducibility and provenance.

---

## REJ-006: Start With Microservices

### Status

Rejected

### Reason

The initial system has no demonstrated scaling or team-boundary requirement.

---

## REJ-007: Remove Scope From Local Mode

### Status

Rejected

### Reason

Local shortcuts would later contaminate schemas, storage, and APIs with unscoped assumptions.

---

## REJ-008: Treat Markdown as the Only Internal Representation

### Status

Rejected

### Reason

Markdown is a useful source and rendering format, but the domain requires structured metadata, provenance, scope, and decisions.

The internal canonical representation is `ContextBlock`.

---

## REJ-009: Optimize Only for Token Reduction

### Status

Rejected

### Reason

Token reduction without fact preservation and answer quality is not product success.

---

## REJ-010: Fork a Large Existing Context Framework

### Status

Rejected

### Reason

A fork would create:

* upstream divergence;
* inherited complexity;
* long-term maintenance;
* unclear product differentiation.

Integration or contribution may be reconsidered only if an existing project later satisfies nearly all requirements.

---

# 5. Deferred Decisions

## DEF-001: Selection of the First Real Retrieval Provider

### Status

Deferred

### Candidates

* project-owned SQLite FTS5;
* QMD;
* another local provider.

### Required Evidence

* spike results;
* adapter size;
* retrieval quality;
* update behavior;
* scope behavior;
* operational complexity.

---

## DEF-002: Embedding Model Selection

### Status

Deferred

### Context

The compiler core does not require embeddings.

The choice depends on the selected retrieval backend and multilingual benchmark results.

---

## DEF-003: MarkItDown Integration

### Status

Deferred

### Trigger

The Markdown and conversation vertical slices must pass their acceptance gates first.

---

## DEF-004: PostgreSQL Integration

### Status

Deferred

### Trigger

Server deployment requires shared durable operational storage or stronger tenant controls.

---

## DEF-005: Qdrant Integration

### Status

Deferred

### Trigger

One or more of the following become true:

* shared remote retrieval;
* concurrent tenant workloads;
* large corpus;
* availability requirements;
* independent retrieval scaling;
* required payload filtering.

No fixed corpus threshold is assumed without benchmark data.

---

## DEF-006: Generative Context Transformation

### Status

Deferred

### Trigger

The deterministic baseline is complete and a separate benchmark demonstrates measurable benefit.

---

## DEF-007: OpenAI-Compatible Gateway

### Status

Deferred

### Trigger

Transparent integration with existing applications becomes a validated product requirement.

The compilation API remains the primary product surface for the MVP.

---

## DEF-008: Full SaaS Platform

### Status

Deferred

### Trigger

The local or developer product demonstrates demand and repeatable value.

---

# 6. Decision Change Process

A decision may be changed when new evidence appears.

Valid evidence includes:

* benchmark results;
* technical spike results;
* production failures;
* security findings;
* unacceptable maintenance cost;
* changed product requirements.

A decision must not be changed only because:

* a new library is popular;
* an AI agent suggests a larger architecture;
* an alternative looks more elegant;
* future scale is imagined but not measured.

---

# 7. ADR Template

Major future decisions should use a separate ADR file.

Recommended path:

```text
docs/decisions/ADR-XXX-short-title.md
```

Template:

```markdown
# ADR-XXX: Decision Title

## Status

Proposed | Accepted | Rejected | Deferred | Superseded

## Date

YYYY-MM-DD

## Decision Owners

Names or roles

## Context

Describe the problem, constraints, and evidence.

## Decision

State the selected approach clearly.

## Alternatives Considered

### Alternative A

Advantages, disadvantages, and reason not selected.

### Alternative B

Advantages, disadvantages, and reason not selected.

## Consequences

### Positive

- ...

### Negative

- ...

### Risks

- ...

## Validation

Describe tests, benchmarks, or spike results required to validate the decision.

## Reversal Plan

Explain how the decision can be changed or removed.

## Related Documents

- PRODUCT_CONTRACT.md
- MVP_SCOPE.md
- ARCHITECTURE.md
- INVARIANTS.md
- METRICS.md
```

---

# 8. Technical Spike Template

External integration spikes should record:

```markdown
# Spike: Component Name

## Question

What exact uncertainty is being tested?

## Time Boundary

Define the maximum acceptable exploration scope.

## Required Capabilities

- ...

## Test Dataset

Describe the input and scale.

## Findings

- ...

## Adapter Surface

List files, interfaces, and approximate complexity.

## Failure Behavior

Describe unavailable, timeout, invalid response, and partial update behavior.

## Performance

Record measured values.

## Operational Cost

List services, runtimes, models, storage, and configuration required.

## Removal Cost

Explain how the integration can be removed.

## Recommendation

Accept | Reject | Revisit later
```

---

# 9. Current Open Questions

The following questions remain intentionally unresolved.

## OPEN-001: Which Tokenizer Will Be the First Production Adapter?

Requirements:

* supported model compatibility;
* deterministic output;
* stable package behavior;
* acceptable performance;
* testability.

## OPEN-002: What Is the Simplest Useful Allocation Algorithm?

Candidate starting point:

1. validate required blocks;
2. include required blocks;
3. enforce category rules;
4. rank optional blocks using deterministic weighted score;
5. greedily include fitting blocks;
6. re-tokenize final render;
7. evict optional blocks if rendering exceeds budget.

More complex optimization must be justified by benchmark improvements.

## OPEN-003: Should the Compiler Be Synchronous?

The domain logic is naturally synchronous after candidates are provided.

Tokenization implementation and application orchestration may introduce asynchronous boundaries.

The kernel should remain synchronous unless a concrete requirement proves otherwise.

## OPEN-004: How Should Rendering Represent Sources?

Candidate formats include:

* Markdown sections;
* XML-like block wrappers;
* compact JSON;
* plain text separators.

The selected format must balance:

* token overhead;
* model comprehension;
* safe escaping;
* provenance readability.

The choice requires token and answer-quality evaluation.

## OPEN-005: Should Near-Duplicate Detection Enter the MVP?

Exact deterministic deduplication is accepted.

Near-duplicate detection remains optional until false-positive behavior is measured.

---

# 10. Review Checklist

Before accepting a new decision, confirm:

* Does it support the product contract?
* Is it required by the MVP scope?
* Does it preserve all invariants?
* Can it be evaluated through defined metrics?
* Does it introduce overlapping responsibility?
* Does it increase external coupling?
* Can it be reversed?
* Is the complexity supported by measured evidence?
* Can the core still run offline?
* Does it reduce or increase future maintenance cost?

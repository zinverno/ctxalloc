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
| DEC-026 | Keep canonical ContextBlock data query-independent           | Accepted |
| DEC-027 | Use js-tiktoken o200k_base as the first real tokenizer       | Accepted |
| DEC-028 | Derive source document identity from explicit logical identity | Accepted |
| DEC-029 | Chunk Markdown deterministically in the application layer      | Accepted |
| DEC-030 | Validate request-specific candidate wrappers before compiler policy stages | Accepted |
| DEC-031 | Deduplicate exact candidate content before policy scoring | Accepted |
| DEC-032 | Normalize explicit candidate signals before deterministic allocation | Accepted |

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

## DEC-026: Keep Canonical ContextBlock Data Query-Independent

### Status

Accepted

### Decision

A `ContextBlock` contains only source-derived or explicitly authored block data.

Its data is query-independent: the same block record is valid for every query in its scope.

Query-dependent values are separated as follows:

* retrieval-supplied scores belong to a future candidate wrapper produced for one request;
* calculated relevance, recency, redundancy, and utility scores belong to a future scoring result;
* scoring must never mutate the canonical `ContextBlock`.

### Context

An earlier version of the architecture placed `relevanceScore` and `recencyScore` inside `ContextBlock.attributes`.

Those values describe one retrieval or one compilation for one query, not the block itself. Persisting them on the canonical entity would mean:

* the stored record changes meaning depending on the last query that touched it;
* the same block yields different persisted data for different queries;
* deduplication and content hashing would have to ignore parts of the record;
* a stale score could silently influence a later compilation;
* provenance and scoring responsibilities would be merged in one structure.

Required status and authored priority are different. They are declared properties of the block and remain valid across queries, so they stay in `attributes`.

### Consequences

`relevanceScore` and `recencyScore` are removed from `ContextBlock`.

Retrieval scores remain untrusted inputs and must be validated where they enter the system (INV-SCORE-002, INV-SCORE-004). Score components must still be recorded in the trace (INV-SCORE-001).

Required status keeps its separate allocation class and must not be represented as a large numeric score (INV-SCORE-003).

The candidate and scored-candidate structures are not implemented by this decision. They are introduced when retrieval and scoring phases begin.

---

## DEC-027: Use js-tiktoken o200k_base as the First Real Tokenizer

### Status

Accepted

### Decision

The first real implementation of the Tokenizer port is an offline adapter built on:

```text
package:  js-tiktoken
version:  1.0.21 (pinned exactly)
import:   js-tiktoken/lite
ranks:    js-tiktoken/ranks/o200k_base
encoding: o200k_base
```

The adapter lives in `@ctxalloc/tokenization` and is the only package allowed to depend on the tokenizer library.

Its stable identity is recorded as two separate values:

```text
id:      js-tiktoken:o200k_base
version: 1.0.21
```

The identifier names the implementation and its vocabulary; the version names the exact package the counts came from. Keeping them separate lets a trace state which counts are comparable (INV-TRACE-005), because counts are comparable only when both values match.

### Context

Token counts are correctness data, not an estimate. A budget decision, a rejected candidate, and a final rendered-context check all depend on the count being exactly what the model will see, so the first real adapter was selected against these requirements:

* it must run offline, because core tests must not require a network (Product Contract 9.5);
* it must be deterministic, with no clock, randomness, or cache;
* it must not download a vocabulary at runtime;
* it must not map model names to encodings implicitly;
* its counts must be independently verifiable;
* it must be removable without changing the compiler kernel.

`js-tiktoken` is a pure-JavaScript port of `tiktoken` that ships its rank tables as importable modules. The `js-tiktoken/lite` entry point contains the BPE implementation only, so the encoding is chosen by importing exactly one rank module and nothing else is loaded.

### Rules

Only the bundled `o200k_base` ranks are loaded. No CDN, no runtime `fetch`, no WASM build, no `encodingForModel`, and no mutable model registry is used. The adapter reads no file, environment variable, clock, or random value while counting.

Encoding uses ordinary-text semantics: no substring may be promoted to a control token, and text that merely looks like one, such as `<|endoftext|>`, is counted as the literal source text it is instead of raising an error. Source content is data, never an instruction to the tokenizer (INV-SEC-001).

The dependency is pinned to one exact version rather than a range. A patch release that changed a rank table or a splitting rule would silently change every recorded count and break comparability between traces, so the version moves only through a reviewed change.

The library type never crosses the port. `Tokenizer` stays a project-owned interface, the adapter's errors are project-owned, and the emitted declarations are checked for library types (INV-ADAPTER-001).

### Scope of the Encoding

`o200k_base` is a reference adapter, not a universal tokenizer. Its counts are valid for model families that use `o200k_base` and must not be assumed valid for another family.

Supporting another family requires either a separate adapter or an explicit decision introducing a model-to-encoding mapping. Silently falling back to a different tokenizer is forbidden: a count from the wrong vocabulary is wrong data, not an approximation.

### Alternatives Considered

#### tiktoken (WASM bindings)

Rejected for the first adapter: it adds a WASM artifact to the build and to every consumer without improving the correctness of the counts the MVP needs.

#### Character or word estimation

Rejected. An estimate cannot support a hard budget guarantee, and a compiled context validated against an estimate can still overflow the real budget.

#### A provider token-count API

Rejected. It requires a network call and credentials, makes core tests dependent on an external service, and introduces latency and nondeterminism into a value the compiler must compute locally.

### Validation

Committed golden fixtures record exact counts for empty text, ASCII, significant whitespace, LF and CRLF line endings, Cyrillic, Japanese, composed and decomposed Unicode forms, emoji including a multi-code-point sequence, Markdown, TypeScript code, literal special-token-looking text, and a mixed-language paragraph.

Those counts are not self-certified by the adapter. Before they were committed they were cross-checked against the official `openai/tiktoken` Python package, version 0.12.0, using ordinary-text encoding semantics. The oracle run happens outside the repository; the committed suite requires no Python, no oracle package, and no network.

### Consequences

`js-tiktoken` must not become a dependency of `@ctxalloc/domain`, `@ctxalloc/ports`, `@ctxalloc/compiler`, `@ctxalloc/application`, `@ctxalloc/testing`, `@ctxalloc/evaluation`, the CLI, or the API.

Token budgets remain a domain concern. A tokenizer reports what text costs; deciding what fits belongs to the allocator (INV-DEP-003).

This decision resolves OPEN-001 for the first adapter only. It does not decide the tokenizer for any other model family.

---

## DEC-028: Derive Source Document Identity From Explicit Logical Identity

### Status

Accepted

### Decision

Source ingestion is an application-layer use case. It lives in `@ctxalloc/application` as one synchronous, deterministic, offline function.

The function receives an explicit scope, a closed `SourceType`, an explicit logical source identity, source content that the caller has already read, optional title and timestamps, and JSON-safe metadata. It returns a runtime-validated `SourceDocument` together with the exact unchanged content.

It does not read a file, walk a directory, fetch a URL, infer a scope or a path, read the clock, generate a random value, normalize text, parse Markdown or frontmatter, split content, create `ContextBlock` records, count tokens, call a model, or persist anything.

Reading bytes remains the responsibility of a future SourceReader adapter, which does not exist yet. This decision does not create that port.

### Logical Source Identity

A source is identified by two caller-controlled strings:

```text
namespace   the identity namespace the caller owns
key         one logical source inside that namespace
```

Both are exact values. They are never trimmed, lowercased, or otherwise rewritten, and neither is a machine-specific absolute path by definition. A future file reader can build them from a stable vault identifier plus a relative path; a future conversation reader from a provider namespace plus a stable conversation identifier.

Absolute paths, relative paths, and provider identifiers may travel in `metadata`, where they remain ordinary untrusted source metadata (INV-SEC-001). They are never project-owned identity by themselves (INV-ADAPTER-002).

### Source Document Identity Algorithm

The document ID is the SHA-256 of this canonical identity payload, serialized with `JSON.stringify` and encoded as UTF-8:

```json
[
  "ctxalloc-source-document-id",
  1,
  scope.tenantId,
  scope.workspaceId,
  scope.projectId ?? null,
  sourceType,
  identity.namespace,
  identity.key
]
```

The result is represented as:

```text
source-document:sha256:<64 lowercase hexadecimal characters>
```

The literal integer `1` is the version of this algorithm. A future change to the tuple, its order, or its meaning must raise that number, which makes the change a visible new identity rather than a silent reinterpretation of existing records.

A fixed-order array is hashed rather than an object, so property insertion order cannot affect the result (INV-DET-002).

The payload deliberately excludes content, `contentHash`, title, timestamps, metadata, the current time, random values, process information, hostname, and any absolute local path. The identity is therefore independent of the source content: editing one logical source changes its `contentHash` and keeps its document identity (INV-BLOCK-001).

Scope participates so the same logical key in another tenant, workspace, or project never reuses one project-owned document ID (INV-SCOPE-002). The source type participates so one key cannot silently change meaning between `markdown`, `text`, and `conversation`.

UUIDs, absolute paths, and database-generated identifiers are not used (INV-DET-003).

### Source Content Hash

`SourceDocument.contentHash` is the SHA-256 of the exact source content encoded as UTF-8, represented as `sha256:<64 lowercase hexadecimal characters>`.

The exact source content is the canonical content for this phase. Ingestion performs no trimming, no Unicode normalization, no line-ending conversion, no BOM removal, no Markdown or frontmatter parsing, no whitespace rewriting, and no trailing-newline adjustment.

The observable consequences are intentional:

* LF and CRLF variants hash differently;
* NFC and NFD variants hash differently;
* adding or removing a trailing newline changes the hash;
* leading or trailing whitespace changes the hash;
* identical exact content always produces the identical hash;
* the empty string produces the standard SHA-256 empty-input digest.

Preserving the exact bytes keeps the hash a statement about the source the caller actually holds (INV-PROV-005). A normalization policy, if one is ever needed for block-level deduplication, is a separate decision at the block layer.

Content that is not well-formed UTF-16 is rejected before hashing. A lone surrogate has no UTF-8 encoding, and encoders substitute U+FFFD, which would produce a hash of text the caller never supplied (INV-BLOCK-007). Identity components are checked the same way. Scope values reach the identity payload through `JSON.stringify`, which escapes a lone surrogate instead of losing it, so the payload stays exactly recoverable either way.

Hashing uses the Node.js standard library. No hashing dependency is added.

### Determinism

No clock, randomness, filesystem read, environment variable, database, network call, or tokenizer participates in ingestion. Identical canonical input always produces identical output, and input property order never affects the result (INV-DET-001, INV-DET-002, INV-DET-003, INV-DET-004).

Validation happens at the runtime boundary: the function accepts `unknown`, rejects unknown fields instead of stripping them, coerces nothing, injects no default, and reports project-owned serializable issues. Validation-library errors do not escape the application API (INV-ADAPTER-001, INV-BLOCK-005).

### Consequences

`@ctxalloc/application` depends on `@ctxalloc/domain` and on the validation library it uses directly. It does not depend on the tokenizer, the ports package, or the compiler.

Chunking and `ContextBlock` identity are separate later decisions. This decision fixes source-level identity only and says nothing about how blocks are derived, how block identifiers are built, or whether block content is normalized before hashing.

Reversing the identity algorithm would change every stored `SourceDocument` ID, so a change requires a new algorithm version and a documented migration.

---

## DEC-029: Chunk Markdown Deterministically in the Application Layer

### Status

Accepted

### Decision

Markdown chunking is an application-layer deterministic transformation. It lives in `@ctxalloc/application` as `MarkdownChunker`, one synchronous, offline class that turns one validated Markdown `IngestedSource` (DEC-028) into runtime-validated `ContextBlock` records.

The chunker receives the project-owned `Tokenizer` port through constructor injection and an explicit token policy. It reads no file, opens no socket, queries no database, calls no model, reads no clock, and generates no random value.

The domain does not gain Markdown parsing, and the compiler does not gain source ingestion or chunking. Reading bytes remains a future SourceReader adapter, which this decision does not create.

### Reference Implementation

The scanner design was adapted from the author's Obsidian plugin `zinverno/obsidian-ai-hub` at commit `e592cbc99d27259db77e05fa06a833f91169cf89`, which is MIT licensed. The license notice is preserved in `THIRD_PARTY_NOTICES.md`.

Only structural scanning ideas were adapted: the CRLF-aware line scan with exact offsets, ATX heading recognition with a heading level stack, fence-aware heading detection for backtick and tilde fences, strict source-only frontmatter detection, and the treatment of lists, blockquotes and callouts, tables, and HTML blocks as atomic logical units.

Obsidian APIs and cache types are excluded. `CachedMetadata`, `HeadingCache`, `TFile`, `Vault`, `App`, and `Plugin` do not appear in CtxAlloc, and no Obsidian package is a dependency (INV-ADAPTER-001). The plugin's architecture, its path-derived identity scheme, and its non-cryptographic `stableHash` are not reused.

### Canonical Block Content

`ContextBlock.content` is an exact substring of the ingested source:

```text
source.content.slice(startOffset, endOffset) === block.content
```

Nothing is trimmed, CRLF-normalized, blank-line collapsed, Unicode-normalized, truncated, or rewritten, and no breadcrumb, heading label, or ellipsis is inserted. Wiki links and embeds stay as written.

This is a deliberate difference from the reference implementation, whose chunk text contains a generated breadcrumb followed by a normalized body. Heading context is preserved in `ContextBlock.headingPath` instead, so provenance is machine-readable and the extractive guarantee stays byte-exact (DEC-014, INV-ALLOC-004, INV-PROV-002).

### Token Limits Replace Character Limits

The policy is `targetTokens` and `maxTokens`, both finite positive safe integers with `targetTokens <= maxTokens`. Numeric strings, fractions, `NaN`, `Infinity`, zero, negatives, and unknown option fields are rejected, and no production default is injected (INV-BUDGET-005).

Every boundary and grouping decision is validated by calling the injected tokenizer over the exact candidate substring. No character-count estimate, and in particular no characters-divided-by-four rule, participates in a decision.

Boundary selection evaluates every candidate in a class rather than stopping at the first one that exceeds `maxTokens`. The `Tokenizer` port guarantees deterministic exact counts but deliberately does not guarantee that a count grows as text is extended: a subword tokenizer can merge tokens so that a longer substring costs fewer of them. An overflowing candidate therefore proves nothing about a later one, and inferring otherwise would discard a boundary that genuinely fits. This decision does not add a monotonicity requirement to the port.

The recorded `tokenCount` describes `block.content` only. Heading path rendering, source labels, separators, compiler wrappers, and protocol overhead are not counted here: the final compiled total is measured by tokenizing the rendered context, which stays a compiler responsibility (INV-BUDGET-002, INV-RENDER-004).

### No Overlap

Canonical blocks never overlap and never duplicate source content. The reference implementation prepends an overlapping suffix of the previous chunk to improve embedding recall; that behavior is not reproduced.

Overlap is deferred to a future retrieval or indexing adapter, where duplicated text would be a property of one index rather than of the canonical record. Introducing it requires its own decision and evidence, because overlapping canonical blocks would double-count tokens, duplicate content in a compiled context, and make block identity ambiguous.

### Atomic Blocks

Fenced code, lists, blockquotes and callouts, tables, and HTML blocks are atomic and are never split. Paragraphs are the only splittable kind.

An atomic block larger than `maxTokens` is emitted as one block, preserved exactly, and marked `metadata.chunking.oversized: true`. It is never truncated and never cut inside a Unicode code point (INV-BLOCK-007, INV-RENDER-005). Deciding what to do with an oversized block belongs to the allocator, which must be able to see the whole unit.

Paragraph splitting prefers a sentence boundary, then a whitespace boundary, then a Unicode-safe hard boundary. When a single indivisible code point cannot fit, it is emitted intact and marked oversized rather than dropped.

### Frontmatter

Frontmatter is detected from the source only, never from a metadata cache. The opener is accepted at the very beginning of the source as exactly `---`, optionally preceded by a BOM; the closing delimiter is exactly `---`; LF and CRLF are both supported. Leading whitespace before the opener, an indented closing delimiter, and an unclosed opener all mean there is no frontmatter, and a `---` later in the document is ordinary content.

Valid frontmatter is excluded from block content. It is not parsed as YAML, its fields are not injected into metadata, and `SourceDocument.metadata` is not modified: source data must never become compiler input (INV-SEC-001). `SourceDocument.contentHash` remains the hash of the complete original source, including the frontmatter.

### Setext Headings

Setext headings are not recognized in this phase. A `Title` line followed by `===` or `---` stays ordinary paragraph content.

The reference implementation supports them only through validated Obsidian cache data. Deciding source-only whether an underline belongs to a preceding paragraph requires full block-context tracking, and a wrong answer moves a section boundary and therefore every offset after it. The limitation is documented and tested rather than approximated. Adding Setext support later is a behavior change that requires updated fixtures, because it changes section boundaries and therefore block identity.

### Heading Paths

Heading paths are built with a heading level stack: a heading pops the stack until the top is shallower, skipped levels are allowed, and duplicate heading text is allowed. A section body starts after its heading line, so heading markers never enter block content and a parent never repeats a child's body. A heading with no body produces no block.

Section discovery and logical block parsing are one pass over the source, not two. A line becomes a heading only when it is reached at document level, so an ATX-looking line inside any atomic span — fenced code, a blockquote or callout, a basic HTML block or comment, a table, or indented list content — is part of that block and never a section. Two passes could disagree about which spans are protected, and a disagreement would split an atomic block at its interior and leak the inner text into a heading path; one pass makes that structurally impossible.

A heading indented to at least a list item's content column is list content. A heading indented less than that column is document structure and closes the list.

Heading text is the parsed ATX title with surrounding and repeated inner whitespace collapsed. That value is provenance metadata, not content, so normalizing it cannot alter source text.

Content before the first heading forms a root section. When `SourceDocument.title` is present and not blank, the root heading path is `[title]`, used exactly as supplied; otherwise `headingPath` is omitted. A heading path is never derived from an absolute path or inferred from a filename, and the title is never trimmed or rewritten.

### Source Ranges

Every Markdown block carries a `text-range` source location with half-open offsets and one-based `startLine` and `endLine`, where `endLine` is the line containing the final source character. One-based numbering follows `SourceLocationSchema`, which requires positive integers; the reference implementation's zero-based lines are not copied.

Ranges are in non-decreasing source order and never overlap.

### Normalized Content Hash

`ContextBlock.normalizedContentHash` is the SHA-256 of the block content after line-ending normalization only, represented as `sha256:<64 lowercase hexadecimal characters>`.

Normalization replaces CRLF with LF and any remaining lone CR with LF. It does not trim, remove trailing spaces, collapse blank lines, or normalize Unicode. This makes an LF copy and a CRLF copy of the same text comparable without changing code indentation, Markdown spacing, or Unicode composition, each of which can carry meaning.

The hash is cryptographic on purpose. A non-cryptographic hash such as the reference project's `stableHash` is not used for CtxAlloc identity.

### ContextBlock Identity Algorithm

The base identity payload is serialized with `JSON.stringify`:

```json
[
  "ctxalloc-context-block-id",
  1,
  source.document.id,
  headingPathOrNull,
  normalizedContentHash
]
```

`headingPathOrNull` is the exact `headingPath` array or `null`. `normalizedContentHash` is the block field value.

Blocks are traversed in source order, and an occurrence counter is kept per exact serialized base payload: the first occurrence is `0`, the second `1`, and so on. The final payload appends that integer to the base array. The ID is the SHA-256 of the serialized final array encoded as UTF-8, represented as:

```text
context-block:sha256:<64 lowercase hexadecimal characters>
```

The literal integer `1` is the algorithm version. A change to the tuple, its order, or its meaning must raise it.

The payload excludes absolute paths, current offsets, line numbers, token counts, tokenizer identity, title, timestamps, metadata, the current time, randomness, database identifiers, and process information.

The consequences are intended:

* unchanged normalized content under the same source and heading path keeps its ID even when unrelated earlier text shifts its offsets (INV-BLOCK-001);
* duplicate identical blocks stay unique through deterministic occurrence (INV-BLOCK-002);
* a heading change is a visible identity change;
* a normalized content change is a visible identity change;
* a source document change is a visible identity change.

Committed golden vectors pin the algorithm.

### Errors

Two project-owned error types are exported. `MarkdownChunkingValidationError` with code `MARKDOWN_CHUNKING_INVALID_INPUT` reports invalid construction input and invalid chunking input, including a `contentHash` mismatch, which is an explicit machine-readable issue rather than an assertion failure.

`MarkdownChunkingError` reports failures that the caller's input did not cause: `MARKDOWN_CHUNKING_TOKENIZER_FAILED` when the injected tokenizer throws or returns a value that is not a usable count, and `MARKDOWN_CHUNKING_INVALID_BLOCK` when an internally derived block fails domain validation. Both carry the source range being processed.

No validation-library error, no tokenizer-library error, and no `DomainValidationError` escapes the public API (INV-ADAPTER-001, INV-ADAPTER-003).

### Consequences

`@ctxalloc/application` now declares `@ctxalloc/ports` in addition to `@ctxalloc/domain`. That edge is already permitted by the boundary allowlist. The chunker does not import `@ctxalloc/tokenization`, `js-tiktoken`, or any concrete tokenizer: the composition root or a test chooses the implementation.

Because block identity depends on normalized content and heading path, any future change to section boundaries, atomic-block detection, paragraph splitting, or the normalization rule changes stored block identifiers and requires a new algorithm version and a documented migration.

---

## DEC-030: Validate Request-Specific Candidate Wrappers Before Compiler Policy Stages

### Status

Accepted

### Decision

Candidate validation is the first stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `CandidateValidator`, one synchronous, deterministic, offline class that turns an untrusted candidate batch into a `ValidatedCandidateSet`.

The batch it receives is built from a new domain record, `CandidateBlock`: an ephemeral request-specific wrapper around one canonical `ContextBlock`. DEC-026 promised that wrapper and deliberately did not build it; this decision builds it.

The validator receives the project-owned `Tokenizer` port through constructor injection. It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, reads no clock, and generates no random value.

It does not filter by policy, deduplicate, choose a canonical duplicate, score, normalize or compare a provider score, resolve required blocks, allocate, order, render, or build a trace.

### CandidateBlock

```ts
interface CandidateBlock {
  readonly schemaVersion: 1;
  readonly block: ContextBlock;
  readonly retrieval?: CandidateRetrieval;
}

interface CandidateRetrieval {
  readonly providerId: string;
  readonly providerVersion: string;
  readonly rank?: number;
  readonly score?: CandidateRetrievalScore;
  readonly metadata?: JsonObject;
}

interface CandidateRetrievalScore {
  readonly value: number;
  readonly semantics: string;
  readonly higherIsBetter: boolean;
}
```

`ContextBlock` stays query-independent under DEC-026. Retrieval-supplied values describe one retrieval for one query, so they live on the wrapper and are never written back into the block.

The wrapper has no identity of its own: `block.id` remains the project-owned stable block identifier. It carries no normalized relevance score, no recency score, no redundancy score, no utility score, no final score, no allocation decision, no trace decision, and no rendered text. `retrieval` is optional, so a direct or statically authored candidate needs no fabricated provider.

The schemas are strict. Unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, and an absent optional field stays absent.

### Retrieval Values Are Untrusted Provider Input

`providerId`, `providerVersion`, and `score.semantics` are validated for blankness with `trim` and for UTF-16 well-formedness, and are then preserved exactly. They are never trimmed, lowercased, or otherwise rewritten: a trace records them verbatim, and rewriting one would make two traces disagree about which counts and scores are comparable.

The UTF-16 check is applied to these new fields and not retroactively to the existing identifier and scope schemas. Retrieval strings arrive from an external system, which is where a lone surrogate is likely to appear, and they have never been persisted; tightening the older schemas could reject already-stored records and belongs to its own migration.

`rank` is optional and must be a non-negative safe integer. Zero is valid, because providers differ between zero-based and one-based ranks. Rank is provider input, never canonical ordering (INV-ALLOC-002).

`score.value` must be finite. `NaN` and `Infinity` are rejected (INV-SCORE-004). Negative values are accepted, because the provider scale is not normalized at this stage. `semantics` names the provider-defined metric, such as `cosine-similarity`, `bm25-score`, or `distance`, and `higherIsBetter` states the direction explicitly, because a similarity rises with relevance while a distance falls.

Phase 7 performs no score normalization and no score comparison. Values from different `providerId`, `providerVersion`, or `semantics` combinations are not assumed comparable (INV-SCORE-002). No `CandidateProvider` port and no retrieval adapter is created by this decision.

### Canonical Normalized Content Hash

`ContextBlock.normalizedContentHash` is SHA-256 over the block content after line-ending normalization only, represented as `sha256:<64 lowercase hexadecimal characters>`. CRLF becomes LF, then any remaining lone CR becomes LF; nothing is trimmed, no trailing space is removed, no blank-line run is collapsed, and Unicode composition is preserved.

DEC-029 fixed that rule for Markdown blocks. It is now generalized to every extractive schema-version-1 text `ContextBlock`, and it is owned by one module in `@ctxalloc/domain`, because two components depend on producing the same value from the same content: the Markdown chunker writes the hash, and `CandidateValidator` recomputes it. Two implementations of one correctness rule would be free to drift (INV-DEP-003).

Content that is not well-formed UTF-16 is rejected before hashing. A lone surrogate has no UTF-8 encoding, and encoders substitute U+FFFD, which would hash text the caller never supplied (INV-BLOCK-007). The lone-surrogate scanner moved from `@ctxalloc/application` into the domain for the same reason: one rule, one owner, rather than a second copy.

Hashing uses the Node standard library. No hashing dependency is added and no `node:crypto` type reaches the published declarations. This is the only place the domain uses a Node module: hashing is a pure function of the supplied string, not an infrastructure dependency, and the domain still reaches no database, framework, filesystem, or SDK (INV-DEP-001).

The DEC-029 block ID algorithm is unchanged, and the committed Phase 6 golden hashes and block identifiers remain byte-identical.

`SourceDocument.contentHash` is a different value and is not recomputed. It describes the complete original source content, which is intentionally absent during compilation, so the validator carries it rather than rechecking it.

### Source Documents Are an Explicit Validation Registry

`CandidateValidator` receives `sourceDocuments` as an adjacent validation input:

```ts
interface CandidateValidationInput {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly candidates: readonly CandidateBlock[];
}
```

A block's source is proven by membership in that array and by nothing else: not by a path, not by metadata, not by the adapter that produced it, and not by array position (INV-PROV-001, INV-ADAPTER-002).

The rules are:

* every source document passes `SourceDocumentSchema`;
* source document IDs are unique inside the registry, and a repetition is rejected even when the two records are byte-identical, because resolving it by first or last write would make the array's order significant and would hide an upstream merge defect (INV-BLOCK-002);
* a duplicated ID resolves to no record at all, so no duplicate becomes authoritative;
* every source document scope equals the request scope;
* every candidate block scope equals the request scope;
* every `block.sourceDocumentId` exists in the registry;
* the referenced document's scope equals the block scope;
* the referenced document's `sourceType` equals `block.sourceType`;
* an unreferenced source document is allowed;
* registry order does not change what is accepted.

Scope matching is exact, using `scopesEqual`. An absent `projectId` and an explicit `projectId` are different scopes (INV-SCOPE-003). Cross-scope data produces an explicit error, never a silent exclusion, because silent removal can hide an upstream security failure (INV-SCOPE-004).

#### An Ambiguous Source ID Resolves to Nothing

The candidate lookup is built only from IDs that occur exactly once.

Rejecting the duplicate is not sufficient on its own. If the lookup took the first (or last) occurrence of a duplicated ID, that record would become authoritative for every candidate referencing it, and the *semantic* issue set would depend on the array's order: two documents sharing an ID but differing in `sourceType` yield a `source_type_mismatch` in one order and not in the other. The batch is rejected either way, but which rules fired must not change with input order (INV-DET-002).

A candidate referencing an ambiguous ID is therefore compared against no record. The registry-dependent checks — `source_scope_mismatch` and `source_type_mismatch` — are skipped for it, because performing them would require choosing one conflicting record.

It does not produce `source_not_found` either. The ID is present; it is only ambiguous, and reporting it as absent would misdescribe the defect. The `duplicate_source_document_id` issue already names the real problem and already rejects the batch.

Everything that does not depend on a source record keeps running for that candidate: scope matching against the request, the source-location kind rule, the normalized content hash, the token count, UTF-16 well-formedness, and block ID conflict detection.

Neither a first-wins nor a last-wins rule exists anywhere in this component.

### Source Location Is Validated, Not Reconstructed

`ContextBlockSchema` validates the shape and internal ordering of `SourceLocation`. The validator does not claim more than it can prove: `SourceDocument` intentionally does not carry full content, so `endOffset <= sourceLength` cannot be checked here.

Phase 7 validates the `SourceLocation` schema, the source reference, and the compatibility of the location kind with the block's own source type. It does not read or reconstruct the source. Complete source-length bounds remain the source and chunker contract, verified by source-reconstruction tests (INV-BLOCK-006). Adding source content to compilation solely to repeat chunker work would defeat the separation the architecture depends on.

### Source Location Kind Must Match the Source Type

Each source type can be located exactly one way:

```text
markdown      -> text-range
text          -> text-range
conversation  -> conversation-message
```

The domain already defines the two kinds this way: a character range inside a text or Markdown document, and a message inside a conversation source. The rule encodes that existing definition rather than inventing a policy, and it adds no source type and changes no schema.

The schema alone cannot enforce it. `SourceLocationSchema` is a discriminated union that validates each kind's own shape, and the registry check proves only that the block and its source document agree on `sourceType`. Between them, a block could still describe itself with provenance its own source type cannot produce: a Markdown block located by a conversation message, or a conversation block located by a character range into a document that has none. Such a block cannot be located in its source at all, which makes every later provenance decision unsound (INV-PROV-002).

The check is therefore a cross-field rule in `CandidateValidator`, reported as `source_location_type_mismatch` at `candidates[i].block.sourceLocation.kind`. It compares two fields of the same block, so unlike the registry rules it needs no source document and stays available even when the referenced ID is missing or ambiguous.

`sourceLocation` remains optional, because `ContextBlockSchema` permits its absence; an absent location is not a contradiction. No location value is ever rewritten.

Expressing the rule inside `SourceLocationSchema` was rejected: the location record does not carry the source type, so the union would have to be re-parsed in the context of a block, which is exactly the cross-field validation the compiler already performs.

### Exact Token-Count Recomputation

For every distinct block content, the validator calls `tokenizer.countTokens(block.content)`, requires a finite non-negative safe integer, and compares the exact returned value with `block.tokenCount`.

A mismatch rejects the batch. The stored field is not recomputed and replaced, no warning-only success is returned, and no character or word estimate participates (INV-BLOCK-003, DEC-027). INV-BLOCK-003 permits either rejecting or recomputing with a warning, and requires the selected behavior to be consistent; this decision selects rejection, because a stale count that the compiler silently repairs hides an out-of-date index rather than reporting it.

The count describes `block.content` only. `headingPath`, metadata, source labels, separators, compiler wrappers, and protocol overhead are not counted here. The final compiled total is measured by tokenizing the rendered context, which remains a later compiler responsibility (INV-BUDGET-002, INV-RENDER-004).

Identical content is counted once, no matter how many wrappers carry it, and every wrapper still receives its own issue, so the reported result does not depend on how often a block repeats.

A tokenizer that throws, or that returns a value which is not a usable count, produces a project-owned issue carrying the candidate context. No tokenizer-library error class escapes (INV-ADAPTER-001, INV-ADAPTER-003).

### Equivalent Duplicates Pass, Conflicting Records Reject

Two wrappers may legitimately carry the same block: a provider can return it twice, and two providers can return it with different retrieval metadata. Those wrappers pass through unchanged, in input order, because collapsing them is deduplication's decision and its canonical selection rules, not validation's (INV-DEDUP-001).

What cannot pass is one `block.id` attached to different canonical `ContextBlock` data. A stable identifier that means two things makes every later provenance and deduplication decision unsound, so it is rejected as `conflicting_block_id` (INV-BLOCK-002).

Comparison uses a canonical serialization of `block` alone, with object keys sorted recursively and array order preserved. Retrieval data therefore never creates a conflict, and JavaScript property insertion order never creates a false one. A plain `JSON.stringify` over unsorted metadata is not sufficient: it emits keys in insertion order, which an adapter, a database driver, or a JSON parser can vary between runs (INV-DET-002). No first-wins or last-wins rule is applied, and the decision does not depend on input order.

Phase 7 implements neither exact-ID nor content-hash deduplication. Both belong to the deduplication phase.

### Priority Is Restricted to Safe Integers Only

`ContextBlockSchema` requires `priority` to be an integer, and the validation library's integer check already enforces the safe-integer range. That is exactly the Phase 7 rule: an absent priority is valid, any finite safe integer is valid including a negative one, and a fraction or an unsafe magnitude is not.

The rule therefore has one enforcement point rather than two that could drift; the validator adds only the focused issue code so a consumer can tell a rejected priority from any other malformed field.

No arbitrary product range such as `0..100` or `-1000..1000` is invented. Semantic minimum and maximum priority, and any policy boost, belong to the versioned `CompilationPolicy` phase. The architecture wording "priority range validation" is corrected to safe-integer validation plus later policy bounds.

### Strict All-or-Nothing Batch Validation

Any request-level, source-registry, or candidate problem rejects the whole batch with one project-owned error:

```text
CandidateValidationError
code: CANDIDATE_VALIDATION_FAILED
```

Validation runs in two stages, and the collection guarantee differs between them.

The top-level schema runs first. **A schema failure short-circuits cross-record validation entirely**: the error carries the schema issues alone. Those rules read fields the schema has not established, so running them over unparsed data could only guess. The short-circuit applies to every schema failure, including one whose only cause is an unknown top-level key.

Once the schema passes, every cross-record problem in the batch is collected before failing, so one call reports the whole batch rather than its first defect.

Re-parsing leniently to salvage a few more issues from a batch that carries an unrecognized top-level key was considered and rejected. The batch is invalid either way, so it buys little; it would make the guarantee harder to state rather than simpler, since every other schema failure would still short-circuit; and it would run semantic rules over a shape the validator has just declared unsupported.

No candidate is silently removed, silently repaired, re-counted, re-hashed, reordered, or collapsed, and no partial `ValidatedCandidateSet` is returned. This satisfies the MVP rule that invalid candidates produce explicit errors. A later compiler trace may translate these issues into rejected-candidate decisions (INV-TRACE-001).

Issues reuse the project-owned `ValidationIssue` shape and are serializable, deterministically ordered, and addressed by both a path array and a dotted pointer. Their codes are:

```text
invalid_input                     invalid_priority
duplicate_source_document_id      scope_mismatch
source_not_found                  source_scope_mismatch
source_type_mismatch              source_location_type_mismatch
conflicting_block_id              invalid_unicode
invalid_normalized_content_hash   invalid_token_count
tokenizer_failed
```

No raw validation-library error, `DomainValidationError`, tokenizer-library error, or external provider error escapes the compiler boundary.

### Impossible Required Budgets Belong to the Allocator

MVP_SCOPE 3.3 listed impossible required-block budgets under candidate validation, while ARCHITECTURE 6.4 and INV-BUDGET-004 assign that decision to `BudgetAllocator`. The allocator is correct and the scope document is corrected.

Required-budget feasibility cannot be decided here. It depends on the complete required allocation, the rendering overhead of required source labels and separators, and the fixed compiler text, none of which exists at validation time. Deciding it early would either duplicate the allocator's arithmetic or guess at it, and INV-DEP-003 forbids two components owning one responsibility.

`CandidateValidator` therefore never inspects a token budget, and `required` remains a declared block attribute that it validates and carries without interpreting (INV-SCORE-003).

### Consequences

`@ctxalloc/compiler` now declares `@ctxalloc/domain`, `@ctxalloc/ports`, and the validation library it uses directly. Both internal edges are already permitted by the boundary allowlist. It does not depend on `@ctxalloc/application`, `@ctxalloc/tokenization`, `js-tiktoken`, or any concrete tokenizer: the composition root or a test chooses the implementation.

`@ctxalloc/domain` gains `CandidateBlock`, the canonical block content hash, and the shared lone-surrogate scanner, and uses `node:crypto` in the hash module only. `@ctxalloc/application` no longer maintains a private copy of either rule.

Because `CandidateValidator` rejects rather than repairs, an out-of-date index becomes a visible failure at the compiler boundary instead of a silently corrected count. That is the intended cost: a stale token count is wrong data for a hard budget guarantee, not an approximation.

Filtering, deduplication, scoring, required-block resolution, required-budget feasibility, allocation, ordering, rendering, traces, compiler orchestration, retrieval, persistence, the CLI, and the HTTP API remain later phases.

---

## DEC-031: Deduplicate Exact Candidate Content Before Policy Scoring

### Status

Accepted

### Decision

Exact candidate deduplication is the second stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `CandidateDeduplicator`, one synchronous, pure, offline class that turns a `ValidatedCandidateSet` into a `DeduplicatedCandidateSet`.

It takes no injected dependency at all. It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, calls no tokenizer, reads no clock, and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002).

It does not filter by policy, score, normalize or compare a provider score, resolve required blocks against a budget, allocate, order for rendering, render, build a trace, or persist anything.

### CandidateValidator Remains the Trust Boundary

The stage consumes a `ValidatedCandidateSet` and nothing else. It is deliberately downstream of `CandidateValidator`, which has already proved the schema, the request scope, the source registry, the source-location compatibility, the UTF-16 well-formedness, the token counts, the normalized content hashes, and that no block ID stands for two different canonical records.

`CandidateDeduplicator` therefore accepts no unknown raw candidate, re-runs no validation, re-counts no token, re-hashes no content, re-checks no source registry or scope, and silently repairs nothing. That is a stage contract, not a runtime boundary: the future compiler orchestration will guarantee the stage order.

No second validation framework and no runtime brand is introduced for it. A brand would add a second, weaker trust mechanism next to the one the validator already provides, and it would still not prove that the batch came from the validator rather than from a hand-built structure with the right shape.

The supplied set is treated as immutable throughout. No candidate, block, attribute, metadata object, source location, retrieval record, source document, or array is mutated, and the result reuses those records by reference rather than rewriting them (INV-ALLOC-004).

### Exact Normalized Content Defines a Duplicate Group

Two candidate wrappers belong to the same duplicate group when their canonical normalized block content strings are exactly equal:

```ts
normalizeContextBlockContentForHash(block.content)
```

That is the shared domain rule fixed by DEC-030 and it is the single definition of equivalence. CRLF becomes LF and any remaining lone CR becomes LF; nothing is trimmed, no trailing space is removed, no blank-line run is collapsed, no space is coalesced, and Unicode composition is preserved.

The consequences are exact:

* repeated wrappers of one block ID group together;
* different block IDs carrying identical normalized content group together;
* an LF copy and a CRLF copy of the same text group together;
* a lone-CR copy and an LF copy of the same text group together;
* identical content from different source documents groups together;
* identical content from different source types groups together;
* a trailing-space difference does not group;
* a blank-line-count difference does not group;
* an indentation difference does not group;
* an NFC and an NFD spelling of the same word do not group;
* a letter-case or punctuation difference does not group;
* a substring or containment relationship does not group;
* a paraphrase does not group;
* two blocks that discuss the same subject with contradictory values do not group (INV-DEDUP-005).

### The Hash Accelerates Grouping and Never Decides It

The validated `normalizedContentHash` is used as an outer bucket, because comparing 64 hexadecimal characters is cheaper than comparing whole documents. Inside a bucket, membership is decided by comparing the canonical normalized content strings themselves.

The hash is therefore never the semantic test. A hypothetical hash collision could not merge two different texts into one group, because the texts are still compared. The pre-bucket also cannot split a real group, because the validator has proved every hash is the canonical hash of its own content, so equal normalized content always hashes equally.

Making hash equality alone the rule was rejected: it would make correctness depend on the collision resistance of a digest rather than on the content the compiler actually holds, and a duplicate decision removes content from a compiled context.

### Every Wrapper Survives as Evidence

Deduplication collapses independently selectable logical content. It does not erase evidence.

Every input `CandidateBlock` wrapper appears exactly once inside exactly one output `DeduplicatedCandidate.members` array, whatever its block ID, retrieval provider, provider rank, provider score, or source document, and whether or not it carries retrieval data at all. Nothing disappears between stages (INV-TRACE-001, INV-DEDUP-003).

Wrappers are carried whole rather than summarized. Retrieval records are never merged into one fabricated object, and no "best" score is selected, averaged, normalized, maximized, minimized, or compared here: provider scales are not comparable at this stage (INV-SCORE-002), and a future scorer may need the individual records. `CandidateBlock` is unchanged, and no deduplication state is written back into `ContextBlock` or `CandidateBlock`.

### Canonical Selection Uses Only Existing Invariant Semantics

The canonical block of a group is chosen from the distinct `ContextBlock` records in that group, by two ordered rules:

1. **Required status.** A block whose `attributes.required` is `true` wins over every block where `required` is `false` or absent. Absent and `false` are both simply optional. If exactly one distinct block is required it becomes canonical; if several are, rule 2 decides among the required blocks only; if none is, rule 2 decides among all of them.
2. **Stable block identifier.** The lexicographically smallest `ContextBlock.id` wins, compared by UTF-16 code unit.

Comparison never uses `localeCompare`: its result depends on the machine's locale and on the ICU data the runtime was built with, which would make one ordering decision differ between machines (INV-DET-002). The code-unit comparison is the project-owned final tie-breaker (INV-DET-005).

Nothing else participates. Retrieval score, retrieval rank, provider identity, authored numeric priority, category, `createdAt`, `updatedAt`, token count, metadata richness, source-location completeness, source document, and input position are all excluded, because:

* retrieval scores and ranks are unnormalized untrusted provider inputs that this stage is forbidden to compare (INV-SCORE-002, INV-PROV-003);
* recency policy does not exist, and reading a timestamp as recency would be a policy decision taken without a policy (INV-DET-004);
* source priority and category priority belong to the versioned `CompilationPolicy`;
* DEC-030 deliberately gave authored numeric priority no semantic bounds or ordering meaning;
* token count and metadata richness are not evidence of correctness, and under a real tokenizer a CRLF copy and an LF copy of one text can even differ in token count while being the same canonical content;
* every duplicate's provenance is preserved in `members`, so canonical selection does not need to destroy any of it;
* input order is forbidden as a decision source (INV-DET-002, INV-ALLOC-005).

### Required Status Survives

Any group containing at least one required distinct block gets a required canonical block.

That is achieved by choosing an already-existing required `ContextBlock`, never by creating a merged block, never by copying `required: true` from one block onto another, and never by mutating a block. Canonical identity and INV-DEDUP-002 are both preserved, and required status remains a separate allocation class rather than a large score (INV-SCORE-003).

### Reason Codes

`canonicalSelectionReason` is set deterministically per group:

```text
single-block                     one distinct block ID, however many wrappers
required-block                   several distinct block IDs, exactly one required
required-then-stable-block-id    several distinct block IDs, several required
stable-block-id                  several distinct block IDs, none required
```

`matchReason` is set per preserved member:

```text
same-block-id                    the wrapper carries the canonical block itself
same-normalized-content          a different block with exactly equal normalized content
```

`same-block-id` is safe even when retrieval metadata differs, because the validator has already established that one block ID cannot stand for two different canonical records (INV-BLOCK-002). Differing retrieval data is never a canonical block conflict.

Both are machine-readable codes rather than free text, so a future trace builder can turn a group into decisions without re-deriving meaning from a message (INV-TRACE-002).

### Provenance Stays Recoverable

The canonical `ContextBlock` keeps its own provenance unchanged. Source IDs are never concatenated into its metadata, the block is never rewritten, and no multi-source block schema is invented.

Every duplicate's provenance stays reachable through the group's members:

```text
member.candidate.block.id
member.candidate.block.sourceDocumentId
member.candidate.block.sourceLocation
member.candidate.block.headingPath
member.candidate.block.metadata
member.candidate.retrieval
```

Together with the canonical block, the canonical selection reason, and each member's match reason, that is everything INV-DEDUP-003 requires a trace to record, without implementing `CompilationTrace` now.

### Stable Ordering

`DeduplicatedCandidateSet.candidates` is ordered by `canonicalBlock.id` ascending, with the group's canonical normalized content as a final tie-breaker so the order stays total even for a caller that bypassed the validator. This is the first stage that intentionally normalizes candidate ordering for later compiler traversal (INV-DET-002); candidate input order is deliberately not preserved.

`members` is ordered by `candidate.block.id` ascending, then by a canonical serialization of the whole wrapper. Wrappers that share a block ID but carry different retrieval evidence therefore have a fixed relative order that depends on neither input position nor JavaScript property insertion order. Two wrappers that serialize identically are indistinguishable, so their relative order has no observable effect.

`sourceDocuments` returns the same validated records in `id` ascending order. The registry is already unique by validation, the array is copied before sorting so the caller's registry is never reordered in place, and no record is mutated.

`scope` is returned unchanged. It is never inferred or rewritten.

That canonical serialization is one compiler-internal helper, shared with the validator's conflicting-block-ID detection rather than reimplemented, because two implementations of one rule would be free to drift (INV-DEP-003). It sorts object keys recursively, preserves array order, and preserves exact strings; a plain `JSON.stringify` would emit keys in insertion order, which an adapter, a database driver, or a JSON parser can vary between runs. The helper stays internal: it is not re-exported from the package entry point and appears in no public declaration.

### The Result Is an Ephemeral Stage Object

`DeduplicatedCandidateSet`, `DeduplicatedCandidate`, and `DeduplicatedCandidateMember` are compiler-owned readonly interfaces, produced and consumed inside one compilation and never persisted. They carry no `schemaVersion`, because that field marks persisted domain records so an unsupported stored shape fails clearly (INV-STORE-004), and no persisted schema is added for a value that never leaves the process.

`ContextBlockSchema` and `CandidateBlockSchema` are unchanged. No deduplication state is written back into either record. No `Map`, `Set`, mutable array, canonical-JSON helper, validation-library type, crypto type, or provider SDK type reaches the public surface (INV-ADAPTER-001).

### No Near-Duplicate Logic

Phase 8 implements no near-duplicate rule of any kind: no embedding, cosine similarity, edit distance, fuzzy match, stemming, token-set similarity, MinHash, SimHash, Levenshtein, LLM comparison, semantic equivalence, same-heading heuristic, substring rule, or containment rule.

INV-DEDUP-004 requires any near-duplicate rule to be deterministic, explainable, tested against false positives, configurable, and disabled by default until validated. The rule is therefore left absent rather than added and switched off. No configuration flag is introduced either: there is no implementation for a flag to enable, and an inert flag would advertise a capability that does not exist.

### No Policy Filtering

No `CandidateFilter` and no `CompilationPolicy` is introduced. No candidate is excluded for its category, source, source type, timestamp, authored priority, retrieval score, retrieval rank, provider identity, query relevance, freshness, or token size. Every validated non-duplicate group survives this stage.

Policy filtering requires a versioned `CompilationPolicy`, which does not exist. Inventing filtering rules here would place policy decisions in a stage that has no policy to apply, and INV-DEP-003 forbids two components owning one responsibility.

MVP_SCOPE 3.4 lists source priority, source recency, and provenance completeness among *possible* canonical selection rules. Only required status and the stable identifier tie-break are implemented, because those are the only two whose semantics the active invariants already define. The rest are policy and remain future work.

ARCHITECTURE 4 previously drew policy filtering before deterministic deduplication. The two stages are swapped, and deduplication now runs immediately after candidate validation. Filtering a group before its duplicates are known would let the surviving copy of one piece of content depend on which wrapper a filter happened to keep, and every filtering rule that exists is a policy rule, so it cannot run before the policy that defines it exists. Deduplication needs no policy at all, so it is the stage that can run now.

### Source Snapshot Binding Remains Deferred

A `SourceDocument.id` is stable across content edits by design (DEC-028), so a persisted `ContextBlock` can reference a document whose content has since changed. Phase 8 has no persistence or index-generation model and cannot prove which source content snapshot produced a block.

Deduplication does not solve this and does not attempt to. No `sourceContentHash` is added to `ContextBlock` in this phase. The problem belongs to the persistence and retrieval design, where index freshness and re-indexing are decided.

### Consequences

`@ctxalloc/compiler` gains a second published stage and no new dependency: `CandidateDeduplicator` needs only `@ctxalloc/domain` types and the shared normalization helper. No external runtime dependency is added, the boundary allowlist is unchanged, and `@ctxalloc/application` and `@ctxalloc/tokenization` remain absent from the kernel.

`CandidateValidator` is unchanged in behavior. Its private canonical serialization moved into a compiler-internal module that both stages now share; the values it produces, the conflicts it detects, and the issues it reports are identical.

Because deduplication normalizes ordering, the candidate order a retrieval adapter happens to produce stops being observable from this stage onward. That is the intended effect: later stages traverse a stable sequence, and a provider cannot influence compiler decisions through array position.

Policy filtering, scoring, required-block resolution, allocation, ordering, rendering, traces, compiler orchestration, retrieval, persistence, the CLI, and the HTTP API remain later phases.

---

## DEC-032: Normalize Explicit Candidate Signals Before Deterministic Allocation

### Status

Accepted

### Decision

Deterministic candidate scoring is the third stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `CandidateScorer`, one synchronous, pure, offline class that turns a `DeduplicatedCandidateSet` into a `ScoredCandidateSet`.

Its only injected dependency is an explicit versioned `CandidateScoringPolicy`, and time reaches it only as an explicit `referenceTime` argument to `score()`. It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, calls no tokenizer, reads no clock, and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002).

It does not filter by policy, read a token budget, decide inclusion or exclusion, evict anything, resolve required blocks against a budget, allocate, order for rendering, render, build a trace, or persist anything.

### CandidateValidator Remains the Trust Boundary

The stage consumes a `DeduplicatedCandidateSet` produced by `CandidateDeduplicator`, which itself consumes a `ValidatedCandidateSet`. `CandidateValidator` has already proved the schema, the scope, the source registry, the UTF-16 well-formedness, the token counts, the content hashes, the timestamp shapes, and that no block ID stands for two different canonical records.

`CandidateScorer` therefore revalidates no candidate, re-counts no token, re-hashes no content, and repairs nothing. That is a stage contract, not a runtime boundary, exactly as in DEC-031.

Two things reaching this stage are *not* covered by that contract, and both are runtime boundaries with their own strict validation: the scoring policy, which is external configuration, and `referenceTime`, which is supplied per call.

### A Narrow Versioned Scoring Policy, Not the Full CompilationPolicy

ARCHITECTURE 5.6 describes a future `CompilationPolicy` covering filtering, scoring, allocation, ordering, and rendering. That broad object is deliberately not built here.

Only the scoring slice exists, because only the scoring stage exists. `CandidateScoringPolicy` carries `schemaVersion`, `policyId`, `policyVersion`, and five optional components:

```ts
interface CandidateScoringPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly retrieval?: {
    readonly weight: number;
    readonly aggregation: 'max';
    readonly rules: readonly RetrievalNormalizationRule[];
  };
  readonly authoredPriority?: { readonly weight: number; readonly min: number; readonly max: number };
  readonly sourcePriority?: {
    readonly weight: number;
    readonly defaultValue: number;
    readonly bySourceDocumentId: readonly { readonly sourceDocumentId: SourceDocumentId; readonly value: number }[];
  };
  readonly categoryPriority?: {
    readonly weight: number;
    readonly defaultValue: number;
    readonly byCategory: readonly { readonly category: string; readonly value: number }[];
  };
  readonly recency?: {
    readonly weight: number;
    readonly maxAgeSeconds: number;
    readonly missingValue: number;
  };
}
```

A later `CompilationPolicy` may contain or reference this object without changing what `CandidateScorer` means by it. Building the broad object now would place filtering, allocation, ordering, and rendering vocabulary in a repository that implements none of them.

Policy validation is strict: unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, exact strings are preserved, and malformed UTF-16 is rejected with the shared domain helper. Every weight must be finite and non-negative; every value the policy states directly on the normalized scale must be finite and inside `[0, 1]`; a retrieval range must be finite with `min < max`; an authored-priority range must be safe integers with `min < max`; `maxAgeSeconds` must be a positive safe integer; and `aggregation` accepts only `max` in schema version 1.

Lookups are compiled only after validation. Duplicate keys are rejected rather than resolved, because resolving a repeat by first or last write would make the order of a caller-owned array significant, so two policies describing the same rules in a different order could score differently (INV-DET-002). The caller's arrays are never sorted or rewritten.

### Raw Retrieval Scores Are Never Compared Across Provider Contracts

Providers disagree on scale and even on direction: a cosine similarity rises with relevance, a vector distance falls, a BM25 score has its own unbounded positive scale, another provider emits negative values, and a provider version may redefine any of them. DEC-030 therefore stored `providerId`, `providerVersion`, `score.value`, `score.semantics`, and `score.higherIsBetter` on `CandidateBlock` and forbade interpreting them.

Phase 9 interprets a raw value only when the policy owns an exact rule for the contract tuple:

```text
[providerId, providerVersion, semantics, higherIsBetter]
```

Two rules may not own the same tuple. For a matching rule with inclusive range `[min, max]`:

```text
higherIsBetter true   normalized = (rawValue - min) / (max - min)
higherIsBetter false  normalized = (max - rawValue) / (max - min)
```

The range is fixed policy input. It is never inferred from the provider, from a rank, or from the values observed in the current batch. Batch-relative normalization was rejected outright: it would make one candidate's normalized score change when an unrelated candidate is added or removed, which would make compilation depend on retrieval result composition rather than on the candidate being scored (INV-DET-001).

A raw value below `min` or above `max` rejects scoring rather than clamping. Clamping would silently reinterpret a measurement the policy says it does not describe, and a provider that has started emitting values outside its documented range is a configuration failure worth reporting.

A scored record with no exact rule also rejects, with `retrieval_score_rule_not_found`. Treating it as zero would state that the provider found the block irrelevant, and dropping it silently would hide a policy that no longer covers the retrieval actually in use (INV-SCORE-002, INV-SCORE-004).

"No exact rule" includes "no retrieval component at all". An absent component states that this policy weighs no relevance signal; it does not license discarding a provider measurement the batch actually carries. Exempting it would make an identity-only policy the one way to smuggle a scored candidate past the contract every other policy must satisfy. A retrieval component configured with an empty rule list behaves identically, and neither case publishes a retrieval component in the score: an absent component means the score has no retrieval term, never a term worth zero.

A retrieval record carrying no score is valid and contributes no relevance evidence. Rank alone is never relevance and provider identity alone is never relevance: a rank is the provider's own position, and neither is a measurement (INV-PROV-003, INV-ALLOC-002).

### Duplicate Evidence Aggregates by Maximum, Never by Count

Phase 8 preserves every candidate wrapper precisely because one exact-content group may carry several retrieval records. `CandidateScorer` reads all of them, not only the wrapper carrying the canonical block.

Every configured score in the group is normalized independently, and the group's retrieval relevance is the **maximum** of the normalized evidence.

Summing, averaging, counting providers, counting wrappers, or multiplying by the number of matching retrievals were all rejected: repeating one wrapper twenty times would then turn "retrieved repeatedly" into "twenty times as useful", which it is not. Preferring the canonical wrapper, the lowest rank, or a particular provider was also rejected: the canonical choice is a deduplication decision and must not become a scoring rule, and provider preference is exactly the cross-contract comparison this stage forbids.

Normalized contracts have already mapped every usable signal onto one comparable `[0, 1]` scale, so the strongest configured relevance in the group is enough for the first deterministic baseline.

All normalized evidence stays visible in the public component, not only the winner, so a later trace can show what was considered. Evidence is ordered by member block ID, provider ID, provider version, semantics, direction, raw value, and finally a canonical serialization of the wrapper, so the array never depends on input order (INV-DET-002, INV-DET-005).

The same `max` rule aggregates the other four components across the **distinct** blocks of a group. A query-independent authored value is counted once per block, not once per wrapper, or duplicate retrieval would inflate authored, source, category, and recency evidence alike.

### Authored Priority Gains Meaning Only Under an Explicit Range

`ContextBlock.attributes.priority` is query-independent authored data, and DEC-030 deliberately gave it no semantic range. Phase 9 does not invent one either: it establishes meaning only when `authoredPriority` is configured, and only over the inclusive safe-integer interval that policy states.

```text
normalized = (priority - min) / (max - min)
```

A priority outside the range rejects rather than clamps. An absent priority contributes no evidence rather than a fabricated midpoint. `required` is never read here (INV-SCORE-003).

### Source and Category Priority Come Only From Explicit Rules

Source priority is resolved by exact `SourceDocument.id`, with an explicit policy `defaultValue` for every unconfigured source. Nothing is inferred from a source type, a path, or arbitrary `SourceDocument.metadata`: source metadata is untrusted content and must never become compiler policy (INV-SEC-001). Which block Phase 8 made canonical also does not decide a score, or deduplication would become a scoring rule.

Category priority is resolved by exact string equality against `ContextBlock.attributes.category`, with an explicit `defaultValue` for an absent or unconfigured category. Nothing is lowercased, trimmed, tokenized, prefix-matched, pattern-matched, or read as a hierarchy in schema version 1: each of those is a policy decision that would have to be versioned and tested on its own, and an implicit hierarchy would silently give one category the value of another. The evidence still distinguishes a block that declared no category from a block whose declared category the policy does not configure.

### Recency Uses the Explicit Reference Time

Recency is optional. When it is absent, timestamps do not affect scoring at all.

When it is configured, each distinct block's evidence timestamp is `updatedAt ?? createdAt`, because `updatedAt` describes the content the block currently holds. A block with neither takes the policy's explicit `missingValue`; no `SourceDocument` timestamp is read as a hidden fallback, because a document's timestamp describes the document, not the block.

```text
ageSeconds = max(0, referenceTimeEpochSeconds - timestampEpochSeconds)
normalized = max(0, 1 - ageSeconds / maxAgeSeconds)
```

A timestamp equal to the reference time scores one, a future timestamp clamps to age zero and also scores one, and content at or beyond `maxAgeSeconds` scores zero. Clamping the future rather than letting it exceed one keeps an upstream clock skew from outranking genuinely current content.

`referenceTime` is validated with the project `Timestamp` contract before anything reads it. `Date.parse` is deliberately not used to convert it: the ECMAScript Date Time String Format fixes only three fractional digits, so an engine's handling of the further digits `TimestampSchema` accepts is implementation-defined, and a compiler decision must not differ between runtimes. A compiler-internal helper parses the validated components and uses `Date.UTC` as transient arithmetic, exactly as the domain's own timestamp validation does. No `Date` instance is retained or exposed.

### Required Status Is Not a Number

No `requiredScore`, `requiredBoost`, large constant, or `Infinity` exists. Required blocks are a separate allocation class that the future `BudgetAllocator` resolves before optional ones (INV-SCORE-003, INV-ALLOC-001); representing that as a large number would make it a tie-break that a high enough score could win.

Phase 8 already guarantees that a group containing any required distinct block gets a required canonical block. `CandidateScorer` preserves that structure unchanged and never reads `required` as a signal. A required candidate may legitimately score zero while an optional one scores higher, and the ranking reflects that.

### Components Are Transparent and Summed in a Fixed Order

Every enabled component publishes its `normalizedValue`, the policy `weight`, the `contribution` (`normalizedValue * weight`), its aggregation rule, and explicit project-owned evidence explaining where the normalized value came from. A disabled component is absent from the score rather than present with a zero. A configured component with weight `0` is still present, with its evidence, and contributes `0`.

`total` is the arithmetic sum of the present contributions taken in one fixed order — retrieval, authored priority, source priority, category priority, recency — rather than by iterating an object, so the floating-point result never depends on property insertion order (INV-DET-002).

Weights need not sum to one. A total is therefore a policy-relative utility, not a probability, and is not bounded by one: it is comparable only against other totals produced in the same run by the same `policyId` and `policyVersion`. These are internal decision values, not financial arithmetic; JavaScript `Number` is sufficient and no decimal library is added.

Sufficient still requires care at the edges of the double range. `max - min` can overflow to infinity while `min`, `max`, and `rawValue` are each finite and accepted, and the plain quotient is then wrong rather than merely imprecise: for `[-MAX_VALUE, MAX_VALUE]` and a raw value of `0` it yields exactly `0` where `0.5` is correct, which no finiteness check can catch because `0` is finite. Retrieval normalization therefore divides every operand by the largest magnitude involved before dividing, whenever the span overflows. The ratio is unchanged, the scaled bounds land in `[-1, 1]`, and ordinary ranges take the direct path bit-for-bit unchanged. Nothing is clamped, rounded for a decision, or formatted through a string.

Every published number is canonicalized so that `-0` becomes `0`: the two compare equal but serialize, print, and deep-equal differently, and publishing one would make two runs that computed the same value look different. A contribution or total that becomes `NaN` or `Infinity` rejects with `non_finite_score_result` rather than being published.

### One Structured Error, Collected Across the Batch

`CandidateScoringError` carries the stable code `CANDIDATE_SCORING_FAILED` and project-owned `ValidationIssue[]`. No validation-library error, `DomainValidationError`, timestamp parsing error, provider error, or implementation exception crosses the boundary (INV-ADAPTER-001, INV-ADAPTER-003).

The issue codes are machine-readable so a later trace can report a failure without re-deriving meaning from a message (INV-TRACE-002):

```text
invalid_policy
duplicate_policy_rule
duplicate_source_priority
duplicate_category_priority
invalid_reference_time
retrieval_score_rule_not_found
retrieval_score_out_of_range
authored_priority_out_of_range
non_finite_score_result
```

A policy schema failure short-circuits duplicate detection, and an invalid `referenceTime` fails immediately, because both would otherwise leave later rules guessing. Once the policy and the reference time are valid, every safely discoverable scoring problem in the batch is collected before failing, and no partial `ScoredCandidateSet` is returned.

Candidate-scoring issues address a group and its blocks by their stable identifiers rather than by array position, so a permuted input produces a byte-identical issue set (INV-DET-002, INV-ALLOC-005).

### No Candidate Is Filtered and Nothing Is Allocated

Every deduplicated candidate appears exactly once in `ScoredCandidateSet` unless scoring fails as a whole. No candidate is excluded for a zero or low score, an absent category, a low source priority, old content, absent retrieval data, a poor provider rank, or a negative authored priority. No minimum score threshold exists.

`CandidateFilter` is not introduced. Policy filtering still requires the broader versioned `CompilationPolicy`, and inventing filtering rules inside the scoring stage would place two responsibilities in one component (INV-DEP-003).

Allocation is equally absent: no budget is read, no token cost is subtracted from a score, no score-per-token is computed, no category quota is enforced, and no inclusion, exclusion, or eviction decision is made. Only the allocator owns final inclusion (INV-ALLOC-002).

### No Second Retrieval Engine and No Redundancy Score

No lexical, BM25, embedding, cosine-over-embeddings, or LLM relevance scorer is implemented inside the compiler. Query-specific relevance arrives through `CandidateRetrieval` under an explicit provider normalization contract; Phase 9 normalizes and combines supplied signals and does not become a second retrieval engine (INV-DEP-002, INV-DEP-003).

No redundancy component and no near-duplicate penalty is added either. Exact duplicates were already collapsed in Phase 8, and INV-DEDUP-004 keeps near-duplicate logic absent rather than present and disabled.

### Stable Ranking

`ScoredCandidateSet.candidates` is ordered by `score.total` descending, then by `canonicalBlock.id` ascending compared by UTF-16 code unit (INV-DET-005). `localeCompare` is never used: its result depends on the machine's locale and on the ICU data the runtime was built with.

Required status does not change this order. The future allocator must still process required candidates as a separate class regardless of their position in this ranking.

The sort runs over a canonical traversal order — canonical block ID, then a canonical serialization of the canonical block — so the ranking is a total order even for a caller that bypassed the pipeline and supplied two groups with one canonical ID.

`sourceDocuments` is returned in `id` ascending order, copied before sorting so the caller's registry is never reordered in place. `scope` is returned unchanged. `policyId`, `policyVersion`, and `referenceTime` are copied verbatim from validated values.

### The Result Is an Ephemeral Stage Object

`ScoredCandidateSet`, `ScoredCandidate`, `CandidateScore`, and every component and evidence type are compiler-owned readonly interfaces, produced and consumed inside one compilation and never persisted. They carry no `schemaVersion`, because that field marks persisted domain records so an unsupported stored shape fails clearly (INV-STORE-004). The policy does carry one, because it is external configuration a caller stores.

`ContextBlockSchema`, `CandidateBlockSchema`, and the Phase 8 result types are unchanged, and no scoring state is written back into any of them. No `Map`, `Set`, `Date`, mutable array, canonical-JSON helper, timestamp helper, score comparator, validation-library type, crypto type, or provider SDK type reaches the public surface (INV-ADAPTER-001).

Evidence records carry identity rather than a second copy of a wrapper: `DeduplicatedCandidate.members` still holds every `CandidateBlock` whole, so nothing is duplicated into the score.

### Trace Readiness Without a Trace

The result preserves everything a future `TraceBuilder` needs to report a scoring decision — policy identity, reference time, every component, the raw evidence used, the normalized evidence values, the aggregation rule, the weight, the contribution, and the total — in machine-readable fields with stable identifiers (INV-SCORE-001, INV-TRACE-005). `CompilationTrace` itself is not implemented.

### Source Snapshot Binding Remains Deferred

As in DEC-031, a `SourceDocument.id` is stable across content edits by design (DEC-028), so a persisted `ContextBlock` can reference a document whose content has since changed. Scoring does not solve this and does not attempt to; no `sourceContentHash` is added. The problem belongs to the persistence and retrieval design.

### Consequences

`@ctxalloc/compiler` gains a third published stage and no new dependency: `CandidateScorer` needs only `@ctxalloc/domain` types, the existing validation library, and two compiler-internal helpers. No external runtime dependency is added, the boundary allowlist is unchanged, and `@ctxalloc/application` and `@ctxalloc/tokenization` remain absent from the kernel.

`CandidateValidator` and `CandidateDeduplicator` are unchanged in behavior. The validator's private issue-path rendering and untrusted-string quoting moved into a compiler-internal module that the scorer now shares, because a pointer must read the same way whichever stage produced it and two implementations of one rule would be free to drift (INV-DEP-003); the values it produces and the issues it reports are identical.

Retrieval scores stop being inert data and start participating in compiler decisions — but only under an explicit contract. A deployment that supplies provider scores without configuring their normalization now fails loudly instead of quietly ignoring them, which is the intended effect.

Policy filtering, `CandidateFilter`, allocation, required-budget resolution, ordering, rendering, traces, compiler orchestration, retrieval, persistence, the CLI, and the HTTP API remain later phases.

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

Answered for the first adapter by DEC-027: `js-tiktoken` 1.0.21 with the `o200k_base` encoding.

The question remains open for every other model family. `o200k_base` is a reference encoding, and a family that uses a different vocabulary requires its own adapter or an explicit model-to-encoding mapping decision.

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

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

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
| DEC-033 | Allocate required and scored content under a deterministic block budget | Accepted |
| DEC-034 | Order selected context by stable source position before rendering | Accepted |
| DEC-035 | Render ordered context as boundary-safe JSONL and measure the exact string | Accepted |
| DEC-036 | Compose explicit compilation contracts and filter scored candidates before allocation | Accepted |
| DEC-037 | Record deterministic privacy-minimized trace snapshots without changing decisions | Accepted |

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

## DEC-033: Allocate Required and Scored Content Under a Deterministic Block Budget

### Status

Accepted

### Decision

Deterministic budget allocation is the fourth stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `BudgetAllocator`, one synchronous, pure, offline class that turns a `ScoredCandidateSet`, an explicit `TokenBudget`, and one narrow versioned `BudgetAllocationPolicy` into an `AllocatedCandidateSet`.

It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, calls no tokenizer, calls no renderer, reads no clock, and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). Its only injected dependency is the policy; the budget is an explicit argument to `allocate()`.

It does not retrieve candidates, revalidate them, re-count tokens, re-hash content, revalidate scope, deduplicate, rescore, filter by policy, trim or rewrite content, order for rendering, render, tokenize, build a trace, or persist anything.

### Block-Content Allocation Is Not Final Rendered-Budget Validation

This is the central constraint of the phase, and it is a deliberate limit rather than an omission.

INV-BUDGET-002 makes the final rendered string the source of truth for the budget, and requires the compiled context — block contents, source labels, headings, separators, wrappers, emitted metadata, fixed prefixes and suffixes — to be tokenized before success is returned. None of that rendering exists yet: `ContextRenderer`, the rendering policy, and the orchestration loop are later phases, so their tokens cannot be counted and must not be guessed.

Phase 10 therefore proves exactly one thing, and proves it exactly:

```text
sum(included canonicalBlock.tokenCount) <= availableInputTokens
```

It never claims:

```text
compiledTokens <= availableInputTokens
```

for a context nobody has rendered. The published metrics are named accordingly — `selectedBlockContentTokens` and `unallocatedBlockContentTokens` — and no `compiledTokens` or final `unusedTokens` field exists on the result. A successful allocation is a provisional block-content selection, not a compilation that satisfies INV-BUDGET-001 and INV-BUDGET-006; only the later renderer plus orchestration loop can satisfy those.

That loop will render the selected blocks, tokenize the complete rendered string, evict optional blocks along the `optionalEvictionOrder` this stage supplies when the result overruns, render and tokenize again, and fail when required content plus hard category constraints plus rendering overhead still cannot fit. It is not implemented here.

One direction of the implication is already definitive. Block content that alone exceeds the available ceiling can never fit once rendering overhead is added, so required block content over the ceiling is a real INV-BUDGET-004 failure before any renderer exists, and it fails immediately. The converse does not hold: required content that fits here is not proof that the rendered required context will fit, and this decision states that explicitly rather than letting a green allocation imply it.

No hidden rendering reserve is added to compensate. Inventing a margin would be guessing a value the caller did not configure, which INV-BUDGET-001 forbids, and it would quietly shrink a budget the caller owns.

### The Budget Is Validated Once, by the Existing Contract

`allocate()` takes the budget as `unknown` because a budget is request configuration rather than a stage contract. It is validated with the existing `TokenBudgetSchema` and nothing else, and the ceiling comes from the existing `availableInputTokens()`.

The arithmetic rules of DEC-013 are not restated here: no reserve is defaulted, injected, or guessed, no `reservedRenderingTokens` field is added, the `TokenBudget` schema is unchanged, and the model context window is never inferred (INV-BUDGET-001, INV-BUDGET-005). An omitted optional reserve stays absent in the returned budget.

### CandidateValidator Remains the Trust Boundary

The stage consumes a `ScoredCandidateSet`. `CandidateValidator` has already proved the schema, the scope, the source registry, the UTF-16 well-formedness, the token counts, the content hashes, and that no block ID stands for two different canonical records; `CandidateDeduplicator` has chosen the canonical block; `CandidateScorer` has composed the scores.

`BudgetAllocator` therefore revalidates no candidate, re-counts no token, re-hashes no content, and repairs nothing. That is a stage contract, not a runtime boundary, exactly as in DEC-031 and DEC-032. The two things that *are* runtime boundaries — the policy and the budget — are validated strictly.

### A Narrow Versioned Allocation Policy, Not the Full CompilationPolicy

ARCHITECTURE 5.6 describes a future `CompilationPolicy` covering filtering, scoring, allocation, ordering, and rendering. That broad object is deliberately not built here, for the same reason DEC-032 did not build it: only the allocation slice exists.

```ts
interface BudgetAllocationPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly optionalSelection: 'score-desc-greedy';
  readonly categoryConstraints?: readonly CategoryAllocationConstraint[];
}

interface CategoryAllocationConstraint {
  readonly category: string;
  readonly minBlocks?: number;
  readonly maxBlocks?: number;
}
```

A later `CompilationPolicy` may contain or reference this object alongside `CandidateScoringPolicy` and future filtering, ordering, and rendering policies without changing what `BudgetAllocator` means by it.

`optionalSelection` names the strategy explicitly instead of leaving it implicit, so a future strategy arrives as a policy value under a new schema version rather than as a silent behavior change.

Policy validation is strict: the object is closed, unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, exact strings are preserved, and malformed UTF-16 is rejected with the shared domain helper. `policyId` and `policyVersion` must be non-blank; `minBlocks` and `maxBlocks` must be non-negative safe integers; at least one bound must be present, because a constraint carrying neither would constrain nothing while looking like configuration; and `minBlocks <= maxBlocks` when both are present. Two constraints owning the same exact category are rejected rather than resolved, because resolving a repeat by first or last write would make the order of a caller-owned array significant (INV-DET-002). Category lookups are compiled only after validation, and the caller's array is never sorted or rewritten.

### Category Constraints Are Exact Block Counts in Schema Version 1

MVP_SCOPE 3.6 required "minimum and maximum category allocations" and ARCHITECTURE 6.4 required the allocator to "enforce category minimums and maximums", but neither document ever stated the **unit**. That ambiguity is resolved here: in schema version 1 the unit is **blocks**, spelled `minBlocks` and `maxBlocks`, and the documents are updated to say so rather than being silently reinterpreted.

`minBlocks` guarantees that at least that many independently selectable canonical blocks of the exact category are included. `maxBlocks` forbids more than that many. There is no token quota, no percentage share, and no byte or character quota.

Counts were chosen over token quotas because:

1. the meaning is explicit — at least or at most N independently selectable canonical blocks of one exact category;
2. feasibility is decidable exactly and efficiently;
3. a hard minimum expressed as a count needs no knapsack or subset-sum optimizer, while a hard minimum expressed as a token quota does;
4. token-share quotas remain possible in a later policy schema version, which the explicit `schemaVersion` exists to allow;
5. it keeps this phase a deterministic allocator rather than an optimization research project.

A category is the canonical block's own `attributes.category`, matched by exact string equality: no case folding, trimming, prefix matching, or hierarchy. A block with no category is unconstrained in v1, because no rule names it. Nothing is inferred from a duplicate member, source metadata, source type, heading path, retrieval provider, or score evidence.

The canonical block alone decides category identity. Phase 8 deliberately chose one canonical block per exact-content group, and the members are provenance rather than additional selectable output blocks; counting a duplicate's category would let one selected block count toward two quotas.

### Required Blocks Are Resolved First and Are Never Removed

Required status is `canonicalBlock.attributes.required === true`. Phase 8 already guarantees a group containing any required block gets a required canonical block, so no duplicate member is consulted (INV-DEDUP-002).

Required blocks are resolved before any optional block (INV-ALLOC-001), are all included when allocation succeeds, receive no numeric boost (INV-SCORE-003), never become evictable, count toward both category bounds, and consume block-content budget. Their traversal order is `canonicalBlock.id` ascending compared by UTF-16 code unit, so the `remainingBefore` and `remainingAfter` values they record cannot depend on input order.

Cost is subtracted one block at a time rather than summed and compared, because summing several counts near `Number.MAX_SAFE_INTEGER` can lose precision and silently accept an impossible allocation.

A required block that does not fit fails the whole allocation with `required_content_exceeds_budget`. No other required block is dropped, no fallback to optional handling happens, and no content is truncated (INV-BUDGET-003, INV-BUDGET-004, INV-ALLOC-004). No partial result is returned.

Required content over a category maximum is the same kind of conflict, and gets the same treatment: `required_category_maximum_exceeded`, never a relaxed maximum and never a removed required block. That is the only coherent result under INV-BUDGET-003 and INV-ALLOC-001 together with INV-ALLOC-003.

### Hard Minimums Use the Minimum-Content-Cost Selection

Required blocks count toward a minimum, so for each constraint:

```text
neededOptionalCount = max(0, minBlocks - requiredCount)
```

When fewer optional candidates of the exact category exist than that, the constraint is unreachable by any budget and fails with `category_minimum_unreachable`. Every such impossibility in the batch is collected before failing, in category order, so a caller learns the whole set at once.

Otherwise exactly `neededOptionalCount` optional candidates are reserved before ordinary optional selection, chosen by:

1. `canonicalBlock.tokenCount` ascending;
2. `score.total` descending;
3. `canonicalBlock.id` ascending by code unit.

Token cost comes first here, and only here. The reason is a proof rather than a preference: exactly K additional blocks of the category must be selected, so taking the K cheapest produces the minimum possible content-token cost of satisfying that count. Each canonical block has at most one exact category, so the per-category selections are disjoint, and the union of per-category minima is therefore the minimum-content-cost selection among all allocations satisfying every category count minimum.

Every category's selection is computed **before** anything is subtracted from the shared remainder, so no category's feasibility depends on the order categories happen to be processed in. The union is then processed in a deterministic order — category ascending, token count ascending, score descending, identifier ascending — and if it does not fit after required allocation, allocation fails with `category_minimums_exceed_content_budget`.

Because the union is minimum cost, that failure is a real block-content infeasibility rather than a greedy artifact: no other selection satisfying the same minimums would have fit either. The issue is reported as a global hard-minimum infeasibility rather than blaming whichever category happened to be traversed last.

Choosing minimum-cost blocks by score descending instead was rejected: it would produce false "minimum impossible" failures whenever a cheaper candidate of the same category existed, and repairing that by search would require exactly the knapsack this phase avoids. Score remains the tie-break among equal-cost candidates, so scoring still decides everything cost does not.

### Optional Selection Is score-desc-greedy

After required blocks and hard minimums are fixed, every remaining optional candidate is considered by `score.total` descending, then `canonicalBlock.id` ascending by code unit. The stage sorts explicitly rather than trusting the caller's array order, even though Phase 9 already produces that ranking, so a hand-assembled set allocates exactly like one that came through the pipeline (INV-ALLOC-005).

For each candidate the category maximum is checked **first**. A candidate whose category is already at `maxBlocks` is excluded with `EXCLUDED_CATEGORY_MAXIMUM` and spends nothing, so the tokens stay available to the next candidate. Otherwise a candidate that fits is included with `INCLUDED_SCORE_ORDER` and its exact token count is subtracted; a candidate that does not fit is excluded with `EXCLUDED_BUDGET_EXHAUSTED` and traversal continues, so a large high-score candidate never stops smaller lower-score ones from being considered.

This is deliberately **not** knapsack, dynamic programming, integer programming, beam search, maximum-total-utility optimization, or stochastic sampling. A greedy pass over the score ranking Phase 9 already produces is simple, deterministic, explainable, and a stable baseline for evaluation; an optimization strategy may be added later, under a new policy schema version, only if benchmarks prove the need (METRICS 7).

### No Score-Per-Token

`score.total` is never divided by `tokenCount`, no token cost is subtracted from a score, and no lower-score candidate is preferred for a better ratio. Scoring and allocation stay separate responsibilities: a ratio would silently optimize a different objective than the one Phase 9 composed and DEC-032 documented.

The one place token cost outranks score is the hard-minimum selection above, where it is a feasibility calculation with a proof, not a utility preference.

### Every Candidate Leaves With One Machine-Readable Decision

Every scored candidate appears exactly once across `included` and `excluded` (INV-TRACE-001), carrying one reason code (INV-TRACE-002):

```text
INCLUDED_REQUIRED
INCLUDED_CATEGORY_MINIMUM
INCLUDED_SCORE_ORDER
EXCLUDED_CATEGORY_MAXIMUM
EXCLUDED_BUDGET_EXHAUSTED
```

Free text is never the primary contract. Each included decision also carries its exact `contentTokens`, `remainingBefore`, and `remainingAfter`, which always differ by exactly `contentTokens`; each excluded decision carries the unchanged `remainingTokens`, because an exclusion spends nothing.

`selectedBlockContentTokens` is the exact sum of the included canonical token counts and `unallocatedBlockContentTokens` is exactly `availableInputTokens - selectedBlockContentTokens`. Nothing is estimated, and no wrapper or duplicate member is counted a second time (INV-TRACE-003). The result reconciles those properties before it is returned, and an accounting defect fails with `invalid_allocation_result` rather than returning numbers a later trace could not reconcile.

The included array is **allocation chronology** — required blocks, then category minimums, then score-ordered optional blocks — and the excluded array is optional traversal order. Neither is final render order: `ContextOrderer` owns that in a later phase. The result is trace-ready but is not a `CompilationTrace`, which remains unimplemented.

### The Optional Eviction Order Is Precomputed and Safe

INV-ALLOC-006 requires a deterministic removal order for the moment rendering overruns the budget. Phase 10 precomputes it and removes nothing itself.

Starting from the complete successful selection, included **optional** candidates are considered in reverse utility order — `score.total` ascending, then `canonicalBlock.id` descending by code unit — against a simulated count per exact category. A candidate enters the order only when removing it would leave its category at or above `minBlocks`; otherwise it is skipped as protected by the hard minimum.

Required blocks never appear, at any position. A maximum restricts inclusion, not removal, so it never protects a block here: eviction only has to preserve required blocks and minimums.

Two consequences follow. Ordinary optional surplus is given back before higher-utility content, and a block first included to satisfy a minimum can still become evictable once later selections created surplus in its category.

### The Eviction Order Is a Safe Removal Order, Not a Feasibility Proof

Every prefix of `optionalEvictionOrder` may be removed from the current selection without removing a required block and without dropping any configured category below `minBlocks`. Applying the whole order, like applying any prefix, preserves both guarantees. That makes it the cheap correction path whenever giving back currently selected optional surplus is enough to make the rendered context fit.

It proves nothing beyond that, and in particular it is **not** a proof of rendered infeasibility. Exhausting the order shows only that no more *currently selected* optional surplus can be removed while the current hard constraints hold. It does not show that no different allocation satisfies the final rendered budget.

The gap is the one this decision has been careful about throughout: hard minimums are satisfied at minimum **canonical block content** cost, while INV-BUDGET-002 measures the rendered string, whose per-block overhead — source labels, headings, separators and wrappers, emitted metadata — may differ between blocks. A block that is cheapest by `tokenCount` can therefore be more expensive once rendered than another candidate of the same category.

Concretely, with `availableInputTokens` of 2 and `facts` requiring one block:

```text
candidate A   content 1 token   rendering overhead 2   rendered cost 3
candidate B   content 2 tokens  rendering overhead 0   rendered cost 2
```

Phase 10 correctly reserves A as the minimum-content-cost candidate for the minimum. B is then not selected by the optional pass, because no block-content budget remains. A is protected by `minBlocks`, so it cannot enter the eviction order. An orchestration that consumed the whole order and then failed would report infeasibility — while B alone satisfies the same minimum inside the rendered budget. "Eviction order exhausted, therefore infeasible" is a false inference.

Consequently, when protected category-minimum blocks remain and rendering still overruns, future orchestration must be free to reconsider those hard-minimum choices against actual rendered cost, or otherwise prove that no allocation fits, before returning a structured failure. It may declare rendered infeasibility immediately only when the remaining protected set is unavoidable under the active policy — required content once every evictable optional block is gone, for instance — or after a future render-aware feasibility procedure has proved that no alternative allocation fits.

Phase 10 implements no render-aware replacement or reallocation, adds no rendering cost, and takes no renderer dependency. It supplies the safe order and states its limits.

This does not weaken `category_minimums_exceed_content_budget`. That failure is a real **block-content** infeasibility: the selection it could not fit is the cheapest canonical content satisfying the minimums, so no other selection satisfying them fits the content ceiling either, and rendering overhead can only add to the cost.

The distinction to keep is:

```text
block-content feasibility  is not  rendered feasibility
safe eviction prefix       is not  complete render-aware allocation search
```

### Stable Ordering and Preserved Metadata

Candidates are traversed in a canonical order — canonical block ID, then a canonical serialization of the canonical block — before any comparator runs, so every remaining tie resolves identically whatever order the caller supplied. `localeCompare` is never used: its result depends on the machine's locale and on the ICU data the runtime was built with.

`sourceDocuments` is returned in `id` ascending order, copied before sorting so the caller's registry is never reordered in place, and this stage does not rely on Phase 9 having sorted it. `scope`, `referenceTime`, the scoring policy identity, and every `ScoredCandidate` and `CandidateScore` object are carried through unchanged and by reference (INV-ALLOC-004). The scoring policy identity and the allocation policy identity are published separately, so a later trace can name both (INV-TRACE-005).

`BudgetAllocator` reads only `ScoredCandidate.score.total` and the canonical block's required flag, category, token count, and identifier. It never reads raw retrieval values, score component evidence, timestamps, authored priority, source priority, or recency directly, which keeps `CandidateScorer` the sole owner of score composition.

### One Structured Error

`BudgetAllocationError` carries the stable code `BUDGET_ALLOCATION_FAILED` and project-owned `ValidationIssue[]`. No validation-library error, `DomainValidationError`, provider error, or implementation exception crosses the boundary (INV-ADAPTER-001, INV-ADAPTER-003).

```text
invalid_policy
duplicate_category_constraint
invalid_budget
required_content_exceeds_budget
required_category_maximum_exceeded
category_minimum_unreachable
category_minimums_exceed_content_budget
invalid_allocation_result
```

A policy schema failure short-circuits duplicate detection, and an invalid budget fails before allocation, because both would otherwise leave later rules guessing. Once the policy and the budget are valid, the category count impossibilities — unreachable minimums and required-versus-maximum conflicts — are collected together, in category order, before failing. Budget infeasibility is then reported deterministically from a canonical traversal. No partial `AllocatedCandidateSet` is ever returned.

Issues address a constraint by its exact category and a candidate by its stable canonical block identifier rather than by array position, so a permuted input produces a byte-identical issue set (INV-DET-002, INV-ALLOC-005).

### The Result Is an Ephemeral Stage Object

`AllocatedCandidateSet`, `IncludedCandidateDecision`, and `ExcludedCandidateDecision` are compiler-owned readonly interfaces, produced and consumed inside one compilation and never persisted. They carry no `schemaVersion`, because that field marks persisted domain records (INV-STORE-004). The policy does carry one, because it is external configuration a caller stores.

No `Map`, `Set`, `Date`, mutable array, canonical-JSON helper, comparator, validation-library type, tokenizer type, or provider SDK type reaches the public surface (INV-ADAPTER-001). No `ContextBlock` is mutated or synthesized: the allocator selects blocks, it does not rewrite them.

### Consequences

`@ctxalloc/compiler` gains a fourth published stage and no new dependency: `BudgetAllocator` needs only `@ctxalloc/domain` types and functions, the existing validation library, and two compiler-internal helpers. The boundary allowlist is unchanged, and `@ctxalloc/application` and `@ctxalloc/tokenization` remain absent from the kernel.

Phases 7, 8, and 9 are unchanged in behavior. `CandidateScorer` still performs no allocation, reads no budget, and ranks exactly as before.

A deployment that configures category constraints now gets hard guarantees with structured failures instead of best-effort behavior, and one that supplies impossible required content fails loudly at the block-content stage rather than at render time.

`CandidateFilter` remains future work and its orchestration placement remains undecided, as recorded by DEC-032. `ContextOrderer`, `ContextRenderer`, final rendered token validation, the render/evict/re-render orchestration, final `unusedTokens`, `CompilationTrace`, `ContextCompiler`, the full `CompilationPolicy`, retrieval, persistence, the CLI, and the HTTP API remain later phases.

---

## DEC-034: Order Selected Context by Stable Source Position Before Rendering

### Status

Accepted

### Decision

Deterministic context ordering is the fifth stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `ContextOrderer`, one synchronous, pure, offline class that turns an `AllocatedCandidateSet` and one narrow versioned `ContextOrderingPolicy` into an `OrderedCandidateSet`.

Its only injected dependency is the policy. It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, calls no tokenizer, calls no renderer, reads no clock, and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002).

It does not include, exclude, or evict a candidate, re-run allocation, score, deduplicate, filter, render, tokenize, estimate rendering overhead, or build a trace.

### Allocation Chronology Is Not Render Order

Phase 10 returns its inclusions in the order the budget was spent: required blocks, then category minimums, then score-selected optional blocks (DEC-033). That sequence records how the allocation was reached, and says nothing about how the content should read.

Four sequences now exist across the kernel, and they answer deliberately different questions:

```text
score ranking          how useful is this candidate                  Phase 9
allocation chronology  in what order was the budget spent            Phase 10
optionalEvictionOrder  what may be given back if rendering overruns  Phase 10
render order           where does this content belong when read      Phase 11
```

They are distinct **semantic** sequences, not disjoint ones. Render order and allocation chronology hold exactly the same decisions, so each is literally a permutation of the other; `optionalEvictionOrder` holds a subset of those block identifiers; and the score ranking also covers candidates allocation excluded, so it is wider than all three. What separates them is that their ordering rules answer different questions, so none may be inferred or derived from another — not that their element sets differ.

Leaving the renderer to sort for itself was rejected. Presentation would then be an implicit side effect of whichever array order happened to reach it, and INV-RENDER-001 requires the same ordered blocks and rendering policy to produce the same string — which presumes that "the ordered blocks" is something a stage decided, explicitly and reproducibly. So one stage owns render order, and it owns nothing else.

### A Narrow Versioned Ordering Policy

As in DEC-032 and DEC-033, the broad future `CompilationPolicy` of ARCHITECTURE 5.6 is not built here. Only the ordering slice exists:

```ts
interface ContextOrderingPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly strategy: 'source-document-then-location';
}
```

`strategy` names the rule explicitly rather than leaving it implicit, so a future strategy — interleaving several sources, grouping by category, placing required content first, or a conversation-aware layout — arrives as a policy value under a new schema version rather than as a silent change of what this one means.

Policy validation is strict and is a runtime boundary: the object is closed, unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, exact strings are preserved, `policyId` and `policyVersion` must be non-blank, and malformed UTF-16 is rejected with the shared domain helper (INV-BLOCK-007).

### The v1 Order

The complete key, applied to canonical blocks only:

```text
1. sourceDocumentId ascending, by UTF-16 code unit
2. position inside that source document
3. block ID ascending, by UTF-16 code unit
```

Grouping by source document first keeps one document's blocks contiguous, so the reader meets a source once rather than in fragments scattered through the context. The identifier is opaque (DEC-028), so its ascending order is a **stable grouping key, not a claim about which document matters more**. Ranking documents would need a policy that does not exist; inventing one here would smuggle a relevance decision into a layout stage.

Position inside a source is the source's own chronology:

**Text and Markdown** (`text-range`): `startOffset` ascending, then `endOffset` ascending, then the block identifier. Nothing else.

Offsets are the chronology of a text source: they state exactly where the block sat in the original content. Nothing is inferred from content, heading path, or timestamps, and `headingPath` in particular is provenance rather than sequence — two sections can share one heading path.

`startLine` and `endLine` deliberately take no part in ordering. They stay in `SourceLocation` as provenance, and `CandidateValidator` still validates them; they simply are not an ordering signal in schema version 1.

The first version of this decision compared them "only when both blocks carry one", and that rule was wrong. It is not transitive, so it is not an ordering at all. With identical offsets in one source:

```text
a   offsets 10-20   lines 2-2
b   offsets 10-20   no lines
c   offsets 10-20   lines 1-1
```

`a < b` and `b < c` both fell to the identifier, because `b` records no line; `c < a` came from the lines. The three results cannot hold together. A comparator with a cycle makes `Array.prototype.sort` an implementation detail rather than a contract — the specification leaves the result implementation-defined — so the stage would have promised a determinism it did not have (INV-DET-001, INV-DET-002, INV-DET-005).

Ranking presence instead — every block with lines before every block without — is transitive, but it lets optional metadata completeness decide the layout: re-indexing a source with a producer that records lines would move blocks that did not change. Offsets already establish position exactly, so the line fields are redundant for this purpose, and ignoring them is the only v1 rule that is both a genuine total order and independent of which producer filled in optional provenance.

**Conversation** (`conversation-message`): a message stating `messageIndex` precedes one that does not; two indexed messages compare by `messageIndex`, then `messageId`, then block ID; two unindexed messages compare by `messageId`, then block ID.

`messageIndex` is the conversation's chronology. `messageId` is a deterministic fallback and nothing more: it is compared by code unit and never parsed for an embedded timestamp, sequence number, or ordering convention, because a provider's identifier format is not a contract this compiler owns. That means `m-10` precedes `m-2`, which is deliberate — a fallback must be reproducible, not clever.

**Absent location**: located blocks of a source come before its unlocated ones, and unlocated blocks are ordered by block ID alone. A block that does not state where it came from does not get a position guessed for it (INV-PROV-002). Unlocated blocks stay inside their own source group rather than being pushed to the end of the whole context.

### What Does Not Order

Score, required status, allocation reason, category, timestamps, heading path, retrieval and provider data, source titles and metadata, duplicate members, and input array position are all absent from the comparator.

A high-scoring block renders late when its source position is late. A required block renders after an optional one from the same source. `INCLUDED_REQUIRED`, `INCLUDED_CATEGORY_MINIMUM`, and `INCLUDED_SCORE_ORDER` produce identical layouts. Duplicate members are provenance carried on the group, and Phase 8 already chose the one canonical block that will be rendered, so a duplicate's location never moves the canonical block.

Placing required content first was considered and rejected for v1: it is a presentation policy with its own trade-offs, it would break source coherence, and it belongs in a later strategy value rather than in the one rule this schema version defines.

### The Result Nests the Allocation

```ts
interface OrderedCandidateSet {
  readonly allocation: AllocatedCandidateSet;
  readonly orderingPolicyId: string;
  readonly orderingPolicyVersion: string;
  readonly orderedIncluded: readonly IncludedCandidateDecision[];
}
```

Nesting is deliberate. Every Phase 10 fact — scope, source registry, both earlier policy identities, reference time, the budget, the block-content metrics, the excluded decisions with their reasons, and `optionalEvictionOrder` — stays reachable, unchanged, and stated once. Copying those fields into a second stage type would create two places for one truth to drift (INV-DEP-003). The single new semantic fact is `orderedIncluded`.

`orderedIncluded` holds exactly the objects of `allocation.included`, by reference, permuted. It is a copy of that array, sorted, so by construction every included decision appears once, no excluded decision can appear, no reason can change, and no `ContextBlock` is cloned or synthesized (INV-TRACE-001, INV-ALLOC-002, INV-ALLOC-004). Sorting a copy can neither lose nor invent an element, which is why this stage needs no reconciliation check and publishes one issue code, `invalid_policy`, under `CONTEXT_ORDERING_FAILED`.

**Array position is the whole of the ordering contract.** No index, rank, or position field is written onto a block or a decision: a block's position is a property of one compilation rather than of the block (DEC-026), and a stored index could disagree with the array holding it.

`optionalEvictionOrder` is carried through untouched and is not render order. Viewed by block identity it *is* a subset of this sequence — the currently included optional blocks that are safely evictable — but it answers a different question, what may be given back if rendering overruns, and its relative order comes from eviction policy rather than from source position. Neither sequence may be derived from the other.

### Determinism

Ordering depends only on the supplied allocation and the validated policy. `localeCompare` and `Intl.Collator` are never used: their results depend on the machine's locale and on the ICU data the runtime was built with.

Every comparator ends in the stable block identifier. For a hand-assembled internal input that carries one identifier on two different canonical records, the existing canonical serialization is the final tie-break, so the result is a total order rather than a sort-stability artifact (INV-DET-005). A batch that came through `CandidateValidator` cannot reach that branch, because the validator rejects one block ID standing for two records (DEC-030).

The comparator is likewise total for a defensive input mixing location kinds inside one source document — `text-range` before `conversation-message`. `CandidateValidator` already enforces kind and source-type compatibility, and this stage does not revalidate it: it is not a second validator, but its comparator must still be a function.

### Trace Readiness Without a Trace

The result exposes the ordering policy identity and the final ordered sequence, which is what a future `TraceBuilder` needs to state how the rendered context was laid out (INV-TRACE-004, INV-TRACE-005). `CompilationTrace` itself is not implemented.

### Consequences

`@ctxalloc/compiler` gains a fifth published stage and no new dependency: `ContextOrderer` needs only `@ctxalloc/domain` types, the existing validation library, the Phase 10 stage types, and one compiler-internal helper. The boundary allowlist is unchanged.

Phases 7 through 10 are unchanged in behavior. No metric is added: an ordering stage produces no measurement, and METRICS gains nothing merely because a stage exists.

`ContextRenderer`, the rendering policy, final rendered token measurement, the render/evict/re-render orchestration, `CandidateFilter`, the broad `CompilationPolicy`, `CompilationTrace`, `ContextCompiler`, retrieval, persistence, the CLI, and the HTTP API remain later phases. The final rendered budget stays future work: nothing here brings INV-BUDGET-002 any closer to being satisfied.

---

## DEC-035: Render Ordered Context as Boundary-Safe JSONL and Measure the Exact String

### Status

Accepted

### Decision

Deterministic context rendering is the sixth stage of the compiler kernel. It lives in `@ctxalloc/compiler` as `ContextRenderer`, one synchronous, pure, offline class that turns an `OrderedCandidateSet`, one narrow versioned `ContextRenderingPolicy`, and one project-owned `Tokenizer` into a `RenderedContextAttempt`.

Its only injected dependencies are the policy and the tokenizer port. It reads no file, opens no socket, queries no database, calls no model, calls no retrieval provider, reads no clock, and generates no random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). It constructs no tokenizer implementation of its own and imports none: `@ctxalloc/tokenization` is not a compiler dependency (INV-ADAPTER-001).

It does not include, exclude, evict, or replace a candidate, re-run allocation or ordering, score, deduplicate, filter, or build a trace.

### A Render Attempt Is Not a Successful Compilation

This is the decision's central boundary.

`ContextRenderer` measures the rendered cost of the **current** selection. That measurement may exceed the budget:

```text id="r1atmp"
renderedTokens > availableInputTokens
```

That is not a renderer error. The result reports it as `fitsAvailableInputBudget: false` and returns normally.

Owning correction here was rejected. The loop that consumes safe optional eviction candidates, re-orders the revised selection, renders again, reconsiders protected category-minimum choices against actual rendered cost, proves final infeasibility, and returns a success or a structured failure is a different responsibility with a different failure model, and INV-DEP-003 forbids two components owning one responsibility. So the renderer never evicts an optional block, never drops a required block, never replaces a category-minimum choice, never calls `BudgetAllocator` or `ContextOrderer`, never raises `REQUIRED_CONTENT_EXCEEDS_BUDGET`, and never fails merely because this attempt is too large.

For the same reason the result is not a `CompilationResult` and its names say so. `renderedTokens` is not `compiledTokens` (METRICS 8.4). No `unusedTokens`, `tokenReduction`, or `budgetUtilization` appears, because each is defined against a `compiledTokens` that only a settled selection has, and no token delta appears, for the separate reason given below.

### The Non-Negative Rendering Overhead Metric Was Wrong

METRICS 8.6 previously defined:

```text id="r2ovhd"
renderingOverheadTokens
  = compiledTokens - includedContentTokens
```

and required the value to be non-negative. That requirement is withdrawn.

The `Tokenizer` port promises exactly one thing: the exact count of one supplied string. It does not promise additivity:

```text id="r3addv"
tokenizer(a + b)
  is not necessarily
tokenizer(a) + tokenizer(b)
```

A subword vocabulary can merge or split differently once content is embedded in a larger string, so the difference between the compiled total and the sum of individual block counts can move in either direction. Nothing in the port, and nothing in a general tokenizer, makes that difference a count of "static overhead".

Forcing the implementation to satisfy the old rule would have meant clamping a real measurement, reporting a value the tokenizer did not produce, or attributing token counts to labels and separators that cannot be attributed. All three break INV-BUDGET-002 in spirit: they publish arithmetic instead of measurement.

The metric is therefore renamed and redefined as a signed `renderingTokenDelta`:

```text id="r4dlta"
renderingTokenDelta
  = compiledTokens - includedContentTokens
```

It may be negative, zero, or positive; it is never clamped; and a negative value is valid, not an error. It is diagnostic only and must not be read as an additive attribution of wrapper, separator, source-label, or heading tokens. No exact token count is attributed separately to any part of the rendered string.

All rendering text is nevertheless inside the rendered string, and that string is what gets tokenized, which is exactly what INV-RENDER-004 requires. The only budget source of truth remains `tokenizer(finalRenderedContext)`.

### Phase 12 Publishes No Attempt Delta

An earlier draft of this decision had `ContextRenderer` publish the same quantity for one attempt, as `renderedTokens - selectedBlockContentTokens`. That is removed, because this stage cannot justify the subtraction from its own accepted inputs.

The two operands need not share a unit:

* `renderedTokens` is produced by the tokenizer injected into `ContextRenderer`;
* `selectedBlockContentTokens` sums `ContextBlock.tokenCount` values that `CandidateValidator` checked under whichever tokenizer it was given.

No stage contract from `ValidatedCandidateSet` through `DeduplicatedCandidateSet`, `ScoredCandidateSet`, and `AllocatedCandidateSet` to `OrderedCandidateSet` carries a tokenizer identity, so the renderer has nothing to compare against and cannot detect a mismatch, let alone label one.

A manually miscomposed chain makes the failure concrete:

```text id="r9mism"
CandidateValidator with tokenizer  id "tok-A" version "1"
  countTokens(block content) = 100
BudgetAllocator publishes
  selectedBlockContentTokens = 100

ContextRenderer with tokenizer     id "tok-B" version "1"
  countTokens(complete rendered string) = 10

renderedTokenDelta would be -90
```

`-90` does not mean rendering saved 90 tokens. It is the difference between two vocabularies, reported in the units of neither. Publishing it would be worse than publishing nothing, because a consumer has no field with which to discover that the number is meaningless.

The rule that a future composition root will use one tokenizer is correct, and it is recorded below — but it is a promise about a component that does not exist, and it does not license this stage to publish a number now that its own inputs do not support.

Several repairs were considered and rejected. An optional number, `null`, or `NaN` moves the problem to every consumer and still offers no way to tell "not comparable" from "not measured". A boolean claiming the counts are probably comparable states a guess as a fact. A caller-supplied tokenizer identity is unverifiable: a miscomposing caller is exactly the one who would supply the wrong value. And propagating a tokenizer identity through five published stage contracts, in Phase 12, purely so this stage can expose an early diagnostic, is not a justified redesign when the composition root must own the invariant regardless.

Phase 12 therefore publishes only what it can prove from its own inputs: `renderedContext`, `renderedTokens`, `fitsAvailableInputBudget`, the renderer identity, the tokenizer identity, and the ordered set and rendering-policy identity. Nothing is lost: `selectedBlockContentTokens` stays reachable through the nested allocation, and the delta is needed for none of exact rendering, INV-BUDGET-002 measurement, the budget observation, or any future correction decision. It is deferred, not discarded — the final `renderingTokenDelta` arrives once comparability is established, in the component that establishes it.

### A Narrow Versioned Rendering Policy

As in DEC-032, DEC-033, and DEC-034, the broad future `CompilationPolicy` of ARCHITECTURE 5.6 is not built here. Only the rendering slice exists:

```ts
interface ContextRenderingPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly format: 'jsonl-blocks';
}
```

`format` names the wire shape explicitly, so a second format arrives as a policy value under a new schema version rather than as a silent change of what this one means.

Policy validation is strict and is a runtime boundary: the object is closed, unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, exact strings are preserved, `policyId` and `policyVersion` must be non-blank, and malformed UTF-16 is rejected with the shared domain helper (INV-BLOCK-007).

### The v1 Format: JSON Lines

One canonical JSON object per included block, joined by exactly one LF (`\n`). No prefix, no suffix, no enclosing array brackets, no trailing newline, and no blank separator line.

The consequences are the point: one physical line is exactly one block, the fixed overhead is minimal, there is no wrapper around the stream, and an empty selection renders as the exact empty string rather than as `[]` or a stray newline.

Each record carries exactly these fields:

```text id="r5recs"
blockId              canonicalBlock.id
content              canonicalBlock.content
headingPath          only when the canonical block carries it
sourceDocumentId     canonicalBlock.sourceDocumentId
sourceType           canonicalBlock.sourceType
```

Key order comes from the existing compiler-internal canonical serializer, so object property insertion order cannot change the output (INV-DET-002).

Score, retrieval data, allocation reason, required status, category, priority, timestamps, arbitrary block metadata, arbitrary `SourceDocument.metadata`, source title, `tokenCount`, `normalizedContentHash`, and policy internals are excluded. They are compiler control and provenance data, not model context: they spend budget, they invite a model to reason about the compiler's own decisions rather than about the content, and arbitrary source metadata is untrusted text that has no business in a prompt without a stated purpose (INV-SEC-001).

### sourceDocumentId Is the v1 Source Label

Every rendered block visibly names its source (INV-RENDER-003), and in v1 that name is `sourceDocumentId`.

It already exists on every trusted canonical block, it is stable project-owned identity (DEC-028), it needs no registry lookup during rendering, and it cannot drift from an optional title. `SourceDocument.title` was rejected for v1: it is optional, it is human-authored, and a label that sometimes exists is not a stable label. A human-readable title is a future rendering-policy version.

### JSON Escaping Is the Boundary Mechanism

A raw delimiter protocol was rejected outright:

```text id="r6delm"
--- block ---
<content>
--- end ---
```

Arbitrary source content can contain any delimiter, so such a format lets content forge a block boundary. The mitigation would be an escaping scheme, and inventing one is strictly worse than using the one that already exists.

Because `content`, `headingPath` entries, and every identifier are encoded as JSON strings, embedded newlines, quotes, and backslashes are escaped. Source content therefore cannot manufacture another top-level JSONL record, and metadata or heading text cannot break the format (INV-RENDER-002). The physical record count always equals the included block count.

### Rendering Is Serialization, Not Rewriting

The canonical `ContextBlock.content` is unchanged in the domain object, and for every rendered line:

```text id="r7trip"
JSON.parse(line).content === canonicalBlock.content
```

exactly. No trimming, no Unicode normalization, no line-ending normalization, no truncation, no summarization, and nothing escaped written back into the block (DEC-014, INV-PROV-004, INV-RENDER-005). Escape sequences inside the serialized string are representation, not mutation of source content. CRLF, tabs, quotes, backslashes, Markdown, fenced code, text resembling a JSON object, text resembling a forged block boundary, supplementary Unicode, and emoji all survive byte for byte.

`headingPath` is emitted exactly as carried: absent omits the key, an explicitly empty array is preserved as `[]`, and values are escaped like any other string. Nothing is synthesized from content or source location, and the path is not turned into Markdown heading text in v1.

### The Renderer Obeys the Order It Is Given

Records follow `OrderedCandidateSet.orderedIncluded` exactly. The renderer does not sort, group, or consult source location, score, required status, or `optionalEvictionOrder`. `ContextOrderer` owns render order (DEC-034), and array position is authoritative here (INV-RENDER-001).

Every ordered included decision is rendered exactly once, no excluded decision is rendered, no block is added, cloned, or mutated, and the `OrderedCandidateSet` is carried in the result by reference (INV-ALLOC-002, INV-ALLOC-004, INV-TRACE-001).

### Exact Full-String Measurement

After the complete `renderedContext` is constructed, `tokenizer.countTokens(renderedContext)` is called on exactly that string, exactly once per `render()`.

The count is never derived by summing block `tokenCount`, summing per-record counts, summing separator counts, estimating JSON escaping, counting characters, or reusing `selectedBlockContentTokens`. The full string is the source of truth (INV-BUDGET-002), and it is what includes every source label, heading path, separator, and escape sequence (INV-RENDER-004).

The returned value is validated before publication: it must be a finite, non-negative, safe integer (INV-BUDGET-005). A tokenizer that throws produces `CONTEXT_RENDERING_FAILED` with `tokenizer_failed`; an unusable count produces `invalid_rendered_token_count`. Neither returns a partial attempt, and neither leaks the provider object or a library exception — a thrown value is described by name and message only (INV-ADAPTER-003, INV-SEC-001).

The tokenizer itself is checked once at construction: it must be a non-null object with a non-blank `id`, a non-blank `version`, and a callable `countTokens`. Identity strings are preserved exactly and never trimmed, because a trace records them verbatim (INV-TRACE-005).

The failure surface is therefore `CONTEXT_RENDERING_FAILED` with `invalid_policy`, `invalid_tokenizer`, `tokenizer_failed`, or `invalid_rendered_token_count`.

### Budget Observation Only

```text id="r8fits"
fitsAvailableInputBudget
  = renderedTokens <= allocation.availableInputTokens
```

No new reserve is subtracted, no model context window is guessed, and the `TokenBudget` is not modified. A `false` value is a successful measurement.

### Cross-Stage Tokenizer Identity Is a Composition Requirement

Counts from different tokenizers are not comparable, and no stage contract from `ValidatedCandidateSet` through `OrderedCandidateSet` carries a tokenizer identity. Redesigning Phases 7 through 11 to add one was rejected: it would change five published stage types to serve a constraint that only the composition root can actually enforce.

The requirement is recorded here instead. **The future `ContextCompiler` composition root must use one configured tokenizer identity and version consistently for `CandidateValidator` block-count validation and for `ContextRenderer` final-string measurement.** A standalone caller that manually composes the stages with different tokenizers is not a valid final compilation.

Phase 12 exposes `tokenizerId` and `tokenizerVersion` on every attempt so the future trace and orchestration can record and enforce that identity. It does not, and cannot, prove cross-stage identity on its own.

That limitation is not merely documented, it is respected: because this stage cannot discharge the same-tokenizer precondition, it publishes no metric that depends on it. Establishing comparability and reporting the final `renderingTokenDelta` are the same component's work (METRICS 8.6).

### Renderer Identity

The result always exposes `rendererId` (`ctxalloc-jsonl`) and `rendererVersion` (`1`). They are project-owned constants: never derived from package manager state, git, the clock, or an environment variable, all of which would make a recorded identity depend on where the code happened to run (INV-DET-003, INV-DET-004, INV-TRACE-005).

### No Final Hard-Budget Guarantee Yet

This phase materially advances INV-BUDGET-002: for the first time an actual complete rendered string is tokenized. It does not discharge the final compiler invariants.

* INV-BUDGET-001 is not satisfied by an over-budget `RenderedContextAttempt`;
* INV-BUDGET-003 and INV-BUDGET-004 still require the future correction and failure behavior for rendered required content;
* INV-BUDGET-006 still has no producer, because final `unusedTokens` does not exist.

Phase 12 supplies the exact measurement primitive. The later orchestration phase will use it until the rendered selection fits or final infeasibility is proven. **"Hard budget guarantee complete" is not a true statement after Phase 12.**

### Consequences

`@ctxalloc/compiler` gains a sixth published stage and no new dependency: `ContextRenderer` needs only `@ctxalloc/domain` types, the `Tokenizer` port, the existing validation library, the Phase 10 and 11 stage types, and two compiler-internal helpers. The boundary allowlist is unchanged.

Phases 7 through 11 are unchanged in behavior.

METRICS changes: 8.6 is renamed and redefined as a signed `renderingTokenDelta` carrying an explicit same-tokenizer validity precondition, 8.4.1 loses its stale cross-reference, and a new 8.4.2 defines the two render-attempt metrics and states why no attempt-level delta joins them.

`CandidateFilter`, the broad `CompilationPolicy`, `CompilationRequest`, render-aware correction and reallocation, `TraceBuilder`, `CompilationTrace`, `CompilationResult`, `ContextCompiler`, retrieval, persistence, the CLI, the HTTP API, and the evaluation harness remain later phases.

---

## DEC-036: Compose Explicit Compilation Contracts and Filter Scored Candidates Before Allocation

### Status

Accepted

### Decision

Three contracts are added to `@ctxalloc/compiler`.

`CandidateFilter` is a deterministic policy eligibility gate that runs **after `CandidateScorer` and before `BudgetAllocator`**. It is one synchronous, pure, offline class that turns a `ScoredCandidateSet` and one narrow versioned `CandidateFilteringPolicy` into a `FilteredCandidateSet`.

`CompilationPolicy` is the broad versioned policy of ARCHITECTURE 5.6, composing the five narrow slices the components already own.

`CompilationRequest` is the complete caller-supplied request data for one compilation, carrying a **required** `referenceTime`.

None of the three retrieves, reads a file, opens a socket, queries a database, calls a model, reads a clock, or generates a random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). No new dependency is added.

### Execution Topology Is Named, Not Numbered

DEC-030 through DEC-035 called the components the first through sixth stages of the kernel. That wording described the order they were *implemented* in, and it was accurate when written.

Inserting `CandidateFilter` between scoring and allocation makes an ordinal unstable: the allocator was "fourth" and is now preceded by five components. Renumbering every decision, document, and TSDoc comment on each insertion would be pure churn, and worse, it would keep encoding position in a label that has to change whenever the pipeline does.

The current topology is therefore defined by component names:

```text id="m1topo"
CompilationRequest validation
  -> CandidateValidator
  -> CandidateDeduplicator
  -> CandidateScorer
  -> CandidateFilter
  -> BudgetAllocator
  -> ContextOrderer
  -> ContextRenderer
  -> render-aware correction   (future)
  -> TraceBuilder              (future)
  -> CompilationResult         (future)
```

Retrieval stays before this flow; model execution stays after it.

The substance of DEC-030 through DEC-035 is unchanged, and their historical ordinal wording is left as written: it is the record of what was decided when. Current source TSDoc and current architecture text name a component's predecessor and successor instead. ARCHITECTURE documents the filter as section 6.3.1 rather than renumbering 6.4 through 6.7, for the same reason: a section number is a document address, and four sections' worth of broken cross-references would be a high price for encoding an order that section 4.1 already states.

### The Filter Runs After Scoring and Before Allocation

DEC-031 and DEC-032 fixed one end of the range. Filtering must not run before deduplication, because filtering a group before its duplicates are known would let the surviving copy of one piece of content depend on which wrapper the filter happened to keep. Filtering may run before or after scoring without changing any surviving candidate's score, because `CandidateScorer` normalizes against fixed policy ranges rather than against the batch.

Schema version 1 reads `score.total`, which fixes the other end: the filter must run after scoring.

It must also run before allocation. Eligibility is a precondition of selection, not a competitor to it. A filter running after allocation would discard a block the allocator had already spent budget on, and that budget would then be unusable without re-running allocation — which is the correction loop's problem, not a filter's.

### Filter Owns Eligibility; Allocator Owns Selection

This is the decision's central boundary, and it is the reading of INV-ALLOC-002 this phase relies on.

```text id="m2role"
CandidateFilter   may this scored OPTIONAL candidate participate in allocation
                  under policy?

BudgetAllocator   among the eligible candidates, which ones are included under
                  required, category, and budget rules?
```

The filter therefore owns no required resolution, no category constraint, no token budget, no eviction, no rendering, and no final hard-budget success. It removes a candidate from consideration under a stated rule and records why; everything that reaches the allocator is selected, or not, by the allocator alone. INV-ALLOC-002 gains a clarifying paragraph saying exactly this. Its normative content is unchanged: the invariant already named retrieval providers, renderers, source adapters, and model providers as the actors that must not decide inclusion, and a kernel policy component is none of them.

`CandidateFilter` is also **not an access-control boundary**. Scope isolation stays with request validation and `CandidateValidator`, which reject a cross-scope candidate outright rather than scoring one and then declining to allocate it (INV-SCOPE-003, INV-SCOPE-004, INV-SEC-004). A filter that doubled as a scope check would put one security rule in two places, and the weaker of the two would eventually be the one that ran.

### The v1 Filtering Language Is One Threshold

```ts
const CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION = 1;

interface CandidateFilteringPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly minimumTotalScore?: number;
}
```

That is the entire language. Excluded block identifiers, source allowlists and denylists, category allowlists and denylists, `sourceType` rules, timestamp or maximum-age rules, retrieval provider, rank, or raw-score rules, content or token-size rules, regular expressions, metadata or tag predicates, and arbitrary callback predicates are all deliberately absent.

**Hard exclusion is deferred because post-deduplication group semantics are undecided.** Filtering runs after exact deduplication (DEC-031), so its unit is a duplicate group, and a group's members may carry the same content from different source documents, under different categories, from different providers. "Exclude source X" over such a group has at least three defensible meanings — drop the group if any member is from X, only if every member is, or drop the member and keep the group — and they disagree on exactly the cases that matter. Choosing one silently would make the surviving copy of one piece of content depend on which wrapper the filter happened to inspect, which is the failure DEC-031 exists to prevent. The language will be decided when those semantics are, not approximated now.

**Recency, source, category, authored priority, and retrieval relevance already have an owner.** They are configured signals of `CandidateScoringPolicy`, and they reach this component already normalized into one group-level `score.total`. Reading any of them again here would put one signal under two owners and let the two disagree (INV-DEP-003). Version 1 consumes the scorer's result and nothing else.

Policy validation is strict and is a runtime boundary: the object is closed, unknown fields are rejected rather than stripped, nothing is coerced, no default is injected, exact strings are preserved, `policyId` and `policyVersion` must be non-blank, and malformed UTF-16 is rejected with the shared domain helper (INV-BLOCK-007). `minimumTotalScore` must be a finite number no less than zero: a total is a sum of non-negative weighted contributions, so a negative threshold could only be a no-op written by someone who believed it did something. The failure surface is `CANDIDATE_FILTERING_FAILED` with `invalid_policy`.

### Threshold Semantics Are Policy-Relative, and Equality Survives

```text id="m3thrs"
minimumTotalScore absent   every scored candidate stays eligible

minimumTotalScore present  optional candidate survives when
                             score.total >= minimumTotalScore
                           optional candidate is filtered when
                             score.total <  minimumTotalScore
```

Equality survives: a candidate that reaches the minimum has met it. Nothing is rounded, clamped, normalized, interpreted as a probability, or divided by a token count. Score-per-token selection is allocation economics, and it belongs to the allocator if it belongs anywhere.

`CandidateScore.total` is policy-relative utility, not a probability. Its weights need not sum to one (DEC-032, INV-SCORE-001), so `0.4` means nothing on its own — it means something only against the scoring policy that produced the totals. Both identities therefore travel in the result, and a threshold copied between scoring policies is a configuration error the compiler cannot detect for the caller.

### Required Blocks Bypass the Threshold

A candidate whose canonical block declares `required: true` stays eligible whatever it scored. A required block scoring exactly zero survives a threshold of one thousand.

It is not filtered, not failed, and not boosted. Boosting in particular is rejected: modelling required status as a large score is exactly what INV-SCORE-003 forbids, and it would make the score field lie about what the scoring policy computed. Required content is a separate allocation class, and a policy threshold is not permitted to remove it (INV-BUDGET-003). Whether the required content actually fits remains the allocator's question, answered with `REQUIRED_CONTENT_EXCEEDS_BUDGET` (INV-BUDGET-004).

### One Decision Per Scored Candidate

```text id="m4decs"
eligible   ELIGIBLE_REQUIRED             required block; threshold not consulted
eligible   ELIGIBLE_POLICY               optional block the policy admits
filtered   FILTERED_SCORE_BELOW_MINIMUM  optional block below the minimum
```

An `ELIGIBLE_POLICY` decision carries the exact `scoreTotal`, and `minimumTotalScore` exactly when the policy configured one — so a consumer can tell a candidate that passed a threshold from one that faced none, without re-reading the policy. A `FILTERED_SCORE_BELOW_MINIMUM` decision carries both operands.

An `ELIGIBLE_REQUIRED` decision carries neither. Neither took part in the decision, and publishing them would suggest a comparison this component deliberately never made. The score stays reachable through the decision's own candidate.

The three shapes are separate types in a discriminated union, so an impossible pairing — a filtered candidate claiming an eligible reason, a required bypass carrying a threshold it never faced, a filtered decision with no minimum to be below — cannot be constructed.

### The Filtered Set Preserves Everything

```ts
interface FilteredCandidateSet {
  readonly scored: ScoredCandidateSet;
  readonly filteringPolicyId: string;
  readonly filteringPolicyVersion: string;
  readonly eligible: ScoredCandidateSet;
  readonly decisions: readonly CandidateFilteringDecision[];
}
```

`scored` is the input by reference, so every candidate stays reachable whether or not it survived, and every one of them appears in exactly one decision (INV-TRACE-001).

`eligible` is a `ScoredCandidateSet` rather than a new stage type, and that is deliberate: **`BudgetAllocator` consumes it directly, with no change to its API.** Its scope, source registry, scoring policy identity and version, and reference time are the input's own values; only `candidates` differs, and every surviving `ScoredCandidate` is reused by reference (INV-ALLOC-004). The structure is ephemeral and carries no schema version (INV-STORE-004).

Filtering is a **stable filter, not a re-ranking**. `CandidateScorer` owns the ranking, so survivors keep their relative input order and the decisions follow input order. Nothing is sorted here and the scorer's comparator is not duplicated (INV-DET-002, INV-DEP-003).

The component reads exactly three things: `score.total`, `canonicalBlock.attributes.required`, and its own validated policy. It takes no tokenizer, and it reaches no raw retrieval field, rank, provider identity, source metadata, title, `sourceType`, category, authored priority, timestamp, `tokenCount`, token budget, rendered cost, query, clock, filesystem, environment, database, or model.

### CompilationPolicy Composes Five Required Slices

```ts
const COMPILATION_POLICY_SCHEMA_VERSION = 1;

interface CompilationPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scoring: CandidateScoringPolicy;
  readonly filtering: CandidateFilteringPolicy;
  readonly allocation: BudgetAllocationPolicy;
  readonly ordering: ContextOrderingPolicy;
  readonly rendering: ContextRenderingPolicy;
}
```

All five are **required**, and none is defaulted. Every slice changes what gets compiled, and a policy that silently inherited a rule nobody wrote would make two callers who supplied identical configuration disagree about what they had asked for. A compilation that filters nothing is an explicit filtering slice with `minimumTotalScore` absent: a stated no-op, not a missing key.

`policyId` and `policyVersion` identify the **composition**, independently of the nested identities, and need not equal any of them. A team that revises only its rendering slice publishes a new parent version while the scoring slice keeps its own. No identifier, version, hash, or fingerprint is generated anywhere in this phase (INV-DET-003).

**Nested validation reuses stage-owned semantics rather than restating them.** The broad wrapper is validated strictly — closed object, exact schema version, non-blank well-formed identity, five present object slices — and each slice is then validated by the component that owns its rules. Reproducing `CandidateScoringPolicySchema` or the allocator's duplicate-category rule here would create a second place for one truth to drift (INV-DEP-003).

Delivering that required one small internal change: each component's existing policy parsing now lives in a package-internal helper that the component's own constructor calls, so the composed validator and the constructor are literally the same code path and cannot diverge. The helpers are not re-exported from the package entry point, name no validation-library type, and changed no behavior — the Phase 9 through Phase 12 policy-validation suites pass unchanged, and the composed validator is tested to report byte-identical messages and pointers to the constructors.

A malformed wrapper short-circuits nested validation, exactly as every component reports schema issues before running rules that read fields the schema has not established. Otherwise every problem in all five slices is collected in the fixed order scoring, filtering, allocation, ordering, rendering, and each issue is re-addressed under its slice pointer:

```text id="m5ptrs"
scoring.authoredPriority.min
filtering.minimumTotalScore
allocation.categoryConstraints[0]
ordering.strategy
rendering.format
```

The failure is `COMPILATION_POLICY_INVALID`, with `invalid_policy` for the composition itself and `invalid_scoring_policy`, `invalid_filtering_policy`, `invalid_allocation_policy`, `invalid_ordering_policy`, or `invalid_rendering_policy` for a named slice. No nested error object escapes.

**`CompilationPolicy` is data, not orchestration.** It stores no component instance, owns no tokenizer, runs no component, and decides nothing. Composing the components stays the future `ContextCompiler`'s work; this record only states what that composition would be configured with.

### CompilationRequest Carries an Explicit Reference Time

```ts
const COMPILATION_REQUEST_SCHEMA_VERSION = 1;

interface CompilationRequest {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly query: string;
  readonly referenceTime: Timestamp;
  readonly candidates: readonly CandidateBlock[];
  readonly sourceDocuments: readonly SourceDocument[];
  readonly budget: TokenBudget;
  readonly policy: CompilationPolicy;
}
```

ARCHITECTURE 5.5 previously described a request with no `referenceTime`, which contradicted both `CandidateScorer`, whose `score` requires an explicit instant, and INV-DET-004, which forbids reading the clock. The field is now required, and the future flow is `CandidateScorer.score(batch, request.referenceTime)`. No default is injected: a missing reference time is a rejected request, never `Date.now()`.

`id` is caller-supplied, non-blank, well-formed UTF-16, and preserved exactly. The kernel generates no UUID and no time-derived identifier, because a kernel that invented request identities would produce a different record for the same input on every run.

`query` is preserved verbatim and read by nothing. **An empty query is valid**, and so is a whitespace-only or multi-line one; none of them is trimmed, collapsed, normalized, lowercased, or truncated. A caller may compile standing context with no question at all, and deciding that a blank query is meaningless is the caller's judgement. Only malformed UTF-16 is rejected. No kernel component consults the query: retrieval already answered it, and the compiler must not become a second retrieval system.

`budget` is the existing `TokenBudgetSchema`, with no guessed context window, no defaulted reserve, and no hidden rendering reserve.

### CompilationRequest Is Request Data, Not the Composition Root

An earlier draft of this decision called the request "the complete, self-contained input of one compilation" and said everything a deterministic compilation needs is in the record. That is too strong, and it contradicts two accepted contracts.

INV-DET-001 already defines determinism over more than the request. It lists the compilation request, the candidates, the policy version, **the tokenizer implementation and version**, **the compiler version**, and the supplied reference time. DEC-035 goes further and records deliberately that no stage contract from `ValidatedCandidateSet` through `OrderedCandidateSet` carries a tokenizer identity, and that using one tokenizer consistently is a requirement on the future composition root rather than a property any current component can verify.

The counterexample is concrete:

```text id="m6tokz"
CompilationRequest R, byte-identical in both runs

Run A   configured tokenizer  tok-A / 1
        block counts validated and rendered string measured with tok-A

Run B   configured tokenizer  tok-B / 1
        block counts validated and rendered string measured with tok-B

R is identical; allocation feasibility, renderedTokens, and the selected
result may still differ.
```

Neither run violates INV-DET-001, because the tokenizer input differed. What the example proves is narrower and exact: **the request alone is not the complete deterministic input.** The same holds for the compiler implementation — a new compiler version may change behavior without changing a byte of the request.

The contract is therefore stated as:

```text id="m7dinp"
deterministic input
  = CompilationRequest
  + configured tokenizer identity and version
  + compiler implementation and version
  + any other explicit compiler configuration the invariants allow
```

`CompilationRequest` owns the first line and only the first line: every **caller-supplied, per-compilation** datum — request id, scope, query, reference time, candidates, source registry, budget, and policy.

It owns none of the rest. No tokenizer instance, tokenizer identity or version, compiler implementation or version, renderer instance, or component instance appears on the request, and none is added in this phase.

The division follows from what the value *is*, not from convenience. `referenceTime` belongs in the request because it is per-compilation data: two compilations of the same content legitimately measure recency against two different instants, and only the caller knows which. The tokenizer does not belong in the request because it is configured compiler composition: it is the same for every compilation a given deployment runs, a caller has no way to honestly supply it, and a caller-supplied identity would be unverifiable — the miscomposing caller is precisely the one who would state the wrong value (DEC-035).

What is not permitted either way is a hidden dependency. The gap between the request and the full deterministic input is filled by **explicit** configuration, never by a clock, a random value, an environment variable, or an ambient default (INV-DET-003, INV-DET-004).

The future `ContextCompiler` binds those composition inputs — including the same-tokenizer requirement DEC-035 records — and the future `CompilationTrace` records them alongside the request, so a recorded compilation states every input it actually depended on (INV-TRACE-005). Neither exists yet, and neither is implemented here.

### Request Validation Is Structural; CandidateValidator Stays the Trust Boundary

This boundary matters more than the schema.

`CompilationRequestValidator` proves the record is a well-formed request of well-formed domain values: unknown top-level fields rejected, nothing coerced, no default injected, `candidates` and `sourceDocuments` checked with the existing domain schemas.

It deliberately does **not** claim that a `tokenCount` matches its content, that a `normalizedContentHash` is correct, that the source registry has no repeated identifier, that a candidate's scope equals the request scope, that a block's source exists or that its type and location are compatible, or that one block identifier stands for exactly one record. Those are cross-record rules `CandidateValidator` owns (DEC-030), and duplicating them would create a second place for one truth to drift (INV-DEP-003).

So a structurally valid request can still be rejected by the validator that follows it, and that is the intended division rather than a gap. The failure is `COMPILATION_REQUEST_INVALID`, with policy problems appearing under `policy.` pointers and their focused slice codes intact.

### What This Phase Preserves for the Trace

No trace exists yet, but the evidence a future `TraceBuilder` needs is now reachable without re-deriving it: the request identity, query, reference time, and scope; the parent policy identity and version; every nested slice identity and version; the original `ScoredCandidateSet`; one filtering decision per scored candidate; the eligible set; and the exact threshold and score on every optional decision.

No request fingerprint, compilation identifier, warning list, or trace schema is produced. Those belong to the phase that defines the trace.

### Consequences

`@ctxalloc/compiler` gains `CandidateFilter`, `CompilationPolicyValidator`, and `CompilationRequestValidator` and **no new dependency**: the boundary allowlist is unchanged, `@ctxalloc/tokenization` is still not a compiler dependency, and no validation-library type reaches a public declaration.

`BudgetAllocator`, `CandidateValidator`, `CandidateDeduplicator`, `CandidateScorer`, `ContextOrderer`, `ContextRenderer`, `Tokenizer`, and `MarkdownChunker` are unchanged in behavior. The only edits to existing components are the internal policy-parsing extraction described above and TSDoc that names neighbours instead of ordinals.

ARCHITECTURE changes: section 4 is split into the named topology (4.1) and the settled filter placement (4.2); section 5.5 and 5.6 become implemented and gain the reference time, the five slices, and the structural-validation boundary; section 6 gains 6.3.1; and section 6.6 loses the stale claim that `ContextRenderer` publishes "one signed diagnostic delta", which approved Phase 12 removed (DEC-035). The renderer runtime is untouched.

INVARIANTS changes: INV-ALLOC-002 gains one clarifying paragraph distinguishing eligibility from selection. No invariant is weakened.

`ContextCompiler`, `TraceBuilder`, `CompilationTrace`, `CompilationResult`, the request and compilation fingerprints, render-aware correction and reallocation, final `compiledTokens` / `unusedTokens` / `renderingTokenDelta`, warnings, retrieval, `SourceReader`, persistence, the CLI, the HTTP API, and the evaluation harness remain later phases. **"Hard budget guarantee complete" is still not a true statement.**

---

## DEC-037: Record Deterministic Privacy-Minimized Trace Snapshots Without Changing Decisions

### Status

Accepted

### Decision

Three contracts are added to `@ctxalloc/compiler`.

`CompilationTrace` is a versioned, serializable, persistence-oriented snapshot of one compilation's evidence, at `COMPILATION_TRACE_SCHEMA_VERSION = 1`.

`TraceBuilder` is an observational component that turns evidence the compiler components **already produced** into that snapshot, under one injected `TraceBuilderConfig`.

`fingerprintCompilationRequest` is a deterministic fingerprint of one **validated** `CompilationRequest`, at `COMPILATION_REQUEST_FINGERPRINT_VERSION = 1`.

None of the three retrieves, reads a file, opens a socket, queries a database, calls a model, reads a clock, or generates a random value (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002). No new external dependency is added; the Node built-in `node:crypto` is used for hashing, exactly as the domain already uses it for the canonical block content hash (DEC-030).

### TraceBuilder Is Observational

This is the decision's central boundary.

```text id="m8obs"
TraceBuilder receives     evidence the components already produced
TraceBuilder produces     a record about that evidence
TraceBuilder never        changes what any component decided
```

It does not validate candidates, deduplicate, score, filter, allocate, order, render, tokenize, evict, reallocate, correct a budget overrun, or select an outcome. It may copy stage evidence, calculate deterministic digests, count and sum already-validated numbers, and refuse to serialize evidence that contradicts itself. Enabling or disabling it changes no compiler output, which is exactly INV-TRACE-006.

It never repairs evidence. Trace generation *can* fail, because a caller may hand it outputs from two different runs; the correct answer there is a structured failure, not a reconciled record. A trace that quietly merged two runs would be a false audit record, and an audit record that can lie is worse than none.

### The Build Input Is Successful Post-Validation Evidence

```ts
interface CompilationTraceBuildInput {
  readonly request: CompilationRequest;
  readonly validated: ValidatedCandidateSet;
  readonly deduplicated: DeduplicatedCandidateSet;
  readonly filtered: FilteredCandidateSet;
  readonly rendered: RenderedContextAttempt;
}
```

Nothing is repeated, because everything else is reachable: the scored set is `filtered.scored`, the allocation is `rendered.ordered.allocation`, the ordering is `rendered.ordered`, and the render attempt is `rendered` itself. Supplying any of them again would create two places for one fact and let them disagree (INV-DEP-003).

`validated` is a **successful** `ValidatedCandidateSet`, and a `CandidateValidationError` is not accepted in its place. `CandidateValidator` is all-or-nothing (DEC-030): when candidate validation fails, no validated set exists and the post-validation chain never runs, so there is no post-validation evidence to trace. **Phase 14 therefore builds no trace for a validation failure.** A future `ContextCompiler` may wrap those structured errors in a terminal failure trace; fabricating one here would record a compilation that did not happen.

No orchestrator sits in front of this input. The caller composes the components — as `tests/compiler/pipeline.test.ts` already does — and hands over what they produced.

### INV-TRACE-001 Is Corrected: Wrappers Are Accounted For, Groups Are Decided

The previous wording was internally inconsistent:

> "Every validated candidate must appear exactly once in the final trace as: included, excluded, deduplicated into another block, rejected as invalid."

A candidate rejected as invalid never *became* a validated candidate, so the list mixed two populations. Worse, after exact deduplication the compiler makes its filtering and allocation decisions about a **group**, while every original `CandidateBlock` wrapper is retained as group membership evidence (DEC-031). Calling one wrapper "included" and its fellows "deduplicated" would require choosing a representative among wrappers that can be byte-identical, and choosing one by input position is a determinism bug (INV-DET-002).

The invariant now distinguishes two levels:

```text id="m8acct"
wrapper accounting   every successfully validated CandidateBlock wrapper appears
                     exactly once as a member of exactly one deduplicated group

group disposition    every deduplicated group receives exactly one current
                     filtering/allocation disposition:
                     filtered | included | excluded
```

For a terminal `CompilationResult` trace, every group additionally carries one final included/excluded disposition, and every validated wrapper remains accounted for through its group membership.

Multiplicity is meaningful. Two byte-identical wrappers produce two identical member records, and no member carries an invented wrapper identity, index, or position. The principle **"no candidate may disappear between stages"** is preserved exactly; only the accounting unit is made correct.

Validation failures stay explicit structured validation errors, and METRICS 13.3 now measures completeness at both levels rather than over one confused population.

### INV-TRACE-003 Is Corrected: Reconciliation Is Deduplication-Aware

The previous formula was:

```text id="m8old"
candidateTokens
  = includedCandidateTokens
  + excludedCandidateTokens
  + rejectedCandidateTokens
```

It cannot reconcile the implemented pipeline. `candidateTokens` is defined over **all validated candidate wrappers** (METRICS 8.1); exact deduplication collapses several wrappers into one canonical group; allocation works on one canonical block per group; and invalid candidates are not part of a successful post-validation trace at all, so a `rejectedCandidateTokens` term in a successful trace is always zero and always misleading.

The corrected reconciliation is:

```text id="m8new"
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

with

```text id="m8defs"
candidateTokens
  = sum(block.tokenCount) across EVERY validated CandidateBlock wrapper

canonicalContentTokens
  = sum(canonicalBlock.tokenCount) across EVERY group exactly once

duplicateCandidateTokens
  = candidateTokens - canonicalContentTokens

filteredContentTokens
  = sum(canonicalBlock.tokenCount) for groups CandidateFilter filtered

allocationExcludedContentTokens
  = sum(canonicalBlock.tokenCount) for eligible groups BudgetAllocator excluded

includedContentTokens
  = sum(canonicalBlock.tokenCount) for currently included groups
```

`duplicateCandidateTokens` is a **group-level difference**, never a chosen "duplicate member" wrapper subtracted by identity — the same reason no representative wrapper is selected above. Every group holds at least one validated member and its canonical block is one of the group's own blocks, so the difference is never negative.

Rendering counts do not participate. `renderedTokens` measures a string and is reported separately; `renderingTokenDelta` (METRICS 8.6) keeps its existing definition and its same-tokenizer precondition, unchanged by this phase.

Arithmetic is overflow-safe: each addend and each running total is checked, and a total that leaves the exact non-negative safe integer range is an explicit trace failure rather than a published approximation (INV-BUDGET-005). METRICS gains section 8.12 defining all seven totals and the counts that accompany them.

### `settled` Exists and Phase 14 Always Emits False

`ContextRenderer` measures **one** attempt and may report `fitsAvailableInputBudget: false` (DEC-035). That is a valid snapshot of a real measurement, so it must be traceable — and it must not be mistaken for a compilation.

```text id="m8stld"
settled: false   stage evidence traced, render attempt measured,
                 no correction has settled a compilation
```

The field is typed `boolean` rather than the literal `false` this phase emits, so a later phase can publish a settled trace without changing the persisted schema merely to flip finality.

**A trace with `settled: false` must never be attached to a successful `CompilationResult`.** ARCHITECTURE 5.7 now records that requirement on the future record.

Nothing else about finality appears: no success or failure outcome, no final failure code, no final included list, no `compiledTokens`, no `unusedTokens`, no `renderingTokenDelta`. Those belong to the correction loop and the result it settles (ARCHITECTURE 7.2).

### The Trace Is Persistence-Oriented, So It Is Versioned and Serializable

Unlike the ephemeral stage-result wrappers, which carry no schema version because they are produced and consumed inside one compilation, a trace is meant to be stored and read back by a consumer that did not produce it. It therefore carries `COMPILATION_TRACE_SCHEMA_VERSION = 1`, so an unsupported future shape fails clearly rather than being reinterpreted (INV-STORE-004).

The record survives `JSON.parse(JSON.stringify(trace))` with deep equality. No `Date`, `Map`, `Set`, class instance, `Error`, function, `undefined` array item, or external SDK type appears anywhere in it, and an absent optional property is genuinely absent rather than present with an `undefined` value.

**Persistence itself is not implemented.** Trace creation is part of compiler correctness; storing a trace remains optional (DEC-020).

### Schema Version 1 Cannot Represent Content At All

INV-SEC-003 requires full source content in persisted traces to be configurable and disabled by default for server operation. Phase 14 takes the safest available reading: **content is not representable**, and there is no `includeContent` switch to get wrong.

```text id="m8priv"
absent   ContextBlock.content
absent   CompilationRequest.query
absent   RenderedContextAttempt.renderedContext
absent   SourceDocument.metadata
absent   SourceDocument.title
absent   ContextBlock.metadata
absent   CandidateRetrieval.metadata
```

A switch defaulting to "off" is a switch someone will turn on, in the deployment where it matters least and leaks most. A field that does not exist cannot be enabled by configuration, by a caller, or by a future component that did not read this decision. When a real need for content capture appears, it can arrive as schema version 2 with its own security controls and its own decision.

What the trace **does** carry is decision and provenance evidence an audit needs: identifiers, digests, scope, source types, source locations, required status, category, authored priority, policy identities, provider identity and version, rank, provider score contract and value, compiler score components, decision reasons, token counts, and the rendered digest and count. Complete policy JSON is not recorded in v1 either: identities state which rules ran, and copying whole policies would put configuration into a record whose privacy boundary was drawn for decisions.

Where a value must be identified rather than stored, a **domain-separated digest** is recorded: `request.queryHash` and `rendering.renderedContextHash`, each `sha256:<64 lowercase hex characters>` over a labelled, versioned canonical preimage. Domain separation matters: hashing two bare strings would let a query that happens to equal a rendered context report the same digest, and an auditor comparing digests would conclude they were the same artefact.

Hashing here is **audit identity, not authorization**. Nothing in the kernel grants access, skips a check, reuses a result, or decides inclusion because two digests match, so no correctness rule depends on collision resistance.

### Tokenizer Identity Has Provenance Coverage

`composition.tokenizer` comes from `RenderedContextAttempt`, which is the one stage that publishes a tokenizer identity (DEC-035). It proves exactly one thing:

```text id="m8tokp"
proven      tokenizer(renderedContext) == rendering.renderedTokens

NOT proven  which tokenizer produced the ContextBlock.tokenCount values
            CandidateValidator accepted, and therefore every content total
            under trace.totals
```

DEC-035 and DEC-036 already record that no stage contract from `ValidatedCandidateSet` through `OrderedCandidateSet` carries a tokenizer identity. `TraceBuilder` reads those contracts and nothing else, so the earlier identity is not merely unrecorded — it is **unobservable from the trace input**.

A bare identity beside the content totals therefore creates a false audit implication. The counterexample is a legal manual composition today:

```text id="m8tokx"
CandidateValidator   tokenizer tok-A / 1   candidate token count = 100
ContextRenderer      tokenizer tok-B / 1   rendered string       =  10 tokens

trace.composition.tokenizer      = tok-B / 1
trace.totals.candidateTokens     = 100
trace.totals.canonicalContentTokens = 100
trace.rendering.renderedTokens   =  10
```

Nothing here is wrong on its own. Every number is the number its stage produced, and no stage can object, because none of them receives an identity to compare. But a reader of the persisted record sees one named tokenizer beside four token quantities and may reasonably conclude that it explains all of them. It explains one.

Schema version 1 therefore publishes the scope of the claim alongside the claim:

```ts
type CompilationTraceTokenizerCoverage =
  | 'rendering-attempt-only'
  | 'validation-and-rendering';
```

**Phase 14 always emits `rendering-attempt-only`.** The content totals stay exactly as they are — they reconcile among themselves, because every one of them sums the same already-validated numbers — and the trace simply stops implying an identity for them.

`validation-and-rendering` is reserved for a future `ContextCompiler`. That component can make the stronger claim because it **owns the construction**: it injects one tokenizer into `CandidateValidator` and `ContextRenderer` itself, so the guarantee is a property of the composition rather than an observation about it.

Three weaker alternatives were rejected.

**A caller-asserted `validationTokenizerId` on `TraceBuilderConfig.`** The manual caller is precisely the party who may miscompose the stages, so the assertion would be strongest exactly where it is least reliable: the miscomposing caller is the one who would state the wrong value, and `TraceBuilder` could not check it. That is an assertion, not evidence, and a trace must not launder one into the other.

**Inferring coverage when the numbers or the identifiers happen to agree.** Two different tokenizers may agree on one batch and diverge on the next, so agreement is not evidence of identity. Inference would also make the field's meaning depend on the fixture rather than on the composition.

**Rejecting a trace whose validation-tokenizer identity is unavailable.** That identity is unavailable in *every* Phase 14 trace, so this would refuse to record a pipeline that succeeded. The record is not wrong; it was over-claiming, and the fix is to narrow the claim rather than to withhold the record.

The coverage field is not inferred, not configurable, and not caller-supplied: it is a constant of the projection, and the union exists so Phase 15 can strengthen it without a schema-version change.

### Minimal Source References

```ts
interface CompilationTraceSource {
  readonly id: SourceDocumentId;
  readonly sourceType: SourceType;
  readonly contentHash: ContentHash;
}
```

A source is identified, not described. Identity plus content hash is what lets an auditor find the original and prove it has not changed; a title is optional prose and metadata is arbitrary untrusted data, and neither answers that question. Sources are ordered by `SourceDocument.id` with the project-owned code-unit comparison, never by locale (INV-DET-002).

### Group, Member, and Decision Evidence

Every `DeduplicatedCandidate` becomes exactly one `CompilationTraceGroup`, carrying its canonical block's audit fields, its `canonicalSelectionReason`, every member wrapper, the `CandidateScore` the scorer published, the filtering decision with the candidate object stripped, and — for an eligible group only — the allocation decision.

A **filtered group carries no allocation decision at all.** It never reached the allocator, so publishing one would describe a comparison that never happened.

The filtering and allocation shapes are discriminated unions, so an impossible pairing cannot be constructed: a filtered group claiming an eligible reason, a required bypass carrying a threshold it never faced, a filtered decision with no minimum to be below, or an inclusion carrying an exclusion reason.

`currentDisposition` is deliberately **not** `finalDisposition`: it describes the traced attempt, and a future correction may settle a different selection.

`renderPosition` is present exactly for included groups, is the zero-based index in `orderedIncluded`, is unique, and the positions cover `0 ... includedCount - 1` exactly.

### Exact Allocation, Ordering, and Rendering Summaries

`includedBlockIds` follows allocation chronology and `excludedBlockIds` optional traversal order. `optionalEvictionOrder` is copied exactly: it is neither sorted nor reinterpreted as render order, because it answers what may be given back if rendering overruns, which is a different question from what renders first (DEC-033, DEC-034). `orderedBlockIds` is exactly the `orderedIncluded` sequence. Rendering reports a digest, a count, and the budget observation, and nothing else.

### The Request Fingerprint Is Not a Compilation Identifier

```ts
const COMPILATION_REQUEST_FINGERPRINT_VERSION = 1;

type CompilationRequestFingerprint = string;

function fingerprintCompilationRequest(
  request: CompilationRequest,
): CompilationRequestFingerprint;
```

The preimage is the canonical serialization of `["ctxalloc-compilation-request-fingerprint", 1, request]`, hashed as exact UTF-8 bytes with SHA-256 and published as `sha256:<64 lowercase hex characters>`. Serialization goes through the project-owned canonical JSON rule: keys sorted by UTF-16 code unit, array order preserved, exact strings kept, no Unicode normalization, no trimming, absent optional properties absent, no `localeCompare`, and nothing environment-dependent.

It answers exactly one question:

```text id="m8fpq"
answers        Which exact validated caller request value was this?
does NOT       Which complete deterministic compiler invocation was this?
```

Because it identifies the exact request value, `request.id` participates, the query participates, and **array order participates** — candidates, source documents, and any policy array where the request value itself differs. Two requests that compile to the same output may therefore have different fingerprints, and that is deliberate: INV-DET-002 governs compiler *processing*, not the identity of the caller's payload, and normalizing candidate order inside the fingerprint would make two genuinely different payloads indistinguishable in an audit record. Object property insertion order does not participate, because canonical serialization sorts keys.

It excludes compiler version, tokenizer identity and version, renderer identity and version, and every other hidden environment state. Those are composition inputs rather than request data (DEC-036), and they are recorded **beside** the fingerprint in `composition`, so a recorded compilation still states every input it depended on (INV-TRACE-005).

A future deterministic **compilation identifier** must bind at least the request fingerprint or normalized request evidence, the compiler identity and version, the tokenizer identity and version, the renderer identity and version where relevant, the policy identities and configuration, and every other explicit composition input. **That identifier is not implemented in this phase**, and `requestFingerprint` is deliberately not named `compilationId`.

### Compiler Version Is Injected, Never Discovered

```ts
interface TraceBuilderConfig {
  readonly compilerId: string;
  readonly compilerVersion: string;
}
```

Validation is strict: closed object, non-blank well-formed UTF-16 strings preserved exactly, no defaults, no coercion. Nothing reads a `package.json` version, a git revision, a build-time constant, an environment variable, or a clock. A value discovered from the surroundings would differ between a source checkout, a published package, and a container, and a trace must state the identity the composition root actually chose (INV-DET-003, INV-TRACE-005).

A future `ContextCompiler` will own this configured identity.

### Coherence Checks, and Why They Are Structural

`TraceBuilder` is not a second semantic validator — every stage already proved its own rules — but it must not serialize a lie. Before projecting anything it verifies that the request's scope, source registry, candidates, budget, and configured policy identities describe the supplied evidence; that every validated wrapper is a member of exactly one group and each group's canonical block is one of its own members; that the scored set covers every group once; that the filtering decisions cover every scored candidate once and the eligible set is exactly what those decisions describe; that the allocation decides exactly the eligible candidates and nothing filtered; that `orderedIncluded` holds exactly the included decisions; and that the rendered budget observation matches the rendered count.

Comparison is **structural** — project-owned canonical serialization and multiset equality — rather than by object identity. The stage contracts do preserve references today, but object identity is not part of the persisted meaning of a trace, and requiring it would reject a caller who legitimately serialized a stage result between components.

Nothing is re-run: no token counting, no normalized hash calculation, no scoring, filtering, allocation, ordering, or rendering. Inconsistent evidence fails with the top-level code `COMPILATION_TRACE_BUILD_FAILED` and focused issue codes `invalid_config`, `inconsistent_request_evidence`, `inconsistent_stage_evidence`, or `invalid_trace_result`. Issues are project-owned, serializable, and deterministically ordered; no validation-library error escapes, and no partial trace is ever returned.

### Alternatives Considered

**Store content behind an `includeContent` flag, defaulting to off.** Rejected: a flag defaulting to off is a flag that gets turned on. A field that does not exist cannot be enabled by configuration or by a component that never read this decision. Content capture can arrive as schema version 2 with its own controls.

**Pick a representative wrapper so each wrapper gets an included/excluded verdict.** Rejected: byte-identical wrappers are observationally indistinguishable, and selecting one by input position would be a determinism violation (INV-DET-002). Group membership plus one group disposition accounts for every wrapper without inventing an order.

**Keep `rejectedCandidateTokens` in the reconciliation.** Rejected: it is always zero in a successful post-validation trace, because a rejected batch produces no validated set at all. A term that can only ever be zero invites a reader to believe rejected candidates are being accounted for when they are not.

**Have `TraceBuilder` re-derive missing evidence rather than fail.** Rejected: re-deriving is deciding. A builder that recomputed a score, a hash, or an allocation would become a second owner of that rule and could disagree with the stage that owns it (INV-DEP-003), and a trace that reconciled two runs would be false.

**Emit `settled: true` for a fitting render attempt.** Rejected: fitting is not settling. Nothing has accepted the compilation, no correction loop has run, and a `CompilationResult` cannot be built. Emitting `true` would let a future consumer attach an unsettled trace to a success.

**Name the fingerprint `compilationId`.** Rejected: it excludes compiler, tokenizer, and renderer identity by design, so it cannot identify an invocation. A name that overstated it would be used as a cache key, and two runs under different tokenizers would collide.

### Consequences

`@ctxalloc/compiler` gains `TraceBuilder`, `CompilationTrace` and its DTO subtypes (including `CompilationTraceTokenizerCoverage`), `CompilationTraceError`, and `fingerprintCompilationRequest`, and **no new external dependency**: the boundary allowlist is unchanged, `@ctxalloc/tokenization` is still not a compiler dependency, no application, persistence, or telemetry package is added, and no validation-library or `node:crypto` type reaches a public declaration.

`CompilationRequestValidator`, `CompilationPolicyValidator`, `CandidateValidator`, `CandidateDeduplicator`, `CandidateScorer`, `CandidateFilter`, `BudgetAllocator`, `ContextOrderer`, `ContextRenderer`, `Tokenizer`, and `MarkdownChunker` are **unchanged in behavior**. No stage source file was edited.

INVARIANTS changes: INV-TRACE-001 and INV-TRACE-003 are corrected as described, and INV-TRACE-004 gains a clarification for unsettled traces. INV-TRACE-002, INV-TRACE-005, and INV-TRACE-006 are unchanged and not weakened.

METRICS changes: section 8.12 defines the trace reconciliation totals and separates them from the final metrics whose names they resemble; 13.3 measures completeness at both accounting levels; 13.5 reads reconciliation against 8.12. `renderingTokenDelta` (8.6) is unchanged.

ARCHITECTURE changes: section 4.1 places `TraceBuilder` in the named topology as observational and distinguishes the implemented trace foundation from the future settled trace; 5.7 records that a successful `CompilationResult` requires a settled trace and stays unimplemented; 6.7 becomes implemented with the full contract; 7.2 gains the unsettled-trace clause; correction remains future.

`ContextCompiler`, the render-aware correction and reallocation loop, the settled final trace, the validation-failure trace envelope, `CompilationResult`, the final metrics, the deterministic compilation identifier, warnings, trace persistence, SQLite, retrieval, `SourceReader`, the CLI, the HTTP API, the model provider, and the evaluation harness remain later phases. **"Hard budget guarantee complete" is still not a true statement.**

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

Answered for rendering-policy schema version 1 by DEC-035: JSON Lines, one canonical JSON object per block, with `sourceDocumentId` as the source label.

The question remains open beyond v1. The v1 choice was made for boundary safety, determinism, and stable provenance, not on measured model comprehension. Remaining candidate formats include:

* Markdown sections;
* XML-like block wrappers;
* plain text separators;
* JSONL with human-readable source titles.

A second format must still balance:

* token overhead;
* model comprehension;
* safe escaping;
* provenance readability.

Choosing one requires token and answer-quality evaluation, and it arrives as a new `format` value under a new rendering-policy schema version.

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

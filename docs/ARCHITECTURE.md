# Architecture

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Document type: Architecture specification
* Status: Active
* Architecture style: Small hexagonal core with replaceable adapters

This document defines the architecture boundaries of the MVP.

It describes dependency direction, component responsibilities, domain objects, execution flow, and the allowed use of external systems.

---

## 1. Architecture Goals

The architecture must support:

* deterministic context compilation;
* strict token budget enforcement;
* complete decision tracing;
* offline core testing;
* local-first execution;
* future server deployment;
* replacement of retrieval and storage backends;
* support for multiple source types;
* future tenant-aware operation.

The architecture must avoid:

* framework-driven domain design;
* direct dependency on a retrieval product;
* duplicated ownership of token budgets;
* hidden context modification;
* mandatory network services for core execution;
* premature microservices;
* adapter layers without a real replacement boundary.

---

## 2. Architectural Style

The project uses a small hexagonal architecture.

The compiler kernel owns the domain behavior.

External systems communicate with the kernel through ports.

Adapters implement those ports.

```text
                 Applications
           CLI / HTTP API / Tests
                       |
                       v
              Application Services
                       |
                       v
                Compiler Kernel
                       |
        +--------------+--------------+
        |              |              |
        v              v              v
   TokenizerPort  CandidatePort   TraceStorePort
        |              |              |
        v              v              v
   Tokenizer       Retrieval       SQLite or
   Adapter          Adapter        In-Memory
```

The core dependency direction is always inward.

Infrastructure may depend on the domain.

The domain must not depend on infrastructure.

---

## 3. Main Layers

### 3.1 Domain Layer

The domain layer contains:

* data structures;
* validation rules;
* compiler policies;
* decision reasons;
* budget allocation rules;
* deterministic ordering;
* compiler errors;
* trace structures.

The domain layer must not import:

* HTTP libraries;
* CLI libraries;
* SQLite clients;
* QMD;
* Qdrant;
* Obsidian APIs;
* model provider SDKs;
* filesystem watchers.

---

### 3.2 Application Layer

The application layer coordinates use cases.

Examples:

* compile context;
* inspect compilation;
* run evaluation;
* normalize a source;
* request candidates;
* store a trace;
* optionally send compiled context to a model.

Application services may depend on domain interfaces.

They must not contain core budget or selection logic.

Example:

```ts
class CompileContextService {
  constructor(
    private readonly compiler: ContextCompiler,
    private readonly candidateProvider: CandidateProvider,
    private readonly traceStore: TraceStore,
  ) {}

  async execute(request: CompileApplicationRequest) {
    const candidates = await this.candidateProvider.getCandidates(request);
    const result = this.compiler.compile({
      ...request,
      candidates,
    });

    await this.traceStore.save(result.trace);
    return result;
  }
}
```

The compiler itself remains synchronous or deterministically asynchronous unless a real domain requirement demands otherwise.

---

### 3.3 Ports Layer

Ports describe required external capabilities.

The MVP should define only ports that represent real boundaries.

Initial ports:

* Tokenizer;
* CandidateProvider;
* SourceReader;
* TraceStore;
* ControlStore;
* ModelProvider;
* Clock, only when deterministic time behavior requires it.

Potential later ports:

* DocumentConverter;
* EmbeddingProvider;
* JobQueue;
* ObjectStore;
* TelemetrySink.

A port must not expose types from an external library.

---

### 3.4 Adapter Layer

Adapters connect external systems to ports.

Examples:

* RealTokenizerAdapter;
* FakeTokenizer;
* StaticFixtureCandidateProvider;
* SQLiteFtsCandidateProvider;
* QmdCandidateProvider;
* InMemoryTraceStore;
* SQLiteTraceStore;
* AnthropicModelProvider;
* MarkdownSourceReader;
* ObsidianVaultSourceReader.

Adapters may be removed without modifying the domain compiler.

---

### 3.5 Application Interfaces

Initial application interfaces:

* CLI;
* minimal HTTP API;
* test harness.

These interfaces call application services.

They do not implement compiler behavior.

---

## 4. Core Execution Flow

The core compilation flow is:

```text
CompilationRequest
        |
        v
Request Validation
        |
        v
Scope Validation
        |
        v
Candidate Validation
        |
        v
Deterministic Deduplication
        |
        v
Deterministic Scoring
        |
        v
Policy Filtering
        |
        v
Required Block Resolution
        |
        v
Token Budget Allocation
        |
        v
Stable Ordering
        |
        v
Context Rendering
        |
        v
CompilationResult + CompilationTrace
```

Retrieval happens before this flow.

Model execution happens after this flow.

```text
Retrieval proposes candidates.
Compiler selects context.
Model consumes compiled context.
```

These responsibilities must not be merged.

Three stages are implemented: candidate validation (section 6.1), deterministic
deduplication (section 6.2), and deterministic scoring (section 6.3). Everything
below them is future work.

`CandidateFilter` does not exist, and its position in this flow is **not yet
decided**. Two constraints are already fixed, and nothing more:

1. Filtering must not run before deduplication. Filtering a group before its
   duplicates are known would let the surviving copy of one piece of content
   depend on which wrapper a filter happened to keep (DEC-031).
2. Filtering may run either before or after scoring without changing any
   surviving candidate's score. `CandidateScorer` normalizes each candidate
   against fixed policy ranges and never against the values observed in the
   current batch, so removing an unrelated candidate cannot move another
   candidate's numbers (DEC-032). A filter that wants to read a score must of
   course run after scoring.

The diagram draws filtering after scoring for that reason alone; the placement
is recorded here as undecided rather than settled, because the policy that would
define a filtering rule does not exist yet.

---

## 5. Domain Model

### 5.1 Scope

```ts
interface Scope {
  tenantId: string;
  workspaceId: string;
  projectId?: string;
}
```

Every source, block, request, and trace belongs to a scope.

Local mode uses:

```json
{
  "tenantId": "local",
  "workspaceId": "default"
}
```

No context query may operate without scope.

---

### 5.2 SourceDocument

```ts
interface SourceDocument {
  id: string;
  schemaVersion: number;
  scope: Scope;
  sourceType: string;
  title?: string;
  contentHash: string;
  createdAt?: string;
  updatedAt?: string;
  metadata: Record<string, unknown>;
}
```

A source document describes the source-level object.

It does not need to contain the full content after blocks have been created.

---

### 5.3 ContextBlock

```ts
interface ContextBlock {
  id: string;
  schemaVersion: number;
  scope: Scope;

  sourceDocumentId: string;
  sourceType: string;
  sourceLocation?: SourceLocation;

  content: string;
  normalizedContentHash: string;
  tokenCount: number;

  headingPath?: string[];
  createdAt?: string;
  updatedAt?: string;

  attributes: {
    required?: boolean;
    priority?: number;
    category?: string;
  };

  metadata: Record<string, unknown>;
}
```

A ContextBlock is the smallest independently selectable unit.

The compiler does not read files during compilation.

All required source information must already be present in the block.

`sourceLocation` is optional, and its kind must match the block's source type: a
`markdown` or `text` block is located by a `text-range`, a `conversation` block
by a `conversation-message`. That compatibility is enforced by
`CandidateValidator` (section 6.1), because the location record does not carry
the source type and cannot check it alone.

A ContextBlock contains only source-derived or explicitly authored block data.

Its content is query-independent: the same block record is valid for every query
in its scope.

Query-dependent retrieval and scoring values must not be persisted inside a
ContextBlock. A provider relevance score, a computed recency score, a redundancy
measure, and a final utility score all describe one retrieval or one compilation
for one query, not the block itself.

The candidate wrapper below carries retrieval-supplied values for one request. A
scored-candidate structure carrying calculated score components remains a future
phase.

See DEC-026 and DEC-030.

---

### 5.4 CandidateBlock

```ts
interface CandidateBlock {
  schemaVersion: 1;
  block: ContextBlock;
  retrieval?: CandidateRetrieval;
}

interface CandidateRetrieval {
  providerId: string;
  providerVersion: string;
  rank?: number;
  score?: CandidateRetrievalScore;
  metadata?: JsonObject;
}

interface CandidateRetrievalScore {
  value: number;
  semantics: string;
  higherIsBetter: boolean;
}
```

A `CandidateBlock` is an ephemeral request-specific wrapper around one canonical
`ContextBlock`. It exists for the duration of one compilation and is never
persisted in place of the block.

It has no identity of its own: `block.id` remains the project-owned stable block
identifier. Two wrappers may carry the same block with different retrieval data;
deciding what to do with that pair belongs to deduplication.

`retrieval` is optional, so a direct or statically authored candidate needs no
fabricated provider. Retrieval values are untrusted provider input: they are
validated, carried, and never written back into the `ContextBlock`, and no score
is normalized or compared at this stage.

The wrapper carries no calculated relevance, recency, redundancy, or utility
score, no allocation decision, no trace decision, and no rendered text.

See DEC-030.

---

### 5.5 CompilationRequest

```ts
interface CompilationRequest {
  id: string;
  schemaVersion: number;
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

  policy: CompilationPolicy;
}
```

The request must contain all information required for deterministic compilation.

`sourceDocuments` is the explicit registry `CandidateValidator` uses to validate
block source references. A block's source is proven by membership in that
registry and by nothing else: not by a path, not by metadata, not by the adapter
that produced it, and not by array position. The registry is a validation input,
not a content store: it carries source-level records, never full source content.

`CompilationRequest` itself is not implemented yet. `CandidateValidator` receives
the scope, the registry, and the candidates directly (DEC-030).

---

### 5.6 CompilationPolicy

The policy defines:

* source priorities;
* category priorities;
* required block behavior;
* recency behavior;
* relevance weights;
* deduplication rules;
* category allocation limits;
* ordering rules;
* rendering rules;
* stable tie-breaking rules.

Policies must be versioned.

The same policy version and request must produce the same result.

---

### 5.7 CompilationResult

```ts
interface CompilationResult {
  compiledContext: string;
  includedBlocks: ContextBlock[];
  trace: CompilationTrace;

  usage: {
    candidateTokens: number;
    compiledTokens: number;
    availableTokens: number;
    unusedTokens: number;
    reductionTokens: number;
    reductionRatio: number;
  };
}
```

---

## 6. Compiler Components

The compiler may be implemented as several internal components.

### 6.1 CandidateValidator

Status: implemented (DEC-030).

Responsibilities:

* runtime schema validation of the request, the source registry, and every
  candidate;
* exact scope matching against the request scope;
* source reference validation against the explicit `sourceDocuments` registry;
* duplicate source identifier detection, after which the duplicated identifier
  resolves to no record, so no duplicate becomes authoritative;
* source location kind compatibility with the block's own source type;
* conflicting block identifier detection, where one block ID is attached to
  different canonical block data;
* exact token count recomputation through the injected `Tokenizer` port;
* normalized content hash recomputation through the shared domain helper;
* safe-integer priority validation.

Priority is restricted to finite safe integers only, including negative values.
No product-specific minimum or maximum exists yet: semantic priority bounds and
any policy boost belong to the versioned `CompilationPolicy`.

Validation is strict and all-or-nothing: any problem rejects the whole batch.
Nothing is silently removed, repaired, re-counted, re-hashed, reordered, or
deduplicated.

A top-level schema failure short-circuits cross-record validation and reports the
schema issues alone. Once the schema passes, every cross-record problem in the
batch is collected before failing.

The validator does not decide whether required content fits the budget. That
depends on the complete required allocation and its rendering overhead, and
belongs to the allocator (section 6.4, INV-BUDGET-004).

### 6.2 CandidateDeduplicator

Status: implemented (DEC-031).

It consumes a `ValidatedCandidateSet` and returns a `DeduplicatedCandidateSet`,
the next compiler-stage type:

```ts
interface DeduplicatedCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly candidates: readonly DeduplicatedCandidate[];
}

interface DeduplicatedCandidate {
  readonly canonicalBlock: ContextBlock;
  readonly canonicalSelectionReason: CanonicalSelectionReason;
  readonly members: readonly DeduplicatedCandidateMember[];
}

interface DeduplicatedCandidateMember {
  readonly candidate: CandidateBlock;
  readonly matchReason: DuplicateMatchReason;
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version.

Responsibilities:

* exact duplicate grouping by canonical normalized block content;
* canonical `ContextBlock` selection;
* explicit machine-readable duplicate match reasons;
* explicit machine-readable canonical selection reasons;
* stable intermediate ordering of groups, members, and the source registry.

Two candidates are duplicates when `normalizeContextBlockContentForHash` maps
their content to exactly equal strings. The validated `normalizedContentHash`
accelerates grouping as an outer bucket, but the normalized text itself decides
membership, so no correctness rule depends on digest collision resistance. Line
endings are the only difference the rule ignores: trailing spaces, blank-line
runs, indentation, letter case, punctuation, and Unicode composition all stay
significant, so conflicting blocks are never collapsed (INV-DEDUP-005).

Canonical selection uses two ordered rules over the distinct blocks in a group:
required status first, then the lexicographically smallest `ContextBlock.id`
compared by code unit. Retrieval score, retrieval rank, provider identity,
authored priority, category, timestamps, token count, metadata richness, source
location completeness, and input position are all excluded. The canonical block
is always one of the group's own records, carried unchanged; no merged or
synthesized block is created and no block is mutated into a required one.

Every input `CandidateBlock` wrapper survives as evidence inside exactly one
group, including wrappers that repeat a block ID, come from different providers,
carry different ranks or scores, carry no retrieval data, or reference different
source documents. Retrieval records are never merged, and no score is normalized,
compared, or selected here.

Output ordering is stable and independent of input order: groups by
`canonicalBlock.id`, members by `candidate.block.id` then a canonical
serialization of the wrapper, and `sourceDocuments` by `SourceDocument.id`. This
is the first stage that intentionally normalizes candidate ordering for later
compiler traversal (INV-DET-002).

The stage takes no injected dependency, calls no tokenizer, and reads no clock,
random value, file, environment variable, database, or network resource.

Near-duplicate logic is absent, not merely disabled: no embedding, similarity
threshold, edit distance, stemming, containment, or heading heuristic exists
(INV-DEDUP-004). Policy filtering is also absent and remains future work, because
it requires a versioned `CompilationPolicy`. Duplicate trace generation belongs
to the trace phase, which can derive it from the groups this stage returns.

### 6.3 CandidateScorer

Status: implemented (DEC-032).

It consumes a `DeduplicatedCandidateSet` and an explicit `referenceTime`, and
returns a `ScoredCandidateSet`, the next compiler-stage type:

```ts
interface ScoredCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly referenceTime: Timestamp;
  readonly candidates: readonly ScoredCandidate[];
}

interface ScoredCandidate {
  readonly candidate: DeduplicatedCandidate;
  readonly score: CandidateScore;
}

interface CandidateScore {
  readonly total: number;
  readonly retrieval?: RetrievalScoreComponent;
  readonly authoredPriority?: AuthoredPriorityScoreComponent;
  readonly sourcePriority?: SourcePriorityScoreComponent;
  readonly categoryPriority?: CategoryPriorityScoreComponent;
  readonly recency?: RecencyScoreComponent;
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version.

Responsibilities:

* strict runtime validation of the scoring policy and the reference time;
* normalization of explicitly configured signals onto a comparable `[0, 1]` scale;
* transparent score components carrying evidence, weight, and contribution;
* deterministic aggregation of duplicate-group evidence;
* a deterministic total and a stable output ranking.

#### CandidateScoringPolicy is a narrow scoring slice

`CandidateScorer` takes one versioned `CandidateScoringPolicy`, not the broad
future `CompilationPolicy` of section 5.6. It carries `schemaVersion`,
`policyId`, `policyVersion`, and five optional components — `retrieval`,
`authoredPriority`, `sourcePriority`, `categoryPriority`, and `recency` — and
nothing about filtering, allocation, ordering, or rendering. A later
`CompilationPolicy` may contain or reference it without changing what this stage
means by it.

Policy validation is strict: unknown fields are rejected rather than stripped,
nothing is coerced, no default is injected, exact strings are preserved, and
duplicate rule identifiers, duplicate provider contracts, duplicate source
entries, and duplicate category entries are all rejected rather than resolved by
array order. Lookups are compiled only after validation, so the declaration order
of the policy arrays cannot affect a result.

#### Raw provider scores are never compared directly

A retrieval score participates only when the policy owns an exact rule for the
tuple `[providerId, providerVersion, semantics, higherIsBetter]`, with a fixed
inclusive `[min, max]` range:

```text
higherIsBetter true   normalized = (rawValue - min) / (max - min)
higherIsBetter false  normalized = (max - rawValue) / (max - min)
```

Ranges are policy input. They are never inferred from the provider, from a rank,
or from the values in the current batch: batch-relative normalization would make
one candidate's score depend on which unrelated candidates were retrieved
alongside it. A value outside its range rejects rather than clamps, and a scored
record with no exact rule rejects rather than being read as zero or dropped
(INV-SCORE-002, INV-SCORE-004). A retrieval record with no score is valid and
contributes no relevance; rank alone and provider identity alone are never
relevance (INV-PROV-003).

#### Normalized components

Every enabled component publishes `normalizedValue` in `[0, 1]`, the policy
`weight`, `contribution = normalizedValue * weight`, its aggregation rule, and
explicit evidence explaining where the normalized value came from. A disabled
component is absent rather than zero; a configured component with weight `0` is
present with its evidence and contributes `0`.

* **retrieval** — normalized provider relevance under an exact contract.
* **authoredPriority** — `(priority - min) / (max - min)` over the policy's
  inclusive safe-integer range; an out-of-range priority rejects, an absent one
  contributes no evidence.
* **sourcePriority** — exact `SourceDocument.id` rules with an explicit default.
  Nothing is inferred from source type, path, or `SourceDocument.metadata`.
* **categoryPriority** — exact category string rules with an explicit default. No
  case folding, trimming, prefix matching, or hierarchy.
* **recency** — `max(0, 1 - ageSeconds / maxAgeSeconds)` against the supplied
  reference time, using `updatedAt ?? createdAt`, with the policy's explicit
  `missingValue` when a block carries neither and age clamped to zero for a
  future timestamp.

`total` is the arithmetic sum of the present contributions in the fixed order
retrieval, authored priority, source priority, category priority, recency.
Weights need not sum to one, so a total is a policy-relative utility rather than
a probability, comparable only within one run of one `policyId` and
`policyVersion`. A non-finite contribution or total rejects the batch.

#### Duplicate evidence aggregates by maximum

Deduplication keeps every wrapper and every retrieval record precisely so the
scorer can read them; it must not reconstruct or approximate retrieval data that
it believes was lost. All members are inspected, not only the wrapper carrying
the canonical block.

Every component aggregates its group's evidence by **maximum** — over normalized
retrieval evidence, and over the distinct blocks of the group for the other four.
Nothing is summed, averaged, or counted, and no wrapper is preferred for being
canonical, lowest-ranked, or from a particular provider. Repeating one wrapper
twenty times therefore leaves the value exactly where one wrapper left it. All
normalized evidence stays visible, in an order that depends only on the records
themselves.

#### Required status is not a score

There is no required component, no required boost, and no large constant. Required
blocks remain a separate allocation class that the allocator resolves first
(INV-SCORE-003, INV-ALLOC-001). A required candidate may score zero while an
optional one scores higher.

#### Nothing is filtered and nothing is allocated

Every deduplicated candidate appears exactly once in the result unless scoring
fails as a whole. No candidate is excluded for a low score, an absent category, a
low source priority, old content, missing retrieval data, a poor rank, or a
negative authored priority, and no minimum score threshold exists. No token budget
is read, no token cost is subtracted, no score-per-token is computed, and no
inclusion, exclusion, or eviction decision is made (INV-ALLOC-002).

#### Stable output ranking

`candidates` is ordered by `score.total` descending, then by `canonicalBlock.id`
ascending compared by UTF-16 code unit (INV-DET-005). Required status does not
change that order, and the allocator must still treat required candidates as a
separate class wherever they land. `sourceDocuments` is returned in `id` order,
`scope` unchanged, and `policyId`, `policyVersion`, and `referenceTime` copied
verbatim from validated values.

The stage reads no clock: `referenceTime` is supplied per call and validated with
the project `Timestamp` contract, and no `Date` instance reaches the public
surface (INV-DET-004). It calls no tokenizer, no retrieval provider, and no
model, and it implements no lexical, BM25, embedding, or LLM relevance scorer of
its own: query relevance arrives through `CandidateRetrieval` under an explicit
provider contract. No redundancy or near-duplicate score exists either.

### 6.4 BudgetAllocator

Status: future phase.

Responsibilities:

* calculate available input budget;
* include required blocks;
* enforce category minimums and maximums;
* select optional blocks;
* prevent budget overruns;
* return unused budget;
* fail on impossible required-block budgets.

Only this component owns final token allocation.

### 6.5 ContextOrderer

Status: future phase.

Responsibilities:

* place blocks in deterministic order;
* group blocks according to policy;
* preserve conversation continuity where required;
* avoid accidental score-order changes between runs.

### 6.6 ContextRenderer

Status: future phase.

Responsibilities:

* serialize selected blocks;
* include source markers;
* apply stable separators;
* avoid unmeasured formatting overhead;
* report rendering token overhead.

### 6.7 TraceBuilder

Status: future phase.

Responsibilities:

* record each compiler stage;
* record score components;
* record inclusion and exclusion reasons;
* record budget transitions;
* record warnings and errors;
* produce a serializable result.

---

## 7. Token Budget Model

The total model context window is not identical to the compiler input budget.

```text
model context window
  - system prompt reserve
  - expected output reserve
  - tool schema reserve
  - protocol overhead reserve
  = compiler context budget
```

The MVP request explicitly provides the compiler budget inputs.

The allocator must not guess the model context window.

Budget calculations must account for:

* selected block content;
* source labels;
* separators;
* rendering wrappers;
* any fixed compiler prefix.

The final rendered context must be tokenized again before returning success.

If rendering causes an overrun, the allocator must remove optional blocks according to policy and render again.

Required blocks must never be silently removed during this correction step.

---

## 8. Retrieval Boundary

The compiler receives candidates through:

```ts
interface CandidateProvider {
  getCandidates(
    request: CandidateRequest,
  ): Promise<CandidateResult>;
}
```

The result may contain:

```ts
interface CandidateResult {
  blocks: ContextBlock[];
  providerId: string;
  providerVersion?: string;
  retrievalTrace?: unknown;
}
```

The provider may be:

* static fixtures;
* an in-memory test provider;
* SQLite FTS5;
* QMD;
* Qdrant;
* another external retrieval system.

The compiler must not know which provider produced the blocks.

The provider is not allowed to:

* enforce the final token budget;
* rewrite block content without provenance;
* remove scope metadata;
* replace project block identifiers;
* decide the final context order.

---

## 9. Source Ingestion Boundary

Source ingestion is separate from compilation.

```text
Source
  |
  v
Source Reader
  |
  v
Normalized SourceDocument
  |
  v
Chunker
  |
  v
ContextBlock records
  |
  v
Candidate index or fixture store
```

Compilation must not perform:

* file reading;
* Markdown parsing;
* document conversion;
* OCR;
* embedding generation;
* index updates.

This separation keeps compilation predictable and fast.

Current stage responsibilities:

```text
SourceReader adapter, future:
  reads bytes/text and provider metadata

Application source ingestion, implemented:
  validates explicit input
  derives SourceDocument identity
  hashes exact source content
  returns SourceDocument plus unchanged content

Application Markdown chunker, implemented:
  scans Markdown structurally
  preserves exact source text as block content
  counts tokens through the injected Tokenizer port
  derives stable ContextBlock identity
  returns blocks in source order

Compiler candidate validation, implemented:
  receives an explicit scope, a source registry, and candidate wrappers
  validates them strictly through the injected Tokenizer port
  never reads source content from files during compilation
```

The application ingestion and chunking stages exist today, and the compiler's candidate validation stage receives their output. No SourceReader port and no source reader adapter has been implemented; ingestion receives content the caller has already read. Identity derivation and content hashing follow DEC-028, Markdown chunking follows DEC-029, and candidate validation follows DEC-030.

The canonical `ContextBlock.normalizedContentHash` rule is owned by `@ctxalloc/domain` so that the chunker which writes a hash and the validator which rechecks it cannot drift apart.

The chunker is an application-layer transformation, not a domain or compiler concern: the domain imports no Markdown parsing, and the compiler imports no ingestion or chunking behavior. It depends on the `Tokenizer` port rather than a tokenizer implementation, so the composition root chooses the adapter.

---

## 10. Markdown and Obsidian Architecture

Markdown is the first supported structured source.

Obsidian support is implemented as metadata around Markdown, not as a dependency inside the compiler.

```text
Obsidian Vault
      |
      v
Obsidian Source Adapter
      |
      v
Markdown SourceDocument
      |
      v
Project Markdown Chunker
      |
      v
ContextBlock records
```

Obsidian-specific metadata may include:

* vault ID;
* relative path;
* frontmatter;
* tags;
* wiki links;
* embedded note references.

The compiler sees these values only as source metadata.

---

## 11. Persistence Architecture

The domain defines storage ports.

Example:

```ts
interface TraceStore {
  save(trace: CompilationTrace): Promise<void>;
  get(id: string): Promise<CompilationTrace | null>;
}
```

MVP adapters:

* InMemoryTraceStore;
* SQLiteTraceStore.

SQLite may also store:

* source metadata;
* block metadata;
* evaluation runs;
* indexing state.

Large original documents should remain in their source location or a dedicated document cache.

SQLite is not the source of truth for an Obsidian vault.

---

## 12. Model Provider Boundary

The model provider consumes the compilation result.

```ts
interface ModelProvider {
  complete(request: ModelRequest): Promise<ModelResponse>;
}
```

The compiler must not:

* call a model;
* retry provider failures;
* stream responses;
* select a model;
* calculate provider billing.

Those responsibilities belong to the application or adapter layer.

The MVP supports one provider implementation for evaluation.

---

## 13. Evaluation Architecture

The evaluation harness must use the same compiler used by production interfaces.

```text
Evaluation Case
      |
      +--> Baseline Context --> Model Provider --> Baseline Answer
      |
      +--> Compiler --> Compiled Context --> Model Provider --> Compiled Answer
                                     |
                                     v
                              Compilation Trace
```

Evaluation produces:

* token comparison;
* required-block recall;
* required-fact preservation;
* answer quality score;
* latency comparison;
* determinism check;
* failure classification.

The benchmark must not use a separate simplified compiler.

---

## 14. Error Model

Errors must be structured.

Initial error categories:

* invalid request;
* invalid scope;
* invalid candidate;
* duplicated candidate identifier;
* impossible token budget;
* required blocks exceed budget;
* tokenizer failure;
* rendering budget overrun;
* provider failure;
* storage failure.

Compiler errors must not be represented only as log messages.

Expected invalid input must not crash the process.

---

## 15. Determinism Rules

The following data must not affect compilation unless explicitly included in the request:

* current system time;
* random numbers;
* filesystem ordering;
* database row ordering;
* object insertion order from external providers;
* network response timing.

When time-based behavior is needed, the request or injected Clock port must provide the reference time.

All tie-breaking must use stable fields such as:

1. required status;
2. computed score;
3. source priority;
4. update timestamp supplied in the request;
5. block identifier.

---

## 16. Repository Structure

Recommended initial structure:

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
    src/
      schemas/
      policies/
      errors/
      decisions/

  compiler/
    src/
      validation/
      deduplication/
      scoring/
      allocation/
      ordering/
      rendering/
      tracing/

  application/
    src/

  tokenization/
    src/
      ports/
      adapters/

  sources/
    src/
      markdown/
      conversation/

  ports/
    src/
      candidate-provider.ts
      trace-store.ts
      model-provider.ts
      source-reader.ts

  evaluation/
    src/

  testing/
    src/
      fake-tokenizer.ts
      fake-candidate-provider.ts
      fake-model-provider.ts
      fixtures/

apps/
  cli/
  api/
```

A monorepo tool may be used, but it must not determine domain boundaries.

---

## 17. Dependency Rules

Allowed dependency direction:

```text
apps
  -> application
      -> compiler
      -> ports
      -> domain

compiler
  -> ports
  -> domain

adapters and technical packages
  -> ports
  -> domain

ports
  -> domain

domain
  -> no project infrastructure
```

Forbidden dependencies:

```text
domain -> SQLite
domain -> QMD
domain -> Qdrant
domain -> Obsidian API
domain -> Anthropic SDK
domain -> HTTP framework

compiler -> filesystem
compiler -> retrieval service
compiler -> model provider
compiler -> database client
```

Automated dependency checks should be added after the initial package structure exists.

---

## 18. External Component Integration Rule

A large external component must pass a technical spike before entering the main dependency graph.

The spike must prove:

* small adapter surface;
* stable identifiers;
* incremental update support;
* source metadata preservation;
* explicit scope behavior;
* acceptable failure behavior;
* measurable performance;
* clean removal path.

The spike implementation must not be merged into the kernel.

QMD, Qdrant, MarkItDown, and memory systems are subject to this rule.

---

## 19. Local MVP Deployment

Initial deployment:

```text
Single Node.js process
  |
  +-- CLI or HTTP API
  +-- Compiler Kernel
  +-- Markdown ingestion
  +-- SQLite adapter
  +-- Optional single model adapter
```

A retrieval process may be added only after the retrieval spike.

Docker is not required before the local vertical slice works.

---

## 20. Future SaaS Evolution

The future server architecture may replace adapters:

```text
Local MVP                  SaaS
------------------------------------------------
SQLite                     PostgreSQL
Local candidate provider   Qdrant or other service
Filesystem cache           Object storage
In-process tasks           Distributed job queue
Local API key              Tenant authentication
Single process             API and worker processes
```

The following components should remain unchanged or mostly unchanged:

* ContextBlock schema;
* compilation policy;
* validator;
* deduplicator;
* scorer;
* budget allocator;
* context orderer;
* renderer;
* trace model;
* evaluation cases.

A SaaS migration that requires rewriting these components indicates an architecture boundary failure.

---

## 21. Architecture Review Questions

Before implementing a new component, answer:

1. Is this compiler behavior or infrastructure behavior?
2. Does the domain need to know which library implements it?
3. Can the component run in core tests without a network?
4. Who owns the token budget?
5. Who owns source provenance?
6. Can the external dependency be removed?
7. Does the feature validate the MVP hypothesis?
8. Does the feature introduce hidden context modification?
9. Is a new interface justified by a real replacement boundary?
10. Can the same result be implemented more directly?

When the answers are unclear, implementation must pause until the responsibility is defined.

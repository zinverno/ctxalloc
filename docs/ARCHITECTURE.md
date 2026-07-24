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
Policy Filtering
        |
        v
Deterministic Deduplication
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
    relevanceScore?: number;
    recencyScore?: number;
  };

  metadata: Record<string, unknown>;
}
```

A ContextBlock is the smallest independently selectable unit.

The compiler does not read files during compilation.

All required source information must already be present in the block.

---

### 5.4 CompilationRequest

```ts
interface CompilationRequest {
  id: string;
  schemaVersion: number;
  scope: Scope;

  query: string;
  candidates: ContextBlock[];

  budget: {
    totalTokens: number;
    reservedOutputTokens: number;
    reservedSystemTokens?: number;
  };

  policy: CompilationPolicy;
}
```

The request must contain all information required for deterministic compilation.

---

### 5.5 CompilationPolicy

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

### 5.6 CompilationResult

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

Responsibilities:

* schema validation;
* scope validation;
* duplicate identifier detection;
* token count validation;
* source reference validation;
* priority range validation.

### 6.2 Deduplicator

Responsibilities:

* exact identifier deduplication;
* content hash deduplication;
* normalized text deduplication;
* canonical block selection;
* duplicate trace generation.

The initial implementation must be deterministic and non-embedding-based.

### 6.3 CandidateScorer

Responsibilities:

* calculate a comparable deterministic score;
* combine policy priority, relevance, recency, and source weight;
* preserve separate score components in the trace;
* use stable tie-breaking.

The score is an input to allocation, not an automatic inclusion decision.

### 6.4 BudgetAllocator

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

Responsibilities:

* place blocks in deterministic order;
* group blocks according to policy;
* preserve conversation continuity where required;
* avoid accidental score-order changes between runs.

### 6.6 ContextRenderer

Responsibilities:

* serialize selected blocks;
* include source markers;
* apply stable separators;
* avoid unmeasured formatting overhead;
* report rendering token overhead.

### 6.7 TraceBuilder

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

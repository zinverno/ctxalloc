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

The implemented service is `CompileLocalContextService` in
`@ctxalloc/application` (DEC-039):

```ts
class CompileLocalContextService {
  constructor(
    config: unknown,
    tokenizer: Tokenizer,
    sourceReader: SourceReader,
    controlStore: ControlStore,
    candidateProvider: CandidateProvider,
  );

  execute(input: unknown): Promise<LocalCompilationResult>;
}
```

It takes one `Tokenizer` object and constructs `MarkdownChunker`, `TextChunker`,
`ConversationChunker`, and `ContextCompiler` with that same object. It does not
accept a pre-built compiler plus a second tokenizer: block token counts would
then be produced by one tokenizer and validated by another.

Trace persistence is deliberately absent from the flow: no `TraceStore` port
exists yet.

The compiler itself remains synchronous. The application service is
asynchronous, because reading sources and asking a provider for candidates are
genuinely asynchronous operations; every decision inside the service is still a
pure function of its validated inputs.

---

### 3.3 Ports Layer

Ports describe required external capabilities.

The MVP should define only ports that represent real boundaries.

Initial ports:

* Tokenizer, implemented (DEC-027);
* CandidateProvider, implemented (DEC-039);
* SourceReader, implemented (DEC-039);
* TraceStore, future;
* ControlStore, implemented and read-only (DEC-039);
* ModelProvider, implemented for evaluation only (DEC-040);
* MonotonicClock, implemented for evaluation durations only (DEC-040);
* TraceStore, future;
* a general wall Clock, still absent: every time-dependent decision takes an
  explicit reference instant, so nothing needs one.

The six implemented ports are type-only contracts in `@ctxalloc/ports`. That
package has no runtime export and no external dependency; it may reference
`@ctxalloc/domain` with type-only imports so that a port and an adapter never
describe one concept in two vocabularies.

`ModelProvider` and `MonotonicClock` are consumed by `@ctxalloc/evaluation` and
by nothing else. The compiler kernel calls no model and reads no clock, and
declaring the ports does not change that: a port is a capability offered, not a
capability every layer may reach for. `ModelProvider` is narrow by design — one
configured model, one text request, one text result, and no streaming, tools,
routing, retry, fallback, caching orchestration, or pricing. `MonotonicClock`
measures elapsed durations only and carries no date semantics.

`ControlStore` declares `listSources` and nothing else. Control-plane writing
needs its own persistence decision and its own failure semantics, so it arrives
with the phase that implements it rather than as a declared method nothing
honors.

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

Implemented:

* `O200kBaseTokenizer` in `@ctxalloc/tokenization` (DEC-027);
* `NodeFileSourceReader` in `@ctxalloc/adapters` (DEC-039);
* `AnthropicModelProvider` in `@ctxalloc/adapters`, for evaluation only (DEC-040);
* `SystemMonotonicClock` in `@ctxalloc/adapters` (DEC-040);
* `FakeTokenizer`, `InMemorySourceReader`, `InMemoryControlStore`,
  `FakeCandidateProvider`, `FakeModelProvider`, and `FakeMonotonicClock` in
  `@ctxalloc/testing`.

Future:

* SQLiteFtsCandidateProvider;
* QmdCandidateProvider;
* InMemoryTraceStore;
* SQLiteTraceStore;
* SQLiteControlStore;
* ObsidianVaultSourceReader.

`AnthropicModelProvider` uses Node's built-in `fetch` and adds no provider SDK.
It reads no environment variable, no configuration file, and no working
directory: every value is explicit configuration. It is an evaluation adapter,
not a model gateway.

`@ctxalloc/adapters` depends on `@ctxalloc/ports` only. It deliberately does not
depend on `@ctxalloc/compiler`: an adapter that could see the kernel would be
able to make a selection decision, and the point of the seam is that it cannot.

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

### 4.1 The implemented topology

The implemented part of the flow is named by its components, not numbered:

```text
CompilationRequest validation
  -> CandidateValidator
  -> CandidateDeduplicator
  -> CandidateScorer
  -> CandidateFilter
  -> BudgetAllocator
  -> ContextOrderer
  -> ContextRenderer
  -> TraceBuilder              (observational)
  -> render-aware settlement
  -> SettledCompilationTrace
  -> CompilationResult
```

Structural request validation (section 5.5) and nine compiler components are
implemented: `CandidateValidator` (section 6.1), `CandidateDeduplicator`
(section 6.2), `CandidateScorer` (section 6.3), `CandidateFilter`
(section 6.3.1), `BudgetAllocator` (section 6.4), `ContextOrderer`
(section 6.5), `ContextRenderer` (section 6.6), `TraceBuilder` (section 6.7),
and `ContextCompiler` (section 6.8). **The compiler kernel is complete.**

`TraceBuilder` sits inside the chain but is **not** a stage in it. It consumes
what the components already produced and produces a record about them; removing
it changes no compiler decision (INV-TRACE-006). Its position in the list says
when it can run, not that anything downstream depends on it.

**The settled compilation trace is implemented (DEC-038).** `TraceBuilder` still
emits only an `UnsettledCompilationTrace` — the stage evidence, the measured
attempt, and nothing settled. `ContextCompiler` runs the render-aware settlement
of section 7.2 and then projects that snapshot plus the proven correction
evidence into a `SettledCompilationTrace`, which is the only trace a successful
`CompilationResult` may carry.

**Topology is defined by component names, not by ordinal position.** Older
wording in this document and in DEC-030 through DEC-035 called the components the
first through sixth stages, which described the order they were implemented in.
Inserting `CandidateFilter` between scoring and allocation shifts every ordinal
after it, so an ordinal is not a stable way to name a position. The names above
are (DEC-036). A component's predecessor and successor are the contract; its
number is not.

Rendering is still not the end of the budget story. `ContextRenderer` tokenizes
the complete rendered string for **one** selection and reports whether that
attempt fits; it never evicts, never reallocates, and never fails merely because
the attempt is too large. Turning a measurement into a success or a structured
failure under INV-BUDGET-001 and INV-BUDGET-002 belongs to `ContextCompiler`
(sections 6.8 and 7.2).

`ContextCompiler` composes these components. It owns one configured `Tokenizer`
and injects that same object into `CandidateValidator` and `ContextRenderer`,
which discharges the cross-stage tokenizer-identity requirement of DEC-035 that
was previously the caller's to honor. It is also the component that hands
`TraceBuilder` its evidence bundle, and the builder still verifies that the
bundle came from one coherent run rather than trusting it.

A caller may still compose the components by hand — the contracts are public and
unchanged — but then the tokenizer-identity guarantee is theirs again, and the
trace such a caller can build is an unsettled one.

### 4.2 Where filtering runs

`CandidateFilter` is implemented, and its position is **settled**: after
`CandidateScorer`, before `BudgetAllocator` (DEC-036).

Two constraints fixed one end of the range:

1. Filtering must not run before deduplication. Filtering a group before its
   duplicates are known would let the surviving copy of one piece of content
   depend on which wrapper a filter happened to keep (DEC-031).
2. Filtering may run either before or after scoring without changing any
   surviving candidate's score. `CandidateScorer` normalizes each candidate
   against fixed policy ranges and never against the values observed in the
   current batch, so removing an unrelated candidate cannot move another
   candidate's numbers (DEC-032).

Schema version 1 of the filtering policy reads `score.total`, which settles the
other end: the filter must run after scoring. It must also run before allocation,
because eligibility is a precondition of selection rather than a competitor to
it. Filtering after allocation would mean discarding a block the allocator had
already spent budget on, leaving that budget unusable.

The division of responsibility is exact. `CandidateFilter` answers *may this
scored optional candidate participate in allocation under policy?*
`BudgetAllocator` answers *among the eligible candidates, which ones are
included?* The filter owns neither required resolution, category constraints,
token budget, eviction, nor final inclusion (INV-ALLOC-002). It is also not an
access-control boundary: scope isolation stays with request validation and
`CandidateValidator` (INV-SCOPE-003, INV-SEC-004).

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

Status: implemented (DEC-036).

```ts
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

The request must contain all **caller-supplied, per-compilation** data the kernel
needs. It is not, by itself, the complete deterministic input.

INV-DET-001 defines determinism over more than the request: the tokenizer
implementation and version, the compiler version, and any other explicit compiler
configuration are inputs too, and DEC-035 records that no stage contract carries a
tokenizer identity. So the deterministic input of one compilation is:

```text
CompilationRequest
  + configured tokenizer identity and version
  + compiler implementation and version
  + any other explicit compiler configuration the invariants allow
```

The counterexample is concrete. One byte-identical request compiled under a
tokenizer `tok-A/1` and again under `tok-B/1` can produce different block-count
feasibility and a different `renderedTokens`. Neither run violates INV-DET-001,
because the tokenizer input differed — which is exactly why the request alone is
not sufficient. No hidden clock, random value, or environment lookup may fill
those gaps; the missing inputs are explicit configuration a future
`ContextCompiler` binds and a future trace records (DEC-035, DEC-036).

The request therefore carries **no** tokenizer instance, tokenizer identity or
version, compiler implementation or version, renderer instance, or any other
component instance. Those are configured composition, not request data.

`referenceTime` is **required**. Recency scoring measures against an instant, and
the compiler must not read the clock, so the instant arrives with the request and
flows to `CandidateScorer.score(batch, request.referenceTime)` (INV-DET-004). No
default is injected.

`id` is caller-supplied, non-blank, well-formed UTF-16, and preserved exactly.
The kernel generates no request identifier (INV-DET-003). `query` is preserved
verbatim: an empty query is valid, a whitespace-only or multi-line query is valid
and is not trimmed, normalized, or truncated, and no kernel component reads it.
`budget` is the existing `TokenBudget`: no reserve is defaulted and no model
context window is guessed.

`sourceDocuments` is the explicit registry `CandidateValidator` uses to validate
block source references. A block's source is proven by membership in that
registry and by nothing else: not by a path, not by metadata, not by the adapter
that produced it, and not by array position. The registry is a validation input,
not a content store: it carries source-level records, never full source content.

**Request validation is structural, and it does not replace
`CandidateValidator`.** `CompilationRequestValidator` proves the record is a
well-formed request of well-formed domain values, with unknown top-level fields
rejected, nothing coerced, and no default injected. It deliberately does not
prove that a token count matches its content, that a normalized content hash is
correct, that the source registry has no repeated identifier, that a candidate is
in the request scope, that a block's source exists or that its type and location
are compatible, or that one block identifier stands for one record. Those are
cross-record rules `CandidateValidator` owns (section 6.1, DEC-030,
INV-DEP-003), so a request may pass this validator and still be rejected by the
one after it. Validation runs no stage, compiles nothing, reads no clock, and
generates no identifier or fingerprint.

---

### 5.6 CompilationPolicy

Status: implemented (DEC-036).

The policy defines:

* source priorities;
* category priorities;
* required block behavior;
* recency behavior;
* relevance weights;
* policy eligibility filtering;
* deduplication rules;
* category allocation limits, as block counts in allocation policy schema
  version 1;
* ordering rules;
* rendering rules;
* stable tie-breaking rules.

Policies must be versioned.

Given the same validated request, policy composition, tokenizer implementation and
version, compiler implementation and version, and other explicit compiler
configuration, the compiler must produce the same result (INV-DET-001). Policy and
request are not the only determinism inputs; see section 5.5.

`CompilationPolicy` composes the five narrow versioned slices the stages already
own:

```ts
interface CompilationPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scoring: CandidateScoringPolicy;      // section 6.3
  readonly filtering: CandidateFilteringPolicy;  // section 6.3.1
  readonly allocation: BudgetAllocationPolicy;   // section 6.4
  readonly ordering: ContextOrderingPolicy;      // section 6.5
  readonly rendering: ContextRenderingPolicy;    // section 6.6
}
```

All five slices are **required** in schema version 1, and none is defaulted. A
compilation that filters nothing is expressed as an explicit filtering slice with
`minimumTotalScore` absent — a stated no-op, not a missing key.

`policyId` and `policyVersion` identify the composition. They are independent of
the nested identities and need not equal any of them: a team that revises only
its rendering slice publishes a new parent version while the scoring slice keeps
its own. No identifier, version, hash, or fingerprint is generated
(INV-DET-003).

Validation is strict at the wrapper and delegated below it. The wrapper rejects
unknown top-level fields, an unsupported schema version, a blank or malformed
identity, and a missing or non-object slice; each slice is then validated by the
stage that owns its rules, through the same helper that stage's constructor uses,
so neither path can accept what the other would reject (INV-DEP-003). A malformed
wrapper short-circuits; otherwise every problem in all five slices is collected
in the fixed order scoring, filtering, allocation, ordering, rendering, and
addressed under that slice's pointer.

**The policy is data, not orchestration.** It holds no component instance, owns
no tokenizer, runs no stage, and decides nothing. Composing the components
remains the future `ContextCompiler`'s work.

Deduplication rules and required-block behavior appear in the list above as
policy *concerns*, not as configured slices: deduplication is exact and
unconfigurable in this phase (DEC-031), and required status is a block attribute
resolved by the allocator, never a policy switch (INV-SCORE-003).

---

### 5.7 CompilationResult

Status: implemented (DEC-038). `ContextCompiler` (section 6.8) is its only
producer.

```ts
const COMPILATION_RESULT_SCHEMA_VERSION = 1;

interface CompilationResult {
  readonly schemaVersion: 1;
  readonly compilationId: CompilationId;
  readonly requestId: string;

  readonly compiledContext: string;
  /** Final canonical blocks, in exact render order. */
  readonly includedBlocks: readonly ContextBlock[];

  readonly usage: {
    readonly candidateTokens: number;
    readonly includedContentTokens: number;
    readonly compiledTokens: number;
    readonly availableTokens: number;
    readonly unusedTokens: number;
    readonly renderingTokenDelta: number;
  };

  readonly trace: SettledCompilationTrace;
}
```

`trace` is a **settled** trace at the type level: an unsettled trace records one
measured attempt rather than the selection that was returned, so attaching one to
a success is not expressible rather than merely forbidden (DEC-037, DEC-038,
INV-TRACE-006).

`includedBlocks` are canonical `ContextBlock` records, not `CandidateBlock`
wrappers, carried by reference and never rewritten. Excluded blocks are not
repeated here: `trace.settlement.decisions` explains every deduplicated group
exactly once, and a second list would be a place for one truth to disagree with
itself (INV-DEP-003).

The usage values are exact, not estimated:

```text
candidateTokens      sum of every validated CandidateBlock wrapper (METRICS 8.1)
includedContentTokens sum of the final selected canonical blocks (METRICS 8.5)
compiledTokens       tokenizer(compiledContext)                   (METRICS 8.4)
availableTokens      availableInputTokens(request.budget)         (METRICS 8.3)
unusedTokens         availableTokens - compiledTokens             (METRICS 8.10)
renderingTokenDelta  compiledTokens - includedContentTokens       (METRICS 8.6)
```

`renderingTokenDelta` is signed and never clamped. It is reportable here — and
only here — because `ContextCompiler` owns the one configured tokenizer that
produced both operands, which is the validity precondition METRICS 8.6 states.

#### No reduction metrics: baselines are evaluation work

Earlier drafts of this section sketched `reductionTokens` and `reductionRatio`.
They are **not** published, and the omission is deliberate.

METRICS 8.7 and 8.8 define both against `baselineInputTokens`, and no baseline
exists anywhere in a `CompilationRequest`: a baseline is what some *other*
strategy would have sent, which is a comparison the evaluation layer sets up
(METRICS 7, section 13). Substituting `candidateTokens`,
`canonicalContentTokens`, `availableTokens`, or `totalTokens` for a baseline
would publish a different quantity under a documented metric's name.

METRICS 8.7 and 8.8 are unchanged; they simply have no producer in the kernel
(DEC-038).

---

## 6. Compiler Components

The compiler may be implemented as several internal components.

Subsection numbers here are **document addresses, not execution positions**. The
execution order is the named topology of section 4.1, and `ContextCompiler`
(section 6.8) is the component that runs it. `CandidateFilter` arrived
after 6.4 through 6.7 were already written and cross-referenced from DEC-033
through DEC-035, METRICS, and the source TSDoc, so it is documented as
section 6.3.1 — immediately after the component it follows — rather than by
renumbering four sections and every reference to them. A local insertion keeps
every existing address valid; renumbering would break them all to encode an order
the numbers were never meant to carry (DEC-036).

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
is the first component that intentionally normalizes candidate ordering for later
compiler traversal (INV-DET-002).

The stage takes no injected dependency, calls no tokenizer, and reads no clock,
random value, file, environment variable, database, or network resource.

Near-duplicate logic is absent, not merely disabled: no embedding, similarity
threshold, edit distance, stemming, containment, or heading heuristic exists
(INV-DEDUP-004). Policy filtering does not happen here either: it is the separate
responsibility of `CandidateFilter` (section 6.3.1), which runs after scoring.
Duplicate trace generation belongs
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

### 6.3.1 CandidateFilter

Status: implemented (DEC-036). It runs after `CandidateScorer` and before
`BudgetAllocator`; see section 4.2 for why.

It consumes a `ScoredCandidateSet` and one narrow versioned
`CandidateFilteringPolicy`, and returns a `FilteredCandidateSet`:

```ts
interface CandidateFilteringPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly minimumTotalScore?: number;
}

interface FilteredCandidateSet {
  readonly scored: ScoredCandidateSet;
  readonly filteringPolicyId: string;
  readonly filteringPolicyVersion: string;
  readonly eligible: ScoredCandidateSet;
  readonly decisions: readonly CandidateFilteringDecision[];
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version.

Responsibilities:

* strict runtime validation of the filtering policy;
* one eligibility decision per scored candidate, with a machine-readable reason;
* an eligible subset the existing `BudgetAllocator` consumes unchanged.

#### The v1 filtering language

`minimumTotalScore` is the whole of schema version 1. There is no block, source,
category, `sourceType`, timestamp, provider, rank, raw-score, size, regular
expression, metadata, tag, or callback rule.

The omissions are the decision. Filtering runs after exact deduplication, so the
unit it sees is a duplicate group whose members may come from different source
documents, carry different categories, and arrive from different providers.
"Exclude source X" has no single meaning over such a group, and inventing one
silently would make the surviving copy of one piece of content depend on which
wrapper the filter happened to inspect. Recency, source priority, category
priority, authored priority, and retrieval relevance already have exactly one
owner: they are configured signals of `CandidateScoringPolicy` and reach this
component already normalized into `score.total`. Version 1 consumes that
group-level result and nothing else, and a hard exclusion language is deferred
until post-deduplication group semantics are decided (DEC-036).

Policy validation is strict and is a runtime boundary: the object is closed,
unknown fields are rejected rather than stripped, nothing is coerced, no default
is injected, exact strings are preserved, `policyId` and `policyVersion` must be
non-blank, malformed UTF-16 is rejected (INV-BLOCK-007), and `minimumTotalScore`
must be a finite number no less than zero. The failure surface is
`CANDIDATE_FILTERING_FAILED` with `invalid_policy`.

#### Threshold semantics

An absent minimum leaves every scored candidate eligible. A configured minimum
admits an optional candidate when `score.total >= minimumTotalScore` and filters
it when the total is strictly below. **Equality survives.** Nothing is rounded,
clamped, normalized, read as a probability, or divided by a token count.

`CandidateScore.total` is policy-relative utility, not a probability: its weights
need not sum to one (INV-SCORE-001). A threshold is therefore meaningful only
against the scoring policy it is paired with, which is why both identities travel
in the result.

#### Required blocks bypass the threshold

A candidate whose canonical block declares `required: true` stays eligible
whatever it scored. A required block scoring zero survives a threshold of one
thousand. It is not filtered, not failed, and not boosted: required content is a
separate allocation class, never a large score (INV-SCORE-003, INV-BUDGET-003).
Whether the required content actually fits stays the allocator's question
(INV-BUDGET-004).

#### One decision per candidate

Every scored candidate finishes as exactly one of (INV-TRACE-001,
INV-TRACE-002):

```text
eligible   ELIGIBLE_REQUIRED             required block, threshold not consulted
eligible   ELIGIBLE_POLICY               optional block the policy admits
filtered   FILTERED_SCORE_BELOW_MINIMUM  optional block below the minimum
```

An optional decision carries the exact `scoreTotal`, and the configured
`minimumTotalScore` where one applied. A required decision carries neither,
because neither took part in it. The decision types are discriminated so an
impossible pairing cannot be constructed.

#### What the filter may read

Exactly three things: `score.total`, `canonicalBlock.attributes.required`, and
its own validated policy.

It reads no raw retrieval field, rank, provider identity, source metadata, title,
`sourceType`, category, authored priority, timestamp, `tokenCount`, token budget,
rendered cost, or query, and no clock, filesystem, environment variable,
database, network resource, or model (INV-DET-001, INV-DET-003, INV-DET-004,
INV-DEP-002). It takes no tokenizer.

#### Eligibility is not selection

`eligible` is a `ScoredCandidateSet`, so `BudgetAllocator` consumes it directly
with no change to its API. Its scope, source registry, scoring policy identity
and version, and reference time are the input's own values; only `candidates`
differs, and surviving candidates are reused by reference (INV-ALLOC-004).

Filtering is stable, not a re-ranking: survivors keep their relative input order
and the decisions follow input order, because `CandidateScorer` owns the ranking
(DEC-032, INV-DET-002). Nothing is sorted here.

`scored` carries the complete input by reference, so every candidate stays
reachable whether or not it survived. The component changes no allocation
decision, evicts nothing, renders nothing, and builds no trace, and it is not an
access-control boundary: scope isolation belongs to request validation and
`CandidateValidator` (INV-SCOPE-003, INV-SEC-004).

### 6.4 BudgetAllocator

Status: implemented (DEC-033).

It consumes a `ScoredCandidateSet`, an explicit `TokenBudget`, and one narrow
versioned `BudgetAllocationPolicy`, and returns an `AllocatedCandidateSet`, the
next compiler-stage type:

```ts
interface AllocatedCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];

  readonly scoringPolicyId: string;
  readonly scoringPolicyVersion: string;
  readonly allocationPolicyId: string;
  readonly allocationPolicyVersion: string;
  readonly referenceTime: Timestamp;

  readonly tokenBudget: TokenBudget;
  readonly availableInputTokens: number;

  readonly selectedBlockContentTokens: number;
  readonly unallocatedBlockContentTokens: number;

  readonly included: readonly IncludedCandidateDecision[];
  readonly excluded: readonly ExcludedCandidateDecision[];

  readonly optionalEvictionOrder: readonly ContextBlockId[];
}

interface IncludedCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'included';
  readonly reason: AllocationDecisionReason;
  readonly contentTokens: number;
  readonly remainingBefore: number;
  readonly remainingAfter: number;
}

interface ExcludedCandidateDecision {
  readonly candidate: ScoredCandidate;
  readonly decision: 'excluded';
  readonly reason: AllocationDecisionReason;
  readonly contentTokens: number;
  readonly remainingTokens: number;
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version.

Responsibilities:

* strict runtime validation of the allocation policy and the token budget;
* required block resolution before every optional block;
* exact category block-count constraints;
* deterministic optional selection under the block-content ceiling;
* one machine-readable decision for every candidate;
* a deterministic optional eviction order for the future render-correction loop;
* structured failure when required content or a category constraint is
  impossible.

Only this component owns final optional inclusion (INV-ALLOC-002).

#### Block-content budget, not final rendered budget

`BudgetAllocator` runs before `ContextRenderer`, and rendering does not exist
yet. It therefore proves exactly one property:

```text
sum(included canonicalBlock.tokenCount) <= availableInputTokens
```

and never claims `compiledTokens <= availableInputTokens` for a context nobody
has rendered. Its metrics are named accordingly — `selectedBlockContentTokens`
and `unallocatedBlockContentTokens` — and no `compiledTokens` or final
`unusedTokens` field exists. No rendering reserve is invented to compensate.

Required block content that alone exceeds the ceiling is definitively impossible
even before overhead is added, so it fails immediately under INV-BUDGET-004. The
converse does not hold: required content that fits here is not proof that the
rendered required context will fit.

The budget is validated with the existing `TokenBudgetSchema`, and the ceiling
comes from the existing `availableInputTokens()`. The model context window is
never guessed and no reserve is defaulted or injected.

#### BudgetAllocationPolicy is a narrow allocation slice

The stage takes one versioned `BudgetAllocationPolicy`, not the broad future
`CompilationPolicy` of section 5.6:

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

Policy validation is strict: unknown fields are rejected rather than stripped,
nothing is coerced, no default is injected, exact strings are preserved, at least
one bound must be present, `minBlocks <= maxBlocks`, and two constraints owning
the same exact category are rejected rather than resolved by array order.

#### Category constraints are block counts

In schema version 1 a category minimum and maximum are **block counts**, spelled
`minBlocks` and `maxBlocks`: at least or at most that many independently
selectable canonical blocks of one exact category. There is no token quota, no
percentage share, and no byte or character quota; those remain possible in a
later policy schema version.

A category is the canonical block's own `attributes.category`, matched by exact
string equality with no case folding, trimming, prefix matching, or hierarchy. An
absent category is unconstrained. Duplicate members are provenance, not
additional selectable blocks, so they never count toward a quota.

#### Required, minimum, and general optional phases

1. **Required.** Every required block is included first, in `canonicalBlock.id`
   order, by exact safe subtraction. A required block that does not fit fails the
   whole allocation; none is dropped and no content is trimmed (INV-BUDGET-003,
   INV-BUDGET-004, INV-ALLOC-004). Required content over a category maximum fails
   the same way rather than relaxing the maximum.
2. **Category minimums.** Required blocks count toward a minimum, so only
   `max(0, minBlocks - requiredCount)` optional blocks are reserved per category,
   chosen by token count ascending, then score descending, then block identifier.
   Taking the cheapest blocks that reach the count minimizes the content cost of
   satisfying it, and categories are disjoint, so the union is the
   minimum-content-cost selection satisfying every minimum. Every category's
   selection is computed before anything is subtracted, and if that union does not
   fit, the failure is a real block-content infeasibility rather than a greedy
   artifact.
3. **General optional.** Everything else is considered by score descending, then
   block identifier ascending.

#### score-desc-greedy

For each remaining optional candidate the category maximum is checked before the
budget, so a blocked candidate spends nothing. A candidate that fits is included
and its exact token count subtracted; one that does not fit is excluded and
traversal continues, so a large high-score candidate never stops smaller
lower-score ones from being considered.

It is deliberately not knapsack, dynamic programming, integer programming, beam
search, total-utility maximization, or score-per-token: no score is divided by a
token count and no token cost is subtracted from a score. The one place cost
outranks score is the hard-minimum feasibility selection above.

#### Decisions and accounting

Every candidate appears exactly once across `included` and `excluded` with one
machine-readable reason — `INCLUDED_REQUIRED`, `INCLUDED_CATEGORY_MINIMUM`,
`INCLUDED_SCORE_ORDER`, `EXCLUDED_CATEGORY_MAXIMUM`, or
`EXCLUDED_BUDGET_EXHAUSTED` (INV-TRACE-001, INV-TRACE-002). Inclusions carry
`remainingBefore` and `remainingAfter` differing by exactly `contentTokens`;
exclusions carry the unchanged remainder. `selectedBlockContentTokens` is the
exact sum of the included counts and `unallocatedBlockContentTokens` is exactly
the ceiling minus it.

The included array is allocation chronology — required, then minimums, then score
order — and is **not** final render order, which `ContextOrderer` owns. The result
is trace-ready but is not a `CompilationTrace`.

#### Deterministic eviction order

`optionalEvictionOrder` is precomputed for the future render-correction loop
(INV-ALLOC-006); this stage evicts nothing. Included optional candidates are
considered in reverse utility order — score ascending, then block identifier
descending — against a simulated per-category count, and a block enters the order
only when removing it would leave its category at or above `minBlocks`. Required
blocks never appear. A maximum restricts inclusion, not removal, so it never
protects a block here.

Consequently ordinary surplus is given back before higher-utility content, and a
block first included for a minimum may become evictable once later selections
created surplus.

**Every prefix is safe, and that is all it proves.** Applying any prefix — up to
and including the whole order — leaves every configured minimum satisfied and
every required block present, which makes the order the cheap correction path
when giving back currently selected surplus is enough. Exhausting it proves only
that no more *currently selected* optional surplus can be removed under the
current hard constraints; it does not prove that no different allocation fits the
rendered budget. Hard minimums were satisfied at minimum canonical block-content
cost, and rendering overhead may vary per block, so a block protected by
`minBlocks` may render more expensively than an unselected candidate of the same
category that satisfies the same minimum (DEC-033 carries the worked
counterexample). Future orchestration must therefore be free to reconsider those
hard-minimum choices against actual rendered cost, or otherwise prove no
allocation fits, before declaring failure.

Failures are structured and all-or-nothing: `invalid_policy`,
`duplicate_category_constraint`, `invalid_budget`,
`required_content_exceeds_budget`, `required_category_maximum_exceeded`,
`category_minimum_unreachable`, `category_minimums_exceed_content_budget`, and
`invalid_allocation_result`. No partial result is ever returned.

The stage reads no clock, calls no tokenizer, renderer, retrieval provider,
model, or storage, and mutates nothing reachable from its input.

### 6.5 ContextOrderer

Status: implemented (DEC-034).

It consumes an `AllocatedCandidateSet` and one narrow versioned
`ContextOrderingPolicy`, and returns an `OrderedCandidateSet`, the next
compiler-stage type:

```ts
interface ContextOrderingPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly strategy: 'source-document-then-location';
}

interface OrderedCandidateSet {
  readonly allocation: AllocatedCandidateSet;
  readonly orderingPolicyId: string;
  readonly orderingPolicyVersion: string;
  readonly orderedIncluded: readonly IncludedCandidateDecision[];
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version.

Responsibilities:

* strict runtime validation of the ordering policy;
* one deterministic render order for the current selection;
* source grouping and source-local position;
* stable tie-breaking down to the block identifier.

It changes no inclusion or exclusion decision, renders nothing, and measures
nothing.

#### The v1 order

```text
1. sourceDocumentId ascending, by UTF-16 code unit
2. position inside that source document
3. block ID ascending, by UTF-16 code unit
```

Grouping by source document keeps one document's blocks contiguous. The
identifier is opaque (DEC-028), so its order is a stable grouping key, not a
claim about which document matters more; ranking documents would need a policy
that does not exist.

Source-local position is the source's own chronology:

* **text-range** — `startOffset` ascending, then `endOffset`, then the block
  identifier. Offsets state where the block sat in the original content; nothing
  is inferred from content, heading path, or timestamps. `startLine` and
  `endLine` take no part: they remain in `SourceLocation` as provenance, but
  comparing them only when both blocks carry one is not transitive, and ranking
  their presence would let optional metadata completeness decide the layout
  (DEC-034).
* **conversation-message** — an indexed message precedes an unindexed one; two
  indexed messages compare by `messageIndex`, then `messageId`, then block ID;
  two unindexed messages compare by `messageId`, then block ID. `messageIndex` is
  chronology, `messageId` is a code-unit fallback that is never parsed for an
  embedded time or sequence number.
* **absent location** — located blocks of a source precede its unlocated ones,
  which are ordered by block ID alone. Position is never guessed
  (INV-PROV-002).

The comparator is a total order by construction: a plain lexicographic
composition of total orders, with no key that applies only when both blocks
happen to carry it. It ends in the block identifier as the final semantic
tie-break, and falls back to the canonical serialization for a hand-assembled
input carrying one identifier on two different records (INV-DET-005).
`localeCompare` and `Intl.Collator` are never used.

#### What does not order

Score, required status, allocation reason, category, timestamps, heading path,
retrieval and provider data, source metadata, duplicate members, and input array
position are all absent from the comparator. A high-scoring block renders late
when its source position is late, and a required block may render after an
optional one from the same source.

#### Three different orders

```text
score ranking          how useful is this candidate                  6.3
allocation chronology  in what order was the budget spent            6.4
optionalEvictionOrder  what may be given back if rendering overruns  6.4
render order           where does this content belong when read      6.5
```

These are distinct **semantic** sequences, not disjoint ones. Render order and
allocation chronology hold the same decisions, so each is a permutation of the
other; `optionalEvictionOrder` holds a subset of those block identifiers, ordered
by eviction policy rather than by source position; and the score ranking also
covers candidates allocation excluded. What separates them is that their ordering
rules answer different questions, so **none may be derived from another**.
`optionalEvictionOrder` in particular is carried through untouched and is not
render order.

#### Conservation

`orderedIncluded` holds exactly the objects of `allocation.included`, by
reference, permuted: a copy of that array, sorted. Every included decision
appears once, no excluded decision appears, no reason changes, and no
`ContextBlock` is cloned (INV-TRACE-001, INV-ALLOC-002, INV-ALLOC-004). Array
position is the whole ordering contract; no index or rank is written onto a block
or a decision.

The allocation is nested whole rather than copied field by field, so every
Phase 10 fact stays reachable and stated once (INV-DEP-003). The single failure is
`CONTEXT_ORDERING_FAILED` with `invalid_policy`: sorting a copy of an array can
neither lose nor invent an element, so no reconciliation code is needed.

### 6.6 ContextRenderer

Status: implemented (DEC-035).

It consumes an `OrderedCandidateSet`, one narrow versioned
`ContextRenderingPolicy`, and one project-owned `Tokenizer`, and returns a
`RenderedContextAttempt`:

```ts
interface ContextRenderingPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly format: 'jsonl-blocks';
}

interface RenderedContextAttempt {
  readonly ordered: OrderedCandidateSet;
  readonly renderingPolicyId: string;
  readonly renderingPolicyVersion: string;
  readonly rendererId: string;
  readonly rendererVersion: string;
  readonly tokenizerId: string;
  readonly tokenizerVersion: string;
  readonly renderedContext: string;
  readonly renderedTokens: number;
  readonly fitsAvailableInputBudget: boolean;
}
```

The structure is an ephemeral compiler-stage result and is never persisted, so it
carries no schema version. It is deliberately **not** a `CompilationResult`.

Responsibilities:

* strict runtime validation of the rendering policy and of the injected
  tokenizer;
* deterministic, boundary-safe serialization of the current selection;
* exact tokenization of the complete rendered string;
* one budget observation.

It publishes **no** token delta. The signed `renderingTokenDelta` needs one
tokenizer identity behind both of its operands, which no stage contract reaching
this component carries, so it belongs to the future orchestration that
establishes comparability (METRICS 8.6, DEC-035, section 7.2).

It changes no inclusion or exclusion decision, evicts nothing, calls no earlier
stage, and builds no trace.

#### The v1 format

JSON Lines: one canonical JSON object per included block, joined by exactly one
LF (`\n`). There is no prefix, no suffix, no enclosing array, no trailing
newline, and no blank separator line, so one physical line is exactly one block
and an empty selection renders as the exact empty string.

Each record carries exactly these fields, in canonical key order:

```text
blockId
content
headingPath          only when the canonical block carries it
sourceDocumentId
sourceType
```

Nothing else renders. Score, retrieval data, allocation reason, required status,
category, priority, timestamps, block metadata, source metadata, source title,
`tokenCount`, `normalizedContentHash`, and policy internals are compiler control
and provenance data, not model context in rendering policy v1.

`sourceDocumentId` is the v1 source label (INV-RENDER-003): it exists on every
trusted canonical block, it is stable project-owned identity (DEC-028), it needs
no registry lookup, and it cannot drift from an optional title. A human-readable
title is a future rendering-policy version.

`headingPath` is emitted exactly as the block carries it. An absent path omits
the key; an explicitly empty array is preserved as `[]`. It is never synthesized
and never rewritten into Markdown heading text in v1.

#### Boundary safety and content preservation

JSON string serialization *is* the boundary mechanism, which is why no raw
delimiter protocol is used: arbitrary source content can contain any delimiter,
but it cannot manufacture a second JSONL record, because newlines, quotes, and
backslashes inside a JSON string are escaped (INV-RENDER-002, INV-RENDER-003).

Rendering is serialization, not rewriting. For every rendered line,
`JSON.parse(line).content` equals the canonical block content exactly: no
trimming, no Unicode normalization, no line-ending normalization, no truncation,
no summarization, and nothing escaped back into the block (INV-RENDER-005,
DEC-014). Escape sequences in the serialized string are representation, not
mutation.

Record order is exactly `orderedIncluded`. The renderer does not sort, group, or
consult source location, score, required status, or `optionalEvictionOrder`:
`ContextOrderer` owns order and array position is authoritative (INV-RENDER-001).

#### Exact measurement, not correction

`renderedTokens` is `tokenizer.countTokens(renderedContext)` over the one
complete string — never a sum of block counts, record counts, or separator
counts, and never a character estimate (INV-BUDGET-002, INV-RENDER-004). The
count is validated as a non-negative safe integer before publication, and a
tokenizer that throws or returns an unusable value produces a structured
`CONTEXT_RENDERING_FAILED` with `tokenizer_failed` or
`invalid_rendered_token_count`, never a partial attempt (INV-ADAPTER-003).

**No token delta is published.** Subtracting `selectedBlockContentTokens` from
`renderedTokens` is meaningful only when one tokenizer identity produced both,
and this stage cannot establish that: `renderedTokens` comes from the injected
tokenizer, `selectedBlockContentTokens` from whichever tokenizer validated the
block counts, and no stage contract from 6.1 to 6.5 carries a tokenizer identity
to compare. A miscomposed chain would otherwise report the gap between two
vocabularies as if it described rendering. The value stays reachable through the
nested allocation; the final signed `renderingTokenDelta` belongs to the
component that guarantees one tokenizer (METRICS 8.6, section 7.2).

`fitsAvailableInputBudget` is `renderedTokens <= availableInputTokens`, and it is
observational. `false` is a successful measurement of an over-budget attempt: the
renderer does not evict an optional block, drop a required one, replace a
category-minimum choice, re-run allocation or ordering, or raise
`REQUIRED_CONTENT_EXCEEDS_BUDGET`. That is the correction loop's work
(section 7.2).

The result publishes `rendererId` / `rendererVersion` (`ctxalloc-jsonl`, `1`) and
the `tokenizerId` / `tokenizerVersion` that produced the count, so a future trace
can record exactly what measured what (INV-TRACE-005). No stage contract carries a
tokenizer identity from 6.1 through to here, so composing the stages with one
configured tokenizer is a requirement on the future composition root, not a
property this stage can verify (DEC-035).

### 6.7 TraceBuilder

Status: implemented (DEC-037), emitting schema version 2 (DEC-038).

Responsibilities:

* verify that the supplied stage evidence belongs to one coherent pipeline;
* project that evidence into a versioned, serializable
  `UnsettledCompilationTrace`;
* record the request identity and its deterministic fingerprint;
* record the compiler, policy, renderer, and renderer-observed tokenizer
  identities, with the coverage of the tokenizer claim;
* record every deduplicated group, its members, its score, and its decisions;
* record the allocation, ordering, and rendering summaries;
* calculate the exact reconciliation totals;
* fail explicitly when the evidence contradicts itself.

#### TraceBuilder is observational

It receives evidence the components **already produced**. It does not validate
candidates, deduplicate, score, filter, allocate, order, render, tokenize, evict,
reallocate, correct a budget overrun, or select an outcome. Enabling or disabling
it changes no compiler output (INV-TRACE-006).

What it may do is copy stage evidence, calculate deterministic digests, count and
sum already-validated numbers, and refuse to serialize evidence that contradicts
itself. It never repairs such evidence: a caller who mixed two runs gets a
structured failure, because a trace that quietly reconciled them would be a false
audit record.

It is synchronous, pure, and offline: no clock, no random value, no file, no
environment variable, no `package.json`, no git revision, no database, no network,
no model, no retrieval provider, and no tokenizer (INV-DET-001, INV-DET-003,
INV-DET-004, INV-DEP-002).

#### The build input is successful post-validation evidence

```ts
interface CompilationTraceBuildInput {
  readonly request: CompilationRequest;
  readonly validated: ValidatedCandidateSet;
  readonly deduplicated: DeduplicatedCandidateSet;
  readonly filtered: FilteredCandidateSet;
  readonly rendered: RenderedContextAttempt;
}
```

Nothing is repeated: the scored set is `filtered.scored`, the allocation is
`rendered.ordered.allocation`, the ordering is `rendered.ordered`, and the render
attempt is `rendered`. Supplying any of them again would create two places for
one fact (INV-DEP-003).

`validated` is a **successful** `ValidatedCandidateSet`. A
`CandidateValidationError` is not accepted in its place: `CandidateValidator` is
all-or-nothing, so a failed batch has no post-validation evidence to trace, and a
validation-failure trace envelope belongs to the future `ContextCompiler`
(DEC-030, section 6.1).

There is no orchestrator in front of this input. The caller composes the
components and hands over what they produced.

#### Compiler identity is injected configuration

```ts
interface TraceBuilderConfig {
  readonly compilerId: string;
  readonly compilerVersion: string;
}
```

Compiler version is an explicit composition input, not request data (DEC-036), and
it is supplied rather than discovered: nothing reads a manifest version, a git
revision, a build constant, or an environment variable, because a value found in
the surroundings would differ between a source checkout, a published package, and
a container. Validation is strict — closed object, non-blank well-formed UTF-16
strings preserved exactly, no defaults.

#### Wrapper accounting and group decisions

The trace satisfies INV-TRACE-001 at its two levels. Every successfully validated
`CandidateBlock` wrapper appears exactly once as a member of exactly one trace
group, and every deduplicated group receives exactly one current
filtering/allocation disposition.

No representative wrapper is invented. Byte-identical wrappers produce identical
member records, and multiplicity is the evidence; selecting one of them by input
position would be a determinism bug (INV-DET-002, DEC-031).

`currentDisposition` is deliberately not called `finalDisposition`: it describes
the traced attempt, and a future correction may settle a different selection.
`renderPosition` is present exactly for included groups and is the zero-based
index in `orderedIncluded`; every position is unique and the positions cover
`0 ... includedCount - 1`.

#### The privacy boundary of schema version 1

Full source content is not configurable in this schema version — it is simply
**not representable**, which is the safest reading of INV-SEC-003. `ContextBlock.content`,
`CompilationRequest.query`, `RenderedContextAttempt.renderedContext`,
`SourceDocument.metadata`, `ContextBlock.metadata`, and `CandidateRetrieval.metadata`
have no field to travel in, and neither has a `SourceDocument.title`.

What the trace does carry is decision and provenance evidence: identifiers,
digests, scope, source types, source locations, required status, category and
authored priority, policy identities, provider identity and version, rank,
provider score contract and value, compiler score components, decision reasons,
token counts, and the rendered digest and count.

#### The tokenizer identity is scoped

`composition.tokenizer` is the tokenizer the **renderer** was given, and it
proves one thing: which tokenizer turned `renderedContext` into
`renderedTokens`. It does not prove which tokenizer produced the
`ContextBlock.tokenCount` values `CandidateValidator` accepted, because no stage
contract from `ValidatedCandidateSet` through `OrderedCandidateSet` carries a
tokenizer identity for `TraceBuilder` to read (DEC-035, DEC-036).

A manual composition may validate under one tokenizer and render under another —
no stage objects, because none receives an identity to compare — and the trace
would then name one tokenizer beside content totals another produced.

`composition.tokenizerCoverage` states the scope rather than widening it:

```text
rendering-attempt-only     the identity explains rendering.renderedTokens only;
                           the content totals under `totals` reconcile among
                           themselves but their tokenizer identity is unknown here

validation-and-rendering   one identity produced the validated block counts and
                           the rendered measurement, so it explains every token
                           quantity in the trace
```

**Phase 14 always publishes `rendering-attempt-only`.** The coverage is never
inferred from matching identifiers or matching numbers, and never accepted as a
caller assertion: the manual caller is exactly the party who might miscompose the
stages. Only a composition root that injects one tokenizer into
`CandidateValidator` and `ContextRenderer` itself can claim
`validation-and-rendering`, and that component is the future `ContextCompiler`
(section 7.2, DEC-037).

Where a value must be identified rather than stored, a deterministic digest is
recorded instead: `request.queryHash` over the exact query and
`rendering.renderedContextHash` over the exact rendered string, both
`sha256:<64 lowercase hex characters>` over a domain-separated canonical preimage.
Hashing here is **audit identity, not authorization**, and no correctness rule of
the kernel depends on collision resistance.

A future schema version may add explicit content capture with security controls.

#### The request fingerprint

```ts
const COMPILATION_REQUEST_FINGERPRINT_VERSION = 1;

type CompilationRequestFingerprint = string;

function fingerprintCompilationRequest(
  request: CompilationRequest,
): CompilationRequestFingerprint;
```

The preimage is the canonical serialization of
`["ctxalloc-compilation-request-fingerprint", 1, request]`, hashed as exact UTF-8
bytes with SHA-256. Object key order is fixed by UTF-16 code unit, array order is
preserved, exact strings survive with no Unicode normalization and no trimming, and
an absent optional property stays absent.

It identifies the **exact validated caller request value**, so `request.id`, the
query, and every array's order participate. It is **not** the future deterministic
compilation identifier, not a semantic-equivalence hash, and not a cache key
promising equivalent outputs. Two requests that compile to the same output may have
different fingerprints, and that is deliberate: INV-DET-002 governs compiler
processing, not the identity of a caller's payload.

The composition inputs it excludes — compiler, tokenizer, and renderer identity —
are recorded beside it in `composition` (INV-TRACE-005).

#### Coherence checks

The builder is not a second semantic validator, but it must not serialize a lie.
Before projecting anything it verifies that the request's scope, source registry,
candidates, budget, and configured policy identities describe the evidence; that
every validated wrapper is a member of exactly one group and each group's
canonical block is one of its own members; that the scored set covers every group
once and the filtering decisions cover every scored candidate once; that the
eligible set is exactly what its eligible decisions describe; that the allocation
decides exactly the eligible candidates and nothing filtered; that `orderedIncluded`
holds exactly the included decisions; and that the rendered budget observation
matches the rendered count.

Each stage is also compared to the one **before** it across every field its
contract carries forward — scope, the source registry, the scoring policy
identity and version, and the reference time — because drift changed on two
stages at once is internally consistent and still wrong. The allocator's
published accounting must not contradict itself either: each decision's
`contentTokens` is its canonical block's own count, the selected sum is the sum
of the inclusions, each inclusion's transition spends exactly its own cost, and
the remainder is the request budget's `availableInputTokens` minus that sum.

Comparison is structural, through the project-owned canonical serialization and
multiset equality, rather than by object identity: identity is not part of the
persisted meaning of a trace, and requiring it would reject a caller who
legitimately serialized a stage result between components.

Nothing is re-run — no token counting, no normalized hashing, no scoring,
filtering, allocation, ordering, or rendering. Inconsistent evidence fails with
`COMPILATION_TRACE_BUILD_FAILED` and one of `invalid_config`,
`inconsistent_request_evidence`, `inconsistent_stage_evidence`, or
`invalid_trace_result`. Issue order is deterministic, and no partial trace is ever
returned.

#### Token reconciliation

The totals reconcile exactly, at the group level, per the corrected INV-TRACE-003
and METRICS 8.12:

```text
candidateTokens
  = canonicalContentTokens + duplicateCandidateTokens

canonicalContentTokens
  = includedContentTokens + excludedCanonicalContentTokens

excludedCanonicalContentTokens
  = filteredContentTokens + allocationExcludedContentTokens
```

`duplicateCandidateTokens` is the difference between the wrapper sum and the group
sum, never a chosen duplicate wrapper subtracted by identity. Rendering counts do
not participate: `renderedTokens` is reported separately, under `rendering`.

Arithmetic is overflow-safe. A total that leaves the exact non-negative safe
integer range is an `invalid_trace_result` failure, never a published
approximation (INV-BUDGET-005).

#### What an unsettled trace deliberately does not carry

No success or failure outcome, no final failure code, no final included list, no
`compiledTokens`, no `unusedTokens`, no `renderingTokenDelta`, no warnings list,
and no deterministic compilation identifier. Those belong to the settlement
overlay below, which only `ContextCompiler` can produce. Trace persistence is
still not implemented; trace creation is not optional, but storing one is
(DEC-020).

#### Schema version 2: the settlement overlay

`COMPILATION_TRACE_SCHEMA_VERSION` is 2 (DEC-038).

Version 1 recorded the filtering decision, the allocation decision, the allocator
summary, the allocation's render order, and the measured render attempt — and
named its per-group verdict `currentDisposition`, **not** `finalDisposition`,
precisely because a render-aware correction may legitimately remove an
allocator-included optional candidate, replace one allocator-selected
category-minimum candidate with another eligible candidate, and settle a
different final render order.

Cloning a version 1 record and flipping `settled: false` to `true` would
therefore publish a false audit record: it would still say the initial allocator
selection was the selection that settled. `settled` being a boolean avoided a
schema change merely to flip finality; it never meant the correction evidence
could be omitted. Representing both the original stage evidence **and** the final
settlement needs new persisted fields, so the version is bumped rather than the
meaning of version 1 changed (INV-STORE-004). No persistence adapter and no
stored trace exist yet, so there is nothing to migrate.

The record is discriminated on `settled`:

```ts
interface UnsettledCompilationTrace extends CompilationTraceBase {
  readonly schemaVersion: 2;
  readonly settled: false;
  readonly composition: { tokenizerCoverage: 'rendering-attempt-only'; ... };
  readonly compilationId?: never;
  readonly settlement?: never;
}

interface SettledCompilationTrace extends CompilationTraceBase {
  readonly schemaVersion: 2;
  readonly settled: true;
  readonly compilationId: CompilationId;
  readonly composition: { tokenizerCoverage: 'validation-and-rendering'; ... };
  readonly settlement: CompilationTraceSettlement;
}

type CompilationTrace = UnsettledCompilationTrace | SettledCompilationTrace;
```

The settlement is an **overlay, not a replacement**. Everything schema version 1
recorded stays exactly where it was — the original filtering and allocation
decisions with their reasons, `currentDisposition`, the allocator summary
including `optionalEvictionOrder`, the allocation's render order, the measured
attempt with its digest and `fitsAvailableInputBudget`, and the reconciliation
totals. Deleting the allocator's evidence because the final selection differs
would destroy the very comparison an audit needs.

```ts
interface CompilationTraceSettlement {
  readonly strategy: 'render-aware-v1';
  readonly correctionApplied: boolean;
  readonly initialRenderedTokens: number;
  readonly evictedBlockIds: readonly ContextBlockId[];
  readonly fallbackSearch: {
    readonly used: boolean;
    readonly selectionsVisited: number;
    readonly maxSelections: number;
    readonly phase?: 'hard-base' | 'policy-selection-rescue';
    readonly chosenBlockIds?: readonly ContextBlockId[];
  };
  readonly decisions: readonly CompilationTraceFinalDecision[];
  readonly ordering: { readonly orderedBlockIds: readonly ContextBlockId[] };
  readonly rendering: { readonly renderedContextHash: string; readonly compiledTokens: number };
  readonly usage: {
    readonly availableInputTokens: number;
    readonly includedContentTokens: number;
    readonly unusedTokens: number;
    readonly renderingTokenDelta: number;
  };
}
```

`decisions` holds exactly one final decision per deduplicated group, in the
trace's own group order; every final inclusion carries one exact `renderPosition`
and the positions cover `0 ... n - 1` exactly once (INV-TRACE-004). The final
reasons are a separate vocabulary from the allocator's, so a correction exclusion
is `EXCLUDED_RENDER_AWARE_CORRECTION` rather than the allocator's
`EXCLUDED_BUDGET_EXHAUSTED`, which may simply be false for it (section 6.8).

The rendered digest uses the same domain-separated preimage as the attempt
digest, so the two are comparable. The final string itself is absent from both,
for the same privacy reason: it appears only in
`CompilationResult.compiledContext` (INV-SEC-003).

#### Settlement is orchestration, not observation

`TraceBuilder` gains no `settle()` method. It still receives only successful
stage evidence, still never calls a tokenizer, still never runs a correction, and
still always emits an unsettled trace. Settlement consumes evidence only
orchestration can produce, so `ContextCompiler` performs it, through a
package-internal helper that builds a **new** value and never mutates the
snapshot (DEC-038).

That helper is also the only place `tokenizerCoverage` is upgraded to
`validation-and-rendering`, and it may do so because `ContextCompiler` owns both
tokenizer injections. The coverage is never inferred from evidence: matching
identifiers or matching numbers prove nothing (DEC-037).

---

### 6.8 ContextCompiler

Status: implemented (DEC-038).

`ContextCompiler` is the **composition root** of the kernel and the only producer
of a `CompilationResult`.

```ts
const CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION = 1;

interface ContextCompilerConfig {
  readonly schemaVersion: 1;
  readonly compilerId: string;
  readonly compilerVersion: string;
  readonly maxCorrectionSelections: number;
}

class ContextCompiler {
  constructor(config: unknown, tokenizer: Tokenizer);
  compile(input: unknown): CompilationResult;
}
```

Responsibilities:

* validate the request and construct every policy-dependent stage from it;
* own the one configured tokenizer and inject it into candidate validation and
  into every rendered measurement;
* run every stage of the named topology, in order, with none skipped;
* settle the rendered budget (section 7.2);
* derive the deterministic compilation identifier;
* project the observational snapshot plus the proven correction evidence into a
  settled trace;
* prove the assembled result before returning it;
* fail with one structured error, naming the stage.

#### One tokenizer, owned by the composition root

The compiler owns exactly one configured `Tokenizer` object and uses that same
object for `CandidateValidator` block token-count validation, for the initial
`ContextRenderer` measurement, and for every render-aware correction measurement.
It constructs no tokenizer of its own and accepts no second one.

This is what finally discharges the open composition requirement of DEC-035: no
stage contract carries a tokenizer identity, so no stage could establish
same-tokenizer provenance alone. The component that performs both injections can,
which makes `tokenizerCoverage: 'validation-and-rendering'` provable and the
signed `renderingTokenDelta` of METRICS 8.6 a defined quantity.

The tokenizer runtime shape check lives in one package-internal helper the
renderer and the compiler share, so the two cannot drift about what a usable
tokenizer is (INV-DEP-003). `ContextRenderer`'s public constructor, issue codes,
and messages are unchanged.

#### Nothing is discovered

`compilerId`, `compilerVersion`, and `maxCorrectionSelections` are injected.
Nothing reads a `package.json` version, a git revision, a build-time constant, an
environment variable, or a clock (INV-DET-003, INV-TRACE-005). Validation is
strict: closed object, non-blank well-formed UTF-16 identities preserved exactly,
no defaults, no coercion.

#### The deterministic compilation identifier

```text
sha256:<64 lowercase hex characters>

["ctxalloc-compilation-id", 1, [
  requestFingerprint,
  { compilerId, compilerVersion, tokenizerId, tokenizerVersion,
    rendererId, rendererVersion,
    correctionStrategy: "render-aware-v1", correctionVersion: 1,
    maxCorrectionSelections }
]]
```

`fingerprintCompilationRequest` (section 6.7) answers *which exact validated
caller request value was this?* This identifier answers *which complete
deterministic compiler invocation was this?* A request-only identifier would
collide across runs that differ in tokenizer, compiler version, renderer, or
search bound — every one of which can change what is compiled.

The whole request is deliberately not duplicated into the preimage: the
fingerprint already binds it (INV-DEP-003). `maxCorrectionSelections`
participates because it is a decision input, not a performance knob.

Nothing random, discovered, or environmental participates. The identifier names
the **invocation**, not only a successful output, so every failure after request
validation exposes it; an invalid raw request has none, because no validated
fingerprint exists to bind.

#### Structured failure

```ts
type ContextCompilationStage =
  | 'configuration' | 'request-validation' | 'candidate-validation' | 'deduplication'
  | 'scoring' | 'filtering' | 'allocation' | 'ordering' | 'rendering' | 'trace'
  | 'correction' | 'result';

class ContextCompilationError extends Error {
  readonly code = 'CONTEXT_COMPILATION_FAILED';
  readonly stage: ContextCompilationStage;
  readonly issues: readonly ValidationIssue[];
  readonly compilationId?: CompilationId;
  readonly trace?: UnsettledCompilationTrace;
}
```

A stage failure is **wrapped, not flattened**: the owning stage's exact issue code
survives and its path is prefixed with the stage, so a consumer keeps the reason
and gains the location. No validation-library error, `DomainValidationError`,
nested stage error object, or tokenizer-library exception crosses the boundary,
and no partial result is ever returned (INV-ADAPTER-001, INV-ADAPTER-003).

`compilationId` is present for every failure after the request validated. `trace`
is the coherent unsettled snapshot, present for a correction or result failure
and absent before rendering. Both optional members are genuinely absent rather
than present holding `undefined`.

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

If rendering causes an overrun, optional blocks must be removed according to
policy and the context rendered again.

Required blocks must never be silently removed during this correction step.

### 7.1 What the allocator enforces before rendering

`BudgetAllocator` (section 6.4) enforces the **canonical block-content budget**
exactly:

```text
sum(included canonicalBlock.tokenCount) <= availableInputTokens
```

`availableInputTokens` comes from the validated `TokenBudget` and nothing else,
and the stage adds no reserve of its own. Its published metrics —
`selectedBlockContentTokens` and `unallocatedBlockContentTokens` — are
provisional block-content values, not the final `compiledTokens` and
`unusedTokens` of METRICS 8.4 and 8.10.

The allocator also precomputes `optionalEvictionOrder`, a deterministic sequence
of optional block identifiers whose removal preserves every required block and
every category minimum. Section 7.2 is what consumes it.

**Exact rendered measurement now exists.** `ContextRenderer` (section 6.6)
serializes the ordered selection and tokenizes the complete rendered string, so
the rendering tokens of source labels, heading paths, JSON escaping, separators,
and record structure are all measured — they are part of the one string that is
counted. `renderedTokens` is a real measurement of what a model would receive for
that selection.

### 7.2 The implemented render-aware settlement

`ContextCompiler` (section 6.8) settles the rendered budget. Correction strategy
version 1 is named `render-aware-v1` and has two paths (DEC-038).

**Every feasibility decision measures one exact complete rendered string.** The
`Tokenizer` port promises the count of one supplied string and nothing more:

```text
tokenizer(a + b)   is not necessarily   tokenizer(a) + tokenizer(b)

S over budget      does not imply       every superset of S is over budget
```

Non-monotonicity forbids two inferences the fallback might otherwise make: that a
required-only overrun proves no selection containing the required blocks fits,
and that exhausting the **minimal** policy-valid bases proves nothing fits at
all. Both are false, and both are treated as measurements below.

So no rendered cost is assigned to a block, no guessed wrapper cost is
subtracted, and no infeasibility is proved by summing per-block estimates
(INV-BUDGET-002, INV-RENDER-004). A complete measurement is cached by a canonical
block-identifier set key, so one exact selection is never tokenized twice; no
per-block cost is ever cached, because no such quantity exists.

The correction reaches `ContextOrderer` and `ContextRenderer` semantics through
package-internal helpers those stages also call, so a corrected selection orders
and renders byte-for-byte as the public stages would.

#### A. The cheap path: the exact optionalEvictionOrder prefix

Render attempt 0 is the existing `ContextRenderer` attempt. If it fits, no
correction is applied and that selection is final.

If it does not, the correction walks `allocation.optionalEvictionOrder` in its
exact published order. For each identifier it removes that block from the current
selected set, keeps every required block, keeps every category minimum satisfied
— which the allocator's order guarantees for every prefix (INV-ALLOC-006) —
re-orders, renders the exact complete string, and tokenizes it. **The first
fitting prefix wins**, and the exact evicted sequence is recorded.

The order is never sorted, never reordered, and never skipped to try a later
entry first. No score, no score-to-token ratio, and no estimated rendered saving
takes part.

#### The required-only probe

Exhausting the eviction order proves nothing, so before enumerating alternatives
the correction measures the exact **required-only** selection: every required
eligible candidate, no optional candidate, ordered, rendered, tokenized, cached.

It is a **measurement, not a verdict.** A required-only overrun is not a token
lower bound: tokenization is not monotonic, so a selection containing the same
required blocks *plus* an optional one may render smaller. Failing here would
reject compilations that demonstrably succeed.

The probe earns its place for two other reasons: it seeds the cache with the
selection most candidates share, and when no category has a deficit it *is* the
first hard base, so the next phase finds it already measured.

`required_content_exceeds_budget` is still raised — but only after the exhaustive
search below, and it then means exactly *no policy-valid final selection
containing every required block renders within the budget*. That is the rendered
form of INV-BUDGET-004 (INV-BUDGET-003).

`BudgetAllocator` already reports the block-content form of this failure, and
that one is definitive without any search — because the canonical block-content
ceiling is an independent allocation constraint, not a prediction of rendered
size. Required content exceeding it is an allocation impossibility under the
active policy, and render compression is not permission to violate that contract.
The converse still does not hold: a required set that fits the content ceiling is
not proof of rendered feasibility.

#### B. The fallback: bounded hard-minimum replacement search

Exhausting `optionalEvictionOrder` shows only that no more *currently selected*
optional surplus can be given back under the current hard constraints. The
allocator minimized canonical block **content** cost when it chose which
candidates satisfy each category minimum, and rendering overhead varies per
block, so a protected cheaper-by-content block may render far more expensively
than an unselected candidate of the same category that satisfies the same minimum
(section 6.4). Declaring infeasibility there would be wrong.

A **hard base** contains every required eligible canonical group, plus exactly
`deficit = max(0, minBlocks - requiredCount)` non-required candidates from each
category carrying `minBlocks`, and no optional surplus beyond those deficits.
Optional candidates in unconstrained categories are absent. Candidates come only
from `FilteredCandidateSet.eligible`. A hard base must also satisfy the
allocation policy's exact content contract, `sum(canonicalBlock.tokenCount) <=
availableInputTokens`: render compression is never an excuse to violate the
ceiling the allocator enforces.

The enumeration order is fixed and total:

1. constrained categories sorted by the project-owned code-unit comparison, never
   by locale;
2. inside a category, optional eligible candidates sorted by the allocator's own
   hard-minimum preference — `tokenCount` ascending, then `score.total`
   descending, then canonical block ID ascending;
3. k-combinations of size `deficit` in lexicographic **index** order over that
   sorted list;
4. the Cartesian product of the per-category lists in sorted category order, with
   the first category varying slowest.

The last rule gives the enumeration its important property: **the first hard base
visited is exactly the category-minimum choice `BudgetAllocator` preferred.**

For each visited base whose content sum fits, the selection is ordered, rendered,
tokenized, and accepted if `compiledTokens <= availableInputTokens`. The first
exact-render fitting base wins and the search stops.

#### C. The rescue: hard bases are not the whole space

If every hard base is over budget, the search does **not** stop. Minimal bases
are only part of the policy-valid space, and a strict policy-valid superset of an
over-budget base may render within the budget.

The rescue enumerates the remaining distinct policy-valid final selections. Every
one contains every required eligible group, draws only from
`FilteredCandidateSet.eligible`, satisfies every `minBlocks` and `maxBlocks`, and
satisfies the content ceiling — but it may carry optional surplus and may include
candidates from unconstrained categories.

Its order is a project-owned total order, deliberately different from the
hard-base phase's: eligible non-required candidates sorted by category presence,
then category, then block ID by code unit; then subset cardinality ascending;
then lexicographic index order inside one cardinality. It does not reproduce the
allocator's preference and need not — the hard-base phase already ran.

The enumerator is **category-constraint-aware**, not a filtered power set, and
that is a property of the bound rather than a performance note: a
category-invalid subset never reaches the visit step, so it never counts and
never consumes the bound. Generating every subset and rejecting the invalid ones
afterwards would therefore do unbounded work — with 30 candidates in a category
whose `maxBlocks` is `0`, `2^30 - 1` invalid subsets under a bound of 1. Instead
three prunes apply during construction: cardinality bounds derived from the total
deficit and total capacity, capacity per category, and reachability of the
remaining minimums. None removes a valid subset, and the order over valid subsets
is unchanged.

The first fitting rescue selection wins. This is **correctness rescue, not
optimization**: it claims no maximum of anything.

A **fitting hard base is still settled immediately** and never re-augmented. The
common path already preserves the greedy allocation and removes only the minimum
safe prefix; the hard-base phase exists only because protected minima rendered
poorly; tokenization is non-additive, so a "fill every spare token" pass would
need its own explicit selection policy, and the current `CompilationPolicy` has
no render-aware optimization slice to express one. That is a limit on ambition,
not on correctness: the rescue still runs whenever no hard base fits.

#### The search limit is a stopping point, never a proof

`maxCorrectionSelections` counts **unique** selections across all three phases —
the probe, every hard base, every rescue selection — keyed by the exact canonical
block-identifier set, so a selection reached twice is counted and tokenized once.
A selection whose content sum exceeds the ceiling is counted and never rendered.

Before admitting unique selection `N + 1`, if `N` already equals the configured
maximum, the search stops with `correction_search_limit_exceeded`, reporting the
configured maximum, with no partial success. It never claims that no policy-valid
selection fits.

The count is **work**, not a census of valid selections: it includes the
required-only probe even when an active category minimum makes required-only
invalid as a final selection, and it includes selections the content ceiling
ruled out before rendering. `selectionsVisited` keeps those semantics — it is
what the bound bounds — and the exhaustive failure messages state the work and
the conclusion separately rather than calling the count a number of policy-valid
selections.

#### The bound stops work, not just results

A bound that fires only after the enumeration has been materialized protects
nothing, because building the universe *is* the pathological cost: with 24
eligible candidates and a minimum of 12 there are `C(24, 12) = 2,704,156` minimal
bases, and at 60 and 30 more than 10^17.

Every combinatorial enumeration is therefore **lazy**. `combinations` is a
generator that yields one index tuple at a time and accumulates nothing; the
Cartesian product takes restartable **factories** rather than sequences, because
it replays each inner sequence once per item of the outer one and a generator
cannot be rewound. The bound is checked as each unique selection is admitted.

#### The three correction failures are distinct

```text
required_content_exceeds_budget          every policy-valid selection containing every required
                                         block was visited, and none renders within the budget
rendered_hard_constraints_exceed_budget  the same, where a non-required category minimum is
                                         active and made the surviving selections mandatory
correction_search_limit_exceeded         the search stopped at its bound; feasibility is unknown
```

The first two report the same measured fact and differ only in which constraint
made the surviving selections mandatory, because that is what tells the caller
which configuration to change. Neither claims a token lower bound. The
classification follows `deficit(category) = max(0, minBlocks -
requiredCount(category))`: no active deficit gives the required-content code,
some active deficit the hard-constraint one. The second is deliberately not a
required-content failure, because category minimums are policy constraints rather
than required-block attributes and the caller's fix is a different one.

#### What this discharges

1. INV-BUDGET-001 is discharged by the success validation of section 6.8: no
   `CompilationResult` is returned whose `compiledTokens` exceeds
   `availableTokens`;
2. INV-BUDGET-002 is discharged: the complete rendered string is tokenized before
   success is returned, and every corrected selection is measured the same way;
3. INV-BUDGET-003 holds through every correction path: no required block is
   evictable, and every hard base contains all of them;
4. INV-BUDGET-004 gains its rendered failure;
5. INV-BUDGET-006 has an implemented producer, exact rather than estimated;
6. a settled `CompilationTrace` exists, and only it may be attached to a success.

What remains outside the kernel is unchanged: retrieval, source reading,
persistence, the CLI, the HTTP API, model execution, and evaluation.

---

## 8. Retrieval Boundary

The application receives candidates through the implemented port (DEC-039):

```ts
interface CandidateProviderRequest {
  readonly scope: Scope;
  readonly query: string;
  readonly referenceTime: Timestamp;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly blocks: readonly ContextBlock[];
}

interface CandidateProvider {
  readonly id: string;
  readonly version: string;
  getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]>;
}
```

The provider returns `CandidateBlock` wrappers rather than bare blocks, so its
own identity, rank, and score travel as retrieval evidence beside a canonical
block that is never rewritten (DEC-030).

`sourceDocuments` and `blocks` carry the prepared corpus explicitly, because the
current phase has no persistent retrieval index. A provider that owned an index
would query it; a provider that does not is handed exactly the corpus the
application prepared.

Implemented: `FakeCandidateProvider`, a test double that performs no retrieval
at all. It reads no query, computes no similarity, and invents no score.

Future: SQLite FTS5, QMD, Qdrant, or another external retrieval system.

The compiler must not know which provider produced the blocks. Candidate order
is provider-owned, and the application preserves it rather than re-sorting it.

Two different guarantees check that a provider proposed from the corpus it was
given, at two different layers, and neither subsumes the other:

```text
CandidateValidator, in the kernel:
  proves source-document validity
  the block names a source in the request registry, agrees with it on scope
  and type, and its hash and token count match its own content
  it never receives the prepared corpus, so it cannot prove membership

Application prepared-corpus boundary, Phase 16:
  proves prepared-corpus membership
  the block carries the identifier of a block this service prepared and is
  structurally identical to it in every field
  a mismatch is rejected, never repaired
```

A block can satisfy the first and fail the second: a provider may return a
schema-valid block naming a real source whose content came from nowhere. That is
provider-invented content, and it must not reach a compiled result
(INV-PROV-001).

Provenance inspection is total over untrusted provider output: a value it cannot
canonicalize is neither compared nor rejected here, so no runtime error escapes
and `CandidateValidator` keeps ownership of malformed-candidate rejection.

Isolation runs in both directions (INV-ADAPTER-004). The provider receives a copy
of the corpus, so mutating what it is handed cannot change what is compiled; and
its valid output is deep-copied on return, so references it retains cannot mutate
a completed `LocalCompilationResult` after the fact. The same application-owned
snapshot is verified, compiled, and published.

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
Control plane, implemented and read-only:
  lists the SourceRegistrations of one exact scope
  owns logical source identity, separate from the adapter locator

SourceReader adapter, implemented:
  reads exact source text for one adapter locator
  validates its configuration and its request strictly, with exact fields
  confines every locator to a configured root by real path
  decodes UTF-8 strictly and normalizes nothing
  infers no source type and no timestamp

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

Application text chunker, implemented:
  splits maximal non-blank line runs into paragraphs
  groups and splits them under one explicit token policy
  preserves exact source text as block content
  infers no heading, list, or table structure

Application conversation ingestion and chunker, implemented:
  validates one strict local JSON format
  hashes canonical logical content, not the raw file
  emits one block per message, never split
  identifies a block by message identity, not position

Compiler candidate validation, implemented:
  receives an explicit scope, a source registry, and candidate wrappers
  validates them strictly through the injected Tokenizer port
  never reads source content from files during compilation
```

The whole local path exists today: `CompileLocalContextService` joins the control store, the source reader, ingestion, chunking, the candidate provider, and `ContextCompiler` into one flow from registered local sources to a `CompilationResult` (DEC-039). Identity derivation and content hashing follow DEC-028, Markdown chunking follows DEC-029, candidate validation follows DEC-030, and text chunking, conversation ingestion, and conversation chunking follow DEC-039.

Logical source identity is never a machine path. A registration carries an
`identity` — namespace plus key — and a `locator`; only the identity, the scope,
and the source type determine the derived `SourceDocument.id`, so moving a file
moves a source rather than creating a second one.

A dependency's own error message is untrusted output and is never republished.
Port implementations choose their own wording, which routinely carries an
absolute path, a connection string, a query, or stored content, so the
application reports fixed project-owned messages and attaches no cause
(INV-SEC-001). Parser diagnostics are treated the same way: they quote the input
and vary by runtime, so they are not part of any published contract.

Real retrieval, trace persistence, control-plane writing, model execution, the
CLI, and the HTTP API remain later phases.

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

The model provider consumes the compilation result. It is implemented as a
project-owned port (DEC-040).

```ts
interface ModelProvider {
  readonly id: string;
  readonly version: string;
  readonly modelId: string;
  generate(request: ModelProviderRequest): Promise<ModelProviderResult>;
}
```

The model identity belongs to the provider **instance**, not to a request, so
one run cannot silently mix two models. The result carries no latency: the
caller measures duration around the call, through `MonotonicClock`.

The compiler must not:

* call a model;
* retry provider failures;
* stream responses;
* select a model;
* calculate provider billing.

Those responsibilities belong to the application or adapter layer.

The MVP supports one provider implementation for evaluation:
`AnthropicModelProvider` (DEC-040). The compiler remains model-free, and only
`@ctxalloc/evaluation` consumes the port.

---

## 13. Evaluation Architecture

The evaluation harness must use the same compiler used by production interfaces.

`EvaluationHarness` is implemented in `@ctxalloc/evaluation` (DEC-040). It
depends on `@ctxalloc/domain`, `@ctxalloc/ports`, and `@ctxalloc/compiler`, and
deliberately not on `@ctxalloc/application`: a benchmark case is static data, so
the measurement stays decoupled from the pipeline that produces what is
measured.

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

The harness owns **one** `Tokenizer` object and gives it to
`CandidateValidator`, to every baseline measurement, and to `ContextCompiler`,
so baseline and compiled counts are one vocabulary. Provider-native token usage
is a second vocabulary and is never combined with it.

Both model calls for one case use the same provider instance, system prompt,
query, output limit, temperature, and prompt version: only the context differs.
The versioned prompt belongs to the harness, never to an adapter.

The three baselines — full context, whole-record truncation, and top-k over
comparable retrieval evidence — are evaluation strategies, not compiler stages.
None produces a `CompilationId`, and token reduction exists only here.

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

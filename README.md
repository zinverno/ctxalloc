# CtxAlloc

**CtxAlloc** (Context Allocation Engine) is a deterministic context budgeting and
compilation engine for AI systems. It is designed to receive a set of candidate
context blocks, select a minimal sufficient subset under a strict token budget,
render the final context, and produce a complete, machine-readable decision trace.
CtxAlloc is not a retrieval system, memory system, vector database, model gateway,
or agent framework.

## Status

Phase 18 — **the compiler kernel is complete, the first local
source-to-compilation slice is complete, the evaluation harness is complete, and
the first real lexical candidate provider is complete**.

`ContextCompiler` composes the kernel stages, settles the rendered budget, and
returns a `CompilationResult` (Phase 15). `CompileLocalContextService` carries
registered local sources into it: the control plane lists them, a source reader
reads exact text, ingestion and chunking prepare a corpus of Markdown,
plain-text, and conversation blocks, a candidate provider proposes wrappers, and
the existing compiler compiles them (Phase 16).

`EvaluationHarness` now measures what that is worth. For one benchmark case it
builds three explicit baselines — full context, whole-record truncation, and
top-k over comparable retrieval evidence — compiles the real request, measures
what survived, optionally asks one model the same question twice changing only
the context, and reports token reduction, context preservation, answer quality
loss, and latency as **separate** numbers. One real model adapter is available
for that, and CI runs the whole benchmark with model execution disabled.

Every measurement boundary fails loudly rather than publishing a weaker number:
the model adapter refuses redirects before a request is transmitted, so an API
key and a prompt are never re-sent to an unauthorized host, and its timeout is
bounded by the timer it actually uses; baseline token counts are accepted only
as non-negative safe integers; a throwing tokenizer or clock becomes a named
harness failure, one clock instance must never read backwards across the whole
run rather than merely within a measured pair, and no averaged latency can be
published as `Infinity`; an injected model provider is checked for identity and
capability at construction, and every result it resolves with is validated
before it is hashed, scored, or counted; and quality loss is withheld when the
two model calls report different actual models.

`MiniSearchCandidateProvider` closes the last gap in that flow: until now every
candidate came from a test double that never read the query. It is **offline
lexical retrieval** — BM25+ over exactly the corpus the request carries, with no
embedding, no model, no reranker, no query expansion, no network, and no index
that survives the call. One prepared block is one indexed record whose identifier
is the block's own and whose only searchable text is the block's own content, and
every candidate it proposes wraps the exact block it was given: nothing is
re-chunked, rewritten, or reconstructed (Phase 18).

The complete local flow is now real end to end:

```text
local files
  -> ControlStore + SourceReader
  -> ingestion and chunking
  -> exact prepared ContextBlocks
  -> MiniSearchCandidateProvider          (lexical retrieval)
  -> CandidateBlock[] with truthful retrieval evidence
  -> prepared-corpus provenance boundary
  -> ContextCompiler
  -> CompilationResult + settled trace
```

The provider's score is published for what it is — the library's BM25+ sum times
the number of matched query terms, unbounded and comparable only within one query
— and never as a compiler score: the compiler normalizes it only through an
explicit policy rule and decides inclusion itself. Retrieval proposes; the
compiler selects. The technology was chosen by a committed spike with hard gates,
and the primary candidate it names was rejected on measured evidence
([docs/RETRIEVAL_SPIKE.md](./docs/RETRIEVAL_SPIKE.md)).

Phases 17 and 18 add **no** compiler selection behavior. The compiler calls no
model, reads no clock, and cannot tell which provider produced a candidate.

The repository contains the TypeScript monorepo scaffolding from Phase 1
(workspace structure, strict compiler and linting configuration, test
infrastructure, package boundaries, boundary checker), the runtime-validated
domain model in `@ctxalloc/domain` (scope, identifiers, content hash values,
JSON-safe metadata, source types, source locations, `SourceDocument`,
`ContextBlock`, `TokenBudget`, and a structured validation API), six
project-owned type-only ports in `@ctxalloc/ports` (`Tokenizer`, `SourceReader`,
`ControlStore`, `CandidateProvider`, `ModelProvider`, `MonotonicClock`), six
deterministic test doubles in `@ctxalloc/testing` (`FakeTokenizer`,
`InMemorySourceReader`, `InMemoryControlStore`, `FakeCandidateProvider`,
`FakeModelProvider`, `FakeMonotonicClock`) with a reusable tokenizer contract
test suite, a real offline tokenizer adapter in `@ctxalloc/tokenization`, the
real local file reader, model adapter, monotonic clock, and lexical candidate
provider in `@ctxalloc/adapters`, the application use cases in `@ctxalloc/application`
(source ingestion, Markdown, plain-text, and conversation chunking, and the local
compilation service), the compiler kernel in `@ctxalloc/compiler` — structural
request and policy validation plus nine components: `CandidateValidator`,
`CandidateDeduplicator`, `CandidateScorer`, `CandidateFilter`, `BudgetAllocator`,
`ContextOrderer`, `ContextRenderer`, the observational `TraceBuilder`, and
`ContextCompiler` — and the evaluation harness in `@ctxalloc/evaluation` with a
versioned benchmark dataset under `benchmarks/evaluation/v1/`, plus a versioned
retrieval dataset under `benchmarks/retrieval/v1/`.

**The product is not complete.** Semantic and hybrid retrieval, embeddings, a
vector database, reranking, query expansion, a persistent retrieval index and its
lifecycle, persistence and SQLite, control-plane writing, trace persistence, the
CLI, the HTTP API, pricing and cost, LLM-as-judge scoring, and multi-model routing
remain later phases. Phase 18 retrieval is **lexical only** — it matches words,
not meaning, and a paraphrase sharing no term with the corpus is a legitimate
miss.

**No benchmark acceptance gate is claimed.** The harness runs; the MVP targets in
[Metrics](./docs/METRICS.md) remain unmet until a real run reports them. CtxAlloc
is not a model gateway, has no production retrieval quality result, and is not
SaaS-ready.

`O200kBaseTokenizer` counts exact text with the `o200k_base` encoding bundled in
`js-tiktoken` (pinned to 1.0.21, see [DEC-027](./docs/DECISIONS.md)). It runs
fully offline: no network request, no model API, no model-name mapping, and no
runtime rank download. Its counts are verified against committed golden fixtures
that were cross-checked with the official `openai/tiktoken` package before being
committed. **This adapter is not universal for all model families:** `o200k_base`
is a reference encoding, and a model family that uses a different vocabulary
needs its own adapter. CtxAlloc supports no provider API — not OpenAI, not
Anthropic, not any other.

`TokenBudget` validates a budget and reports two exact values:
`configuredReservedTokens` and `availableInputTokens`. It is pure arithmetic over
validated integers and depends on no tokenizer. Both arrived in Phase 4.

`@ctxalloc/application` adds `ingestSource`, one synchronous, deterministic,
offline use case (see [DEC-028](./docs/DECISIONS.md)). It takes an explicit
scope, source type, logical source identity, JSON-safe metadata, and **source
content that the caller has already read**, then returns a validated
`SourceDocument` plus the unchanged content. The document ID is derived from the
logical identity alone, so editing a source changes its `contentHash` and keeps
its identity; the `contentHash` is SHA-256 over the exact content encoded as
UTF-8. Content is never normalized: line endings, whitespace, a BOM, a trailing
newline, and composed or decomposed Unicode all survive unchanged and are all
visible in the hash. Malformed UTF-16 is rejected before hashing.

`MarkdownChunker` turns one ingested Markdown source into validated
`ContextBlock` records (see [DEC-029](./docs/DECISIONS.md)). It is synchronous,
deterministic, and offline, takes the `Tokenizer` port through constructor
injection, and takes an explicit `targetTokens` / `maxTokens` policy — token
limits, never character estimates. Every block's `content` is an exact substring
of the source: `source.content.slice(startOffset, endOffset) === block.content`.
Heading context lives in `headingPath`, never inside the content, and canonical
blocks never overlap.

The chunker recognizes ATX headings, backtick and tilde fences, strict
source-only frontmatter, loose and nested lists, blockquotes and callouts,
tables, and HTML blocks. Fenced code, lists, quotes, tables, and HTML blocks are
atomic and are never split; an atomic block larger than `maxTokens` is emitted
intact and marked oversized rather than truncated. Only paragraphs are split, at
a sentence, whitespace, or Unicode-safe boundary, and never inside a surrogate
pair. Block IDs are SHA-256 over a versioned payload of source document, heading
path, normalized content hash, and a deterministic duplicate occurrence, so a
block keeps its identity when unrelated earlier text shifts its offsets.
**Setext headings are not supported in this phase:** a title underlined with
`===` or `---` stays ordinary paragraph content, a limitation documented in
DEC-029 rather than approximated.

Its structural scanning design was adapted from the MIT-licensed
`zinverno/obsidian-ai-hub` plugin; see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). CtxAlloc imports no Obsidian
API or metadata cache type.

**No source reader exists.** Ingestion and chunking read no file, walk no
directory, fetch no URL, and infer no path or scope; the caller supplies the
content.

`@ctxalloc/compiler` opens with `CandidateValidator`, the compiler kernel's
runtime trust boundary (see [DEC-030](./docs/DECISIONS.md)). It is synchronous, deterministic,
and offline, and takes the `Tokenizer` port through constructor injection.

Candidates arrive as `CandidateBlock`, an ephemeral request-specific wrapper
around one canonical `ContextBlock`. The wrapper carries optional
retrieval-supplied data — provider identity, rank, and a provider-defined score
with explicit `semantics` and `higherIsBetter` — so a `ContextBlock` stays
query-independent. **The validator carries retrieval scores without interpreting
them:** it never normalizes, compares, or sorts by one, and scores from different
providers or metrics are not assumed comparable. Only `CandidateScorer`
interprets a score, and only under an exact normalization contract (see below).
Retrieval data is never written back into the block.

**Validation is strict and all-or-nothing.** Any problem rejects the whole batch
with one structured `CandidateValidationError`. Nothing is silently removed,
repaired, reordered, or re-counted. A top-level schema failure reports the schema
issues alone; once the schema passes, every cross-record problem in the batch is
collected before failing.

Both `tokenCount` and `normalizedContentHash` are recomputed — the count through
the injected tokenizer over the exact block content, the hash through the shared
domain helper — and a mismatch is a rejection, not a repair. Source references
are validated against an explicit `SourceDocument` registry supplied with the
batch, and scope matching is exact, so an absent `projectId` and an explicit one
are different scopes. A duplicated source ID resolves to no record at all, so no
duplicate becomes authoritative and the reported issues cannot depend on registry
order. `SourceDocument.contentHash` is not recomputed: the complete original
source content is intentionally absent during compilation.

Provenance must also be internally consistent: a block's `sourceLocation` kind
must match its own source type — `markdown` and `text` blocks are located by a
character range, `conversation` blocks by a message — so a block cannot claim
provenance its source type cannot produce. An absent source location stays valid,
and no location value is rewritten. This is provenance validation, not source
reconstruction: `endOffset <= sourceLength` is still not checked, because
`SourceDocument` carries no full content.

`CandidateValidator` itself does not deduplicate: two wrappers carrying the same
block, with or without different retrieval metadata, pass through in input order
for the next stage. What it rejects is one block ID attached to two _different_
canonical records.

Priority is restricted to finite safe integers, including negative values. The
block schema itself still declares no product-specific range: a semantic range
exists only where a scoring policy states one, in the `authoredPriority`
component described below.

`CandidateDeduplicator` runs after the validator (see
[DEC-031](./docs/DECISIONS.md)). It takes a `ValidatedCandidateSet` and returns
groups of exact duplicates. It needs no injected dependency and calls no
tokenizer.

**Duplicates are decided by exact canonical normalized text, not by the hash
alone.** The validated `normalizedContentHash` only picks a bucket; membership is
settled by comparing the normalized strings, so no duplicate decision rests on
digest collision resistance. Line endings are the only difference the rule
ignores: an LF copy and a CRLF copy of one text deduplicate, while a trailing
space, a different blank-line count, different indentation, NFC versus NFD, a
case or punctuation change, a substring, or a paraphrase all stay distinct.
Contradictory values — `timeout = 30` against `timeout = 60` — are never
collapsed.

**Required blocks win exact duplicate groups,** and the remaining tie-break is
the lexicographically smallest block ID, compared by code unit rather than by
locale. Retrieval score, retrieval rank, provider identity, authored priority,
category, timestamps, token count, metadata richness, source location
completeness, and input position never select the canonical block. The canonical
block is always one of the group's own records, carried unchanged: nothing is
merged, synthesized, or mutated into a required block.

**Every wrapper and every retrieval record is preserved as evidence,** appearing
exactly once inside exactly one group, so a duplicate's block ID, source
document, source location, heading path, metadata, and provider data all stay
recoverable. No retrieval record is merged and no score is compared or
normalized. Output groups, members, and the returned source registry are ordered
stably and do not depend on candidate input order.

**No near-duplicate logic exists** — no embeddings, similarity thresholds, edit
distance, stemming, containment, or heading heuristics — and no configuration
flag is offered for a capability that is not implemented. **No policy filtering
exists** either: it requires a versioned `CompilationPolicy`, so no candidate is
excluded here for its category, source, timestamp, priority, score, rank,
provider, relevance, freshness, or size.

`CandidateScorer` runs after deduplication (see
[DEC-032](./docs/DECISIONS.md)). It takes a `DeduplicatedCandidateSet` and an
explicit reference time and returns a `ScoredCandidateSet`: every group carries
one `CandidateScore` with **five optional transparent components** — retrieval
relevance, authored priority, source priority, category priority, and recency —
each publishing its normalized value, the policy weight, the contribution, its
aggregation rule, and the evidence behind it. It is driven by one narrow
versioned `CandidateScoringPolicy`, not by the broad future `CompilationPolicy`,
and it needs no tokenizer, provider, clock, or storage.

**Retrieval scores require an exact normalization contract.** A provider score
counts only when the policy owns a rule for its exact `providerId`,
`providerVersion`, `semantics`, and `higherIsBetter`, with a fixed inclusive
range. Ranges are policy input, never inferred from the provider, from a rank, or
from the other candidates in the batch. A value outside its range rejects rather
than clamps, and a scored record with no rule rejects rather than being read as
zero or dropped. A retrieval record with no score is fine and simply carries no
relevance; rank alone and provider identity alone never do.

**Duplicate retrieval count cannot inflate a score.** Every component aggregates
its group by maximum — across normalized retrieval evidence, and across the
group's distinct blocks for the other four. The same content wrapped twenty times
scores exactly as it does wrapped once, nothing is summed, averaged, or counted,
and all evidence stays visible.

**Required blocks are never boosted.** There is no required component, no boost,
and no large constant: required content stays a separate allocation class for the
future allocator, and a required candidate may score zero while an optional one
scores higher.

**Recency is driven by an explicit reference time** supplied per call and
validated with the project `Timestamp` contract — never by the system clock. It
uses `updatedAt ?? createdAt`, an explicit policy value when a block carries
neither, and clamps a future timestamp to age zero.

The result is **ranked by total then block ID**, compared by code unit rather
than by locale. Weights need not sum to one, so a total is a policy-relative
utility rather than a probability, comparable only within one run of one policy
version.

**No candidate is filtered.** Every deduplicated candidate appears exactly once
in the result unless scoring fails as a whole; there is no minimum score
threshold, no token budget is read, and no inclusion, exclusion, or eviction
decision is made. No lexical, BM25, embedding, or LLM relevance scorer runs
inside the compiler, and no redundancy or near-duplicate score exists.

`BudgetAllocator` runs after scoring and policy filtering (described below; see
[DEC-033](./docs/DECISIONS.md)). It takes a `ScoredCandidateSet`, an explicit
`TokenBudget`, and one narrow versioned `BudgetAllocationPolicy`, and returns an
`AllocatedCandidateSet` in which every candidate carries exactly one
machine-readable decision. It needs no tokenizer, renderer, provider, clock, or
storage.

**Required blocks are resolved first.** They are included before every optional
block, in stable block-identifier order, and are never boosted by a score, never
silently removed, and never evictable. Required block content that alone exceeds
the available budget fails with a structured error, and required content over a
category maximum fails rather than relaxing the maximum.

**Reserves are exact.** The budget is validated with the existing `TokenBudget`
contract and the ceiling comes from `availableInputTokens()`. The model context
window is never guessed, no reserve is defaulted or injected, and no hidden
rendering reserve is added.

**Category minimums and maximums are block counts,** spelled `minBlocks` and
`maxBlocks`: at least or at most that many independently selectable canonical
blocks of one exact category. They are not token quotas or percentage shares.
Categories match by exact string equality, an absent category is unconstrained,
and duplicate wrappers never count as extra blocks.

**Hard minimums use the minimum-content-cost selection.** Required blocks count
toward a minimum, and the shortfall is filled with the cheapest candidates of that
category — token count ascending, then score, then block identifier — so a
minimum is reported as infeasible only when no selection satisfying it would have
fit.

**Optional selection is score-desc greedy.** Candidates are considered by score
descending, then block identifier. A category maximum is checked before the
budget, so a blocked candidate spends nothing, and a candidate that does not fit
is skipped while smaller lower-scoring ones are still considered. There is no
score-per-token ratio, no knapsack, and no total-utility optimization.

**Failures are structured and all-or-nothing:** an invalid policy, a duplicate
category constraint, an invalid budget, required content over the budget, required
content over a category maximum, an unreachable category minimum, and category
minimums that exceed the content budget each produce a machine-readable issue, and
no partial result is ever returned.

**A deterministic eviction order is precomputed** for the future
render-correction loop. Required blocks never appear in it, and a block enters it
only when removing it would keep its category at or above its minimum, so every
prefix is safe to remove from the current selection. It is a **safe removal order,
not a feasibility proof**: exhausting it shows only that no more currently
selected optional surplus can be given back, never that no other allocation fits
the rendered budget, because hard minimums were satisfied at minimum
block-content cost and rendering overhead may vary per block.

**Selected block-content tokens are not final rendered tokens.** The allocator
proves `sum(included canonicalBlock.tokenCount) <= availableInputTokens` exactly
and publishes `selectedBlockContentTokens` and `unallocatedBlockContentTokens`.
It deliberately publishes no `compiledTokens` and no final `unusedTokens`: those
belong to a settled selection, which only the future correction loop produces.

`ContextOrderer` runs after allocation (see
[DEC-034](./docs/DECISIONS.md)). It takes an `AllocatedCandidateSet` and one
narrow versioned `ContextOrderingPolicy`, and returns an `OrderedCandidateSet`
whose `orderedIncluded` is the render order of the current selection. It exists
so that the future renderer never decides layout implicitly.

**It changes no decision.** The ordered sequence holds exactly the included
decision objects the allocator produced, by reference, permuted: every one
appears once, no excluded decision appears, and no reason changes. Nothing is
rendered, tokenized, measured, or cloned, and array position is the whole
ordering contract — no index is written onto a block.

**Blocks are grouped by source document, then follow that source's own order.**
Text and Markdown blocks are ordered by character offset alone — `startLine` and
`endLine` stay in the source location as provenance but never order anything,
because comparing them only when both blocks record them is not transitive and
ranking their presence would let optional metadata decide the layout.
Conversation blocks follow `messageIndex`; a message that
states no index comes after those that do, and `messageId` is only a
deterministic code-unit fallback — never parsed for an embedded timestamp or
sequence number, so `m-10` precedes `m-2`. A block with no source location is
placed after the located blocks **of its own source** and ordered by identifier
alone, because position is never guessed. Every comparison ends in the stable
block identifier.

**Score and required status do not define render order.** A high-scoring block
renders late when its source position is late, and a required block may render
after an optional one from the same source. The score ranking, the allocation
chronology, and the optional eviction order are three other sequences: they share
elements with the render order — the allocation chronology holds exactly the same
decisions, and the eviction order a subset of them — but each answers a different
question, so none may be derived from another.

`ContextRenderer` closes the implemented kernel (see
[DEC-035](./docs/DECISIONS.md)). It takes an `OrderedCandidateSet`, one narrow
versioned `ContextRenderingPolicy`, and one project-owned `Tokenizer`, and
returns a `RenderedContextAttempt`: the current selection serialized as one
deterministic string, plus the token count of exactly that string.

**Rendering policy v1 has one format: JSON Lines.** One canonical JSON object per
included block, joined by exactly one LF — no prefix, no suffix, no enclosing
array, no trailing newline, no blank separator line. One physical line is exactly
one block, and an empty selection renders as the exact empty string. Each record
carries `blockId`, `content`, `headingPath` when the block carries one,
`sourceDocumentId`, and `sourceType`, and nothing else:

```text
{"blockId":"block-1","content":"The compiler selects final context.","sourceDocumentId":"doc-1","sourceType":"markdown"}
```

Score, retrieval data, allocation reason, required status, category, priority,
timestamps, block metadata, source metadata, source titles, `tokenCount`, and
`normalizedContentHash` are compiler control and provenance data, and none of
them renders. `sourceDocumentId` is the v1 source label because it exists on
every canonical block, is stable project-owned identity, and cannot drift from an
optional title.

**JSON escaping is the boundary mechanism.** A raw delimiter protocol was
rejected: arbitrary source content can contain any delimiter. Because content,
heading entries, and identifiers are JSON strings, embedded newlines, quotes, and
backslashes are escaped, so source content cannot forge a second record. Content
round-trips exactly — `JSON.parse(line).content` equals the block content byte for
byte, with no trimming, normalization, truncation, or rewriting. Records follow
`orderedIncluded` exactly; the renderer never sorts.

**The complete rendered string is tokenized, once.** `renderedTokens` is
`countTokens(renderedContext)` over the whole string — never a sum of block
counts, record counts, or separator counts, and never a character estimate. A
tokenizer that throws or returns an unusable value produces a structured
`CONTEXT_RENDERING_FAILED`, never a partial result.

**No token delta is published.** Subtracting the allocated block-content sum from
the rendered count is only meaningful when one tokenizer identity produced both,
and the renderer cannot establish that: its count comes from the tokenizer it was
given, while `selectedBlockContentTokens` comes from whichever tokenizer
validated the block counts, and no stage contract reaching the renderer carries a
tokenizer identity to compare. Compose the stages with two tokenizers and the
subtraction would report the gap between two vocabularies as if it described
rendering. The sum stays reachable through the nested allocation, and the final
signed `renderingTokenDelta` belongs to the future orchestration that guarantees
one tokenizer throughout — where the old non-negative `renderingOverheadTokens`
definition has been replaced by a signed value with an explicit same-tokenizer
precondition (see [METRICS 8.6](./docs/METRICS.md)).

**The renderer can report an over-budget attempt.** `fitsAvailableInputBudget` is
`renderedTokens <= availableInputTokens` and is observational: `false` is a
successful measurement, not an error. The renderer evicts nothing, drops no
required block, replaces no category-minimum choice, re-runs no earlier stage,
and never raises `REQUIRED_CONTENT_EXCEEDS_BUDGET`.

### Compilation contracts and policy filtering

`CompilationRequest` is the complete **caller-supplied request data** for one
compilation (see [DEC-036](./docs/DECISIONS.md)): scope, query, reference time,
candidates, source registry, budget, and policy. `CompilationRequestValidator`
accepts `unknown` and returns a validated record.

**The request is not, by itself, the whole deterministic input.** INV-DET-001
defines determinism over the request _plus_ the configured tokenizer identity and
version, the compiler version, and any other explicit compiler configuration —
and DEC-035 records that no stage contract carries a tokenizer identity. One
byte-identical request compiled under two different tokenizers can legitimately
produce different `renderedTokens` and different allocation feasibility; that is
not a determinism violation, it is why the request alone is not sufficient. So
the request carries no tokenizer, no compiler version, and no component instance:
those are configured composition that a future `ContextCompiler` binds and a
future trace records. Nothing hidden fills the gap — no clock, no random value,
no environment lookup.

**`referenceTime` is required.** The compiler never reads the clock, so the
instant arrives with the request and flows to the scorer. **`id` is
caller-supplied** and preserved exactly — the kernel generates no request
identifier. **`query` is preserved verbatim:** an empty query is valid, and a
whitespace-only or multi-line one is valid and is not trimmed, normalized, or
truncated. No reserve is defaulted into the budget and no context window is
guessed.

**Request validation is structural, not a second `CandidateValidator`.** It
proves the record is a well-formed request of well-formed domain values. Stale
token counts, wrong content hashes, duplicate source identifiers, cross-scope
candidates, missing or mismatched sources, and conflicting block identifiers stay
`CandidateValidator`'s to reject, so a request can pass this validator and be
rejected by the next one.

`CompilationPolicy` composes **five required slices** — scoring, filtering,
allocation, ordering, rendering — under its own schema version and identity. None
is defaulted; a compilation that filters nothing states an explicit filtering
slice with no minimum. The parent identity and the nested identities are
independent and need not match, and nothing generates an identifier, version,
hash, or fingerprint. Each slice is validated by the component that owns its
rules, so the composed validator can neither accept nor reject what a component
would not. **The policy is data:** it holds no component instance and owns no
tokenizer.

`CandidateFilter` runs between `CandidateScorer` and `BudgetAllocator`. It
answers one question — **may this scored optional candidate participate in
allocation under policy?** — and returns a `FilteredCandidateSet` in which every
scored candidate carries exactly one eligibility decision.

**Filtering policy v1 has one rule: an optional `minimumTotalScore`.** No block,
source, category, `sourceType`, timestamp, provider, rank, raw-score, size,
regex, metadata, tag, or callback rule exists. Filtering runs after exact
deduplication, so its unit is a duplicate group whose members may come from
different sources and carry different attributes, and hard exclusion over such a
group has no single meaning yet. Recency, source, category, authored priority,
and retrieval relevance already feed the scorer and arrive here normalized into
`score.total`.

**Equality survives.** A candidate at the minimum is eligible; one strictly below
is filtered. Nothing is rounded, clamped, normalized, read as a probability, or
divided by a token count. The total is policy-relative utility, so a threshold is
meaningful only against the scoring policy it is paired with.

**Required blocks bypass the threshold.** A required block scoring zero survives a
threshold of one thousand, as `ELIGIBLE_REQUIRED`. It is never filtered, failed,
or boosted: required content is a separate allocation class, not a large score.

**The filter does not select.** Required resolution, category constraints, the
token budget, eviction, and final inclusion all stay with `BudgetAllocator`, over
the eligible candidates it is given. The eligible set is a `ScoredCandidateSet`,
so the allocator consumes it with no change to its API. The filter reads exactly
three things — `score.total`, `attributes.required`, and its own policy — takes
no tokenizer, and is not an access-control boundary: scope isolation stays with
request validation and `CandidateValidator`.

### Compilation traces and request fingerprinting

`TraceBuilder` closes the implemented kernel (see
[DEC-037](./docs/DECISIONS.md)). It takes the evidence the components already
produced — the validated request, the validated candidate set, the deduplicated
set, the filtered set, and the render attempt — plus one explicit compiler
identity, and returns a `CompilationTrace`: a versioned, serializable snapshot of
what the compiler decided and why.

**It is observational.** It validates nothing again, deduplicates nothing, scores
nothing, allocates nothing, orders nothing, renders nothing, and calls no
tokenizer. Removing it would change no compiler output. What it may do is copy
stage evidence, calculate deterministic digests, count and sum already-validated
numbers, and **refuse to serialize evidence that contradicts itself** — a caller
who mixed two runs gets a structured failure, never a repaired record.

**Wrappers are accounted for; groups are decided.** After exact deduplication the
compiler decides a _group_, while every original candidate wrapper is kept as
membership evidence. So every validated wrapper appears exactly once as a member
of exactly one trace group, and every group carries exactly one current
disposition — filtered, included, or excluded. No representative wrapper is
invented: two byte-identical wrappers produce two identical member records,
because picking one of them by input position would be a determinism bug. A
filtered group carries no allocation decision at all, since it never reached the
allocator.

**Nothing raw is representable.** Block content, the query, the rendered string,
source metadata, block metadata, source titles, and retrieval metadata have no
field to travel in — and there is no `includeContent` switch to get wrong. The
trace records identities, decision reasons, score components, token counts,
source locations, and deterministic `sha256:` digests of the query and the
rendered context instead. Hashing is audit identity, not authorization: no
compiler rule depends on collision resistance.

**Totals reconcile exactly, at the group level.** `candidateTokens` sums every
validated wrapper, `canonicalContentTokens` sums each group's canonical block
once, and their difference is `duplicateCandidateTokens` — never a chosen
"duplicate member" wrapper subtracted by identity. Included, filtered, and
allocation-excluded content sum back to the canonical total. Arithmetic is
overflow-safe, and a total that leaves the exact safe-integer range fails rather
than being published. Rendering counts take no part: `renderedTokens` is reported
separately.

**The recorded tokenizer identity is scoped, not global.** A `TraceBuilder`
snapshot takes it from the render attempt, so it proves which tokenizer measured
the rendered string and nothing more — no stage contract carries the identity of
the tokenizer that produced the validated block counts. A manual composition may
legitimately validate under one tokenizer and render under another, and the trace
would then name one identity beside totals another produced. So the trace
publishes `tokenizerCoverage`, and a builder snapshot always says
`rendering-attempt-only`. Coverage is never inferred from matching names or
numbers and never taken as a caller's word — the manual caller is exactly who
might miscompose the stages — so the stronger `validation-and-rendering` belongs
to `ContextCompiler`, which injects one tokenizer itself.

**The request fingerprint identifies the exact validated request value.** It is
SHA-256 over a domain-separated canonical serialization of the whole request, so
`request.id`, the query, and **array order** all participate, while object
property insertion order does not. Two requests that compile to the same output
may fingerprint differently — deliberately: order-independence is a property of
compiler _processing_, not of the caller's payload. It is **not a compilation
identifier**: it excludes compiler, tokenizer, and renderer identity by design,
and those are recorded beside it in the trace. Compiler version is injected
configuration, never read from a manifest, a git revision, or the environment.

**A builder snapshot is current, not final.** Every trace `TraceBuilder` produces
carries `settled: false`: the stage evidence is recorded and the render attempt
is measured — including an over-budget one, which traces successfully — but
nothing has accepted or rejected a compilation. Such a trace can never be
attached to a successful `CompilationResult`; schema version 2 makes that
unrepresentable rather than merely forbidden.

### The compiler: `compiler.compile(request)`

`ContextCompiler` is the composition root of the kernel (see
[DEC-038](./docs/DECISIONS.md)). It takes one explicit configuration and one
`Tokenizer`, runs every stage of the named topology in order, settles the
rendered budget, and returns a `CompilationResult`.

```ts
const compiler = new ContextCompiler(
  {
    schemaVersion: 1,
    compilerId: 'ctxalloc-compiler',
    compilerVersion: '0.15.0',
    maxCorrectionSelections: 64,
  },
  tokenizer,
);

const result = compiler.compile(request);
```

**A hard final rendered budget.** The complete rendered string is tokenized
before success is returned, and no result is ever returned whose `compiledTokens`
exceeds the caller's `availableInputTokens`. An over-budget selection produces a
correction or a structured failure, never a success.

**Safe eviction first.** If the initial render is over budget, the compiler gives
back the surplus the allocator itself declared safe, walking
`optionalEvictionOrder` in its exact published order — one entry at a time,
re-ordering, re-rendering, and re-tokenizing after every removal. The first
fitting prefix wins. Required blocks are never evicted and category minimums are
never dropped.

**A bounded fallback search, in three phases.** Exhausting the eviction order
proves nothing: the allocator minimized canonical _content_ cost when it picked
which candidates satisfy each category minimum, so a protected
cheaper-by-content block can render far more expensively than an unselected
candidate that satisfies the same minimum.

So the compiler measures the exact **required-only** selection, then walks the
**hard bases** — minimal policy-valid selections — in the allocator's own
preference order, and finally, only if every one of those failed, walks the
remaining policy-valid selections in a **rescue** phase. A fitting hard base
settles immediately and is never re-augmented; the rescue exists because a strict
policy-valid superset of an over-budget selection may fit.

**Nothing is concluded from a subset.** Tokenization is neither additive nor
monotonic: `tokenizer(a + b)` need not equal `tokenizer(a) + tokenizer(b)`, and
an over-budget selection does not make every superset of it over budget. So a
required-only overrun is a measurement rather than a verdict, exhausting the
minimal bases is not a global proof, and no per-block rendered cost is ever
computed, cached, or subtracted. Every feasibility decision measures one exact
complete rendered string.

**The bound stops work, not just results.** `maxCorrectionSelections` counts
unique selections across all three phases. Every combinatorial enumeration is
lazy, and the rescue enumerator prunes category-invalid subsets while
constructing them rather than filtering them afterwards — an invalid subset never
reaches the visit step, so it would never count and the bound would never fire.
A pathological policy therefore stops after roughly that many selections instead
of walking an exponential universe. Reaching the bound is reported as a search
limit, never as infeasibility — and infeasibility itself is claimed only after
every policy-valid selection has been visited. The compiler claims no maximum of
score, block count, or token utilization.

**Same-tokenizer composition.** The compiler owns exactly one configured
`Tokenizer` and injects that same object into candidate block-count validation
and into every rendered measurement. That is what makes
`tokenizerCoverage: 'validation-and-rendering'` provable and the signed
`renderingTokenDelta` a defined quantity rather than the gap between two
vocabularies.

**A deterministic compilation identifier.** `CompilationId` is SHA-256 over a
domain-separated preimage binding the request fingerprint plus every explicit
composition input: compiler identity and version, tokenizer identity and version,
renderer identity and version, the correction strategy and version, and the
search bound. Nothing random, discovered, or environmental takes part, and the
identifier names the invocation — every failure after request validation carries
it.

**A settled trace.** The settlement is an overlay, not a replacement: the
original filtering and allocation evidence stays exactly where it was, and the
settlement states separately what the correction did — the evicted identifiers,
the search that ran, one final decision per group with its render position, the
final order, the digest of the final string, and the final usage. The snapshot is
never mutated, and the final string still appears only on the result.

**Exact final usage.** `candidateTokens`, `includedContentTokens`,
`compiledTokens`, `availableTokens`, `unusedTokens`, and the signed
`renderingTokenDelta`. No `reductionTokens` or `reductionRatio`: both are defined
against a baseline input, no baseline exists in a `CompilationRequest`, and
baselines are evaluation work.

**The local slice.** `CompileLocalContextService` owns one `Tokenizer` object and
constructs `MarkdownChunker`, `TextChunker`, `ConversationChunker`, and
`ContextCompiler` with it, so block token counts and compiler validation are
composed consistently. Logical source identity is separate from the adapter
locator: moving a file changes where its bytes are, not what the source is.
`NodeFileSourceReader` confines every locator to a configured root by real path,
so a symlink pointing outside it is rejected, and decodes UTF-8 strictly rather
than substituting U+FFFD. Registrations are ordered by identity, never by
locator; the provider's candidate order is preserved exactly.

**What remains after the slice.** Real retrieval, persistence and SQLite,
control-plane writing, trace persistence, the CLI, the HTTP API, model execution,
the evaluation harness and its baselines, and telemetry. CtxAlloc supports no
Obsidian integration.

## Prerequisites

- Node.js `22` (see [`.nvmrc`](./.nvmrc) and the `engines` field in `package.json`).
- [pnpm](https://pnpm.io) via Corepack (the version is pinned in the
  `packageManager` field of `package.json`).

```bash
corepack enable
```

## Installation

```bash
pnpm install
```

## Workspace commands

| Command                   | Description                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- |
| `pnpm build`              | Emit declarations and compiled output for all packages (`tsc -b`).               |
| `pnpm typecheck`          | Type-check packages, apps, tests, and configuration without emitting.            |
| `pnpm lint`               | Run ESLint over the workspace.                                                   |
| `pnpm test`               | Run the Vitest suite.                                                            |
| `pnpm format`             | Format supported files with Prettier.                                            |
| `pnpm format:check`       | Verify formatting without writing changes.                                       |
| `pnpm check:boundaries`   | Validate internal package dependencies against the allowlist.                    |
| `pnpm check:declarations` | Validate the generated declaration surface. Requires a preceding `pnpm build`.   |
| `pnpm check`              | Run `format:check`, `lint`, `typecheck`, `test`, and boundaries. Writes nothing. |
| `pnpm clean`              | Remove generated build artifacts.                                                |

`pnpm check` is non-mutating: it never builds and never creates a `dist` directory.
Declaration validation runs after a build, as CI does:

```bash
pnpm check && pnpm build && pnpm check:declarations
```

## Workspaces

```text
apps/
  api/          @ctxalloc/api
  cli/          @ctxalloc/cli
packages/
  adapters/     @ctxalloc/adapters
  application/  @ctxalloc/application
  compiler/     @ctxalloc/compiler
  domain/       @ctxalloc/domain
  evaluation/   @ctxalloc/evaluation
  ports/        @ctxalloc/ports
  testing/      @ctxalloc/testing
  tokenization/ @ctxalloc/tokenization
```

Allowed internal dependency direction (enforced by `pnpm check:boundaries`):

```text
apps -> application -> compiler -> ports -> domain
                evaluation -> compiler -> ports -> domain
                  adapters -> ports -> domain
```

`@ctxalloc/adapters` is the only workspace that touches a filesystem, a network,
or a platform clock, and the only one that may depend on an external retrieval
library. It depends on `@ctxalloc/ports`, on `@ctxalloc/domain` for the
project-owned types the ports already speak, and on one exactly pinned lexical
search library — never on the compiler kernel: an adapter that could see the
kernel could make a selection decision.

`@ctxalloc/evaluation` sits above the compiler and deliberately **not** on
`@ctxalloc/application`: a benchmark case is static data, so the measurement
stays decoupled from the pipeline that produces what is measured.

## Documentation

- [Product Contract](./docs/PRODUCT_CONTRACT.md)
- [MVP Scope](./docs/MVP_SCOPE.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Invariants](./docs/INVARIANTS.md)
- [Metrics](./docs/METRICS.md)
- [Decisions](./docs/DECISIONS.md)
- [Retrieval Spike](./docs/RETRIEVAL_SPIKE.md)

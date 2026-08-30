# CtxAlloc

**CtxAlloc** (Context Allocation Engine) is a deterministic context budgeting and
compilation engine for AI systems. It is designed to receive a set of candidate
context blocks, select a minimal sufficient subset under a strict token budget,
render the final context, and produce a complete, machine-readable decision trace.
CtxAlloc is not a retrieval system, memory system, vector database, model gateway,
or agent framework.

## Status

Phase 11 — deterministic context ordering. The repository contains
the TypeScript monorepo scaffolding from Phase 1 (workspace structure, strict
compiler and linting configuration, test infrastructure, package boundaries,
boundary checker), the runtime-validated domain model in `@ctxalloc/domain` (scope,
identifiers, content hash values, JSON-safe metadata, source types, source
locations, `SourceDocument`, `ContextBlock`, `TokenBudget`, and a structured
validation API), the project-owned `Tokenizer` port in `@ctxalloc/ports`, the
deterministic `FakeTokenizer` test double in `@ctxalloc/testing` with a reusable
tokenizer contract test suite, a real offline tokenizer adapter in
`@ctxalloc/tokenization`, the first two application use cases in
`@ctxalloc/application`, and the first five compiler-kernel stages in
`@ctxalloc/compiler`.

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

`@ctxalloc/compiler` adds `CandidateValidator`, the first stage of the compiler
kernel (see [DEC-030](./docs/DECISIONS.md)). It is synchronous, deterministic,
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

`CandidateDeduplicator` is the second stage of the kernel (see
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

`CandidateScorer` is the third stage of the kernel (see
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

`BudgetAllocator` is the fourth stage of the kernel (see
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
It deliberately publishes no `compiledTokens` and no final `unusedTokens`: source
labels, separators, wrappers, and other rendering overhead are not measured,
because the renderer does not exist yet. **There is no final hard budget guarantee
until the renderer and its orchestration loop exist.**

`ContextOrderer` is the fifth stage of the kernel (see
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

**No renderer exists yet.** Nothing produces a compiled string, no rendering
overhead is measured, and there is still no final hard-budget guarantee. There is
no rendering policy, trace builder, `CandidateFilter`, policy filtering, compiler
orchestration, retrieval provider, persistence, HTTP, or CLI behavior. CtxAlloc
does not yet render context, and it supports no Obsidian integration.

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
```

## Documentation

- [Product Contract](./docs/PRODUCT_CONTRACT.md)
- [MVP Scope](./docs/MVP_SCOPE.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Invariants](./docs/INVARIANTS.md)
- [Metrics](./docs/METRICS.md)
- [Decisions](./docs/DECISIONS.md)

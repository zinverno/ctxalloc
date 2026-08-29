# CtxAlloc

**CtxAlloc** (Context Allocation Engine) is a deterministic context budgeting and
compilation engine for AI systems. It is designed to receive a set of candidate
context blocks, select a minimal sufficient subset under a strict token budget,
render the final context, and produce a complete, machine-readable decision trace.
CtxAlloc is not a retrieval system, memory system, vector database, model gateway,
or agent framework.

## Status

Phase 7 — candidate wrapper and strict candidate validation. The repository contains the TypeScript
monorepo scaffolding from Phase 1 (workspace structure, strict compiler and
linting configuration, test infrastructure, package boundaries, boundary
checker), the runtime-validated domain model in `@ctxalloc/domain` (scope,
identifiers, content hash values, JSON-safe metadata, source types, source
locations, `SourceDocument`, `ContextBlock`, `TokenBudget`, and a structured
validation API), the project-owned `Tokenizer` port in `@ctxalloc/ports`, the
deterministic `FakeTokenizer` test double in `@ctxalloc/testing` with a reusable
tokenizer contract test suite, a real offline tokenizer adapter in
`@ctxalloc/tokenization`, the first two application use cases in
`@ctxalloc/application`, and the first compiler-kernel stage in
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
query-independent. **Retrieval scores are carried but never normalized,
compared, sorted by, or used to include anything;** scores from different
providers or metrics are not assumed comparable. Retrieval data is never written
back into the block.

**Validation is strict and all-or-nothing.** Any problem rejects the whole batch
with one structured `CandidateValidationError` carrying every discoverable issue.
Nothing is silently removed, repaired, reordered, or re-counted.

Both `tokenCount` and `normalizedContentHash` are recomputed — the count through
the injected tokenizer over the exact block content, the hash through the shared
domain helper — and a mismatch is a rejection, not a repair. Source references
are validated against an explicit `SourceDocument` registry supplied with the
batch, and scope matching is exact, so an absent `projectId` and an explicit one
are different scopes. `SourceDocument.contentHash` is not recomputed: the
complete original source content is intentionally absent during compilation.

**Duplicate wrappers are not deduplicated yet.** Two wrappers carrying the same
block, with or without different retrieval metadata, pass through in input order
for the future deduplication phase. What is rejected is one block ID attached to
two _different_ canonical records.

Priority is restricted to finite safe integers, including negative values. No
product-specific range exists yet; semantic bounds belong to the future
`CompilationPolicy`.

**No allocator exists yet.** Nothing decides which blocks fit a budget, and
whether required content fits is the allocator's decision, not the validator's.
There is no policy filtering, deduplication, scoring, allocation, ordering,
rendering, trace generation, compiler orchestration, retrieval provider,
persistence, HTTP, or CLI behavior yet. CtxAlloc does not yet compile or optimize
context, and it supports no Obsidian integration.

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

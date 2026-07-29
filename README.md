# CtxAlloc

**CtxAlloc** (Context Allocation Engine) is a deterministic context budgeting and
compilation engine for AI systems. It is designed to receive a set of candidate
context blocks, select a minimal sufficient subset under a strict token budget,
render the final context, and produce a complete, machine-readable decision trace.
CtxAlloc is not a retrieval system, memory system, vector database, model gateway,
or agent framework.

## Status

Phase 4 — real tokenization and the token budget value model. The repository
contains the TypeScript monorepo scaffolding from Phase 1 (workspace structure,
strict compiler and linting configuration, test infrastructure, package
boundaries, boundary checker), the runtime-validated domain model in
`@ctxalloc/domain` (scope, identifiers, content hash values, JSON-safe metadata,
source types, source locations, `SourceDocument`, `ContextBlock`, `TokenBudget`,
and a structured validation API), the project-owned `Tokenizer` port in
`@ctxalloc/ports`, the deterministic `FakeTokenizer` test double in
`@ctxalloc/testing` with a reusable tokenizer contract test suite, and a real
offline tokenizer adapter in `@ctxalloc/tokenization`.

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
validated integers and depends on no tokenizer.

**No compiler and no allocator exist yet.** Nothing decides which blocks fit a
budget. There is no allocation, scoring, deduplication, ordering, rendering,
trace generation, retrieval, ingestion, persistence, HTTP, or CLI behavior yet.
CtxAlloc does not yet compile or optimize context.

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

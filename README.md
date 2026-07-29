# CtxAlloc

**CtxAlloc** (Context Allocation Engine) is a deterministic context budgeting and
compilation engine for AI systems. It is designed to receive a set of candidate
context blocks, select a minimal sufficient subset under a strict token budget,
render the final context, and produce a complete, machine-readable decision trace.
CtxAlloc is not a retrieval system, memory system, vector database, model gateway,
or agent framework.

## Status

Phase 2 — domain foundation. The repository contains the TypeScript monorepo
scaffolding from Phase 1 (workspace structure, strict compiler and linting
configuration, test infrastructure, package boundaries, boundary checker) and the
runtime-validated domain model in `@ctxalloc/domain`: scope, identifiers, content
hash values, JSON-safe metadata, source types, source locations, `SourceDocument`,
`ContextBlock`, and a structured validation API.

**Compiler behavior is still not implemented.** The domain package defines and
validates data only. There is no tokenization, token allocation, scoring,
deduplication, rendering, trace generation, retrieval, ingestion, persistence,
HTTP, or CLI behavior yet. CtxAlloc does not yet compile or optimize context.

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

| Command                 | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm build`            | Type-check and emit declarations for all packages (`tsc -b`).    |
| `pnpm typecheck`        | Type-check all packages, apps, and tests without emitting.       |
| `pnpm lint`             | Run ESLint over the workspace.                                   |
| `pnpm test`             | Run the Vitest suite.                                            |
| `pnpm format`           | Format supported files with Prettier.                            |
| `pnpm format:check`     | Verify formatting without writing changes.                       |
| `pnpm check:boundaries` | Validate internal package dependencies against the allowlist.    |
| `pnpm check`            | Run `format:check`, `lint`, `typecheck`, `test`, and boundaries. |
| `pnpm clean`            | Remove generated build artifacts.                                |

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

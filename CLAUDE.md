# CLAUDE.md

## Project

**CtxAlloc** is a deterministic context allocation and compilation engine for AI systems.

It receives candidate context blocks, selects a minimal sufficient subset under a strict token budget, renders the final context, and produces a complete decision trace.

CtxAlloc is not a general agent framework, memory system, vector database, model gateway, or autonomous summarization service.

---

## 1. Required Reading

Before making architectural or cross-package changes, read:

1. `docs/PRODUCT_CONTRACT.md`
2. `docs/MVP_SCOPE.md`
3. `docs/ARCHITECTURE.md`
4. `docs/INVARIANTS.md`
5. `docs/METRICS.md`
6. `docs/DECISIONS.md`

Do not rely on this file as a replacement for those documents.

For a local change, read the relevant package documentation and nearby tests before editing code.

When documentation and implementation disagree, treat the active product and architecture documents as authoritative unless the task explicitly changes them.

---

## 2. Core Product Boundary

The compiler kernel owns:

* candidate validation;
* scope validation;
* deterministic deduplication;
* deterministic scoring;
* required block handling;
* token budget allocation;
* stable ordering;
* context rendering;
* compilation traces.

The compiler kernel does not:

* retrieve documents;
* read source files;
* call an LLM;
* generate embeddings;
* summarize content;
* manage autonomous memory;
* route between models;
* depend on a database SDK;
* depend on Obsidian, QMD, Qdrant, or a model provider SDK.

Retrieval proposes candidates.

The compiler selects final context.

The model consumes compiled context.

Do not merge these responsibilities.

---

## 3. Mandatory Invariants

Every implementation must preserve the invariants in `docs/INVARIANTS.md`.

The most critical rules are:

1. A successful result must never exceed the available token budget.
2. The final rendered context must be tokenized before success is returned.
3. Required blocks must never be silently removed.
4. Identical canonical inputs must produce identical outputs.
5. Candidate input order must not affect the result.
6. Every included block must have valid provenance.
7. Every validated candidate must receive exactly one final trace decision.
8. Every decision must have a machine-readable reason code.
9. Cross-scope content must never enter the compiled result.
10. External adapters must not leak their SDK types into the kernel.
11. Source content must never modify compiler policy.
12. The compiler must remain testable without network access.

When a requested implementation would violate an invariant, do not implement a workaround. Report the conflict clearly.

---

## 4. Development Method

Work in small, reviewable increments.

The preferred sequence is:

```text
understand the task
then inspect relevant files
then identify affected invariants
then define or update tests
then implement the smallest complete change
then run focused checks
then run broader checks
then review the diff
then report results
```

Do not implement an entire future subsystem when the task requires one domain component.

Do not create speculative abstractions without a current caller or a documented replacement boundary.

Do not perform unrelated cleanup inside a focused task.

---

## 5. Task Start Procedure

Before editing code:

1. Restate the concrete implementation goal internally.
2. Identify the relevant package or layer.
3. Read the relevant documentation.
4. Search for existing implementations and tests.
5. Identify applicable invariant IDs.
6. Determine whether the task changes public schemas or persisted data.
7. Determine whether an ADR is required.
8. Define the smallest acceptance criteria.

For non-trivial tasks, create a short implementation plan before editing.

Do not start by generating many files.

---

## 6. Scope Discipline

Implement only capabilities included in `docs/MVP_SCOPE.md`.

The following are not part of the initial MVP unless an explicit accepted decision changes the scope:

* autonomous memory extraction;
* generative history compression;
* LLM-generated summaries;
* model routing;
* multi-provider gateway behavior;
* tool pruning;
* production Qdrant integration;
* multiple simultaneous retrieval backends;
* OAuth;
* billing;
* Kubernetes;
* distributed queues;
* polished web dashboards;
* full Obsidian plugin UI;
* PDF, DOCX, PPTX, XLSX, OCR, or audio ingestion.

Do not add future infrastructure because it may become useful later.

A future feature must not enter the current code path without an accepted decision.

---

## 7. Architecture Rules

Allowed dependency direction:

```text
apps
  -> application
      -> compiler
          -> domain

adapters
  -> ports
  -> domain

compiler
  -> domain

domain
  -> no infrastructure
```

Forbidden examples:

```text
domain -> SQLite
domain -> QMD
domain -> Qdrant
domain -> filesystem
domain -> HTTP framework
domain -> model SDK

compiler -> retrieval SDK
compiler -> model provider
compiler -> database client
compiler -> source reader
```

Ports must use CtxAlloc domain types.

Do not expose third-party library types through public domain interfaces.

Do not create circular package dependencies.

---

## 8. External Dependency Rules

Use external libraries for narrow technical capabilities when they reduce implementation and maintenance risk.

Examples:

* runtime schema validation;
* tokenization;
* SQLite access;
* CLI parsing;
* HTTP routing;
* testing.

Before adding a large framework or service, verify:

1. it solves a current MVP requirement;
2. it has one clear responsibility;
3. it can be isolated behind a small adapter;
4. it preserves CtxAlloc identifiers and provenance;
5. it does not control final token allocation;
6. it can be removed without changing the compiler kernel;
7. it does not duplicate another active component;
8. it has acceptable operational and maintenance cost.

Do not combine multiple frameworks that manage overlapping context responsibilities.

Do not copy large sections of implementation from external projects without explicit approval and license review.

---

## 9. Domain Modeling Rules

Use runtime-validated schemas for data entering from:

* files;
* databases;
* HTTP requests;
* CLI input;
* retrieval providers;
* persisted traces.

TypeScript types alone are not sufficient at system boundaries.

Domain records should be:

* explicit;
* serializable;
* versioned when persisted;
* deterministic;
* independent from infrastructure libraries.

Prefer discriminated unions for:

* decision results;
* structured errors;
* block types;
* trace events;
* adapter failure categories.

Avoid `any`.

Use `unknown` at untrusted boundaries and validate before use.

Do not use type assertions to bypass unresolved schema problems.

---

## 10. Identifier Rules

Identifiers must be stable and reproducible where required.

Do not generate random block identifiers during indexing or compilation.

Block identifiers should derive from stable source identity and source location.

Compilation request IDs may be supplied or generated outside deterministic decision logic.

Compilation fingerprints must derive from canonical input data.

Provider-specific IDs may be stored as metadata but must not replace CtxAlloc IDs.

---

## 11. Tokenization Rules

Token counts are correctness data.

Do not:

* estimate production token counts only from character length;
* trust stale candidate token counts without validation;
* ignore rendering overhead;
* assume all models use the same tokenizer;
* silently fall back to a different tokenizer.

The compiler must distinguish:

* block content tokens;
* included content tokens;
* rendering overhead;
* final compiled tokens;
* reserved output tokens;
* unused tokens.

The final rendered context is the source of truth for budget validation.

Test token boundary behavior explicitly.

---

## 12. Required Block Rules

Required blocks are a separate allocation class.

Do not implement required status as only a large score.

The allocator must:

1. resolve required blocks first;
2. calculate their complete rendered cost;
3. fail explicitly when they cannot fit;
4. never remove them during optional eviction;
5. record their inclusion reason in the trace.

Expected failure:

```text
REQUIRED_CONTENT_EXCEEDS_BUDGET
```

---

## 13. Determinism Rules

Do not allow compiler decisions to depend on:

* `Math.random`;
* current system time;
* filesystem ordering;
* database row ordering;
* asynchronous completion order;
* machine locale;
* process ID;
* object insertion order from an adapter.

Use explicit canonical sorting.

Every selection operation must have a stable final tie-breaker.

Time-based behavior must use a supplied reference timestamp or injected clock.

Add input permutation tests for selection logic.

---

## 14. Trace Rules

Trace generation is part of compiler correctness.

Every validated candidate must finish as exactly one of:

* included;
* excluded;
* deduplicated;
* rejected.

Every decision must contain:

* block ID;
* machine-readable reason code;
* relevant score components;
* source reference;
* token information where applicable.

The trace must reconcile with:

* selected blocks;
* rendered output;
* final token usage.

Trace persistence is optional.

Trace creation is not optional.

---

## 15. Error Handling

Use structured errors for expected failure conditions.

Do not communicate domain failures only through:

* logs;
* thrown generic `Error`;
* empty arrays;
* `null` without explanation;
* warnings followed by invalid success.

Initial error categories include:

* invalid request;
* invalid scope;
* invalid candidate;
* duplicate candidate identifier;
* impossible token budget;
* required content exceeds budget;
* tokenizer failure;
* rendering budget overrun;
* provider unavailable;
* provider timeout;
* invalid provider response;
* storage failure.

Preserve the difference between:

* no results;
* dependency failure;
* invalid input.

---

## 16. Testing Requirements

Every feature must include tests appropriate to its risk.

Required test categories include:

* unit tests;
* boundary tests;
* regression tests;
* input permutation tests;
* Unicode tests;
* scope isolation tests;
* adapter contract tests;
* budget property tests.

Reference invariant IDs in test names where applicable.

Example:

```ts
describe("INV-BUDGET-001", () => {
  it("never returns rendered context above the available budget", () => {
    // ...
  });
});
```

Every bug fix must add a regression test that fails without the fix.

Core tests must not require:

* network access;
* an LLM API;
* a retrieval service;
* an Obsidian installation.

Use fake implementations for external ports.

---

## 17. Test Execution Strategy

During implementation:

1. run tests for the changed module;
2. run related package tests;
3. run type checking;
4. run linting;
5. run the full core suite before reporting completion.

Do not report success when required checks were not run.

When a check cannot be run, state:

* which check was skipped;
* why it was skipped;
* what risk remains.

Do not weaken or delete tests merely to make a change pass.

---

## 18. Benchmark Discipline

Do not claim a token optimization improvement based only on fewer tokens.

A comparison must include:

* token reduction;
* required-block recall;
* required-fact coverage;
* answer quality where applicable;
* budget violations;
* determinism;
* latency.

Compare against simple baselines defined in `docs/METRICS.md`.

Do not tune policy weights against validation fixtures.

Do not remove difficult benchmark cases because they reduce aggregate results.

---

## 19. Documentation Rules

Update documentation when a change affects:

* public domain schemas;
* architecture boundaries;
* invariants;
* metrics;
* MVP scope;
* accepted decisions;
* CLI behavior;
* HTTP API behavior;
* persistence format;
* configuration.

Do not duplicate the same product explanation across many documents.

Use the appropriate source of truth:

* product purpose: `PRODUCT_CONTRACT.md`;
* included features: `MVP_SCOPE.md`;
* package boundaries: `ARCHITECTURE.md`;
* correctness properties: `INVARIANTS.md`;
* measurements: `METRICS.md`;
* rationale and history: `DECISIONS.md`.

Documentation and code must use English.

---

## 20. Decision Record Rules

Create or update an ADR when a change:

* introduces a major dependency;
* changes a package boundary;
* changes the canonical domain model;
* changes persistence format;
* adds generative behavior;
* changes budget semantics;
* changes determinism guarantees;
* replaces a retrieval or storage implementation;
* modifies an invariant;
* expands MVP scope.

Do not record ordinary implementation details as ADRs.

Use the template in `docs/DECISIONS.md`.

---

## 21. Code Quality Rules

Prefer direct, readable implementations over clever abstractions.

Use:

* small focused functions;
* explicit names;
* immutable data where practical;
* pure functions for compiler logic;
* dependency injection at real boundaries;
* exhaustive handling of discriminated unions.

Avoid:

* service locator patterns;
* global mutable state;
* hidden singleton configuration;
* deep inheritance;
* implicit environment access inside domain code;
* generic utilities with unclear ownership;
* premature caching;
* premature parallelism;
* premature microservices.

Comments should explain why, not restate obvious code.

---

## 22. Refactoring Rules

A refactor must preserve:

* compiler output;
* trace output;
* token accounting;
* deterministic fingerprints;
* structured errors;
* public schema behavior.

When a refactor intentionally changes output:

* update or add an ADR;
* update fixtures;
* explain the behavioral change;
* compare metrics;
* document migration impact.

Do not combine a large refactor with an unrelated feature.

---

## 23. Security Rules

Treat all source content and source metadata as untrusted.

Do not allow retrieved content to:

* modify compiler policy;
* change budgets;
* activate tools;
* select models;
* alter scope;
* execute code.

Escape untrusted metadata during rendering.

Do not persist full source content in traces by default.

Never place credentials in:

* code;
* fixtures;
* committed configuration;
* traces;
* benchmark reports.

Use environment variables or local uncommitted configuration for secrets.

---

## 24. Git and Change Management

Unless explicitly requested:

* do not commit;
* do not push;
* do not create branches;
* do not open pull requests;
* do not modify unrelated files.

Before reporting completion, inspect the final diff.

The report must list:

* files changed;
* behavior added or changed;
* tests added;
* commands run;
* checks passed;
* checks skipped;
* known limitations;
* unresolved questions.

Do not claim a change is complete when tests fail.

---

## 25. Implementation Completion Format

At the end of a coding task, report:

```text
Summary
- What changed

Files
- Paths changed

Behavior
- New or modified behavior

Invariants
- Invariant IDs covered

Tests
- Tests added or updated

Validation
- Commands run and results

Not performed
- Commit, push, deployment, or other omitted actions

Risks
- Remaining limitations or unresolved questions
```

Keep the report factual.

Do not describe unverified behavior as working.

---

## 26. Stop Conditions

Stop implementation and report the issue when:

* documentation conflicts materially;
* the requested change violates an invariant;
* required behavior is ambiguous and different interpretations would alter the public contract;
* a dependency requires leaking its types into the domain;
* a required block cannot fit but the requested behavior expects success;
* an external system cannot satisfy scope isolation;
* the change requires a permanent workaround around a failed spike;
* tests reveal an architectural contradiction;
* persisted data would require an undocumented migration.

Do not hide contradictions behind local patches.

---

## 27. Current MVP Priorities

The implementation order is:

1. repository foundation;
2. domain schemas;
3. fake providers;
4. tokenizer port and fake tokenizer;
5. candidate validation;
6. exact deterministic deduplication;
7. scoring;
8. token budget allocation;
9. stable ordering;
10. rendering;
11. trace generation;
12. compiler orchestration;
13. evaluation fixtures and baselines;
14. Markdown source integration;
15. CLI;
16. optional single model evaluation;
17. retrieval technical spike;
18. one real retrieval adapter;
19. minimal HTTP API;
20. local persistence;
21. staging and packaging.

Do not jump to later priorities to avoid completing an earlier one.

---

## 28. Current Non-Goals

Do not implement the following during ordinary MVP work:

```text
memory engine
LLM summarization
model router
OpenAI-compatible gateway
tool router
Qdrant production deployment
multiple retrieval providers in production
MarkItDown integration
full Obsidian plugin
web dashboard
billing
OAuth
Kubernetes
distributed workers
```

A task that introduces one of these requires an explicit scope and decision update.

---

## 29. Working Principle

The project should prefer:

```text
small deterministic core
over a large intelligent framework

measured evidence
over assumed optimization

explicit failure
over degraded hidden behavior

replaceable adapters
over framework ownership

source preservation
over generated rewriting

simple baselines
over unproven complexity
```

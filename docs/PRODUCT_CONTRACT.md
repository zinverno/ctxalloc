# Product Contract

## Document Status

* Product name: CtxAlloc
* Expanded name: Context Allocation Engine
* Public product name: To be selected
* Document type: Product contract
* Status: Active
* Applies to: MVP and all subsequent implementations

This document defines the product that the project is allowed to become.

Implementation decisions may change. Libraries, databases, retrieval systems, model providers, and deployment methods may change. The product contract must remain stable unless it is intentionally revised through an architectural decision record.

---

## 1. Product Definition

CtxAlloc is a deterministic context budgeting and compilation engine for AI applications.

It receives a larger set of potentially useful context than an LLM request can or should contain. It selects, orders, and formats a smaller context package under a strict token budget.

For every compilation, it produces an audit trace explaining:

* which context blocks were included;
* which context blocks were excluded;
* why each decision was made;
* how many tokens were allocated;
* which source each block came from;
* whether required information was preserved;
* how the compiled result compares with the original context.

CtxAlloc is not primarily a retrieval system, memory system, vector database, LLM gateway, or agent framework.

It may integrate with those systems through replaceable adapters.

---

## 2. Problem Statement

AI applications frequently send more context than the model needs.

Common causes include:

* sending entire conversation histories;
* sending complete documents instead of relevant fragments;
* including duplicate or outdated information;
* including large tool results;
* including unrelated project notes;
* allocating context without explicit priorities;
* treating the model context window as the only budget;
* having no explanation for why information was included or removed.

This causes:

* unnecessary token cost;
* increased latency;
* weaker attention over important facts;
* context conflicts;
* reduced prompt cache efficiency;
* unpredictable behavior;
* difficulty debugging incorrect answers.

Existing retrieval and memory systems can produce candidate context, but they do not always provide deterministic budget allocation and complete inclusion or exclusion traces across multiple source types.

---

## 3. Core Product Hypothesis

A large portion of available context does not need to be sent to the LLM for every request.

A deterministic compiler can remove irrelevant, duplicate, outdated, or low-priority context while preserving the information required to answer the current request.

The hypothesis is considered supported when CtxAlloc can:

1. reduce input context size;
2. preserve required facts;
3. maintain answer quality within an accepted tolerance;
4. never exceed the configured token budget;
5. explain every compilation decision.

Token reduction alone is not success.

A smaller prompt that produces a worse answer is a failed compilation.

---

## 4. Primary Users

### 4.1 Local AI User

A person using local files, notes, conversations, and developer tools with an AI assistant.

Initial example:

* Obsidian vault;
* Markdown project documentation;
* conversation history;
* one external LLM.

### 4.2 AI Application Developer

A developer who already has:

* an AI application;
* a model provider;
* a retrieval system;
* a memory system;
* or a collection of context sources.

The developer uses CtxAlloc to compile context before an LLM request.

### 4.3 Future SaaS Operator

A team operating a multi-user AI product.

This user requires:

* tenant-aware context;
* access control;
* configurable budgets;
* usage reporting;
* scalable retrieval adapters;
* server deployment.

Full SaaS operation is not part of the MVP, but the core data model must not prevent it.

---

## 5. Primary Product Operation

The fundamental operation is:

```text
compile(query, candidates, policy, budget) -> compiled context + trace
```

### Inputs

A compilation request may contain:

* user query;
* candidate context blocks;
* conversation blocks;
* document blocks;
* memory blocks;
* tool result blocks;
* source metadata;
* access scope;
* required blocks;
* optional blocks;
* token budget;
* ordering rules;
* source priorities;
* freshness rules.

### Outputs

A compilation result must contain:

* compiled context;
* included blocks;
* excluded blocks;
* final token count;
* original token count;
* token reduction;
* unused budget;
* source references;
* decision reasons;
* warnings;
* deterministic compilation identifier.

---

## 6. Core Guarantees

### 6.1 Hard Budget Guarantee

The compiled context must never exceed the configured context budget.

Budget enforcement must not depend on the LLM provider rejecting an oversized request.

### 6.2 Deterministic Compilation

Given the same:

* input blocks;
* query;
* policy;
* tokenizer version;
* compiler version;
* configuration;

CtxAlloc must produce the same compiled result.

External retrieval may be nondeterministic, but the compiler must be deterministic after candidates are received.

### 6.3 Source Traceability

Every included block must retain a reference to its original source.

A block without provenance must not be silently treated as trusted context.

### 6.4 Decision Explainability

Every included or excluded candidate must have a machine-readable decision reason.

Examples:

* required by policy;
* high relevance;
* recent conversation continuity;
* duplicate of another block;
* lower priority than selected alternatives;
* outside the active scope;
* stale information;
* insufficient remaining budget;
* invalid source reference.

### 6.5 Scope Isolation

Every context operation must execute inside an explicit scope.

A scope contains at least:

* tenant identifier;
* workspace identifier;
* optional project identifier.

Local mode uses a local tenant and workspace instead of removing scope from the model.

### 6.6 Provider Independence

The core compiler must not depend directly on:

* QMD;
* Qdrant;
* Obsidian;
* OpenAI;
* Anthropic;
* Gemini;
* a specific embedding model;
* a specific database.

External systems must be connected through adapters.

### 6.7 Graceful Degradation

Failure of an optional adapter must not corrupt the compiler state.

Examples:

* retrieval is unavailable;
* an embedding model is unavailable;
* document conversion fails;
* an LLM provider fails.

The system must return a clear failure or a documented degraded result.

---

## 7. Product Boundaries

CtxAlloc owns:

* normalized context block representation;
* token counting;
* candidate validation;
* deterministic deduplication;
* candidate filtering;
* priority handling;
* budget allocation;
* context ordering;
* compiled context generation;
* compilation traces;
* evaluation of context reduction.

CtxAlloc does not need to own:

* vector storage;
* embedding generation;
* long-term memory extraction;
* document OCR;
* model hosting;
* authentication providers;
* billing infrastructure;
* agent execution loops.

Those capabilities may be added through adapters or external services.

---

## 8. Explicit Non-Goals

The MVP is not intended to become:

* a general-purpose agent framework;
* a replacement for Qdrant;
* a replacement for QMD;
* a replacement for Mem0, Zep, Letta, or similar memory systems;
* a full OpenAI-compatible model gateway;
* an autonomous prompt rewriting agent;
* an LLM-based summarization service;
* a complete Obsidian AI assistant;
* a full enterprise SaaS platform;
* a visual no-code workflow builder.

Features outside the product contract require a separate decision before implementation.

---

## 9. Product Principles

### 9.1 Measure Before Optimizing

No compression method is considered useful without measuring:

* token reduction;
* required fact preservation;
* answer quality;
* latency;
* operational cost.

### 9.2 Retrieval Is Not Compilation

Retrieval proposes candidate context.

The compiler decides what enters the final context.

A high retrieval score does not automatically guarantee inclusion.

### 9.3 Prefer Removal Over Rewriting

The MVP should prefer:

* excluding irrelevant blocks;
* removing duplicates;
* selecting exact source fragments;
* preserving original wording.

Generative rewriting and summarization are deferred until they demonstrate measurable value.

### 9.4 Preserve Information Before Saving Tokens

Required facts have priority over token reduction.

### 9.5 Keep the Core Small

The core must remain independently testable without:

* a network connection;
* a vector database;
* an external LLM;
* an Obsidian installation;
* a running retrieval service.

### 9.6 External Dependencies Must Be Replaceable

An external dependency is acceptable only when it is isolated behind a small adapter and can be removed without changing the compiler domain model.

---

## 10. Supported Operating Modes

### 10.1 Library Mode

An application calls the CtxAlloc TypeScript API directly.

```ts
const result = await compiler.compile(request);
```

### 10.2 Local Service Mode

A local daemon exposes the compiler through an HTTP API or CLI.

### 10.3 Server Mode

A deployed service receives scoped compilation requests from AI applications.

Server mode may use different storage and retrieval adapters while sharing the same compiler kernel.

---

## 11. MVP Product Promise

The MVP must demonstrate the following end-to-end scenario:

1. A local source provides Markdown or conversation content.
2. Content is normalized into context blocks.
3. Candidate blocks are produced by a test provider or one real retrieval adapter.
4. CtxAlloc validates and deduplicates the candidates.
5. A deterministic allocator selects blocks under a token budget.
6. The compiler produces final context.
7. The system produces a complete trace.
8. The compiled context is compared with an unfiltered baseline.
9. The result is optionally sent to one LLM provider.
10. Evaluation determines whether token savings preserved required information.

---

## 12. MVP Success Definition

The MVP is successful only when all of the following are true:

* the compiler never exceeds the configured token budget;
* every included block has source provenance;
* every decision is traceable;
* identical inputs produce identical output;
* required facts are preserved at the target rate;
* context size is reduced by the target amount;
* answer quality remains within the accepted tolerance;
* the core tests run without external services;
* at least one local source works end to end;
* at least one real retrieval implementation can be replaced by a fake provider in tests.

---

## 13. Terminology

### Candidate

A context block proposed for possible inclusion.

### Context Block

The smallest independently selectable unit of context.

### Required Block

A block that must be included unless the request is invalid or the budget is impossible.

### Compiled Context

The final ordered context sent to an LLM or returned to an application.

### Compilation Policy

The rules that control validation, priority, deduplication, budgeting, and ordering.

### Compilation Trace

The complete machine-readable record of compiler decisions.

### Retrieval Provider

A component that finds potentially relevant blocks.

### Model Provider

A component that sends compiled context to an LLM.

### Scope

The tenant, workspace, and optional project boundary for a request.

---

## 14. Change Control

A proposed feature must be rejected or moved outside the core when it:

* duplicates an established external system without measurable benefit;
* makes the core depend on one retrieval backend;
* introduces generative behavior into deterministic compilation;
* prevents offline unit testing;
* removes provenance;
* weakens scope isolation;
* makes compilation decisions impossible to explain;
* expands the MVP without improving validation of the core hypothesis.

Changes to this product contract must be recorded in the project decision log.

# Retrieval Technology Spike

## Document Status

* Product name: CtxAlloc
* Document type: Technical spike record
* Status: Complete
* Date: 2026-09-03
* Decision: [DEC-041](./DECISIONS.md)

This document records the evidence behind the choice of the first real
`CandidateProvider` implementation. It is a spike record, not a product
document: it describes what was measured, on which exact versions, and what
followed from it.

---

## 1. Question

Phase 18 needs **one** real retrieval implementation behind the existing
`CandidateProvider` port. CtxAlloc already owns exact `ContextBlock` boundaries,
block identifiers, source provenance, content hashes, and token counts, so a
retrieval technology is acceptable only if it can rank text **without taking
ownership of any of them**.

The question is therefore not *which retriever is best?* but *which retriever can
be an adapter?*

---

## 2. Hard Gates

A candidate technology had to satisfy all eight.

| # | Gate | Requirement |
|---|------|-------------|
| 1 | Exact block identity | One indexed record is exactly one supplied `ContextBlock`; every result maps back to one exact `block.id`. No provider chunk, snippet, or reconstruction becomes a candidate. |
| 2 | Explicit corpus | Retrieval runs over exactly `request.blocks`. No home directory, global collection, working-directory scan, or previous session index. |
| 3 | Offline lexical mode | No embeddings, no model download, no reranker, no query-expansion model, no LLM, no network. |
| 4 | Deterministic output | Identical config, scope, query, reference time, corpus, and dependency version return structurally identical candidates in identical order. Ties may be made deterministic by adapter logic. |
| 5 | Truthful score semantics | The adapter publishes the score it actually receives, named for what it actually is. |
| 6 | No global mutable state | No shared cache, environment-selected database, working directory, or process-global registry. |
| 7 | CI feasibility | Runs in CI with no paid API, model download, network, external daemon, or global CLI install. |
| 8 | Narrow dependency | No external type reaches `@ctxalloc/ports`, `@ctxalloc/application`, or any public `CandidateProvider` contract. |

---

## 3. Candidates Inspected

Two, both installed and executed. The named primary candidate was tested first
and on its own terms; a technology is not rejected on reading alone.

* **`@tobilu/qmd` 2.8.3** (MIT) — the named primary candidate. On-device hybrid
  search over Markdown, with a BM25 path, a vector path, and LLM reranking.
* **`minisearch` 7.2.0** (MIT) — a single-file in-process lexical index with a
  BM25+ ranker and zero dependencies.

---

## 4. Gate Matrix

| Criterion | `@tobilu/qmd` 2.8.3 | `minisearch` 7.2.0 |
|---|---|---|
| **Exact block mapping** | **FAIL.** No API indexes an in-memory string. Records are created by scanning the filesystem, and identity is provider-owned: `filepath` is `qmd://<collection>/<file>` and `docid` is a truncated content hash. Two distinct blocks with identical content received the **same `docid` `031e10`**, so `docid` cannot address a CtxAlloc block. | **PASS.** `idField: 'id'` takes any string, so the record identifier *is* `String(block.id)`. One document in, one result out, with no chunking of any kind. |
| **Hidden state** | **FAIL.** The corpus must be materialized as files inside a globbed directory, and a SQLite database file is mandatory. `enableProductionMode()` plus `getDefaultDbPath()` resolve to a shared cache location; only an explicit `dbPath` avoids it. | **PASS.** The index is an in-memory object built per call from `request.blocks`. No file, no database, no registry, nothing shared between calls. |
| **Offline lexical mode** | Partial. `searchLex` runs BM25 with no model loaded. But `node-llama-cpp` 3.20.0 is a **hard, non-optional dependency**, as are `better-sqlite3`, `sqlite-vec`, and four native tree-sitter grammars. The lexical path does not need them; installing the package does. | **PASS.** Pure JavaScript, zero dependencies, no model, no native module, no network. |
| **Deterministic behavior** | Deterministic per corpus, but the query is silently rewritten: `budget OR reticulator` returned **0 hits** where `reticulator` alone returned 1, and `reticulator*` performed prefix expansion. Raw FTS5 operator syntax reaches the query. | **PASS** with one adapter obligation. Scores are reproducible across instances; equal scores keep **insertion order**, so the adapter imposes its own `block.id` tie-break — which Gate 4 explicitly permits. |
| **Score semantics** | Expressible but not BM25. `searchLex` returns `abs(bm25) / (1 + abs(bm25))`, a transformed value in `[0, 1)`. Publishing it as "BM25" would be untrue. | **PASS.** The returned value is the sum of per-term BM25+ scores multiplied by the number of matched query terms. Unbounded above, finite, positive for any match. Named exactly that: `minisearch-bm25plus-sum-times-matched-query-terms`, under provider id `ctxalloc-minisearch-bm25plus`. Being unbounded is what forced the Phase 9 normalization contract to be corrected — see DEC-041. |
| **CI feasibility** | **FAIL.** `npm install @tobilu/qmd@2.8.3` produced **856 MB** of `node_modules`, of which **662 MB** is prebuilt `@node-llama-cpp` binaries. Native builds are required for `better-sqlite3` and the grammars. | **PASS.** 912 KB installed, no build step, no postinstall script. |
| **Dependency weight** | 13 runtime dependencies, including an MCP server and a llama.cpp binding, plus five platform-specific optional `sqlite-vec` packages. | 1 package, 0 transitive dependencies. |
| **Verdict** | **REJECTED** — fails Gates 1, 2, 3, 6, 7, and 8. | **SELECTED** — passes all eight gates. |

---

## 5. Evidence

Every claim above was produced by running the pinned versions, not by reading
documentation.

### 5.1 QMD: one block is not one record

QMD's library API creates records by scanning a directory:

```ts
await store.addCollection('corpus', { path: '/some/dir', pattern: '**/*.md' });
await store.update(); // walks the filesystem
```

There is no method that accepts `{ id, content }`. `insertDocument` exists on the
internal store but takes `(collectionName, path, title, hash, createdAt,
modifiedAt)` — the body still comes from the file. Representing a `ContextBlock`
therefore requires writing it to a temporary file and letting QMD derive its own
identity from the path, which is exactly the ownership Gate 1 forbids.

Observed `searchLex` result over two files with byte-identical content:

```text
{"filepath":"qmd://corpus/blk-dup-1.md","docid":"031e10","score":1.687e-6}
{"filepath":"qmd://corpus/blk-dup-2.md","docid":"031e10","score":1.687e-6}
```

The two blocks are distinguishable only by the path the adapter would have had to
invent for them. A CtxAlloc block identifier is an arbitrary string, so it would
need filesystem-safe encoding and parsing back — a provider-owned identity
mapping, not `String(block.id)`.

Frontmatter is indexed as part of the body and `title` is derived from the
filename, so a `.md` file is also interpreted rather than taken as bytes.

### 5.2 QMD: the score is not BM25

From `dist/store.js`, the FTS path:

```js
// bm25 lower is better; sort ascending.
const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
```

This is documentable, and it alone would not have failed the spike. It is
recorded because a rejected candidate's score semantics are still evidence: the
value is a monotone transform in `[0, 1)`, not a BM25 score.

### 5.3 QMD: install cost

```text
node_modules                       856M
  @node-llama-cpp                  662M
  node-llama-cpp                    40M
  tree-sitter-typescript            38M
  better-sqlite3                    27M
```

`node-llama-cpp` is listed under `dependencies`, not `optionalDependencies`, so
this cost is unavoidable even though the lexical path never loads a model.

### 5.4 MiniSearch: behavior confirmed

Confirmed by execution against 7.2.0:

* `search('')` and a whitespace-only query return `[]`; no operator syntax
  exists, so `budget AND`, `-budget`, and `"unclosed` are treated as ordinary
  terms and none of them throws.
* Defaults are `combineWith: 'OR'`, `prefix: false`, `fuzzy: false`,
  `bm25: { k: 1.2, b: 0.7, d: 0.5 }`, `processTerm: term => term.toLowerCase()`,
  and `tokenize: text => text.split(/[\n\r\p{Z}\p{P}]+/u)`. The adapter passes
  the first four explicitly rather than inheriting them; measured against the
  library run with no options at all, the scores are identical.
* Cyrillic text tokenizes and matches without any CtxAlloc normalization.
* `addAll` **throws** on a duplicate identifier, which the adapter pre-empts with
  its own `duplicate_block_id` failure.
* Documents passed in are not mutated.
* Equal scores are returned in insertion order — the one determinism gap, closed
  by the adapter's `block.id` tie-break.

---

## 6. Outcome

`minisearch` 7.2.0 is selected, pinned exactly, and used in its plain lexical
mode. QMD is rejected: it is a capable search **product**, and that is the
problem — it owns document identity, chunking, and storage, which are the exact
responsibilities CtxAlloc must keep.

No project-owned BM25 engine was written. Rule C of the spike (stop and report if
nothing passes) was not reached, because a technology that satisfies every gate
exists.

Semantic and hybrid retrieval, embeddings, reranking, query expansion, and a
persistent retrieval index remain deferred. Nothing in this record argues against
them; it argues only that Phase 18 is lexical.

The gates are kept as regression tests in
`tests/adapters/minisearch-dependency.test.ts`, so a later dependency change that
reintroduced a model, a native module, a database, or hidden state fails the
suite rather than production.

# Phase 22B: real dogfood protocol and intake

Status: **READY_FOR_HUMAN_DATA**. This PR prepares a local diagnostic pilot; it
contains no real dogfood evaluation result and does not complete the Phase 22B
evaluation. No approved corpus, human judgments or operating settings were
provided. Toy software tests are not dogfood evidence. No live models or judges
are permitted, and no Product Validation PASS is claimed.

## Baseline and fixed candidate

The actual merged-main baseline is
`407da35bdb2dfcdd4e7f11bb76b6fecf425d292f` (merged PR #28). The Phase 22A
integrated files match handoff `248bb3d1c99738bf5713c43039bc6299fe0a00a0`.
This comparison does not depend on the original head being an ancestor after
squash integration. Canonical Phase 21E integration anchor
`f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c` remains an ancestor; the re-anchored
verifier authenticates historical Phase 21E PASS and Phase 21C retains FAIL.

The candidate remains `minisearch-query-rank-incomplete-admit@1`, calibration
version `phase22a-development-1`. The unchanged MiniSearch 7.2.0 provider emits
native BM25+ evidence. Canonical input ordering precedes retrieval. Reciprocal
rank `1/(rank+1)` determines allocation order, evidence is incomplete, and the
admission policy has no restrictive threshold. No labels enter compiler scores,
priorities, applicability or required attributes. Provider, compiler, production
CLI/API defaults, historical evidence and Phase 22A annotations remain unchanged.

The Phase 22A raw command is expected to exit **1**: native corpus permutation
changed floating-point score tails in 13 queries. Canonical request preparation
is a caller-side contract; it does not fix or version the native adapter.

## Target, collection and coverage

Target: the operator's actual local project tasks, answered using an explicitly
approved snapshot of that project's documents, notes, conversation exports and
available tool-result text. This is a diagnostic pilot, not population-level
statistical proof or an answer-quality study.

Before reading scores, select the first **20 consecutive eligible real tasks**
in a predeclared collection interval/project scope. Record the interval and
eligibility/exclusion rule locally. Keep unanswerable, insufficient-source,
ambiguous and difficult tasks. Record exclusions and their reasons before
retrieval. Do not select cases because they produce favorable retrieval results.
If natural sampling misses coverage, record that gap; do not fabricate tasks or
quietly replace the initial cohort. A separately identified supplementary cohort
may be collected under a predeclared rule and reported separately.

Minimum pilot coverage for an evaluable overall acceptance claim:

- At least 20 real tasks, with at least five tasks in each primary stratum:
  actual project documentation, developer notes/reference, and actual conversation
  history. Strata can overlap and are assigned by the human before retrieval.
- Tool-result tasks: at least five when approved real tool-result material is
  available; otherwise explicitly record unavailable coverage. Plain text supports
  exported results, not execution of tools.
- Include and report natural unanswerable/insufficient-source tasks. If fewer than
  two arise, mark that coverage incomplete; do not manufacture them.
- Declare the source/query languages before collection. Evaluate each declared
  query-language stratum with at least five tasks; a smaller stratum is INCOMPLETE.
  Report untranslated originals; no implicit translation or language claims.

Source-origin declarations describe the material's actual origin, not merely its
file tag. A query added as an obligatory block is not conversation-history
coverage. The software checks structural consistency; a human must review origin
and sampling claims. Single-person dogfooding is not a blinded independent study.

## Operating decisions required before freezing

There are deliberately no production defaults in the template. Supply:

1. Explicit source approval reference, exact tenant/workspace/project scope,
   snapshot directory and enumerated relative file locators. No glob or scan.
2. Reader byte limit and Markdown/text `targetTokens`/`maxTokens`. Conversation
   preparation uses the existing one-message-per-block owner and strict v1 JSON.
3. Actual production candidate cap, primary **available-context** tokens and output
   reservation. Total tokens passed to the compiler equal available + reservation.
   Available tokens must already account for any external system/tool/protocol
   reserves; list that operating assumption. Do not use Phase 22A's 2,048-token
   diagnostic budget as an inferred production preference.
4. Collection interval/rule, query languages, source availability, primary strata,
   and genuine caller-known runtime obligations (or an explicit empty list).
5. Human annotation process and explicit authorization for the frozen evaluation.

The generous diagnostic control uses a predeclared deterministic headroom formula
and verifies that all prepared/retrieved candidates survive under the same renderer.
It isolates allocation loss and cannot rescue primary-budget failure. No budget
sweep is selected in this protocol. A future sweep must be declared in a new
protocol before observation; it cannot replace the primary operating point.

## Human checkpoint and annotations

Keep the snapshot, task file, annotation file, review worksheet, freeze and reports
inside ignored `.ctxalloc/`. Preparation calls only the existing source reader,
ingestion and chunkers, with no candidate provider or selection. The local review
worksheet carries exact approved source content, source hashes, chunk identities,
locations and content. It contains no scores, ranks or compiled selection.

A human reads the source and worksheet, authors the real tasks, and records:

- Useful evidence spans or whole conversation messages, with exact source identity,
  location and quote. Spans are measured in JavaScript UTF-16 code units.
- Explicitly irrelevant prepared block IDs. Everything else remains unjudged.
  A partly useful block cannot also be declared wholly irrelevant.
- Atomic facts, alternatives of evidence carriers (all carriers within an
  alternative are needed; any complete alternative suffices), required-for-task
  flags and criticality. Unknown criticality is `null`, not false or perfect recall.
- Answerable, unanswerable or insufficient-source status, plus whether the full
  approved scope was reviewed. Missing material and unavailable fact carriers
  remain explicit, including facts with no available alternative.

Tasks and caller obligations live in a separate input from evaluator annotations.
The compiler sees only task text, approved prepared blocks, native/mapped evidence,
operating settings and caller obligations. It never receives usefulness labels,
negative judgments, fact carriers, criticality or evaluator-required flags.
Only genuinely caller-known obligations become runtime-required blocks. The query
itself is not silently made required. Runtime preservation and answer-evidence
preservation have separate denominators even if their text overlaps.

At least 80% of prepared blocks per task must have an explicit positive or negative
judgment for the pilot annotation-coverage gate. All useful facts require explicit
criticality for that gate. This threshold concerns completeness of the evidence,
not precision quality; report remaining uncertainty bounds. Sparse annotations can
produce ordinary diagnostic results, but cannot produce overall PASS. An
unanswerable claim requires full source-scope review; it does not automatically
label every candidate irrelevant.

An attestation, hash, checked boolean or LLM-authored example does not establish
independent human annotation. Record who performed which role and what they could
see, locally. Operator approval and the actual process are the authority; software
can enforce declared prerequisites and identity consistency only.

## Actual preparation and its limits

The local workflow uses `NodeFileSourceReader` and `PrepareLocalCorpusService`,
including the existing Markdown, text and conversation ingestion/chunking owners.
The manifest is an explicit in-memory implementation of the existing read-only
control-store port. It neither discovers nor persists registrations.

Only available listed files are read. Declared missing sources stay in the manifest
and evidence denominator. Unexpected read/parse failures block freezing; they are
not silently treated as an empty corpus. A post-freeze snapshot or preparation
change invalidates that run. Source bytes and prepared identities are reconciled
before selection; evidence that exists in source but maps to no complete prepared
carrier remains a preparation loss.

This exercises the production preparation owners and public provider/compiler
APIs, with an opt-in benchmark composition. It does not exercise CLI argument
parsing, HTTP transport, SQLite registration/trace persistence, source export tools,
conversation roles/tool-call execution, live answers or the application's global
failure behavior. It must not be advertised as full CLI/API dogfooding.

## Freeze and first result

Freeze before the first selection call: settings, source byte hashes, prepared
corpus, task set and caller obligations, human annotations, fixed provider/profile,
candidate cap, budgets, reader/chunker configuration, tokenizer/renderer/compiler
composition, protocol, metric/gate definitions and implementation hashes.

Write the freeze and first report exclusively to new local files; do not overwrite
an earlier artifact. Record an execution marker before selection so a failed or
interrupted attempt is retained. A rerun uses the same frozen inputs and a new
report identity. Corrected inputs require a separately identified experiment and
an explanation of the defect; never replace the first unfavorable result.

No evaluation is permitted here without the human-data checkpoint. When inputs are
missing, return **READY_FOR_HUMAN_DATA**, list the missing decisions, and stop before
retrieval. Preparation-only status is not an evaluated baseline verdict.

## Metrics, denominators and ownership

For every task trace useful evidence/facts through source availability, preparation,
all matching native candidates, the actual configured candidate cap, admission and
final rendered context. Keep the retrieval/admission/allocation owners disjoint:
retrieval includes explicit unavailable-source, preparation and cap subcounts.
Do not omit unmapped units or compilation failures from end-to-end denominators.

Report both useful-evidence and fact counts, with fact alternatives respected:
source availability / all annotated units; preparation coverage / available units;
retrieval recall / all annotated units at the actual cap; admission recall /
retrieved useful units; final fact preservation / all annotated facts. Also report
conditional retrieval given preparation, annotated critical-fact preservation,
caller-required preservation, complete-evidence-loss cases and failures per task.
Zero denominators are `null`. Missing criticality is NOT_EVALUATED.

Precision uses admitted candidate blocks and separate positive, negative and
unjudged counts. Report judgment coverage, judged-only precision, precision bounds
and false-admission bounds. Do not call unjudged blocks irrelevant. Compilation
failures have no delivered context, remain in outcome counts, and preserve zero
final units; unavailable stage observations remain explicit rather than guessed.

Measure compatible JSONL rendering with the actual O200k tokenizer:

1. Prepared full context versus full context retained by retrieval/capping.
2. Retrieved full context versus primary compiled context.
3. Prepared full context versus primary compiled context.

All baselines include the same caller obligations and renderer. Check every final
rendered string against the primary available budget. Failed compilations do not
create artificial 100% token savings; their token reduction is null and reported
as missing coverage. Only complete-workload preservation-qualified savings count
as optimization evidence.

An evaluator-only feasibility diagnostic builds a candidate witness from annotated
required/critical facts and caller obligations, renders it identically, and checks
complete fact coverage and exact tokens. A valid fitting witness means FEASIBLE.
A failed greedy witness is UNKNOWN, never proof of infeasibility. Missing criticality
is NOT_EVALUATED. This diagnostic never affects compilation, its budget, ranking,
required flags or operating gates. Infeasible/unknown cases remain in the workload.

## Fixed operating gates and interpretation

Starting targets from Phase 22A remain fixed:

- 100% admission recall on retrieved useful evidence.
- 100% genuine runtime-required and annotated critical-fact preservation.
- At least 95% useful retrieval recall and final useful-fact preservation overall
  and in every predeclared primary source/language stratum.
- Zero budget and cross-scope violations, zero compilation failures, exact
  downstream determinism for repeated and permuted canonical profile inputs.
- The predeclared pilot/task/annotation coverage above must be met for PASS.

A measured violation gives **DOGFOOD BASELINE FAIL**. Insufficient or unmeasured
evidence gives INCOMPLETE/NOT_EVALUATED, never an inferred success. Report the full
workload and all declared segments, including failed and zero-evidence tasks.
Generous controls and feasibility diagnostics cannot waive primary gates.
Token savings qualify only when all preservation and coverage requirements pass.

If the baseline fails, identify source preparation, retrieval/capping,
ranking/allocation or operating-budget suitability as the next development owner.
Do not change any of those algorithms in this evaluation task.

## Privacy and local workflow

Use only explicitly approved content. Do not scan repositories, homes, personal
notes, vaults or client directories. All local paths must resolve inside ignored
`.ctxalloc/`; source files additionally stay inside the approved snapshot root.
Symlink escapes and unknown fields are rejected. Input/error handling is bounded;
errors expose fixed codes rather than local paths, source text or stack traces.

Keep detailed worksheets, annotations, execution markers and reports local. Only
separately reviewed and explicitly approved sanitized aggregate evidence may enter
Git; this PR includes none from private sources. Hashes are identifiers, not
anonymization or proof of consent. No automatic upload or publication occurs.

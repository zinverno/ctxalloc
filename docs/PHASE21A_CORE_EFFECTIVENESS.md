# Phase 21A — Optional-context selection evidence

## Baseline and outcome

Baseline: actual merged main `33f81c57580d14d3f9c7e5e1443329490a4a8bbc`
(PR #21). The working tree was clean before baseline execution. Full baseline
validation passed 171 test files / 3671 tests. Deterministic acceptance independently
reproduced engineering `INCOMPLETE` and product validation `FAIL` on frozen
`ctxalloc-eval-v1` (development 3 / validation 3 / regression 7).

**Outcome B: no core selection behavior change.** This conclusion was recorded
from the baseline code and real stage diagnostics before implementing reusable
diagnostic code. Ranking information exists; an exclusion criterion establishing
that lower-ranked information is dispensable does not. The supplied filtering
policy explicitly admits all scores >= 0, and the allocator honors that eligibility.
The resulting behavior matches its current contract, but this permissive policy
does not satisfy the broader goal of minimum sufficient context.

## Root cause from the actual compiler path

`CompilationRequestValidator` validates the request/policy. `CandidateValidator`
checks candidates, scope, provenance, exact token counts and content hashes.
`CandidateDeduplicator` groups exact normalized content; conflicting values are
not duplicates (INV-DEDUP-005). `CandidateScorer` produces policy-relative utility
from configured signals. `CandidateFilter` establishes eligibility using the
explicit inclusive `minimumTotalScore`. `BudgetAllocator` resolves required and
category-minimum groups, then traverses optional groups by score descending and
stable id. It includes an eligible group unless a category maximum or remaining
content budget prevents it. `ContextCompiler` measures the rendered selection and
corrects it only when rendering exceeds the hard budget.

The frozen policy configures priority normalization [0, 1000] with weight 1,
retrieval normalization [0, 1] with weight 1, filtering minimum 0, and
`score-desc-greedy`. It configures no recency component or category constraints.
All 18 candidate wrappers in these three validation cases are compiler-optional:
`attributes.required` is absent. Evaluation `requiredBlockIds` and required-fact
annotations measure preservation; they do not set compiler required flags or
feed selection. Supplying them as runtime labels would leak evaluation answers.

### case-04-conflicting-context

Both blocks are distinct canonical groups, in scope, with valid provenance.
`blk:current-limit` has authored priority 900 (total .9), costs 15 content tokens,
and is included with 300 -> 285 content tokens remaining. `blk:stale-limit` has
priority 10 (total .01), costs 15, and is included with 285 -> 270 remaining.
Both pass `ELIGIBLE_POLICY` at minimum 0 and receive `INCLUDED_SCORE_ORDER`.
The complete render costs 79 against 300 available; no correction runs.

The lower-priority block is identifiable as less preferred. Its being obsolete,
its relationship to the other fact, and whether the caller wants only the current
value are not represented as structured exclusion evidence. Neither block has
createdAt/updatedAt, and recency is disabled. Dates and the stale/current meaning
occur in source text, which the compiler does not interpret as selection policy.
Priority is query-independent preference, not a validity flag or supersession edge.

### case-12-retrieval-noise

Three distinct optional canonical groups have comparable retrieval evidence:
`blk:purge` .91 (rank 0), `blk:warm` .62 (rank 1), `blk:calendar` .11 (rank 2).
No authored priorities or timestamps are supplied. Allocation includes them in
that score order at content costs 12, 8 and 10: remaining budgets are
300 -> 288 -> 280 -> 270. Every score meets minimum 0; every group receives
`INCLUDED_SCORE_ORDER`. The final render costs 100 against 300 available.

The scores identify relative relevance, but .11 is not a stated rejection and
.62 is not a calibrated guarantee of usefulness. The annotation marking calendar
irrelevant is available only to evaluation. Changing a cutoff after reading these
validation answers would tune frozen validation policy. Selecting only the top
score, inferring rejection from a score gap, or applying a score/token ratio would
add a new rule without evidence that lower-ranked complementary facts are expendable.

### case-05-budget-pressure

`blk:commander` has priority 1000 (score 1) and costs 15 content tokens. Twelve
filler groups have priority 1 (score .001), each costing 14. All pass minimum 0.
The allocator includes commander then filler-01 through filler-08; the latter
leaves 13 of 140 available content tokens. Filler-09 through filler-12 fail with
`EXCLUDED_BUDGET_EXHAUSTED` at that same 13-token remainder.

The initial render costs 360, so render correction evicts filler-08 through
filler-03 in the recorded policy order. Commander, filler-01 and filler-02 remain:
120 rendered tokens, 20 unused. These are six render-correction exclusions and
four initial budget exclusions, not ten relevance exclusions. The 520-token full
baseline reduces by 400 / 520 = .7692307692307693 because of budget pressure.

## Why no implicit policy correction is justified

The budget is already a ceiling: existing `CandidateFilter` can exclude optional
context with unused capacity under an explicit minimum, while required blocks
bypass it. The missing input here is a defensible admission policy paired with
meaningful score semantics, not another allocator budget check. The v1 policy
intentionally set minimum 0 to avoid tuning fixture selection. A positive global
cutoff, a maximum-score-only rule, or a relative gap rule cannot be inferred from
these rankings and would risk useful optional context. Missing scores are also
not evidence of uselessness: existing distributed-facts and conversation cases
contain useful optional blocks without numeric evidence.

No benchmark fixture, annotation, split, policy, budget, expected result, metric
formula or threshold changes. No new percentage utilization target, model call,
retrieval subsystem or implicit default is introduced. Existing compiler/API/
CLI/trace/persistence contracts and invariants therefore require no ADR revision.

## Phase 21B recommendation

Start with the existing versioned `CandidateFilteringPolicy.minimumTotalScore`
seam: define an explicit optional-admission policy for a documented caller/use
case, justify its utility scale and threshold using independent development
examples, and freeze it before a separate held-out evaluation. Do not retrofit
that threshold into evaluation v1. Required obligations must be explicit caller
input (`attributes.required`), not copied from held-out answer annotations.

For conflicts requiring authoritative current-only selection, the smallest
additional semantic contract would be an explicit applicability/supersession
relationship supplied outside the kernel, with defined behavior across exact
duplicate groups and required members. Timestamps or numerical priority alone
cannot establish that one fact supersedes another. Specify and validate that
contract before implementing it; no embeddings, model scorer or summarizer is
needed merely to express applicability. Preserve support for histories and for
multiple complementary low-ranked facts. Nearly all-useful context may correctly
produce little or no reduction.

## Reproducible diagnostic

Run from a checkout of this phase using Node 22 and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --silent diagnose:selection > selection.json
pnpm --silent acceptance:mvp > acceptance.json
```

The generated reference is [phase21a-selection.json](evidence/phase21a-selection.json).
It is actual output from the built diagnostic, pretty-printed for review; it is
not an input or expected-result fixture. The unchanged kernel and frozen input
baseline are the SHA above. Invocation identifiers, request fingerprints,
query/source/content hashes, policy versions and tokenizer identity bind the
observed inputs and composition. Execution time and git working-tree state are
intentionally absent from the deterministic diagnostic payload. Acceptance keeps
its existing execution provenance separately.

[diagnoseCompilation](../benchmarks/diagnostics/compilation-decisions.ts) accepts
only a compiler request, compiler config and tokenizer. It compiles with the real
`ContextCompiler`, then replays the existing validation, deduplication, scoring,
filtering and allocation owners to recover per-decision budget remainders absent
from the settled trace. Shared group identities, scores, filtering decisions,
allocation reasons and allocation summary must agree with the real trace or the
diagnostic throws. No score calculation or selection rule is duplicated here.
This extra replay is offline observation, not a latency measurement or serving
path. The validation runner chooses the existing validation split without
case-specific branching or consulting preservation/irrelevance annotations.

Each canonical group contains every candidate wrapper, its original required
flag, priority, retrieval score contract and rank, timestamps, source type,
location and hashes, scope match, canonical relationship, and duplicate reason.
The group's score retains the compiler's component evidence and aggregation.
Repeated identical wrappers remain repeated rows; they have no independent
wrapper id and are charged once through their canonical group. Group membership
links each member to the group's actual filtering, allocation and final decision.
`compilerRequired` is explicitly distinct from evaluation-required annotations.

`initialAllocation` is null for a filtered group. Included groups carry actual
`remainingBefore` / `remainingAfter`; initially excluded groups carry actual
`remainingTokens`. These are **canonical content-token** allocation values, not
final rendered capacity. The settled trace separately carries initial rendered
cost, correction eviction order, final disposition/reason, final rendering hash,
compiled tokens and unused capacity. It does not invent intermediate rendered
costs for individual evictions or charge duplicates as independent decisions.
Missing optional input signals appear as null (or absent optional retrieval
fields); missing numeric evidence is not silently converted to relevance zero.

The output omits raw query, block content, rendered context, source titles and
arbitrary source/block/retrieval metadata, following existing trace privacy.
Identifiers, category labels and provenance locations remain evidence; this is
not an anonymizer for caller-controlled identifiers. It emits diagnostics only
for successful compilations. Invalid input, scope failures, compilation failures
or replay disagreement fail explicitly. The no-argument executable emits one
JSON result on stdout; failure exits 1 with a fixed `selection_diagnostic_failed`
JSON error on stderr and no partial result or raw exception detail.

Repeated identical invocations produce byte-identical JSON. Candidate
permutations preserve processing evidence and final output; invocation identity
still records exact caller array order under DEC-037. No existing schema,
persistence format, API/CLI behavior or package boundary changes. CI runs the
built diagnostic after deterministic acceptance.

## Before/after unchanged-v1 acceptance

The after result is measured with the same frozen inputs and core behavior. No
reduction improvement is claimed.

| Validation case | Before: full -> compiled | After: full -> compiled | Before / after reduction |
| --- | --- | --- | --- |
| case-04-conflicting-context | 79 -> 79 | 79 -> 79 | 0 / 0 |
| case-05-budget-pressure | 520 -> 120 | 520 -> 120 | 0.7692307692307693 / 0.7692307692307693 |
| case-12-retrieval-noise | 100 -> 100 | 100 -> 100 | 0 / 0 |

| Gate | Before | After | Status (both) |
| --- | --- | --- | --- |
| Median validation context reduction (target >= 0.35) | 0 | 0 | FAIL |
| Long-context reduction (target >= 0.50) | 0.7692307692307693 | 0.7692307692307693 | PASS |
| Required-block recall | 1 | 1 | PASS |
| Required-block recall, stronger valid-budget checklist | 1 | 1 | PASS |
| Weighted required-fact coverage | 1 | 1 | PASS |
| Critical fact coverage | 1 | 1 | PASS |
| Budget violations | 0 | 0 | PASS |
| Unexpected failures | 0 | 0 | PASS |
| Expected failure accuracy | 2/2 | 2/2 | PASS |
| Provenance coverage | 27/27 | 27/27 | PASS |
| Wrapper accounting | 38/38 | 38/38 | PASS |
| Group decision completeness | 37/37 | 37/37 | PASS |
| Decision reason coverage | 111/111 | 111/111 | PASS |
| Trace reconciliation | 11/11 | 11/11 | PASS |
| Repeat determinism | 26/26 | 26/26 | PASS |
| Scope violation detection | 1/1 | 1/1 | PASS |
| Cross-scope inclusions | 0 | 0 | PASS |
| Frozen dataset unchanged | 1 | 1 | PASS |
| Built CLI workflow | 1 | 1 | PASS |
| Built HTTP workflow and parity | 1 | 1 | PASS |
| Source-instruction escape count | null | null | NOT_EVALUATED |
| Docker runtime | null | null | NOT_EVALUATED (NOT_RUN) |
| Median answer-quality loss | null | null | NOT_EVALUATED |

Engineering acceptance remains **INCOMPLETE** and product validation remains
**FAIL**. Performance remains NOT_EVALUATED in this deterministic run. No live
answer-quality calls or Docker cleanup were performed. The thirteen hand-authored
cases are small fixed historical evidence, not statistical proof of sufficiency
or calibrated admission thresholds. Phase 21B must address the missing admission
semantics; diagnostics alone do not make the product acceptance pass.

## Validation and change boundary

Node 22.23.2 / pnpm 10.33.0, with frozen dependency installation. Completed:

- `pnpm clean`, `pnpm install --frozen-lockfile`.
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`: PASS.
- `pnpm test`: **173 files / 3682 tests PASS**, including **2 new files / 11
  diagnostic tests**. Baseline was 171 / 3671.
- `pnpm check:boundaries`: **11 workspaces PASS**; `pnpm check`: PASS, including
  the same 173 files / 3682 tests. No workspace dist existed after standalone
  typecheck/tests or after the aggregate check.
- Clean `pnpm build`: PASS; `pnpm check:declarations`: **74 declarations PASS**.
- `pnpm smoke:cli`: built executable and persistence across processes PASS.
  `pnpm smoke:api`: **12 checks PASS**, including Markdown/conversation, budget,
  CLI/API parity, restart persistence, SIGTERM drain, scope/privacy and database
  side-file cleanup.
- `pnpm --silent acceptance:mvp`: execution PASS with the acceptance states above;
  **13 cases, 11 successful compilations, 2/2 expected failures**, no unexpected
  failure. All 24 gates, split counts and aggregates equal baseline. Every case's
  result evidence is unchanged except measured compilation latency.
- `pnpm --silent diagnose:selection`: PASS. Repeated command output is
  byte-identical and matches the generated reference; invalid arguments exit 1
  with fixed JSON stderr and no stdout.
- `git diff --check`: PASS. Entire kernel/app trees, frozen evaluation v1,
  acceptance producers and lockfile are unchanged. No generated dist or private
  configuration is included, and no temporary database/WAL/SHM files remain.

The nine changed files are this document and its generated JSON, three benchmark
diagnostic sources, two diagnostic test files, the root script entry and the CI
step. Tests observe existing admission/required rules, no-signal and useful
optional behavior, tight budgets/render correction, duplicate multiplicity,
retrieval/freshness/privacy, repeat/permutation determinism, scope rejection,
replay disagreement and actual frozen input/result reconciliation. These protect
INV-BUDGET-002, INV-SCORE-003, INV-DEDUP-003, INV-DET-001/002, INV-TRACE-004,
INV-SCOPE-001 and INV-SEC-003 without changing their contracts.

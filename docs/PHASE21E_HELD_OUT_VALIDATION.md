# Phase 21E: second frozen held-out validation

Integration update: PR #26 was squash-merged and the original experiment commits are not ancestors of main. [Phase 21E-R](PHASE21E_REANCHOR.md) records exact handoff/integration tree equality and provides a separate versioned historical verifier. The original PASS, ancestry warning and report remain unchanged.

**Held-out evidence-aware context selection: PASS.** All 19 preregistered gates and 775 individual checks passed on the first execution. Contract correctness, primary selection effectiveness and misleading-risk disclosure each passed. This is bounded offline context-selection evidence; it is **not full Product Validation PASS**. Live answer quality remains NOT_EVALUATED.

The 60 requests produced 43 intended successes and all 17 expected structured failures, with zero unexpected outcomes. The 41 primary successes preserved 78/78 useful groups, 86/86 useful facts, 41/41 critical facts and 213/213 weighted required facts. All nine runtime-required groups survived. The two misleading-complete cases preserved 0/4 useful facts and admitted all four irrelevant groups, despite being contract-correct. Their results remain in every ordinary aggregate below.

## Provenance and stage order

| Stage | Recorded identity |
| --- | --- |
| Merged Phase 21D / PR #25 | `9dceacbd320ddaaa642b2484d876cec21c302d06` |
| Branch | `codex/phase-21e-heldout-validation` |
| Protocol commit | `2e1db08110523d532775a041a8406f75c624c088` |
| Dataset/freeze commit (`heldOutFreezeRevision`) | `ebebc9b5671fc55acee4eb84fce047821d1c5ea2` |
| First execution head | `ebebc9b5671fc55acee4eb84fce047821d1c5ea2` |
| First execution UTC | 2026-09-09 04:53:30–04:53:34 |
| First stdout SHA-256 | `4c3114ca7dc301fe79e55559c21bc647fa2290b4356b6389096ea960b2896646` |
| Stable evidence hash | `sha256:24423484552fb656906888f8d90c96fa0e8140bdc8739451dceec75d5091acff` |
| Manifest SHA-256 | `sha256:f7210ac39e7e5b8fc97bf62608b57994c454c1f4c84ba7f97d28c179df0204b2` |

The [protocol](PHASE21E_HELD_OUT_PROTOCOL.md) and all executable preparation, evaluation and gate code were committed before any Phase 21E source content was authored. The distinct dataset commit preceded the first compiler invocation. Its tree was clean at that invocation. The [original report](evidence/phase21e-first-run.json) is the exact stdout byte sequence, copied without JSON reformatting; exit code was 0 and stderr was empty. No frozen evaluator, compiler, input, annotation, threshold, budget, metric or gate changed after observation. A later historical verifier and explicit package/CI wiring were added after a committed-report reader limitation was found; that path does not execute selection. [Verification evidence](evidence/phase21e-verification.json) records baseline/final checks, audits and reproduction.

The manifest protects 220 semantic files and 142 built JavaScript artifacts, with 60 input/annotation/policy hash triples. Compiler sources and all historical experiment inputs and producers are unchanged from the merged baseline. The fixed compiler instance is `ctxalloc-heldout-v2` v1; tokenizer is `js-tiktoken:o200k_base` v1.0.21 and renderer is `ctxalloc-jsonl` v1. Scoring/filtering/trace/evidence-observation schemas remain **2/3/4/1**. All five evaluation profiles are v1; the nine Phase 21D development profiles are unchanged.

## Dataset and authoring boundary

The matrix is exactly **5 profiles × 6 strata × 2 replicas = 60 requests**. Each profile has 12 requests; each stratum has 10. Thirty tight cases have 160 available input tokens; thirty generous cases have 1,000. All reserve 100 output tokens. The source registry contains 260 block records, 230 distinct new source contents and 280 candidate wrappers, including deliberate alternatives and repeated wrappers. All 60 queries are unique. Source types cover 85 text, 90 markdown and 85 conversation block records.

Topics cover newly authored return, dispatch, component-handling and record-handover tasks. Static novelty checks found zero reused queries, contents or case IDs against v1, Phase 21B, Phase 21C and Phase 21D literals, and zero cross-case content reuse within v2. Exact same-case copies are explicitly annotated. The design uses repeated workload structures; 60 synthetic cases are not a representative population or a blinded independent annotation study.

Preparation used strict request/candidate/policy validation, evidence preflight, exact contract/range/completeness/scope checks and structural applicability/duplicate/reference checks. It did not score, filter, deduplicate/select, allocate, order or render held-out content. Twelve new toy tests cover the preparation boundary, truth/input independence, incomplete rejection preflight, commit guards, actual evaluator behavior, ignored/scored evidence across all profiles, privacy and misleading evidence. They use unrelated development literals.

Caller attributes and retrieval are authored separately from evaluator labels and materialized first. Mandatory caller records carry explicit rationales. Evaluator-required and critical facts do not automatically acquire runtime-required status. Truth units partition exact-content alternatives; facts specify OR-of-AND evidence. Intended applicability and evidence condition are frozen before execution. The negative cases deliberately alter only their preregistered contract field.

| Evidence condition | Requests | Successes | Matched failures |
| --- | --- | --- | --- |
| truthful-complete | 8 | 8 | 0 |
| truthful-incomplete | 30 | 23 | 7 |
| misleading-complete | 2 | 2 | 0 |
| permissive-curated | 10 | 10 | 0 |
| negative-contract | 10 | 0 | 10 |

## All preregistered gate results

| Gate | Class | Checks | Result |
| --- | --- | --- | --- |
| outcomes | contract | 63 | PASS |
| runtime-required | contract | 9 | PASS |
| budget | contract | 1 | PASS |
| scope | contract | 3 | PASS |
| accounting | contract | 215 | PASS |
| determinism | contract | 3 | PASS |
| admission | contract | 43 | PASS |
| applicability | contract | 43 | PASS |
| compatibility | contract | 43 | PASS |
| completeness | contract | 43 | PASS |
| traceVersion | contract | 43 | PASS |
| useful-blocks | effectiveness | 57 | PASS |
| useful-facts | effectiveness | 57 | PASS |
| critical-facts | effectiveness | 57 | PASS |
| required-facts | effectiveness | 57 | PASS |
| admission-recall | effectiveness | 16 | PASS |
| admission-precision | effectiveness | 10 | PASS |
| reduction | effectiveness | 9 | PASS |
| misleading-risk-disclosure | risk-disclosure | 3 | PASS |

The outcome gate checks each slot independently. The 17 expected failures have no selection-quality denominator. Zero-tolerance contract checks include provenance 123/123, wrapper accounting 206/206, group accounting 162/162, reason accounting 451/451 and trace reconciliation 43/43. Budget violations and cross-scope inclusions are zero. Both candidate-scope negatives and the evidence-scope negative were detected exactly. All 120 direct repeat comparisons and all 43 additional harness comparisons agreed. Every successful case passed admission, applicability, compatibility, completeness and trace-version observations.

Primary useful-block/fact and admission-recall gates require profile and evidence-condition micro AND macro ≥95%, with a per-case useful preservation floor of 80%. Critical and weighted required coverage require 100%. Precision floors were fixed at 80% for complete/reject and 50% for admit/curated/combined. Every primary preservation/recall segment is 100%. Precision is lower for the explicit uncertainty/curation profiles, as shown below.

Reduction gates use the 21 slots selected before authoring: truthful complete noise exclusion, distributed duplicate alternatives and temporal applicability/duplicates. Their overall median reduction is **66.80%**, above 20%; every eligible profile and condition median exceeds 15%. All-useful density cases are excluded from this gate, and all five correctly preserve their whole input with zero reduction. Selection failures cannot be rescued by token savings.

## Overall preservation and token accounting

| Metric | All successes: counts | All: micro / macro | Primary: counts | Primary: micro / macro |
| --- | --- | --- | --- | --- |
| usefulBlockRecall | 78/82 | 95.12% / 95.35% | 78/78 | 100.00% / 100.00% |
| usefulFactCoverage | 86/90 | 95.56% / 95.35% | 86/86 | 100.00% / 100.00% |
| criticalFactCoverage | 41/43 | 95.35% / 95.35% | 41/41 | 100.00% / 100.00% |
| weightedRequiredFactCoverage | 213/223 | 95.52% / 95.35% | 213/213 | 100.00% / 100.00% |
| optionalAdmissionPrecision | 69/118 | 58.47% / 68.02% | 69/114 | 60.53% / 71.34% |
| optionalAdmissionRecall | 69/73 | 94.52% / 95.35% | 69/69 | 100.00% / 100.00% |
| runtimeRequiredGroupRecall | 9/9 | 100.00% / 100.00% | 9/9 | 100.00% / 100.00% |
| irrelevantRejection | 35/80 | 43.75% / 44.74% | 35/76 | 46.05% / 47.22% |

| Population | Full rendered tokens | Compiled rendered tokens | Savings | Micro reduction | Median reduction |
| --- | --- | --- | --- | --- | --- |
| All 43 successes | 8358 | 4935 | 3423 | 40.95% | 43.37% |
| Primary 41 successes | 8037 | 4772 | 3265 | 40.62% | 42.80% |
| Preregistered 21 reduction slots | 5245 | 2022 | 3223 | 61.45% | 66.80% |

Across successful requests, 206 wrappers form 162 groups: 127 admitted, 123 included, 35 filtered and four excluded during render-aware budget correction. Thirty-six admissions explicitly preserve uncertainty. Full baselines count all wrappers and actual JSONL overhead; reductions are not content-only estimates. Raw counts, case distributions and leave-one-request-out micro ranges are in the versioned JSON. Empty denominators are null, shown here as a dash. Percentages are rounded for display.

## Per-profile results

These are ordinary aggregates, including misleading evidence wherever present. S/F means successful / matched expected failure requests. Preservation columns show raw counts; admission columns show micro / macro.

| Segment | S/F | Useful groups | Useful facts | Critical facts | Weighted required facts |
| --- | --- | --- | --- | --- | --- |
| complete | 10/2 | 15/19 | 17/21 | 8/10 | 42/52 |
| incomplete-admit | 10/2 | 19/19 | 21/21 | 10/10 | 52/52 |
| incomplete-reject | 3/9 | 6/6 | 6/6 | 3/3 | 15/15 |
| curated | 10/2 | 19/19 | 21/21 | 10/10 | 52/52 |
| combined-mixed | 10/2 | 19/19 | 21/21 | 10/10 | 52/52 |

| Segment | Admission precision | Admission recall | Irrelevant rejection | Full → compiled | Savings | Median all | Median eligible |
| --- | --- | --- | --- | --- | --- | --- | --- |
| complete | 76.47% / 80.00% | 76.47% / 80.00% | 15/19 | 1946 → 760 | 1186 | 51.59% | 67.48% |
| incomplete-admit | 53.12% / 60.83% | 100.00% / 100.00% | 6/19 | 1970 → 1298 | 672 | 0.00% | 57.73% |
| incomplete-reject | 100.00% / 100.00% | 100.00% / 100.00% | 4/4 | 575 → 244 | 331 | 66.80% | 66.80% |
| curated | 53.12% / 60.83% | 100.00% / 100.00% | 5/19 | 1930 → 1317 | 613 | 0.00% | 57.09% |
| combined-mixed | 53.12% / 60.83% | 100.00% / 100.00% | 5/19 | 1937 → 1316 | 621 | 0.00% | 57.39% |

The complete profile has 78.95% ordinary useful-group recall because both misleading cases select only irrelevant groups. Its preregistered primary subset is truthful-complete: 15/15 groups, 17/17 useful facts, 8/8 critical facts, 42/42 weighted required facts, and 13/13 admission precision/recall. This subset choice was committed before authoring. The other profiles have no misleading cases; their ordinary and primary quality values agree. Incomplete-reject has only three successful requests; its nine failures are explicit coverage, not evidence that it can always produce a usable context.

## Per-condition results

These are ordinary aggregates, including misleading evidence wherever present. S/F means successful / matched expected failure requests. Preservation columns show raw counts; admission columns show micro / macro.

| Segment | S/F | Useful groups | Useful facts | Critical facts | Weighted required facts |
| --- | --- | --- | --- | --- | --- |
| truthful-complete | 8/0 | 15/15 | 17/17 | 8/8 | 42/42 |
| truthful-incomplete | 23/7 | 44/44 | 48/48 | 23/23 | 119/119 |
| misleading-complete | 2/0 | 0/4 | 0/4 | 0/2 | 0/10 |
| permissive-curated | 10/0 | 19/19 | 21/21 | 10/10 | 52/52 |
| negative-contract | 0/10 | — (0/0) | — (0/0) | — (0/0) | — (0/0) |

| Segment | Admission precision | Admission recall | Irrelevant rejection | Full → compiled | Savings | Median all | Median eligible |
| --- | --- | --- | --- | --- | --- | --- | --- |
| truthful-complete | 100.00% / 100.00% | 100.00% / 100.00% | 15/15 | 1625 → 597 | 1028 | 66.94% | 67.48% |
| truthful-incomplete | 56.52% / 65.94% | 100.00% / 100.00% | 15/42 | 4482 → 2858 | 1624 | 0.00% | 66.67% |
| misleading-complete | 0.00% / 0.00% | 0.00% / 0.00% | 0/4 | 321 → 163 | 158 | 48.45% | — |
| permissive-curated | 53.12% / 60.83% | 100.00% / 100.00% | 5/19 | 1930 → 1317 | 613 | 0.00% | 57.09% |
| negative-contract | — / — | — / — | — (0/0) | 0 → 0 | 0 | — | — |

## Workload and budget results

| Segment | S/F | Useful groups | Useful facts | Critical / weighted required | Admission precision micro/macro | Admission recall micro/macro | Median reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| focused | 8/2 | 16/16 | 16/16 | 8/8; 40/40 | 57.14% / 62.50% | 100.00% / 100.00% | 0.00% |
| distributed | 8/2 | 16/16 | 24/24 | 8/8; 56/56 | 50.00% / 56.25% | 100.00% / 100.00% | 57.09% |
| density | 9/1 | 14/14 | 14/14 | 9/9; 37/37 | 60.87% / 75.00% | 100.00% / 100.00% | 0.00% |
| evidence-gaps | 8/2 | 12/16 | 12/16 | 6/8; 30/40 | 42.86% / 37.50% | 75.00% / 75.00% | 0.00% |
| temporal-records | 10/0 | 20/20 | 20/20 | 10/10; 50/50 | 100.00% / 100.00% | 100.00% / 100.00% | 66.93% |
| guardrails | 0/10 | — (0/0) | — (0/0) | — (0/0); — (0/0) | — / — | — / — | — |

| Segment | S/F | Useful groups | Useful facts | Critical / weighted required | Admission precision micro/macro | Admission recall micro/macro | Median reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tight | 22/8 | 42/44 | 46/48 | 21/22; 113/118 | 62.26% / 72.73% | 94.29% / 95.45% | 25.61% |
| generous | 21/9 | 36/38 | 40/42 | 20/21; 100/105 | 55.38% / 63.10% | 94.74% / 95.24% | 43.37% |

Tight cases use 4,072 full rendered tokens versus 2,330 compiled, saving 1,742; generous cases use 4,286 versus 2,605, saving 1,681. Primary preservation is 100% in both budgets. The ordinary deficits above come entirely from one misleading case in each budget. The incomplete-admit, curated and combined profiles each have **zero ordinary median reduction**, despite useful preservation. Their compression comes from the preregistered duplicate/applicability slots, not a general guarantee of removal under uncertainty.

## Exact failures, losses and risk

| Case | Observed stage | Exact unique issue code | Outcome |
| --- | --- | --- | --- |
| ev2-011 | evidence-validation | retrieval_score_rule_not_found | expected-failure |
| ev2-012 | evidence-validation | retrieval_score_rule_not_found | expected-failure |
| ev2-023 | evidence-validation | evidence_scope_mismatch | expected-failure |
| ev2-024 | candidate-validation | scope_mismatch | expected-failure |
| ev2-025 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-026 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-027 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-028 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-030 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-031 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-032 | filtering | incomplete_admission_evidence | expected-failure |
| ev2-035 | request-validation | invalid_scoring_policy | expected-failure |
| ev2-036 | request-validation | invalid_request | expected-failure |
| ev2-047 | candidate-validation | scope_mismatch | expected-failure |
| ev2-048 | filtering | required_applicability_conflict | expected-failure |
| ev2-059 | request-validation | invalid_scoring_policy | expected-failure |
| ev2-060 | filtering | missing_applicability_target | expected-failure |

All seven incomplete-evidence rejects occurred at the registered filtering boundary. Both unsupported tuples failed preflight; missing completeness and rule/ignore overlap failed request validation. There were no accidental compatibility failures in an intended-success case.

| Misleading case | Contract | Useful groups/facts | Critical / weighted required | Admission precision / recall | Irrelevant rejection | Full → compiled | Reduction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ev2-007 | PASS | 0/2; 0/2 | 0/1; 0/5 | 0/2; 0/2 | 0/2 | 161 → 83 | 48.45% |
| ev2-008 | PASS | 0/2; 0/2 | 0/1; 0/5 | 0/2; 0/2 | 0/2 | 160 → 80 | 50.00% |

Cases `ev2-007` and `ev2-008` each lose `fact-a` and `fact-b`, including the critical first fact. These are the only useful-fact losses. Both false complete declarations are contract-valid; their numeric grades cause useful exclusion and irrelevant admission. The separate disclosure gate has no semantic-recovery threshold. Its PASS means the risk was measured and exposed, not that this behavior is useful or safe for every product.

The four budget exclusions are `ev2-013:n2`, `ev2-015:n2`, `ev2-039:n2` and `ev2-051:n2`, each with `EXCLUDED_RENDER_AWARE_CORRECTION`. All four are irrelevant by independent truth. No primary useful or critical item was evicted. The evidence-gaps stratum rejects 0/16 irrelevant groups, showing the compression cost of uncertainty and the harm of false confidence.

## Historical evidence stays separate

Historical v1 MVP evidence remains Engineering Acceptance INCOMPLETE and Product Validation FAIL: 13 cases, 11 successes, two expected failures, 23 gates, ordinary median reduction zero. Phase 21A remains a diagnostic. Phase 21B remains development-only: 20 cases and 100 checks. Phase 21D remains development-only: 27 cases, 21 successes, six expected failures and 255 contract checks. No historical cases are pooled into this second held-out result.

Phase 21C remains the immutable first held-out **FAIL**: 48 requests, 22 successes, four expected scope failures and 22 unexpected compatibility failures; six gates failed, six passed and reduction was not evaluated. Its original report SHA-256 remains `3144a9f8c505f46c45e142dccf1da24feef149a38ed280d630910aa39945a4e1`. Its historical integrity command verifies the original artifact inventory, 48 hash triples and 155 frozen semantic files; 123 original built JavaScript hashes are retained as historical identities, not reattributed to the current binary.

## Limits and next phase

The next development phase should evaluate the caller evidence-quality boundary and real answer-quality measurement design separately. This experiment supports the fixed compatibility/completeness/uncertainty contracts on this new synthetic matrix. It does not calibrate a real provider, prove that caller confidence is truthful, establish broad compression under uncertainty, or show that an LLM answers better. A provider or answer-quality study needs its own preregistration and unseen data. No live LLM, new retrieval backend, summarizer, UI, database feature or compiler feature was added.

The frozen executable and the historical verifier require their recorded protocol, freeze and results commits to remain ancestors. Preserve those identities when integrating this PR; a squash that removes them requires a later explicitly re-anchored historical verification. This PR is opened for review and is not merged.


## Verification before the results commit

All 23 producer-stage validation steps passed at the freeze revision, including the required clean build and
second execution from rebuilt artifacts before the report itself was committed. Both the standalone full test run and
the aggregate check ran **184 files / 3,802 tests**; 12 tests in three new files
were added to the baseline's 181 files / 3,790 tests.

| Command or audit | Result |
| --- | --- |
| `pnpm clean` | PASS; no workspace dist before tests |
| `pnpm install --frozen-lockfile` | PASS; Node 22.23.2, pnpm 10.33.0, unchanged lockfile |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS; zero warnings |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS; 184 files, 3,802 tests |
| `pnpm check:boundaries` | PASS; 11 workspace packages |
| `pnpm check` | PASS; format, lint, type, full tests and boundaries |
| No dist after standalone and aggregate tests | PASS |
| `pnpm build` after clean | PASS; all 11 TypeScript build projects |
| `pnpm check:declarations` | PASS; 76 public declarations |
| `pnpm smoke:cli` | PASS; built executable and cross-process persistence |
| `pnpm smoke:api` | PASS; all 12 smoke checks |
| `pnpm --silent acceptance:mvp` | Reproduced 23 historical gates, counts, aggregates and case evidence apart from measured latency |
| `pnpm --silent diagnose:selection` | Byte-identical to baseline Phase 21A |
| `pnpm --silent development:admission` | Byte-identical to baseline Phase 21B |
| `pnpm --silent validation:heldout:historical` | PASS integrity; byte-identical Phase 21C historical FAIL report |
| `pnpm --silent development:evidence` | Byte-identical to baseline Phase 21D; 255/255 contract checks |
| `pnpm --silent validation:heldout:v2` | First-run PASS reproduced byte-for-byte after clean build |
| `git diff --check` | PASS |
| Protected compiler/history/freeze comparison | Zero changed files after observation |
| Artifact, credential, privacy and database audits | PASS; no tracked dist/scratch/private configuration, credential-pattern matches, residual DB/WAL/SHM files, or raw source contents/queries in first-run report |

The historical v1 producer emits the existing Node SQLite experimental warning;
it does not change its historical verdict. Phase 21E records no timing claim.
The committed additions are evaluation/protocol/test/data/evidence files and
one new root command plus CI step. No public declarations or compiler behavior
changed. The post-commit verification path is described below. Required checks were not skipped. Live model quality, real retrieval
calibration, Docker closure and source-instruction escape closure remain outside
this phase as preregistered.

## Post-commit artifact limitation and separate historical verifier

The first report is **1,097,510 bytes**. After committing it at
`210efbd015b98499454a3d48dbe1208b668fdc30`, the frozen executable's final
`git show` verification exceeded Node's default synchronous child-process output
buffer. The exact-head `pnpm --silent validation:heldout:v2 --require-pass`
exited 1 with `heldout_v2_integrity_or_execution_failed`; direct diagnosis found
`spawnSync git ENOBUFS`. This is an artifact-reader failure after the report
commit. It does not alter the preserved first execution or its gate outcomes.
The frozen reader, its original source and artifact hashes, and its limitation
are retained unchanged. The default executable is not advertised as working
on the final branch tree.

Part L of the requested evaluation permits a later historical-integrity command.
`pnpm --silent validation:heldout:v2:historical` supplies that separate path. It
reads Git artifacts with an explicit 16 MiB buffer, authenticates the original
report bytes and stable evidence hash, verifies the immutable evaluator/data/
protocol inventory and all 60 input/annotation/policy hashes, and verifies all
220 original semantic hashes against the original freeze tree. It preserves the
142 original built artifact hashes as historical identities. It imports no
compiler or evaluator and explicitly reports `compilerExecuted: false` and
`originalExecutableReproduced: false`. Its PASS means integrity, not a new
held-out execution or a new effectiveness result.

The post-observation changes are two new historical-verifier modules, seven
regression/tamper tests, a new package command and a CI step selecting that
command, plus documentation/verification evidence. `package.json` and
`.github/workflows/ci.yml` are the two original protected files with changed
execution wiring; their original versions remain in the immutable freeze. This
is disclosed rather than rebasing, regenerating or weakening the original
manifest. No selection or metric semantics were changed. The original command
continues to enforce its original file inventory and is retained for its
original freeze checkout; CI now verifies history on the final tree.

The first-report reader issue and the need to preserve distinct commit ancestry
remain documented limits. A future executable runner repair must use a new
version and preserve this original report; it must not retune these observed
cases or replace the first-run bytes.

## Final-tree validation with historical verification

All 23 applicable steps passed again after adding the separate verifier: clean,
frozen install, format, lint, typecheck, standalone full tests, boundaries,
aggregate check, clean build, declarations, CLI/API smoke, historical v1,
Phase 21A/B/C/D, and Phase 21E historical integrity. Both full-suite invocations
passed **185 files / 3,809 tests**. The phase adds **19 tests in four files** in
total: 12 tests frozen with the protocol and seven later historical-integrity
tests. Builds still cover 11 projects and 76 public declarations; all 12 API
smoke checks pass.

[Phase 21E historical evidence](evidence/phase21e-history.json) verifies 21
immutable working files, 220 original semantic hashes and 60 case hash triples,
while retaining 142 original artifact hashes and the original PASS. A separate
clean-build audit also confirmed that **all 142 original JavaScript artifact
hashes still match** the current build; no original evaluator or compiler
artifact was changed. Of the original 220 protected files, 218 working files
remain byte-identical and the two disclosed command/CI wiring files changed.

Historical v1's 23 gates, all counts/aggregates and case evidence apart from
latency still match the start baseline. Phase 21A/B/C-integrity/D reports remain
byte-identical. The final audit covers **30 changed files** and found no
credential patterns, private configuration or residual database side files.
The first report remains byte-identical to its original saved stdout. Final-tree
CI uses historical artifact verification; it does not claim that the frozen
executable was reproduced on that changed tree.

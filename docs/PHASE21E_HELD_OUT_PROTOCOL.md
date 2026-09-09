# Phase 21E: second frozen held-out protocol

Status: preregistration, before authoring any Phase 21E source content. This
protocol and all preparation, metric, gate and execution code must be committed
before the dataset directory is created. The introduction commit of this file
is the protocol revision; the manifest records that exact revision. Never amend
this protocol in response to held-out observations.

## Baseline and interpretation

PR #25 merged on 2026-09-08 at 18:08:42 UTC. The actual fetched `main` baseline is
`9dceacbd320ddaaa642b2484d876cec21c302d06`. Its tree equals the reviewed Phase 21D
head `c856a075c1e979e16b14af43155470f0cf7e2f14`. The working tree was clean before
creating `codex/phase-21e-heldout-validation` from that merged revision.

Stage 0 completed the full applicable repository baseline: 181 test files,
3,790 tests, 11 build projects, 76 public declarations, CLI/API smoke tests,
and separate v1, 21A, 21B, 21C integrity and 21D reports. All 22 baseline steps
passed. The v1 case evidence, counts and 23 gates matched its previous run
(excluding observational latency); the A/B/C-integrity/D reports were byte
identical. The Phase 21C first report remains the immutable held-out FAIL.

This experiment evaluates fixed deterministic contracts and independently
annotated selection effectiveness separately. It is not live answer-quality
validation, retrieval calibration, population inference or full Product
Validation. No model, retrieval backend or network is used by the evaluator.

## Fixed identities and semantics

The complete merged compiler/package sources remain byte-identical to Stage 0.
The compiler instance configuration is schema 1, id `ctxalloc-heldout-v2`,
version `1`, maximum correction selections 64. The implementation revision is
the baseline above; the evaluation identity does not imply a new implementation.
Tokenizer: `js-tiktoken:o200k_base` version `1.0.21`. Renderer:
`ctxalloc-jsonl` version `1`, JSONL blocks. Reference time is
`2026-09-01T12:00:00.000Z`. Node 22 and the frozen pnpm lockfile are required.

Scoring schema 2, filtering schema 3, trace schema 4 and evidence observation
schema 1 are fixed Phase 21D contracts. Positive-weight incomplete components
cannot justify a below-threshold exclusion: `admit` preserves eligibility,
whereas `reject` produces `filtering/incomplete_admission_evidence`. Eligibility
does not guarantee allocation under a token budget. Required groups bypass
score admission; conflicting applicability is a structured failure. Applicable
older/history content is not implicitly obsolete. Scoped applicability targets
only validated candidate groups; explicit inapplicable/superseded declarations
apply to exact-content alternatives. Nothing infers semantic truth from text.

The nine `evidence-dev:*` Phase 21D profiles and all earlier policies stay
unchanged. Five evaluation profiles serve distinct caller choices, fixed here
and in `benchmarks/heldout-v2/profiles.ts`:

| Profile suffix | Authored component | Retrieval component | Threshold | Incomplete action | Ignored contracts |
| --- | --- | --- | ---: | --- | --- |
| complete | complete, weight 1 | unconfigured | 0.5 | admit | support, auxiliary |
| incomplete-admit | incomplete, weight 1 | unconfigured | 0.5 | admit | support, auxiliary |
| incomplete-reject | incomplete, weight 1 | unconfigured | 0.5 | reject | support, auxiliary |
| curated | incomplete, weight 1 | unconfigured | absent | admit | support, auxiliary |
| combined-mixed | complete, weight 1 | incomplete, weight 1, max | 1 | admit | auxiliary |

Each root policy is `heldout-v2:<suffix>` version 1. Scoring/filtering IDs append
`:score`/`:admission`, version 1. Common allocation, ordering and rendering IDs
are `heldout-v2:allocation`, `heldout-v2:ordering`, `heldout-v2:rendering`, all
version 1, with unchanged score-desc-greedy, source-document-then-location and
jsonl-blocks strategies. Other scoring components are unconfigured and have no
completeness declaration. Every profile supports scoped applicability; its
exclusion list is independent caller input, frozen with each request.

Authored priority normalizes the closed interval [0,4]. The exact support tuple
is (`heldout-v2-caller-evidence`, `1`, `synthetic-support-grade-0-to-4`, true).
Combined-mixed scores it using rule `caller-grade`, closed interval [0,4]. The
exact auxiliary tuple is (`heldout-v2-auxiliary-evidence`, `1`,
`synthetic-unrelated-magnitude`, true), explicitly ignored everywhere. Ignored
numeric values still satisfy the finite-number schema; they have no configured
normalization range or contribution. Different provider/version/semantics/
direction tuples are unsupported, never silently zeroed. Grades are synthetic
caller assertions, not probabilities or calibrated retrieval scores.

## Exact preregistered matrix

Exactly **60 requests**, `ev2-001` through `ev2-060`: five profiles × six strata ×
two replicas. Profile order is the table above; stratum order is the table below;
replica 0 precedes 1. Each profile has 12 requests; each stratum has 10. Replica
0 always has 160 available input tokens (260 total, 100 reserved output);
replica 1 has 1,000 available (1,100 total, 100 reserved). Thus 30 tight and 30
generous requests. These budgets are fixed before any content tokenization.

| Stratum | Authoring coverage |
| --- | --- |
| focused | Direct useful context and irrelevant noise; missing optional signals under complete declarations, and explicit low truthful evidence |
| distributed | Complementary facts, including AND evidence requirements and exact-content alternatives; duplicate groups |
| density | Replica 0 nearly/all useful; replica 1 nearly/none useful |
| evidence-gaps | Missing useful and irrelevant signals under incomplete/curated declarations; deliberately false complete grades in the complete profile |
| temporal-records | Useful older/history content, explicit applicability exclusions and duplicate alternatives |
| guardrails | Two preregistered contract negatives per profile |

Mix text, markdown and conversation sources. Include repeated wrappers as well
as distinct block IDs with identical content, explicit caller-known mandatory
obligations, evaluator-required optional facts and critical optional facts.
Sources, queries, IDs, topics, evidence arrangements, annotations and specific
applicability situations must be newly authored after this protocol commit.
No literals from Phase 21C or D may be reused. Authoring must include a static
novelty audit against historical fixtures. These are synthetic, author-labeled
requests; profile comparisons describe balanced classes with different new
contents, not a randomized paired causal experiment.

## Labels and exact expected failures

Conditions are fixed by slot, never inferred from a result:

| Condition | All requests | Intended successes | Expected failures |
| --- | ---: | ---: | ---: |
| truthful-complete | 8 | 8 | 0 |
| truthful-incomplete | 30 | 23 | 7 |
| misleading-complete | 2 | 2 | 0 |
| permissive-curated | 10 | 10 | 0 |
| negative-contract | 10 | 0 | 10 |
| Total | 60 | 43 | 17 |

Complete profile evidence-gaps slots are misleading-complete. Its other
non-guardrail slots are truthful-complete. Curated non-guardrail slots are
permissive-curated. Other non-guardrail slots are truthful-incomplete, including
combined-mixed (complete authored plus incomplete retrieval evidence).

| IDs | Expected stage / unique issue code |
| --- | --- |
| ev2-011, ev2-012 | evidence-validation / retrieval_score_rule_not_found (unlisted tuple; wrong direction) |
| ev2-023 | evidence-validation / evidence_scope_mismatch |
| ev2-024, ev2-047 | candidate-validation / scope_mismatch |
| ev2-035 | request-validation / invalid_scoring_policy (missing completeness) |
| ev2-036 | request-validation / invalid_request (unknown future wrapper signal) |
| ev2-048 | filtering / required_applicability_conflict |
| ev2-059 | request-validation / invalid_scoring_policy (support rule/ignore overlap) |
| ev2-060 | filtering / missing_applicability_target |
| ev2-025, 026, 027, 028, 030, 031, 032 | filtering / incomplete_admission_evidence |

The last seven reject-policy slots intentionally need incomplete evidence to
justify an optional exclusion. The three intended reject-policy successes are
all-useful density replica 0 and both temporal-records slots: optional eligible
groups must meet the threshold, with low unusable context explicitly excluded
by applicability. Intended success counts per profile are 10/10/3/10/10;
expected failure counts are 2/2/9/2/2. Failures must match the exact stage and
set of unique issue codes. Multiple pointers for one code do not add failures.
An expected rejection contributes coverage, never a synthetic selection zero.
Any unexpected success or failure fails the experiment.

## Independent truth and preparation boundary

`authoring.json` stores caller fields and a separate annotations object.
Preparation materializes literal caller content, priority, retrieval, required
flags, source documents, order and exclusions before reading annotations.
Evaluator labels cannot change those fields. Required runtime flags need
separate caller rationales. Evaluator-required/critical facts need no runtime
flag, and must not automatically acquire one. Truth annotations name useful
and irrelevant exact-content units, intended applicability and duplicate
alternatives; facts carry useful/required/importance labels and OR-of-AND block
evidence groups. Queries and descriptions disambiguate usefulness. All inputs
and annotations are frozen, with independent hashes.

Static preparation validates strict request/policy/candidate schemas, numeric
ranges and exact scored/ignored compatibility, completeness configuration and
scope, provenance hashes/token counts, applicability scope/targets/conflicts,
annotation partition, fact references, duplicate equality and caller obligations.
It uses only request validation, candidate validation and evidence preflight;
its own applicability check resolves equality and declarations without choosing
a canonical winner. It cannot score, filter, deduplicate/select, allocate,
order or render. It never predicts the incomplete threshold rejection by
executing admission arithmetic. Tests forbid every selection-stage method
while preparing unrelated toy specimens and validating freeze records.

Protocol guards refuse CLI preparation before this file's committed introduction
and refuse regeneration after the committed manifest. Freeze guards require
baseline/compiler/history identity and exact protocol-file inventories and
bytes. No actual dataset content appears in this protocol commit. The toy test
specimens are development fixtures, not held-out evidence or authored cases.

## Metrics version 1

`ctxalloc-heldout-v2-metrics` version 1 is fixed in `protocol.ts`/`metrics.ts`.
Useful-block recall counts retained useful exact-content units / all useful
units; duplicate wrapper multiplicity cannot multiply truth. Facts are
preserved when any annotated evidence group has every named block included.
Useful-fact and critical-fact coverage count preserved / labeled facts.
Weighted required-fact coverage weights critical/major/minor by 3/2/1.

Admission precision counts useful applicable runtime-optional units admitted /
all admitted runtime-optional units. Admission recall counts those admitted /
all useful applicable runtime-optional units. Required group recall counts
runtime-required units included / all runtime-required units. Irrelevant
rejection counts irrelevant units not included / all irrelevant units; budget
exclusion and filtering both count, so it is not pure admission precision.

Every report includes raw numerator/denominator, micro (summed counts), macro
(mean of defined case ratios), defined-case counts, nearest-rank distributions
and leave-one-request-out micro ranges. Empty denominators are null, not zero
or perfect. These ranges are descriptive sensitivity, not confidence intervals.
Failures have no selection denominator; explicit outcome coverage guards against
silently dropping unintended failures.

For every success the existing `EvaluationHarness` computes its full rendered
wrapper baseline, including duplicates, with the fixed JSONL renderer and real
tokenizer. Report full tokens, final compiled rendered tokens, signed savings,
unclamped reduction ratio and distribution including nearest-rank median.
Zero full tokens produces null reduction. No hand-written renderer or character
estimate replaces the baseline. Both tokens include actual rendering overhead.

Report all requests overall and by profile, condition, stratum, budget and
profile × condition; additionally report primary and reduction-eligible subsets.
Counts expose wrappers, groups, admitted/uncertain/included/filtered/budget-excluded
groups, intended and matched failures, unexpected failures and successes.
Per-case records include missing useful/critical/required facts and false
admissions/exclusions. Traces and reports contain IDs, scores and hashes, never
raw source text or prompts. No latency or model quality is measured.

Three direct compiler executions per request supply two comparisons (120 total)
of the entire result or structured failure. Each actual success also receives
one harness execution whose compilation ID and context must agree. These
additional comparisons are reported separately. Fixed zero clock is labeled
NOT_MEASURED, not a performance result.

## Required gates version 1

`ctxalloc-heldout-v2-gates` version 1. All gates are required. Null mandatory
segment denominators make a gate NOT_EVALUATED; that cannot produce a PASS
verdict. No overall average can rescue a failing profile. Exact checks and
all failed observations are emitted in the report.

| Gate IDs | Requirement |
| --- | --- |
| outcomes | Exactly 60 requests, 43 successes, 17 matched failures; each of the 60 slot outcomes must match |
| runtime-required | Every defined successful case ratio = 1; at least one measured obligation |
| budget | Zero violations of final rendered available tokens |
| scope | Zero foreign inclusions; exactly two candidate-scope failures and one evidence-scope failure |
| accounting | Every defined provenance, wrapper, group, reason and trace reconciliation ratio = 1 |
| determinism | 120 direct comparisons, zero mismatches, zero additional harness disagreements |
| admission | Actual score, threshold, requiredness and positive-weight completeness imply the observed admission reason; reject never silently admits uncertainty |
| applicability | Final exclusion reason exactly follows caller declaration across the group |
| compatibility | Every ignored numeric wrapper is observed and contributes no scored retrieval evidence |
| completeness | Observation scope/configuration/declaration matches the frozen request |
| traceVersion | Every successful trace uses schema 4 |
| useful-blocks | Primary profile and condition micro AND macro >= 0.95; each defined primary case >= 0.8 |
| useful-facts | Same independent 0.95 segment and 0.8 case thresholds |
| critical-facts | Primary profile/condition micro AND macro = 1; every defined primary case = 1 |
| required-facts | Weighted required coverage: same independent = 1 segment and case thresholds |
| admission-recall | Primary profile/condition micro AND macro >= 0.95 |
| admission-precision | Primary profile micro AND macro >= 0.8 for complete/reject; >= 0.5 for admit/curated/combined |
| reduction | Eligible overall median >= 0.20; each eligible profile and condition median >= 0.15 |
| misleading-risk-disclosure | Exactly two successful misleading cases, contract measurement and reduction present; useful-block/fact, irrelevant-rejection and admission precision/recall denominators all positive |

Precision floors differ because explicit uncertainty preservation knowingly
admits some irrelevant groups; permissive curation has the same precision cost.
This is a preregistered caller-contract tradeoff, not calibration from outcomes.
All condition precision values remain visible even though the precision gate
uses profile-specific floors. Preservation, precision and compression gates are
independent: high savings can never compensate for lost critical facts.

Reduction eligibility is a fixed slot flag, corroborated by structural truth:
exclude every expected failure and every misleading-complete slot; include
complete-profile focused, distributed and density replica 1; include every
profile's intended-success distributed or temporal-records slots. Distributed
requires annotated exact-content alternatives; temporal requires explicitly
unusable irrelevant truth. Complete focused/density replica 1 requires irrelevant
truth. No all-useful density replica 0 is eligible. This gives 21 eligible
requests (complete 7, admit 4, reject 2, curated 4, combined 4). Eligibility is never selected by observed savings.

Misleading complete evidence belongs in every ordinary aggregate and its own
risk report. It is excluded only from primary effectiveness/reduction gates.
The separate required disclosure gate enforces visibility and denominators; it
has **no semantic-recovery or effectiveness minimum**. A deterministic compiler
has no alternative truth source with which to correct deliberately false but
valid caller grades. Such cases may be contract-correct and ineffective. Their
losses are product-risk evidence, not proof of a broken deterministic guarantee.
The contract correctness verdict still covers these cases. Passing disclosure
does not mean the risk is acceptable or selection is effective on false evidence.

## Irreversible execution and evidence

1. Commit this protocol, profiles, metrics, gates, preparation/guard/evaluator
   code and toy tests. No real held-out source content has been authored.
2. Author 60 new cases and separate truth; run schema/cross-field validation and
   the novelty audit only. Build existing frozen code. Prepare `v2/cases.json`
   then `v2/freeze.json`; commit authoring, cases and manifest together.
3. Record the manifest's committed introduction as `heldOutFreezeRevision`.
   Only then run `pnpm --silent validation:heldout:v2` for the first time. The
   guard checks protocol ancestry, distinct commits, original manifest bytes,
   protected source inventories/hashes, built JavaScript hashes and case
   input/annotation/policy hashes before the first compilation.
4. Preserve original stdout as `docs/evidence/phase21e-first-run.json` without
   reformatting. Record its SHA-256. Commit first-run evidence and the validation
   report. Repeats may verify identical evidence; they never replace first bytes.

The manifest contains exact slot matrix, expected-failure/condition maps,
versions and policy definitions, merged compiler revision, tokenizer/renderer,
metric/gate definitions, input/annotation/policy hashes and protected source
and built artifact hashes. Source protection includes new evaluator and tests,
all benchmark inputs, packages/apps, scripts, dependency/build configuration,
CI, this protocol and METRICS. Results documents are separate. The manifest
cannot hash itself; the guard pins its bytes to its original commit.

The CLI emits one versioned JSON report. Default exit 0 means the frozen
experiment executed, **not** that its gates passed. `--require-pass` exits 2 on
any non-PASS required gate. Integrity/execution-route errors exit 1 and cannot
be confused with observed expected failures. Subsequent commands compare the
new evidence hash with the preserved first report and, once committed, verify
that report's original bytes. Runtime head/Node provenance is outside the
stable evidence hash; the first report retains its original freeze-head value.

Any required gate failure produces exactly
`Held-out evidence-aware context selection: FAIL`; all required gates passing
produce `Held-out evidence-aware context selection: PASS`. A missing required
measurement cannot yield PASS. Compiler/policy/scoring/filtering/completeness,
thresholds, inputs, labels, budgets, expected failures, metrics and gates must
never change after the first real observation. A repair needs another
development phase and a wholly new held-out dataset.

## Historical separation and handoff

Keep v1 historical MVP, Phase 21B admission development, Phase 21C first frozen
held-out FAIL, Phase 21D evidence development and this second held-out report
separate. Phase 21A remains a diagnostic. Never pool their success rates or
rerun the original Phase 21C frozen executable under revised compiler semantics.
Use its unchanged historical integrity command and retained first bytes.

Final verification includes clean/frozen install/format/lint/type/full tests,
boundaries/aggregate check/clean build/declarations/CLI and API smoke, each
historical report and integrity check, second held-out reproduction, and
artifact/privacy/database audits. Open the requested PR without merging.
Validation documentation records exact commits, immutable first-report hash,
counts, all gates, segmented metrics, individual losses, misleading risk,
limitations, unchanged history and the recommended next phase. Full Product
Validation PASS is not available from this experiment.

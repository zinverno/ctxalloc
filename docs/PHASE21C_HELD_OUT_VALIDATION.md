# Phase 21C held-out context-selection validation

**Held-out context-selection validation: FAIL.** Six required gates fail, six pass, and reduction is NOT_EVALUATED. The first frozen run produced 22 successful compilations, four matched expected scope failures, and 22 unexpected scoring failures. This result is preserved permanently; no case, annotation, policy, compiler, evaluator, threshold or gate was changed after observation.

The dataset construction supplied numeric retrieval evidence to the authored-support and curated-history profiles, which define no retrieval normalization rules. Their 22 intended-success requests fail with `retrieval_score_rule_not_found`. This is an input/profile compatibility error in the authored experiment, not evidence that those profiles lose information during successful selection. It prevents the intended complete four-profile comparison. Structural schema checks and the toy tests did not catch this cross-field contract mismatch before freeze.

The two profiles that did compile also fail preservation: `ho19`, `ho20`, `ho31`, and `ho32` lose the evaluator-required critical fact. A conditional median reduction of 0.5035460992907801 across only 22 successful requests cannot rescue either failure. No positive selection-quality claim is available for authored-support or curated-history.

Overall historical **Product Validation remains FAIL**, engineering acceptance remains INCOMPLETE, and live answer quality remains NOT_EVALUATED. Phase 21C does not evaluate overall product acceptance; its report field `productValidation: NOT_EVALUATED` is not a replacement for the historical product verdict.

## Provenance and freeze order

| Artifact | Revision / identity |
| --- | --- |
| Merged Phase 21B baseline (PR #23) | `e24a42a71d414ce6de1e8c46de98094100cb7bc1` |
| Protocol committed before authoring | `36d468aee5e34d287df43aaf971cd25984b08453` |
| heldOutFreezeRevision | `2319e902de318af9598f4b6508649cfc69873319` |
| First execution repository head | `2319e902de318af9598f4b6508649cfc69873319` |
| Dataset | `ctxalloc-heldout-v1`, version `1`, split `held-out` |
| Compiler | `ctxalloc-heldout`, version `1`, schema `1`, max correction selections `64` |
| Tokenizer | `js-tiktoken:o200k_base`, version `1.0.21` |
| Local runtime | Node `v22.23.2`, pnpm `10.33.0` |
| Manifest SHA-256 | `sha256:36a0e5c13243991fe861d40b162a9aaf9eaeb839bb25b26f71c25014174baba3` |
| Deterministic evidence SHA-256 | `sha256:176c9642c61e97f44aa2e02776be2e038c6c1d5363f68e1c8723dd52c78037d5` |

The [protocol](PHASE21C_HELD_OUT_PROTOCOL.md) was committed before any held-out authoring. The subsequent freeze commit contains the [48 serialized requests and annotations](../benchmarks/heldout/v1/cases.json), [manifest](../benchmarks/heldout/v1/freeze.json), evaluator, 13 gate definitions, 18 tests, command and CI integration. The manifest hashes 155 protected input/source/configuration/test files and 123 built JavaScript artifacts, plus every individual input, annotation and complete per-request policy.

No held-out case reached compiler, scoring, filtering, allocation, deduplication or rendering before that freeze. Preparation used structural request validation, normalized content hashes and tokenizer counts; spies verify that preparation invokes no selection stage. Evaluator tests compiled unrelated toy requests only. The first real run followed a clean build at the exact freeze commit and successful integrity verification. Its [original report](evidence/phase21c-first-run.json) is added in this later results commit, without reformatting or editing it.

`pnpm --silent validation:heldout` verifies freeze ancestry, original manifest bytes, protected file lists/hashes, built artifact hashes and case/annotation/policy hashes before compilation. A descendant can run only with matching semantics. CI checks out full history for this verification. The first repeat was byte-identical even including runtime provenance. Subsequent comparisons exclude only the outer `runtimeProvenance` object (head and Node version); all other bytes represented by the serialized evidence must match. The fixed August reference time in requests is an input to deterministic behavior, not a claimed wall-clock execution date.

The preregistered default exit status is 0 for successful report production, including a FAIL verdict. `--require-pass` returns 2 for a valid FAIL/INCOMPLETE report; integrity or execution errors return 1. A passing CI job demonstrates reproducible measurement and regressions, not a passing context-selection gate.

## Dataset and annotations

Exactly **4 profiles × 6 strata × 2 distinct requests = 48**. Each cell contains one tight and one generous budget: 180 or 900 available input tokens, plus 100 reserved output tokens. Zero-based profile/stratum/replica parity determines the regime; budgets were not chosen from observed token savings. There are 24 requests per regime, 12 per profile, eight per stratum and 24 cells. Four preregistered negative requests (`ho12`, `ho24`, `ho36`, `ho48`) expect candidate-validation `scope_mismatch`, leaving 44 intended successes.

There are 204 candidate wrappers across text (68), Markdown (64) and conversation (72), with new topics, ids, source contents and independently arranged candidate orders. The 48 literal scenarios are retained in [authored.ts](../benchmarks/heldout/authored.ts); the serialized JSON is authoritative at execution. Novelty checks compare complete queries and block contents with the historical v1 and Phase 21B development literals. They do not prove statistical independence or semantic dissimilarity.

Runtime evidence, caller-known required flags and applicability declarations were authored separately from evaluator judgments. The complete runtime request is materialized before annotations are read. The dataset records 24 caller obligations, including obligations absent from evaluator required-id lists; evaluator-only critical obligations also remain runtime-optional. Required annotations are never converted to runtime flags. Intended duplicate-group dispositions are separate from caller declarations. Useful/non-useful units exhaust unique exact-content groups, repeated wrappers add no usefulness credit, and facts use explicit OR-of-AND evidence. Required-block recall retains exact-id semantics; critical facts carry weight 3, major 2 and minor 1.

Ambiguity resolutions and evidence-condition labels were written before freeze: 31 complete, four missing, four conflicting and nine curation-stress cases. The missing/conflicting stresses remain in every preregistered gate. Annotations are independent of compiler output, but were made by the same authoring process that knew the policy specifications and earlier phases. They are not independent human review, randomly sampled traffic, or a claim of 48 statistically independent observations.

## Fixed Phase 21B policies

All four complete policies are imported unchanged from the merged [Phase 21B definitions](../benchmarks/admission-development/profiles.ts). Policy ids are `admission-dev:<profile>`, scoring ids append `:score`, filtering ids append `:admission`; each base version is `1`. Scoring and base filtering schema versions are `1`. Applicability requests use the existing opt-in filtering schema `2`, version `1-applicability`, with frozen request-scope exclusions; their full policy hashes are in the manifest.

| Profile | Scoring contract | Admission |
| --- | --- | --- |
| authored-support | Authored [0,4], weight 1; no retrieval rule | minimum 0.5 |
| retrieval-support | Synthetic retrieval [0,4], weight 1, max aggregation | minimum 0.5 |
| combined-support | Authored plus synthetic retrieval, each [0,4], weight 1 | minimum 1 support unit |
| curated-history | Authored [0,4], weight 1; no retrieval rule | no numerical threshold |

Synthetic provider identity is `admission-development-evidence-grades`, version `1`, semantics `caller-support-grade-0-to-4`, higher-is-better. These grades are caller-owned support units, not probabilities or calibrated MiniSearch/BM25/cosine/embedding scores. No retrieval provider was called or calibrated.

## All preregistered gates

| Gate | Frozen criterion | Result | Evidence |
| --- | --- | --- | --- |
| failures | 4 expected matches; 0 unexpected failures; 44 successes | FAIL | 4 matches; 22 unexpected; 22 successes |
| required-blocks | Recall = 1 in every measured successful case | FAIL | ho19, ho20, ho31, ho32: 0 |
| required-facts | Weighted required coverage = 1 in every measured successful case | FAIL | ho19, ho20, ho31, ho32: 0 |
| critical-facts | Critical coverage = 1 in every measured successful case | FAIL | ho19, ho20, ho31, ho32: 0 |
| useful-preservation | Each profile block/fact micro AND macro ≥ 0.95; each case ≥ 0.80 | FAIL | Both measured profiles below 0.95; four cases at 0.50; two profiles unmeasured |
| admission-quality | Each profile precision micro AND macro ≥ 0.80; recall ≥ 0.95 | FAIL | Both measured profile recalls below 0.95; two profiles unmeasured |
| reduction | Overall median ≥ 0.20; EACH profile median ≥ 0.15 | NOT_EVALUATED | Two profiles lack any successful denominator; observed medians meet numeric floors |
| budget | 0 budget violations | PASS | 0 among 22 successful outputs |
| scope | 4/4 foreign detections; 0 cross-scope inclusions or successful foreign requests | PASS | 4/4; 0; 0 |
| accounting | All five completeness measures = 1 in every measured successful case | PASS | 44/44 provenance; 90/90 wrappers; 86/86 groups; 216/216 reasons; 22/22 reconciliation |
| determinism | 96 repeat comparisons, 0 mismatches; 0 additional disagreements | PASS | 96/96 repeats agree; 22/22 additional compilations agree |
| applicability | 0 contradictions with intended dispositions in successful cases | PASS | 0; positive applicability observed for ho23 and ho35 |
| runtime-required | Runtime-required-group recall = 1 in every measured successful case | PASS | 10/10 groups on successful requests |

FAIL takes precedence over missing evidence within a gate. Null observations are retained in the original report, not silently treated as success. Correctness PASS rows apply only to their stated measured outputs; they do not negate the 22 unexpected failures or establish coverage of the failed profiles.

## Preservation and admission

All tables below are **conditional on successful compilation**. Unexpected failures stay in failure/matrix counts but have no invented preservation or reduction values. `N/A` is a zero denominator, not zero recall or perfect recall. Cells show **numerator/denominator; micro/macro**, rounded to four decimals; the original JSON retains full precision, measured-case counts, distributions and leave-one-request-out ranges.

### Profile preservation

| Profile | Success / expected failure / unexpected | Required blocks | Useful units | Useful facts | Weighted required facts | Critical facts |
| --- | --- | --- | --- | --- | --- | --- |
| authored-support | 0 / 1 / 11 | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A |
| retrieval-support | 11 / 1 / 0 | 8/10; 0.8000/0.8000 | 21/23; 0.9130/0.9000 | 23/25; 0.9200/0.9000 | 36/42; 0.8571/0.8000 | 8/10; 0.8000/0.8000 |
| combined-support | 11 / 1 / 0 | 8/10; 0.8000/0.8000 | 21/23; 0.9130/0.9000 | 23/25; 0.9200/0.9000 | 36/42; 0.8571/0.8000 | 8/10; 0.8000/0.8000 |
| curated-history | 0 / 1 / 11 | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A | 0/0; N/A/N/A |

### Profile admission

| Profile | Optional precision | Optional recall | False admissions | False exclusions |
| --- | --- | --- | --- | --- |
| authored-support | 0/0; N/A/N/A | 0/0; N/A/N/A | 0 | 0 |
| retrieval-support | 16/17; 0.9412/0.9444 | 16/18; 0.8889/0.8500 | 1 | 2 |
| combined-support | 16/17; 0.9412/0.9444 | 16/18; 0.8889/0.8500 | 1 | 2 |
| curated-history | 0/0; N/A/N/A | 0/0; N/A/N/A | 0 | 0 |

### Stratum preservation

| Stratum | Success / expected failure / unexpected | Required blocks | Useful units | Useful facts | Weighted required facts | Critical facts |
| --- | --- | --- | --- | --- | --- | --- |
| direct-noise | 4 / 0 / 4 | 4/4; 1.0000/1.0000 | 8/8; 1.0000/1.0000 | 8/8; 1.0000/1.0000 | 12/12; 1.0000/1.0000 | 4/4; 1.0000/1.0000 |
| complementary | 4 / 0 / 4 | 4/4; 1.0000/1.0000 | 12/12; 1.0000/1.0000 | 16/16; 1.0000/1.0000 | 36/36; 1.0000/1.0000 | 4/4; 1.0000/1.0000 |
| all-none | 4 / 0 / 4 | 2/2; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 2/2; 1.0000/1.0000 |
| missing-conflicting | 4 / 0 / 4 | 0/4; 0.0000/0.0000 | 4/8; 0.5000/0.5000 | 4/8; 0.5000/0.5000 | 0/12; 0.0000/0.0000 | 0/4; 0.0000/0.0000 |
| older-history | 4 / 0 / 4 | 4/4; 1.0000/1.0000 | 8/8; 1.0000/1.0000 | 8/8; 1.0000/1.0000 | 12/12; 1.0000/1.0000 | 4/4; 1.0000/1.0000 |
| applicability-duplicates | 2 / 4 / 2 | 2/2; 1.0000/1.0000 | 4/4; 1.0000/1.0000 | 4/4; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 2/2; 1.0000/1.0000 |

### Stratum admission

| Stratum | Optional precision | Optional recall | False admissions | False exclusions |
| --- | --- | --- | --- | --- |
| direct-noise | 6/6; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 0 | 0 |
| complementary | 12/12; 1.0000/1.0000 | 12/12; 1.0000/1.0000 | 0 | 0 |
| all-none | 4/4; 1.0000/1.0000 | 4/4; 1.0000/1.0000 | 0 | 0 |
| missing-conflicting | 2/4; 0.5000/0.5000 | 2/6; 0.3333/0.2500 | 2 | 4 |
| older-history | 6/6; 1.0000/1.0000 | 6/6; 1.0000/1.0000 | 0 | 0 |
| applicability-duplicates | 2/2; 1.0000/1.0000 | 2/2; 1.0000/1.0000 | 0 | 0 |

### Budget preservation

| Budget | Success / expected failure / unexpected | Required blocks | Useful units | Useful facts | Weighted required facts | Critical facts |
| --- | --- | --- | --- | --- | --- | --- |
| tight | 11 / 2 / 11 | 8/10; 0.8000/0.8000 | 21/23; 0.9130/0.9000 | 23/25; 0.9200/0.9000 | 36/42; 0.8571/0.8000 | 8/10; 0.8000/0.8000 |
| generous | 11 / 2 / 11 | 8/10; 0.8000/0.8000 | 21/23; 0.9130/0.9000 | 23/25; 0.9200/0.9000 | 36/42; 0.8571/0.8000 | 8/10; 0.8000/0.8000 |

### Budget admission

| Budget | Optional precision | Optional recall | False admissions | False exclusions |
| --- | --- | --- | --- | --- |
| tight | 16/17; 0.9412/0.9444 | 16/18; 0.8889/0.8500 | 1 | 2 |
| generous | 16/17; 0.9412/0.9444 | 16/18; 0.8889/0.8500 | 1 | 2 |

### Overall successful-output measurements

| Metric | Numerator / denominator; micro / macro | Measured cases |
| --- | --- | --- |
| requiredBlockRecall | 16/20; 0.8000/0.8000 | 20 |
| usefulBlockRecall | 42/46; 0.9130/0.9000 | 20 |
| usefulFactCoverage | 46/50; 0.9200/0.9000 | 20 |
| weightedRequiredFactCoverage | 72/84; 0.8571/0.8000 | 20 |
| criticalFactCoverage | 16/20; 0.8000/0.8000 | 20 |
| optionalAdmissionPrecision | 32/34; 0.9412/0.9444 | 18 |
| optionalAdmissionRecall | 32/36; 0.8889/0.8500 | 20 |
| runtimeRequiredGroupRecall | 10/10; 1.0000/1.0000 | 10 |

## Reduction and outliers

Full context uses the existing harness JSONL renderer and preserves every original wrapper, including duplicates. Candidate content tokens are a distinct quantity. Saved tokens equal full rendered minus compiled rendered tokens; the ratio is unclamped. The median is nearest-rank p50. Both tight and generous regimes produced 11 successful requests, two expected failures and 11 unexpected failures.

| Segment | Successful cases | Candidate content tokens | Full rendered → compiled | Saved | Micro / macro reduction | Median |
| --- | --- | --- | --- | --- | --- | --- |
| overall | 22 | 1084 | 3216 → 1575 | 1641 | 0.5103 / 0.5022 | 0.5035 |
| authored-support | 0 | 0 | 0 → 0 | 0 | N/A / N/A | N/A |
| retrieval-support | 11 | 533 | 1599 → 783 | 816 | 0.5103 / 0.5024 | 0.5172 |
| combined-support | 11 | 551 | 1617 → 792 | 825 | 0.5102 / 0.5019 | 0.5035 |
| curated-history | 0 | 0 | 0 → 0 | 0 | N/A / N/A | N/A |
| direct-noise | 4 | 229 | 703 → 281 | 422 | 0.6003 / 0.6004 | 0.6000 |
| complementary | 4 | 188 | 566 → 428 | 138 | 0.2438 / 0.2438 | 0.2429 |
| all-none | 4 | 149 | 433 → 215 | 218 | 0.5035 / 0.5000 | 0.0000 |
| missing-conflicting | 4 | 171 | 503 → 210 | 293 | 0.5825 / 0.5939 | 0.5172 |
| older-history | 4 | 206 | 584 → 295 | 289 | 0.4949 / 0.4949 | 0.4932 |
| applicability-duplicates | 2 | 141 | 427 → 146 | 281 | 0.6581 / 0.6580 | 0.6570 |
| tight | 11 | 533 | 1599 → 784 | 815 | 0.5097 / 0.5015 | 0.5035 |
| generous | 11 | 551 | 1617 → 791 | 826 | 0.5108 / 0.5029 | 0.5172 |

The two all-useful successful requests correctly have zero reduction: `ho17` is 107→107 tokens and `ho29` is 108→108, with complete useful/required preservation. The none-useful requests `ho18` and `ho30` each return 109→0; useful-recall and admission-precision denominators are absent, not automatically credited as 1. Combining these legitimate extremes produces an all-none median of 0 under the frozen nearest-rank convention.

No successful-case group was excluded by budget allocation. Successful traces contain 10 required inclusions, 34 optional inclusions, 38 score-filtered groups, two superseded groups and two inapplicable groups. Thus the observed losses occur at admission, and this small-content corpus supplies limited evidence about allocation under severe budget pressure even though budget assignment is balanced.

The 0.5172 median reduction in missing/conflicting cases coexists with zero required/critical preservation. High reduction there includes lost useful content and is not a success. Positive applicability and deduplication produce roughly 0.658 median reduction only in the two observed positive cases. Neither pattern repairs missing outcomes for the other profiles.

## Exact failures and attribution

All unexpected failures occur at scoring with `retrieval_score_rule_not_found`:

- authored-support: `ho01`, `ho02`, `ho03`, `ho04`, `ho05`, `ho06`, `ho07`, `ho08`, `ho09`, `ho10`, `ho11`;
- curated-history: `ho37`, `ho38`, `ho39`, `ho40`, `ho41`, `ho42`, `ho43`, `ho44`, `ho45`, `ho46`, `ho47`.

These span all six strata in each affected profile. The unchanged scorer explicitly validates every supplied numeric retrieval measurement even when a policy has no retrieval component ([candidate-scorer.ts](../packages/compiler/src/candidate-scorer.ts), DEC-032). Supplying such evidence does not authorize silently ignoring it. The authored dataset/profile mismatch must be treated as a failed experiment construction. It is not retrospectively an expected failure and is not a reason to weaken the compiler contract.

Four successfully compiled cases fail required-block, weighted-required-fact, critical-fact and useful-preservation gates:

| Case / topic | Profile / regime | Missing required critical fact | Observed admission failure | Rendered tokens |
| --- | --- | --- | --- | --- |
| ho19 / botanical dye swatches | retrieval-support / tight | ho19-fact-a; ho19-a | Missing grade yields score 0 below 0.5 | 109 → 36 |
| ho20 / railway switchboard | retrieval-support / generous | ho20-fact-a; ho20-a | Useful score 0.25 below 0.5; non-useful ho20-b admitted | 145 → 70 |
| ho31 / printmaking drying rack | combined-support / generous | ho31-fact-a; ho31-a | Missing grades yield score 0 below 1 | 108 → 34 |
| ho32 / choir archive folder | combined-support / tight | ho32-fact-a; ho32-a | Useful score 0.75 below 1; non-useful ho32-b admitted | 141 → 70 |

Each case loses one of two useful units/facts (coverage 0.5). The lost `*-a` block is evaluator-required but runtime-optional. In missing-evidence requests, a separate caller-required `*-b` obligation is retained. Conflicting requests falsely admit `ho20-unit-b` and `ho32-unit-b`; all four falsely exclude their useful `*-unit-a`. The frozen annotations distinguish these obligations correctly. The result demonstrates dependence on incomplete or conflicting caller support evidence; it does not demonstrate a runtime-required handling bug or a budget eviction bug.

No annotations, grades, metadata, required flags, candidate arrangements, budgets or declarations were repaired or reinterpreted after these findings. The first report's four expected scope failures remain exactly `ho12`, `ho24`, `ho36`, and `ho48`.

## Uncertainty and limits

All 24 profile/stratum cells, profile/stratum/budget aggregates, per-case measurements, exact failure subjects, micro/macro denominators, min/max/mean/median/p10/p90 and descriptive leave-one-request-out sensitivity ranges are available in the machine-readable report. These are not confidence intervals. Correlated synthetic scenarios, only two requests per cell, same-process annotations, and complete loss of two profiles' successful-output denominators preclude population-level claims.

| Overall metric, successful requests only | Leave-one-request-out micro range |
| --- | --- |
| requiredBlockRecall | 0.7895–0.8421 |
| usefulBlockRecall | 0.9070–0.9318 |
| usefulFactCoverage | 0.9130–0.9375 |
| weightedRequiredFactCoverage | 0.8400–0.8889 |
| criticalFactCoverage | 0.7895–0.8421 |
| optionalAdmissionPrecision | 0.9355–0.9688 |
| optionalAdmissionRecall | 0.8788–0.9143 |
| runtimeRequiredGroupRecall | 1.0000–1.0000 |

The overall successful-request median-reduction sensitivity range is 0.5035460992907801–0.5172413793103449. In the all-none stratum it is 0–1, illustrating how little four observed requests can establish. Stability of a conditional aggregate does not replace missing profile evidence.

Timing is explicitly NOT_MEASURED. The harness uses a constant clock and omits latency fields; zeros are not reported as performance measurements. Model execution is disabled. No live/paid LLM, mock answer-quality substitute, Docker runtime exercise, provider calibration or source-instruction escape measurement was performed.

## Separate historical evidence

`ctxalloc-eval-v1` remains historical MVP evidence; the Phase 21B corpus remains policy-development evidence; `ctxalloc-heldout-v1` is this separately frozen failed validation experiment. Their aggregates are never pooled.

All 23 historical v1 gates, split counts/aggregates and individual case evidence except observed latency match merged Phase 21B. Validation cases remain 79→79, 520→120 and 100→100 tokens; median reduction is 0 (FAIL), long-context reduction is 0.7692307692307693, required-block recall and weighted/critical fact coverage are 1. Thirteen cases include 11 successful compilations and two matched expected failures. Provenance is 27/27, wrapper accounting 38/38, groups 37/37, reasons 111/111, reconciliation 11/11, repeated comparisons 26/26, scope detection 1/1, with zero cross-scope inclusions, unexpected failures or budget violations. Engineering acceptance stays INCOMPLETE and Product Validation stays FAIL.

The Phase 21A diagnostic is byte-identical to its historical evidence (SHA-256 `bc4bb91e7e9b2a5b7152cf1cde902d4f7973478a5076b064a3cb47d14955bd1b`). Phase 21B development is byte-identical: 20/20 cases, 100/100 contract checks, 46 wrappers, 43 groups, 30 admitted, 28 included, nine score-filtered, one inapplicable, three superseded, two budget-excluded, runtime required groups 2/2 and zero budget violations (SHA-256 `123741582dc2c3d813f682c6107cbf2b3dd542533853a31522aa8d91e70227a0`). Compiler/application sources, existing evaluators, historical datasets, four policy definitions and lockfile are unchanged from the merged baseline.

## Validation and changed files

The baseline sequence passed 20 steps with 175 test files / 3,734 tests. Pre-freeze validation passed all 20 steps with 178 files / 3,752 tests in both standalone and aggregate runs. Eighteen meaningful tests were added in three files, covering toy formula behavior, duplicates, missing denominators, profile isolation, expected failure handling, privacy, uncommitted-manifest rejection, hash drift and non-compiling preparation. Eleven workspace boundaries/build projects, 75 public declarations, built CLI smoke and all 12 named built HTTP API checks pass.

The full final sequence passed all 21 steps: clean, frozen install, format, lint, typecheck, tests, boundaries, aggregate checks, no-dist checks, clean build, declarations, built CLI/API smoke, frozen acceptance, Phase 21A diagnostic, Phase 21B development, held-out validation, and diff/status audits. Both standalone and aggregate final tests pass 178 files / 3,752 tests. `--require-pass` returns 2 and emits the identical frozen FAIL report. Exact final results and artifact/repeat checks are recorded in [verification evidence](evidence/phase21c-verification.json). A report-production PASS is distinct from the frozen held-out FAIL. No tracked dist, credentials/private configuration or residual DB/WAL/SHM files are included.

The 23-file focused change adds `benchmarks/heldout/` (authoring, serialized inputs, freeze guard, observer, metrics, aggregates and gates), `tests/heldout/`, the protocol and this report, and two evidence JSON files. Root `package.json` exposes the command; `.github/workflows/ci.yml` adds full-history checkout and report execution. Public package APIs, compiler behavior and existing evaluation contracts remain unchanged. Invariant coverage reuses the existing budget, scope, provenance, determinism and complete-trace measurements rather than redefining them. The PR is for review against `main` and must remain unmerged.

## Recommended next phase

Start **Phase 21D: caller-contract compatibility and evidence completeness development** in a separate change. First add development-only request/profile compatibility checks that reject uncovered numeric retrieval evidence before dataset freeze; use new development examples for all four fixed profiles. Decide explicitly how callers represent incomplete/conflicting support and independently known obligations. Develop and test any evidence-contract or admission changes there, without translating evaluator answers into runtime required flags.

Preserve Phase 21C, including its construction error and FAIL, as historical evidence. Do not delete retrieval metadata here, add missing rules to these frozen policies, change required flags, relabel failures, lower gates or publish a repaired run as held-out. Once Phase 21D development contracts and tests are fixed, pre-register a **new Phase 21E protocol and newly authored held-out dataset**, with separate contents and output-blind annotations; freeze before compilation again.

A future real-provider phase needs provider-specific development data → calibration/profile freeze → separate provider-specific held-out data. Current retrieval adapters have no Phase 21C calibrated admission evidence. Live answer-quality evaluation, suite-level source-instruction escape measurement and Docker runtime validation remain separate unresolved work. None is promoted to PASS by this phase.

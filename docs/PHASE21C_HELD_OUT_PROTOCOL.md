# Phase 21C held-out context-selection protocol

Protocol identity: `ctxalloc-heldout-protocol`, version `1`.
Status: preregistered before case authoring and before any held-out compilation.
Baseline: merged PR #23, `e24a42a71d414ce6de1e8c46de98094100cb7bc1`.

## Question and interpretation

Do the fixed Phase 21B caller policies remove unnecessary context on new authored
workloads while retaining useful and required information? This is a bounded,
offline context-selection experiment. It is not live answer-quality evaluation,
a probability calibration, or evidence of universal performance.

The Phase 21B implementation, four profile contracts and historical evaluations
remain byte unchanged. No model calls, real-provider calibration, Docker work or
source-instruction escape measurement belongs to this phase. Overall Product
Validation must not become PASS from these results.

This protocol is committed before authoring workloads. A later freeze commit
must include the dataset, annotations, metric/gate definitions, evaluator code,
tests and a manifest. Only then may any compiler execute a held-out request.
The protocol commit is `protocolRevision`; the later manifest-containing commit
is `heldOutFreezeRevision`. Neither commit is rewritten after observation.

## Fixed policy contracts

Reuse the exact merged definitions in `benchmarks/admission-development/profiles.ts`:

| Profile | Scoring identity/version | Filtering identity/version | Admission |
| --- | --- | --- | --- |
| authored-support | admission-dev:authored-support:score / 1 | admission-dev:authored-support:admission / 1 | authored [0,4], weight 1, threshold 0.5 |
| retrieval-support | admission-dev:retrieval-support:score / 1 | admission-dev:retrieval-support:admission / 1 | synthetic retrieval [0,4], weight 1, threshold 0.5 |
| combined-support | admission-dev:combined-support:score / 1 | admission-dev:combined-support:admission / 1 | both preceding components, threshold 1 |
| curated-history | admission-dev:curated-history:score / 1 | admission-dev:curated-history:admission / 1 | authored ranking, no minimum |

Top-level identities are `admission-dev:<profile>` version `1`. Other slices are
`admission-dev:allocation`, `admission-dev:ordering`, `admission-dev:rendering`, all
version `1`, with the original greedy allocation, source/location ordering and
JSONL rendering. The manifest stores all four complete policies and their hashes.

The synthetic evidence owner remains `admission-development-evidence-grades`,
version `1`, semantics `caller-support-grade-0-to-4`, higher-is-better, maximum
aggregation. Its grades mean 0 no contribution, 1 background, 2 subtask support,
3 direct answer, 4 decisive support. They are not BM25/cosine probabilities.

Applicability cases use the existing Phase 21B opt-in transformation: filtering
schema 2, filtering policyVersion `1-applicability`, explicit scope and exclusions.
All numeric policy settings remain fixed. Each request's complete policy hash
also freezes its actual declarations. No natural-language claim activates policy.

## Dataset and fixed allocation

Dataset: `ctxalloc-heldout-v1`, version `1`, split `held-out` (project-level dataset
identity; the existing harness receives its compatible `validation` split).
Exactly 48 requests: four profiles × six strata × two independent requests.
Profile order is the table order. Stratum order is:

1. `direct-noise`: a direct answer with unrelated available context;
2. `complementary`: several useful facts needed together;
3. `all-none`: request 1 all useful, request 2 none useful;
4. `missing-conflicting`: request 1 missing evidence, request 2 conflicting evidence;
5. `older-history`: older useful history mixed with recent/background content;
6. `applicability-duplicates`: explicit dispositions and exact-content duplicates.

Use new topics, ids, queries, source contents and annotations for every request.
Text, Markdown and conversation sources are represented. Conceptual strata may
recur; copying or lightly renaming historical/development contents is prohibited.
Each request has its own scope/project and source identities. Candidate order is
authored independently; it is never rearranged after compiler observation.

Budgets are fixed now: **180 available input tokens (tight)** and **900 (generous)**,
with **100 reserved output tokens** in both regimes (total 280 or 1000). For
zero-based profile p, stratum s and replica r, use tight iff `(p+s+r)%2 == 0`.
Thus every profile/stratum cell contains one of each regime, 24 requests each
regime overall, six each regime per profile. No budget is fitted after execution.
Do not shorten useful content after a run to make a tight case fit.

Request 2 in `applicability-duplicates` is a negative scope request for each
profile: an otherwise structured duplicate batch contains a foreign-scope
candidate. Expected outcome is stage `candidate-validation`, issue `scope_mismatch`.
These **four expected failures** remain in the 48-case matrix and determinism/
scope/failure accounting, and are excluded from successful-output preservation,
admission and reduction denominators. There are **44 expected successes**, 22
per budget regime. Positive applicability requests exercise both declared
inapplicability and superseded groups while preserving usable content.

## Annotation ownership and ambiguity

Author input evidence separately from evaluator judgments. Scores describe the
caller's supplied evidence; annotations describe the author's intended task facts.
Neither annotation sets nor expected outcomes may be copied into compiler inputs.
Each request records, separately:

- exact evaluator-required block ids;
- useful and non-useful content units, each listing alternative duplicate member ids;
- useful/non-useful facts and OR-of-AND evidence block groups;
- fact importance (`critical`, `major`, `minor`) and whether the fact is required;
- caller-known runtime required obligations and their rationale;
- intended per-unit applicability (`applicable`, `inapplicable`, `superseded`);
- evidence condition (`complete`, `missing`, `conflicting`, or `curation-stress`);
- an ambiguity-resolution note written before freeze.

A useful content unit is one exact-content equivalence group, so legitimate
deduplication is not counted as useful information loss. Each distinct candidate
block id belongs to exactly one annotated unit. Repeated wrappers do not create
extra units. Unit members must have equal normalized content; useful/non-useful
labels are disjoint and complete. Every fact references existing ids, and every
useful fact's evidence belongs to useful applicable units. Critical facts are
required useful facts. Annotation contradictions reject the freeze.

Required-block recall keeps the existing exact-id definition. Facts use the
existing OR across alternative evidence groups / AND within a group rule, so
annotators can explicitly represent interchangeable duplicate evidence. Runtime
required flags are authored caller obligations before compilation, never derived
from evaluator-only required ids or facts. A separate runtime-required-group
measurement accounts for required obligations across duplicate members.

Missing evidence is not silently relabeled irrelevant. Restrictive profiles may
exclude useful ungraded content; curated-history may admit non-useful content.
Conflicting signals and imperfect curation are intentional evidence-stress strata,
identified before freeze. They test end-to-end dependence on caller evidence,
not the compiler's ability to invent semantic truth. Uniform preservation gates
still apply; if these stresses cause failure, report it and distinguish caller
contract limitations from compiler correctness bugs. Do not remove stress cases
from headline gates after observing results.

Annotations are independent of compiler output, not a claim of independent human
review: the authoring process has seen the policy specification and prior phases.
Record this limitation. Ambiguity must be resolved and explained before freeze;
post-run disagreement does not authorize changing a label or rerunning a tuned set.

## Metrics, units and aggregation (version 1)

Use the existing EvaluationHarness with model execution disabled and three
compilations per request for baseline tokens, required-block recall, weighted
required-fact coverage, critical-fact coverage and repeat comparisons. Reuse
`benchmarks/acceptance/correctness.ts` for provenance, wrapper/group/reason
accounting, trace reconciliation and scope detection. Do not change these owners.
An additional actual compilation provides the trace for admission and useful
unit measurements, and must agree with the harness compilation identity/usage.

For successful cases, let I be final included ids and A the eligible groups in
the filtering trace. Admission is measured **before budget allocation**. Optional
units exclude any unit with a runtime required member. A unit is included if any
member is in I, and admitted if a trace group with any member is eligible.

- Required-block recall = included annotated required ids / annotated required ids.
- Useful-block recall = included useful units / useful units (duplicate-aware unit).
- Useful-fact coverage = preserved useful facts / useful facts.
- Weighted required-fact coverage = preserved required weight / required weight,
  using unchanged importance weights critical 3, major 2, minor 1.
- Critical-fact coverage = preserved critical facts / critical facts.
- Optional admission precision = admitted useful optional units / admitted optional units.
- Optional admission recall = admitted useful optional units / useful optional units.
- False admission = admitted non-useful or inapplicable optional units.
- False exclusion = useful applicable optional units not admitted. Budget-only
  exclusions do not count here; they still affect final preservation.
- Runtime-required-group recall = included runtime-required units / such units.

A fact is preserved if all ids in at least one of its frozen evidence groups are
in I. Required facts are a separately marked subset of useful facts; non-useful
facts remain visible as annotations but receive no preservation credit.

A zero denominator is **null / NOT_APPLICABLE**, never an invented zero or one.
For each ratio report numerator/denominator, micro (sum numerators / sum
denominators), macro (mean of measured case ratios), valid-case count and the
case-ratio distribution. Distributions use the repository's nearest-rank
convention: sorted index `ceil(p*n)-1` clamped to the array; median is p50. Report
minimum, maximum, mean, median, p10 and p90. Expected failures contribute no
success-output denominator; unexpected failures fail their hard gate and are
never hidden as successes.

Full-context baseline tokens include every candidate wrapper in original order,
including duplicates, with the existing evaluation JSONL renderer and tokenizer.
Candidate content-token sum is reported separately. Saved tokens = full-context
rendered tokens minus compiled rendered tokens; reduction = saved/full tokens,
unclamped and null for a zero baseline. Report micro reduction, macro reduction,
median and distributions, per case and every aggregate. All-useful cases may
correctly have zero reduction; they have no individual positive-reduction gate.
The aggregate reduction gates cannot compensate for preservation failures.

Report overall, each profile (12 requests), each stratum (8), each budget regime
(24), and all 24 profile/stratum cells (2). Preserve counts for expected failures.
Never combine these aggregates with historical v1 or development results.

Uncertainty is descriptive: exact denominators, case ranges and leave-one-request-
out ranges for micro ratios and median reduction. These are sensitivity ranges,
not confidence intervals. The authored sample is not random; correlated facts,
12 requests/profile and two/cell cannot establish population-level probabilities.
No significance claim or universal threshold follows from a point estimate.

## Preregistered required gates (version 1)

Every gate below is required. PASS requires all observations for a gate to meet
its criterion; FAIL in any gate means **Held-out context-selection validation: FAIL**.
Insufficient expected evidence is NOT_EVALUATED and cannot yield PASS.

| ID | Exact criterion |
| --- | --- |
| failures | 4/4 expected stage/code matches; 0 unexpected failures; 44 successful compilations |
| required-blocks | Required-block recall = 1 in every successful case with required ids |
| required-facts | Weighted required-fact coverage = 1 in every successful case with required facts |
| critical-facts | Critical-fact coverage = 1 in every successful case with critical facts |
| useful-preservation | Useful-block recall and useful-fact coverage: micro AND macro >= 0.95 for EACH profile; each measured case ratio >= 0.80 |
| admission-quality | Optional admission precision: micro AND macro >= 0.80 for EACH profile; optional admission recall: micro AND macro >= 0.95 for EACH profile |
| reduction | Overall median rendered reduction >= 0.20; EACH profile median >= 0.15 over successful cases |
| budget | 0 compiled contexts exceeding available tokens |
| scope | 4/4 foreign-candidate scope detections; 0 cross-scope inclusions; 0 successful foreign-scope requests |
| accounting | Provenance, wrapper accounting, group decisions, reason coverage and trace reconciliation = 1 for every measured successful case |
| determinism | 0 mismatched repeats across all 48 requests (96 comparisons); 0 harness/additional-compilation disagreements |
| applicability | 0 successful-case groups with a disposition/reason contradicting frozen intended applicability |
| runtime-required | Runtime-required-group recall = 1 in every measured successful case |

Exact required/critical preservation follows their obligation semantics. Ordinary
useful context has a small 5% aggregate tolerance but a case floor, preventing
one profile or a severe case loss being hidden. Admission allows at most 20%
non-useful admitted units while retaining at least 95% of useful optional units;
these are narrow declared task tolerances, not statistical calibration. A 20%
overall / 15% per-profile median reduction requires material savings across this
mixed experiment, while all-useful cases remain legitimate zero-saving cases.
The zero-tolerance correctness gates follow existing compiler invariants.

## Freeze, first execution and permanence

Before freeze, structural validation, tokenizer counts, build/lint/type checks
and evaluator tests on separate toy inputs are allowed. No held-out request may
reach ContextCompiler, EvaluationHarness, diagnostic replay, scoring, filtering,
allocation or rendering stages. Tests must not import and execute held-out cases
before the freeze commit. The generator/manifest builder must not compile them.

The machine-readable manifest records dataset/matrix counts; per-input and
per-annotation SHA-256 hashes; four complete policies; exact metric/gate versions
and definitions; baseline/protocol revisions; compiler config; tokenizer id
`js-tiktoken:o200k_base` version `1.0.21`; and hashes covering dataset, evaluator,
reused compiler/policy/metric/tokenizer sources and build/dependency configuration.
Serialized per-case inputs are the executable dataset; authoring notes are not
runtime policy. Commit these artifacts together as the freeze commit.

The runner discovers the manifest-containing commit, records it as
`heldOutFreezeRevision`, proves ancestry and checks the frozen file hashes before
compiling. The first execution must use a clean build from that commit. Later
runs may use descendants only when executable inputs/semantics still match the
freeze; reports/docs may be added, but no policy/compiler/evaluator fixes may be
smuggled into a descendant. Any post-observation defect requires an honestly
invalid/failed report and a new phase, not an amended freeze.

`pnpm --silent validation:heldout` emits one versioned content-free report. As in
MVP acceptance, successful report production exits 0 even when a measured gate
fails; integrity/execution errors exit 1. Optional `--require-pass` exits 2 when a
valid report contains failed or incomplete required gates. CI checks reproducible
measurement, not an invented passing outcome. This exit policy is fixed before
results exist.

Record the complete first report in a later evidence commit, then repeat. The
comparison excludes only explicitly named `runtimeProvenance` (current repository
head and Node version); all case evidence, aggregates, gates and freeze provenance
must be byte-identical. No live latency is claimed: timing is NOT_MEASURED.
Record real first-run provenance separately from deterministic evidence. Reports
contain ids, hashes, counts, reasons and scores, never raw query/source/compiled
text, fact descriptions, private configuration or credentials.

After first execution, do not modify case contents, candidate arrangements,
annotations, facts, required flags, applicability, source types, budgets, profile
selection, thresholds, scoring, metric formulas, gates or compiler behavior.
A failed gate remains FAIL. Identify exact cases/profile/strata and recommend a
separate development phase followed by another newly frozen held-out dataset.
Even all-green context gates leave live answer quality NOT_EVALUATED and full
Product Validation incomplete/failing under the existing acceptance definition.

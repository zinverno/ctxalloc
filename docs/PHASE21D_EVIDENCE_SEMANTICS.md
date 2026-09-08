# Phase 21D — Explicit admission evidence semantics

Phase 21D is **DEVELOPMENT ONLY**. Its 27 scenarios pass their declared contract
checks; they do not establish product validation or a new held-out PASS.
Phase 21C remains a legitimate immutable **FAIL**. Historical v1 engineering
acceptance remains **INCOMPLETE**, product validation **FAIL**, and live answer
quality **NOT_EVALUATED**.

## Baseline and decision order

PR [#24](https://github.com/zinverno/ctxalloc/pull/24) merged on
2026-09-08 at 09:44:30 UTC. The fetched, clean actual merged `main` was
`087078538adad2f353812117c3fe1353a49cc505`; this branch was created from that
revision. Baseline validation passed all 20 applicable steps: 178 test files,
3,752 tests, 11 workspace/build projects, 75 public declarations, CLI smoke and
12 API smoke checks. The 23 historical v1 gates and all counts/aggregates/case
evidence except measured latency matched; Phase 21A diagnostic and Phase 21B
development output were byte-identical to their historical reports.

[DEC-045](DECISIONS.md#dec-045-explicit-signal-compatibility-and-scoped-evidence-completeness)
was committed before behavioral changes at
`4e030d4249e47093a3870427c77373281a328e36`. It records the inspected pipeline,
new contracts, version boundaries, alternatives and limits. The baseline
compiler's missing-rule behavior was intentional rejection of an unsupported
numeric retrieval configuration, not an implicit instruction to ignore metadata.
It was detected inside scoring, after deduplication. Authored and curated
profiles did not contain normalization rules for the supplied retrieval signal.

## The two causes and the impossible guarantee

Phase 21C's 22 unexpected `retrieval_score_rule_not_found` failures came from
intended-success authored-support and curated-history inputs supplying numeric
retrieval evidence that their fixed profiles could not consume. Adding an ignore
exception to those legacy profiles would silently change policy meaning; those
profiles, thresholds, cases and failure labels remain untouched.

In ho19/ho20/ho31/ho32, successful compilation lost evaluator-required critical
information: missing or falsely low support excluded useful runtime-optional
groups before allocation. Runtime-required groups remained protected. A larger
budget could not reverse admission exclusion. The scalar arithmetic alone did
not say whether evidence was absent, incomplete or a trustworthy negative.

A caller may also assert complete evidence and assign the useful block grade 0
and irrelevant block grade 4. The compiler has no independent semantic evidence
that those grades are false. It cannot recover truth from them. Explicit runtime
`required` obligations provide hard preservation or failure; calibrated retrieval
and independent signals can improve evidence quality, but neither is implemented
as a new truth source here. No LLM, special ho20/ho32 heuristic or threshold
retuning was added.

## Versioned compatibility

| Surface | Legacy | Opt-in Phase 21D |
| --- | --- | --- |
| Compilation request / policy envelope | 1 | 1; explicit nested versions |
| Candidate schema / signal fields | 1 | 1; unknown fields still rejected |
| Scoring policy | 1 | 2 |
| Filtering policy | 1 or 2 | 3; paired only with scoring 2 |
| Compilation trace | 2; 3 with applicability | 4 |
| Evidence observation inside score | absent | 1 |
| Stored trace envelope / SQLite | unchanged | unchanged |

A scoring schema 2 policy requires `compatibility.ignoredRetrievalContracts`,
including an explicit empty array when nothing is ignored. Every numeric
retrieval observation must match either a normalization rule or an explicitly
ignored `[providerId, providerVersion, semantics, higherIsBetter]` tuple. Duplicate
ignore entries and rule/ignore overlap reject. An ignore accepts only that exact
existing typed signal. Changing any tuple field rejects unless separately covered;
future signal fields, invalid types, NaN and Infinity still reject structurally.
Rank-only retrieval metadata retains its existing non-scoring meaning.

Ignored values contribute nothing to retrieval score, regardless of finite
magnitude. Traces retain provider/version/semantics/direction, block ID and raw
numeric value for audit. Duplicate wrappers remain observable with their original
multiplicity, but cannot multiply score. Other optional metadata components retain
their explicit configured/unconfigured meaning; provider normalization does not
appear by implication.

`CandidateScorer.validateEvidence(validatedBatch)` is a public deterministic,
non-mutating preflight: it checks scoped declarations, exact retrieval coverage
and configured raw-value ranges without calculating scores. `ContextCompiler`
runs it after full candidate scope/provenance validation and before deduplication
under scoring 2. Stable `retrieval_score_rule_not_found`,
`retrieval_score_out_of_range`, `authored_priority_out_of_range` and
`evidence_scope_mismatch` codes identify failures at `evidence-validation`.
Direct scoring checks it too. Legacy compilation continues to detect missing
retrieval rules at `scoring`. HTTP maps the new structured client errors to fixed
400 responses without copying provider messages or source bodies.

## Completeness and uncertainty

The caller supplying the request declares `scoring.evidence`:

```json
{
  "scope": { "tenantId": "example", "workspaceId": "observatory" },
  "completeness": [
    { "component": "authoredPriority", "state": "complete" },
    { "component": "retrieval", "state": "incomplete" }
  ]
}
```

Exactly one declaration is required for each configured component, and none for
unconfigured components. Supported components are retrieval, authored priority,
source priority, category priority and recency. `incomplete` includes partial and
unknown coverage; there is no inferred default. The declaration is request-scoped
and component-wide across all candidates; retrieval completeness covers all its
configured provider rules. Per-provider/per-candidate completeness and automatic
fallback profiles were deferred to keep the contract small.

| Observation | Meaning for the new contract |
| --- | --- |
| Absent signal, complete component | Caller certifies coverage; configured missing-value/zero arithmetic is allowed to justify threshold exclusion |
| Explicit zero/low, complete component | Present evidence may justify threshold exclusion; it is not objective irrelevance |
| Absent or low, incomplete positive-weight component | Scalar score is still calculated, but below-threshold exclusion invokes explicit uncertainty behavior |
| Unsupported numeric contract | Reject before scoring unless exactly ignored |
| Ignored observation | Present and audited; supplies no scoring contribution |
| Incomplete zero-weight component | Observable; cannot affect exclusion justification |

`filtering.schemaVersion: 3` requires `onIncompleteEvidence: "admit"` or `"reject"`.
Applicability resolves independently first, including contradictions with required
groups. Required groups bypass numeric admission. For remaining optional groups:

1. No threshold or a met threshold gives ordinary eligibility.
2. Below threshold with all positive-weight components complete gives ordinary
   `FILTERED_SCORE_BELOW_MINIMUM`.
3. Below threshold with any incomplete positive-weight component either yields
   `ELIGIBLE_INCOMPLETE_EVIDENCE` with the component list, or rejects the complete
   compilation with `incomplete_admission_evidence`, as the caller selected.

Admission under uncertainty leaves content optional. Allocation and exact rendered
budget settlement may still exclude it. There is no hidden global fail-open,
fail-closed, fallback or promotion to required. Natural language, metadata, ranks,
provider names, batch size and duplicate counts cannot declare completeness.
Foreign candidates fail before evidence preflight; foreign declarations fail
scope equality. No declaration influences another request's scope.

## Profiles and diagnostics

The nine new `evidence-dev:*` profile families have policy version `1`, distinct
score/admission IDs, schema 2 scoring and schema 3 filtering. Their definitions
are in [profiles.ts](../benchmarks/evidence-development/profiles.ts).

| Family suffix | Configured completeness | Ignore auxiliary contract | Threshold | Incomplete behavior |
| --- | --- | --- | --- | --- |
| authored-complete | authored complete | no | .5 | admit |
| authored-complete-ignore | authored complete | yes | .5 | admit |
| retrieval-complete | retrieval complete | no | .5 | admit |
| combined-complete-ignore | both complete | yes | 1 | admit |
| authored-incomplete-admit | authored incomplete | no | .5 | admit |
| authored-incomplete-reject | authored incomplete | no | .5 | reject |
| combined-mixed-admit | authored complete, retrieval incomplete | no | 1 | admit |
| authored-incomplete-ignore | authored incomplete | yes | .5 | admit |
| curated-incomplete-ignore | authored incomplete | yes | none | admit |

Configured grades use synthetic caller-owned 0–4 scales, weight 1 and the same
support-unit interpretation as Phase 21B: .5 requires grade 2; combined 1 requires
a support unit across components. These are explicit development examples, not
calibrated providers, a kernel registry or recommended universal thresholds.
Applicability exclusions and exact scope are per-request declarations. Changing
a family's scoring or admission meaning requires a new policy version.

Each trace 4 group records all five component configuration/presence/completeness
observations, ignored numeric evidence, the unchanged scalar score and admission
reason. Presence describes candidate metadata independently of configuration;
for example an ignored retrieval score can be present but unused. The settled
trace's decision overlay records final inclusion, exclusion or filtering. Raw
queries, source content and truth descriptions are not copied into the report.
The reader retains its existing strict shape/version validation, without claiming
to verify arithmetic coherence or semantic truth of arbitrary stored records.

## Development results

The new [corpus](../benchmarks/evidence-development/cases.ts) deliberately exercises
known failure modes. It uses synthetic observatory content and explicit independent
useful/irrelevant unit labels. It is not representative sampling or held-out
validation. Repeated wrappers count once per truth unit; labels never become
runtime required flags automatically.

- ed01–ed07: authored-only, retrieval-only, incompatible authored/retrieval,
  explicit ignore on the same evidence, unknown signal rejection, mixed evidence,
  required content with ignored evidence.
- ed08–ed18: complete absence, incomplete useful/irrelevant absence, explicit low
  complete/incomplete evidence, mixed completeness, generous/tight uncertainty,
  required content under reject, applicability and duplicate wrappers.
- ed19–ed21: falsely low useful, falsely high irrelevant, and both together.
- ed22–ed27: explicit incomplete rejection, permissive curation, foreign candidate,
  foreign completeness, required/applicability conflict and ignored magnitude
  under incompleteness with mixed source types.

All **255 contract checks pass**: 27 cases, 39 input wrappers, 21 successful compilations and six
expected failures, with no unexpected outcome. Successful traces account for
33 wrappers and 30 groups: 22 admitted (10 under uncertainty), 21 finally included,
eight filtered and one budget-excluded. All four runtime-required groups are
included. The six expected failures have no selection output and are reported
separately from effectiveness.

| Successful-case segment | Useful preservation | Irrelevant rejection | Admission precision | Admission recall |
| --- | --- | --- | --- | --- |
| Overall, micro | 14/16 = 87.5% | 7/14 = 50% | 14/22 = 63.64% | 14/16 = 87.5% |
| Declared development evidence | 14/14 = 100% | 7/12 = 58.33% | 14/20 = 70% | 14/14 = 100% |
| Misleading complete evidence | 0/2 = 0% | 0/2 = 0% | 0/2 = 0% | 0/2 = 0% |

Overall macro precision is 67.65%; the other overall macro ratios equal their
micro values here. Undefined ratios are null, with applicable-case counts.
The report includes exact counts and definitions. Admitting uncertainty preserves
useful missing evidence but also admits irrelevant context; ed10 makes that cost
visible. ed15 admits uncertainty yet excludes an optional group under the tight
budget. ed19–ed21 are contract-correct and ineffective: the compiler cannot infer
that the complete caller grades are false. These effectiveness losses are not
relabelled compiler correctness failures or hidden by changing truth labels.

## Permanent Phase 21C integrity

`pnpm validation:heldout:historical` compares all 21 immutable working artifacts
against merged baseline `0870785`, verifies all 155 original semantic source hashes
against that baseline tree, recomputes the 48 input/annotation/policy hash triples
and the original evidence hash, and checks pinned manifest/report bytes. The
123 original built-JavaScript hashes remain historical provenance; this command
does not compare them to changed Phase 21D binaries or execute the old experiment.
The original protocol and freeze commits were squash-merged; current ancestry
cannot be presented as the original pre-freeze execution history.

- Protocol revision: `36d468aee5e34d287df43aaf971cd25984b08453`.
- Original freeze: `2319e902de318af9598f4b6508649cfc69873319`.
- Manifest SHA-256: `36a0e5c13243991fe861d40b162a9aaf9eaeb839bb25b26f71c25014174baba3`.
- Original first-report SHA-256: `3144a9f8c505f46c45e142dccf1da24feef149a38ed280d630910aa39945a4e1`.
- Original evidence hash: `sha256:176c9642c61e97f44aa2e02776be2e038c6c1d5363f68e1c8723dd52c78037d5`.

The stored experiment still has 48 cases, 22 successful compilations, four expected
scope failures and 22 unexpected compatibility failures. Six gates FAIL, six PASS
and reduction is NOT_EVALUATED. The failed gates include required/critical/useful
preservation and admission quality. See the immutable
[Phase 21C report](PHASE21C_HELD_OUT_VALIDATION.md). Integrity PASS preserves this
FAIL; it is not a re-execution or a new validation result. The old
`validation:heldout` command and its guard remain unchanged for original frozen
execution provenance; CI now uses the historical command on changed descendants.

## Migration and rollback

Adoption is explicit: select new policy IDs/versions, supply scoring 2 compatibility
and scoped completeness, and pair filtering 3 with an explicit incomplete action.
Do not add evidence fields to legacy policies or rename an old profile in place.
The complete canonical request fingerprint includes all new declarations; changing
them changes compilation identity. Original legacy requests retain their identities.

Deploy the reader accepting trace 2/3/4 before enabling new writers. Existing
records remain unchanged; no SQLite or stored-envelope migration is needed. Old
readers safely reject trace 4 as unsupported, so rollback must disable new-policy
writes and either keep a reader capable of 4 or accept explicit unsupported-record
errors. Do not downgrade the trace version number, strip evidence fields or rewrite
old records. Legacy scoring 1 plus filtering 1/2 remain available for caller-led
rollback; restoring those semantics is a policy choice, not automatic fallback.

## Validation and reproducibility

Run `pnpm clean`, frozen install and `pnpm check` without generated dist, then
`pnpm build`, declarations and CLI/API smokes. Run historical `acceptance:mvp`,
`diagnose:selection`, `development:admission`, the new
`validation:heldout:historical` and `development:evidence` separately.

Final local validation passed all 22 steps: format, lint, typecheck, complete
suite and aggregate check, boundaries, clean build, declarations, smokes and each
separate evidence command. Both full suite runs passed **181 files / 3,790 tests**
(38 new tests in three new files). Checks covered **11 workspace/build projects**,
**76 public declarations**, CLI smoke and **12 API smoke checks**. No dist appeared
during no-emit checks. Artifact/privacy audits found zero tracked dist/scratch,
residual database files, credential patterns or raw query/block bodies in the
new report. No dependency or lockfile changed.

All 23 historical v1 gates and its counts/aggregates/case evidence except measured
latency remain equal to the merged baseline. Phase 21A diagnostic and Phase 21B
development reports are byte-identical; Phase 21B retains 20 passing cases and
100 passing contract checks. Clean-build Phase 21D and historical-integrity reports
are byte-identical to their committed development/integrity artifacts.

The final validation evidence is recorded in
[phase21d-verification.json](evidence/phase21d-verification.json), with the
[development report](evidence/phase21d-development.json) and
[historical integrity report](evidence/phase21d-history.json). These are development
and integrity artifacts; original Phase 21C reports are not regenerated.

## Phase 21E proposal — no dataset authored here

Before authoring, commit and freeze the new compiler revision, tokenizer/renderer,
policy IDs and versions, exact supported/ignored signal tuples, component
completeness meaning, incomplete admit/reject behavior, budgets, metrics and gates.
Use a completely new unseen dataset and separate protocol/freeze/first-run commits;
do not reuse these observatory fixtures or Phase 21C requests. The authoring split
must prevent outcomes from influencing policy development after freeze.

Propose a balanced matrix crossing restrictive complete, restrictive incomplete
admit/reject, and permissive profiles with tight/generous budgets. Include compatible
and intentionally unsupported evidence, truthful complete and incomplete coverage,
misleading complete grades, mixed source types, applicability, duplicates and scope
failures. Set expected compatibility, scope and incomplete-rejection failures
before running. Freeze exact case counts and minimum segment coverage in the new
protocol before any case authoring; this proposal supplies no hidden cases.

Freeze contract gates at exact expected outcomes, 100% runtime-required preservation
on successful valid compilations, zero budget/cross-scope violations, complete trace
accounting and exact repeat determinism. Freeze useful/critical preservation,
admission precision/recall and rendered-token reduction gates independently by
profile and evidence condition. Predeclare denominator handling and which failures
are expected; unexpected failures must fail coverage rather than disappear from
successful-output averages. Misleading evidence remains visible as effectiveness
risk; do not set an impossible semantic-recovery correctness gate. Product claims
need evidence beyond this development corpus, including separately measured live
answer quality where required by the existing product gates.

# Phase 21B — Explicit admission and applicability semantics

## Verified baseline

PR #22 is merged into actual main at
`c45c73739ac1305a8e83edcbbd743637fee3a245`. Branch
`codex/phase-21b-admission-semantics` starts there with a clean working tree.
Before implementation, clean/frozen install, full tests (173 files / 3682 tests),
build, deterministic MVP acceptance and the Phase 21A diagnostic passed execution.
The diagnostic reproduces the generated Phase 21A reference. Product validation
is FAIL, engineering acceptance INCOMPLETE: validation reductions remain 0,
0.7692307692307693, 0; median 0. This phase does not attempt to make v1 pass.

## Design recorded before implementation

[DEC-044](DECISIONS.md#dec-044-separate-caller-admission-from-scoped-applicability-declarations)
defines the contract, migration, required interaction and explicit non-goals.

- Ranking means one eligible candidate is preferred to another.
- Admission means the caller's stated utility criterion has been met sufficiently
  to participate in allocation. It does not guarantee inclusion or answer quality.
- Applicability is a separate caller assertion that content must not be used for
  this request, regardless of score or spare budget.

No universal probabilistic interpretation or global threshold is justified. The
existing typed/versioned `CompilationPolicy` already binds the scoring and
filtering slices. Callers retain explicit `minimumTotalScore` control, including
permissive omission. Required blocks bypass score admission; annotations such as
evaluation `requiredBlockIds` are never translated into runtime required flags.

The narrow implemented target is a scoped group-wide exclusion declaration, not
a general supersession graph. A declaration may identify any group member, with
reason `inapplicable` or `superseded`. Conflicting reasons or required members
fail closed; missing targets and foreign scopes reject. Self/edge/cycle fields
are unsupported and rejected structurally. A superseded disposition promises no
replacement: the caller must explicitly require any necessary replacement.

## Development methodology and score ownership

The new admission corpus is DEVELOPMENT-ONLY and independent of `ctxalloc-eval-v1`.
It uses new authored topics, contents and expectations. It imports no frozen v1
fixture, annotation or policy. No development result is held-out product
validation, empirical probability calibration or a live answer-quality result.

The caller's support rubric is specified before constructing scenarios: 0 means
no identified contribution, 1 background only, 2 supports a requested subtask,
3 directly answers, 4 decisive support. The authored-support profile maps authored
priority [0,4] with weight 1 and admits grade >=2: threshold 0.5. The synthetic
retrieval-support profile owns an explicit evidence-grade provider contract on
[0,4] with the same boundary. These are different input owners, not an assumed
shared meaning of arbitrary retrieval scores.

The combined profile requires a total of 1 support unit: one grade-4 component
or two grade-2 components qualifies. Duplicate evidence aggregates by maximum per
component using the existing scorer, so repeating wrappers cannot earn admission.
Missing numeric evidence adds no support under these explicitly restrictive
profiles; that is absence of the caller's required evidence, not proof of
irrelevance. Useful context lacking retrieval evidence can be supported by
explicit authored evidence or protected by a required obligation. The separate
curated-history profile deliberately admits absent/low numeric evidence because
the caller curated the candidate batch. No recency decay discards useful history.

The thresholds follow the declared rubric algebra (2/4 and 1 support unit), not
a fit to v1 answers or a claim of optimality. No single threshold is recommended
across these contracts. A real provider needs independent contract-specific
calibration and held-out evaluation before adopting a restrictive profile.

## Caller configuration and compatibility

The four development profiles are complete `CompilationPolicy` values produced
by the existing validator in
[profiles.ts](../benchmarks/admission-development/profiles.ts). Their scoring and
filtering slices have explicit identities and versions. There is no new profile
registry, global default, or inference from a provider's rank. Do not copy these
cutoffs to a different normalization or provider contract. In particular the
synthetic evidence-grade provider is not the shipped MiniSearch/BM25 adapter.

Library callers pass a policy in `CompilationRequest.policy`; CLI request files
and HTTP compile bodies already expose the same policy slot. They do not need a
new endpoint or source metadata convention. Under the authored-support [0,4]
profile, this explicit filtering slice additionally declares one group unusable:

```json
{
  "schemaVersion": 2,
  "policyId": "caller:workshop-applicability",
  "policyVersion": "1",
  "minimumTotalScore": 0.5,
  "applicability": {
    "scope": { "tenantId": "development", "workspaceId": "workshop" },
    "exclusions": [{ "blockId": "retired", "reason": "superseded" }]
  }
}
```

The scope must equal the request's complete scope, including project when
present. `retired` must identify an actual candidate member; its exact-content
group is the unit excluded, not one source copy. Omit `minimumTotalScore` only
when intentionally configuring permissive admission. An empty exclusions array
is valid and asserts no inapplicability. Repeated target ids, unknown fields,
missing targets, conflicting reasons within a group, and required-group conflicts
reject rather than choose an interpretation. Exclusion resolution indexes each
member once and sorts declarations by code unit; no recursive graph traversal or
repeated scan of each duplicate group is needed.

A caller owns the applicability assertion for this invocation. Source locators,
headings, timestamps, retrieval metadata and natural-language claims do not
activate it. Foreign candidates fail full validation before filtering. Even
empty declarations under a foreign policy scope reject; unknown target ids
cannot reach outside the validated batch. The policy is not a source ACL or a
replacement for authentication. Required content bypasses numerical admission,
but a declaration contradicting it yields `required_applicability_conflict`.
Unrelated required groups retain existing impossible-budget failure semantics.

## Decisions, diagnostics and persistence

The filter retains the original score evidence, then records one group decision:

| Situation | Filtering reason | Final reason |
| --- | --- | --- |
| Required, no applicability conflict | ELIGIBLE_REQUIRED | INCLUDED_REQUIRED (or whole compilation fails) |
| Optional meets explicit admission / permissive policy | ELIGIBLE_POLICY | Existing allocation/render reason |
| Optional below threshold | FILTERED_SCORE_BELOW_MINIMUM | FILTERED_POLICY, with the exact filter operands retained |
| Explicitly inapplicable | FILTERED_INAPPLICABLE | FILTERED_INAPPLICABLE |
| Explicitly superseded | FILTERED_SUPERSEDED | FILTERED_SUPERSEDED |

Applicability decisions retain sorted `declaredBlockIds`; every original wrapper
remains in its group's provenance. There is no fabricated score comparison for
hard exclusions, and correction cannot restore a filtered group. Invalid
assertions produce structured `ContextCompilationError` at `filtering`, with a
specific issue code and no partial successful trace. Schema errors are rejected
earlier at request validation. The HTTP adapter maps the four defined applicability
failures to HTTP 400 at `compilation`, with fixed matching codes and messages;
unknown operational failures remain HTTP 500. The CLI preserves the compiler
issue code in its existing `compilation` error envelope. Neither exposes target
identifiers in these errors.

The Phase 21A reusable diagnostic now includes explicit applicability evidence
for new policies and emits diagnostic schema 2 for them. Legacy diagnostic
schema 1 output remains byte-identical. Raw query, source/block content,
compiled context and arbitrary metadata remain absent. Scope, identifiers,
hashes and declared target ids are audit evidence, not anonymized values.

Legacy filtering schema 1 continues emitting compilation trace schema 2.
Opt-in filtering schema 2 emits trace schema 3, including when its declarations
are empty. The persisted validator reads both exactly; it rejects new reasons
in a downgraded schema-2 record and rejects future unsupported versions. SQLite
still stores its existing version-1 envelope and integer trace-schema column;
there is no DB migration or rewriting of old rows. CLI/HTTP integration exercises
new and old traces in the same actual database and retrieves them after restart.

Deploy the new reader before enabling applicability policies. Older binaries
cannot read schema 3, so rollback must stop new policy use and retain a compatible
reader for existing schema-3 audit records. TypeScript consumers with exhaustive
filter/final reason switches must handle the two new reasons; existing runtime
policies need no migration. `supportedSchemaVersions` exposes `[2,3]`; the old
singular `supportedSchemaVersion` property remains the legacy value 2.

## Reproduction and interpretation

With Node 22 and the pinned pnpm:

```sh
pnpm clean
pnpm install --frozen-lockfile
pnpm build
pnpm --silent development:admission > development.json
pnpm --silent diagnose:selection > selection-v1.json
pnpm --silent acceptance:mvp > acceptance-v1.json
```

The development command emits actual compiler diagnostics for all 20 authored
scenarios, their independent expected admission/final sets, four complete
profiles, token usage and exact assertion counts. All failures exit nonzero;
uncaught compilation or argument errors use a fixed JSON error without source
text. Two repeated runs must be byte-identical. This is an offline diagnostic
with stage replay, not a performance measurement. CI runs it separately from
unchanged v1 acceptance.

The two pressure scenarios use 40 available tokens; their complete renders cost
54 and 55. The tight/generous pair compares 40 with 500 available tokens; the
equal-score case separately exercises a stable tie. This establishes budget pressure
in the new development corpus without changing any frozen v1 budget or treating
budget utilization as a target. The missing-evidence scenario intentionally
shows an unrated useful fact being filtered by a restrictive profile, beside its
preservation under the curated profile. Passing the contract checks does not
convert this tradeoff into a claim of universal useful-fact preservation.

## Measured development results

All 20 development cases pass their five contract checks: **100/100 checks**.
There are **46 wrappers / 43 groups**, **30 admitted groups**, **9 score-filtered**,
**1 inapplicable**, and **3 superseded**. Final output includes **28 groups**;
**2 admitted groups** are excluded by the budget. Both explicit required groups
are included (**2/2**), with **0 budget violations**. All 20 diagnostics include
replayed-stage reconciliation. The full command output is byte-identical across
two executions, with SHA-256 `123741582dc2c3d813f682c6107cbf2b3dd542533853a31522aa8d91e70227a0`.

These counts measure contract behavior. In particular, the missing-evidence
restrictive case still loses a useful unrated fact, and a superseded disposition
can leave no replacement. Neither is counted as evidence of answer sufficiency.

| Case | Caller profile | Wrappers/groups | Admitted | Included | Rendered/available tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| retrieved-tool-and-noise | retrieval-support | 2/2 | 1 | 1 | 33/500 |
| complementary-medium-facts | retrieval-support | 4/4 | 3 | 3 | 91/500 |
| nearly-all-useful | authored-support | 3/3 | 3 | 3 | 86/500 |
| no-useful-optionals | retrieval-support | 2/2 | 0 | 0 | 0/500 |
| missing-retrieval-authored-support | authored-support | 2/2 | 1 | 1 | 34/500 |
| missing-evidence-restrictive | retrieval-support | 1/1 | 0 | 0 | 0/500 |
| missing-evidence-curated | curated-history | 1/1 | 1 | 1 | 31/500 |
| combined-support-units | combined-support | 3/3 | 2 | 2 | 58/500 |
| useful-old-conversation | curated-history | 2/2 | 2 | 2 | 65/500 |
| duplicates-aggregate-support | retrieval-support | 4/2 | 1 | 1 | 32/500 |
| tight-budget | authored-support | 2/2 | 2 | 1 | 27/40 |
| generous-budget | authored-support | 2/2 | 2 | 2 | 54/500 |
| conflict-ranking-insufficient | authored-support | 2/2 | 2 | 2 | 65/500 |
| explicit-superseded-disposition | authored-support | 2/2 | 1 | 1 | 31/500 |
| explicit-room-inapplicability | authored-support | 2/2 | 1 | 1 | 32/500 |
| required-below-admission | authored-support | 3/3 | 2 | 2 | 63/500 |
| mixed-source-support | authored-support | 3/3 | 3 | 3 | 91/500 |
| equal-score-tight-budget | authored-support | 2/2 | 2 | 1 | 27/40 |
| duplicate-group-inapplicability | authored-support | 3/2 | 1 | 1 | 28/500 |
| superseded-without-replacement | authored-support | 1/1 | 0 | 0 | 0/500 |

## Frozen v1 historical comparison

The baseline and final reports match across **all 23 gates**, all split counts
and aggregates, and every case result except observed compilation latency.
`benchmarks/evaluation/v1`, `packages/evaluation`, and `benchmarks/acceptance`
are unchanged from merged baseline, including fixtures, annotations, policies,
splits, budgets, formulas, thresholds and expectations. The legacy selection
diagnostic is byte-identical to baseline and structurally identical to the
committed Phase 21A reference (SHA-256 of command output:
`bc4bb91e7e9b2a5b7152cf1cde902d4f7973478a5076b064a3cb47d14955bd1b`).

| Frozen validation case | Full baseline tokens | Compiled tokens | Reduction ratio |
| --- | ---: | ---: | ---: |
| case-04-conflicting-context | 79 | 79 | 0 |
| case-05-budget-pressure | 520 | 120 | 0.7692307692307693 |
| case-12-retrieval-noise | 100 | 100 | 0 |

Median reduction remains **0 (FAIL)**; long-context reduction remains
**0.7692307692307693 (PASS)**. Required-block recall (including the stronger
valid-budget criterion), weighted fact coverage and critical fact coverage each
remain **1**. There are **13 cases** (3 development / 3 validation / 7 regression),
**11 successful compilations**, **2/2 matched expected failures**, **0 unexpected
failures**, and **0 budget violations**.

Provenance is **27/27**, wrapper accounting **38/38**, group decisions **37/37**,
reasons **111/111**, trace reconciliation **11/11**, repeated determinism **26/26**,
scope detection **1/1**, and cross-scope inclusion **0**. Engineering acceptance
remains **INCOMPLETE**, product validation remains **FAIL**. Source-instruction
escape measurement, Docker runtime and live answer quality remain
**NOT_EVALUATED**; performance is also unmeasured. No missing evidence is promoted
to PASS.

## Final local verification

Node **22.23.2**, pnpm **10.33.0**. The final sequence passed all **20 steps**:
clean, frozen install, formatting, lint, typecheck, three no-build-output checks,
complete tests, boundaries, aggregate check, build with no prior workspace output,
declarations, built CLI smoke, built API smoke, frozen acceptance, legacy
selection diagnostic, development evaluation, diff check and status inspection.
The standalone test command and aggregate check each passed **175 files / 3734
tests**. This adds **2 test files / 52 tests** to baseline. Boundaries cover **11
workspace packages**, the build covers **11 referenced projects**, and **75 public
declarations** pass. The built CLI smoke passes; the built API smoke passes all
**12 named checks**, including CLI parity, restart, scope, privacy and shutdown.
No workspace `dist` appeared during typecheck/tests/check; none is tracked.

The added tests cover scoped exclusions, required conflicts and bypass,
unsupported graph fields, duplicate provenance, input permutations, missing
support, unused capacity, budget pressure, old/new trace persistence, CLI/API
parity, fixed API errors and the development corpus. An earlier full run exposed
a runtime stage import in the trace builder; the final version restores the
existing type-only boundary. Declaration checks now assert both explicit policy
branches and trace versions without exposing validation-library types or the
internal resolver.

The final diff changes **29 files** (listed below). No dependency/lockfile change,
private config, secret, tracked build output, temporary database, WAL or SHM
artifact is included. CI additionally executes the development command. Exact
commit/PR/CI identity is recorded in the PR and handoff after publishing; there
is no merge authorization in this phase.

- `.github/workflows/ci.yml`
- `apps/api/src/errors.ts`
- `benchmarks/admission-development/cases.ts`
- `benchmarks/admission-development/evaluate.ts`
- `benchmarks/admission-development/profiles.ts`
- `benchmarks/admission-development/run.ts`
- `benchmarks/diagnostics/compilation-decisions.ts`
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`
- `docs/INVARIANTS.md`
- `docs/METRICS.md`
- `docs/MVP_SCOPE.md`
- `docs/PHASE21B_ADMISSION_SEMANTICS.md`
- `docs/PRODUCT_CONTRACT.md`
- `package.json`
- `packages/compiler/src/candidate-applicability.ts`
- `packages/compiler/src/candidate-filter.ts`
- `packages/compiler/src/compilation-trace.ts`
- `packages/compiler/src/context-compiler.ts`
- `packages/compiler/src/index.ts`
- `packages/compiler/src/persisted-trace.ts`
- `scripts/check-declarations.mjs`
- `tests/admission-development/development.test.ts`
- `tests/api/http-boundary.test.ts`
- `tests/api/integration.test.ts`
- `tests/compiler/applicability.test.ts`
- `tests/compiler/filtering-contract.test.ts`
- `tests/compiler/persisted-trace.test.ts`
- `tests/compiler/public-api.test.ts`

## Phase 21C held-out proposal

Freeze the final profile definitions, rubric, applicability contract and test
protocol before authoring a separately versioned held-out dataset. Keep all 20
Phase 21B scenarios as development evidence only. Do not relabel or retrofit v1.
A concrete first held-out matrix is 48 new requests: four profile contracts by
six strata (direct answer plus noise, complementary facts, all-useful/none-useful,
missing/conflicting evidence, useful older history, explicit applicability with
duplicates), with two independent requests in each cell and balanced tight and
generous budgets. Use new contents, ids and answers, with mixed source types.

A person or process separate from profile development should annotate useful and
required facts, intended admission and applicability independently of compiled
output, review ambiguous cases, and freeze the cases and preregistered thresholds
before the first run. Runtime required flags must come from the caller's explicit
obligations, never from held-out answer annotations. Report per-profile and
per-stratum admission precision/recall, useful/required-fact preservation,
rendered token reduction, budget/scope violations, duplicate/trace accounting and
repeated determinism, including expected failure cases in a separate regression
set. A profile failing its preservation criterion must not be rescued by higher
aggregate reduction. Report uncertainty and sparse denominators.

Real retrieval-provider calibration needs its own independent development
samples before testing its frozen profile in Phase 21C; the synthetic rubric
cannot establish BM25 or cosine admission quality. Live answer-quality evaluation
is a separately authorized future measurement, not part of this phase. General
supersession edges remain a distinct follow-up requiring explicit replacement
availability, authority, transitive/cycle rules, required conflict resolution and
trace migration; the implemented disposition contract claims none of these.

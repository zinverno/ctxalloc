# MVP Acceptance — Phase 20

The implementation includes HTTP, the shared compile/persist use case, boundary
hardening, reproducible acceptance commands and a Docker/VPS staging path.
**Engineering acceptance is `INCOMPLETE`; product validation is `FAIL`.** The
measured validation median context reduction misses its target. Live answer
quality, a suite-level source-instruction escape count, and Docker runtime
validation remain missing. The product hypothesis is **inconclusive**: this small
fixed suite does not establish the promised general reduction/quality tradeoff.

## Provenance and reproduction

Phase 19 merge and actual fetched main head:
`fb90f18579c0c8a99e0b8c1e9290c535eb68128f` (PR #19 merged). The clean-main baseline
was **162 test files / 3515 tests**, all passing. Phase 20 starts from that commit
on `codex/phase-20-http-api-mvp-acceptance`; no earlier commit is rewritten.

The reference measurement executes clean implementation commit
[`65623868a8a59cf67783a3e4e3aac2c4623159c2`](https://github.com/zinverno/ctxalloc/commit/65623868a8a59cf67783a3e4e3aac2c4623159c2)
(`sourceRevision.dirty: false`). The full versioned machine report is committed
as [phase20-reference.json](evidence/phase20-reference.json). The evidence-only
follow-up changes documentation, not executable code; CI separately checks the
final PR head.

Reference environment: Node **v22.23.2**, pnpm **10.33.0**, Linux
**6.12.95-1-MANJARO**, **x64**, **AMD Ryzen 5 5500U with Radeon Graphics**, 12 logical
CPUs and **7,607,300,096 bytes** total memory.

```sh
pnpm install --frozen-lockfile
pnpm build
mkdir -p .ctxalloc
pnpm --silent acceptance:mvp > .ctxalloc/acceptance.json
pnpm --silent performance:mvp > .ctxalloc/performance.json
```

Both commands emit one versioned JSON report with source revision/dirty state,
environment, dataset/version, all case reports, split-specific aggregates,
per-gate target/value/evidence/state, overall states and explicit missing gates.
The performance command additionally measures warmed latency. Timing and model
calls are not CI gates. The deterministic command invokes the built CLI and API
smokes itself, rather than accepting a claimed integration pass from a config.

Gate states are `PASS`, `FAIL`, `NOT_EVALUATED`, `NOT_APPLICABLE`. A required
failure determines `FAIL`; otherwise required missing evidence determines
`INCOMPLETE`. `engineeringAcceptance` covers correctness, integration and staging;
`productValidationAcceptance` also requires context and answer-quality evidence.
Exit 1 signals measured engineering failure. Exit 0 means the measurement ran
without such failure; it does **not** assert product acceptance. CI can therefore
remain green while clearly reporting the measured product failure and missing
external evidence.

## Dataset and metric evidence

The unchanged **ctxalloc-eval-v1**, version **1**, contains **13** authored cases:
**development 3 / validation 3 / regression 7**. Development is diagnostic;
regression is retained as correctness evidence. Release context aggregates use
validation only. The long-context subset contains one validation case. Neither
three validation cases nor one long-context case is statistical proof.

The existing `EvaluationHarness` owns baselines and token/fact/quality formulas.
Full-context is the baseline for reduction; truncation and top-k remain separate
baseline reports. Incomparable retrieval evidence keeps top-k inapplicable.
The reference tokenizer is `O200kBaseTokenizer` with offline `o200k_base`; it is
not a claim of exact Anthropic billing tokens. Narrow correctness observations
in `benchmarks/acceptance/correctness.ts` implement METRICS 9.5, 13.3–13.5 and 15.1–2.
They use existing validators/deduplicator/tokenizer and compare actual output,
without changing compiler decisions. Ratios without denominators remain missing.

| Gate | Definition / evidence | Actual | Result |
| --- | --- | ---: | --- |
| Median context reduction | Harness validation median >= .35 | 0 | FAIL |
| Long-context reduction | Harness tagged validation median >= .50 | 0.7692307692307693 | PASS |
| Required-block recall | Minimum measured validation case >= .95 | 1.00 | PASS |
| Valid-budget required-block recall | METRICS 9.1 / final checklist = 1.00 | 1.00 | PASS |
| Weighted required-fact coverage | Minimum measured validation case >= .95 | 1.00 | PASS |
| Critical fact coverage | Minimum annotated validation case = 1.00 | 1.00 | PASS |
| Budget violation count | Harness all splits = 0 | 0 | PASS |
| Provenance coverage | Valid included provenance / included blocks = 1.00 | 27 / 27 | PASS |
| Wrapper accounting completeness | Validated wrappers present exactly once / wrappers = 1.00 | 38 / 38 | PASS |
| Group decision completeness | Groups with one disposition / groups = 1.00 | 37 / 37 | PASS |
| Decision reason coverage | Decisions with machine-readable reason / decisions = 1.00 | 111 / 111 | PASS |
| Trace reconciliation rate | Every METRICS 8.12 equation, final render/decision/usage agreement | 11 / 11 | PASS |
| Repeat determinism rate | Identical / repeated comparisons = 1.00 | 26 / 26 | PASS |
| Scope violation detection rate | Individually detected foreign candidates / foreign candidates | 1 / 1 | PASS |
| Cross-scope inclusion count | Included blocks outside exact request scope = 0 | 0 | PASS |
| Source instruction escape count | Untrusted text changing policy/execution = 0 | Unmeasured | NOT_EVALUATED |
| Answer-quality median loss | Complete live same-model evidence <= .05 | Unmeasured | NOT_EVALUATED |
| Unexpected failures | Harness all splits = 0 | 0 | PASS |
| Expected-failure accuracy | Correct expected failures / expected failures = 1.00 | 2 / 2 | PASS |
| Dataset unchanged | Exact before/after suite snapshot | 1 | PASS |
| Built CLI workflow | Executed source registration and restart/list smoke | 1 | PASS |
| Built HTTP workflow / parity | Both formats, separate databases, compile/restart/trace | 1 | PASS |
| Docker runtime | Image, mounts, compile, SIGTERM, restart trace | NOT_RUN | NOT_EVALUATED |

Eleven cases compile successfully; both expected-failure regression cases remain
in the suite. Three executions per case produce 26 comparisons, including stable
expected failures. The source-instruction regression remains in the original
suite, and a real HTTP regression verifies source instructions remain JSONL data
without changing request budget/scope or adding a route. These bounded tests are
not relabeled as a suite-level behavioral escape-count producer. That missing
required measurement keeps engineering acceptance incomplete even though all
measured correctness/integration gates pass.

The validation failure is observable without interpretation or threshold changes:

| Validation case | Full-context tokens | Compiled tokens | Reduction |
| --- | ---: | ---: | ---: |
| case-04-conflicting-context | 79 | 79 | 0% |
| case-05-budget-pressure | 520 | 120 | 76.92% |
| case-12-retrieval-noise | 100 | 100 | 0% |

The two zero-reduction cases fit all their content within the configured budget;
the existing policy retains it. The budget-pressure case removes 400 tokens and
preserves the annotated required facts. The median remains zero. No validation
fixture, split, policy, metric definition or threshold was tuned after observing
this result. The older development-order prose and the .95 recall target versus
the stronger valid-budget/final-checklist 1.00 target were reconciled explicitly:
actual phase order is documented, and both recall gates are reported.

## Answer quality

The default run constructs no model provider. Every case records model execution
as disabled. No answers exist; neither context/fact coverage nor fake-provider
tests count as product answer quality. `qualityEvidence.live` is false and the
quality gate is `NOT_EVALUATED`, not zero loss. The empty severe-loss case list
means no live measurement, not evidence of no severe losses.

`tests/acceptance/gates.test.ts` supplies fake zero-loss results and confirms they
cannot pass the quality gate. The report builder additionally requires a real
`AnthropicModelProvider` instance, and the gate checks adapter identity, complete
validation execution, same-model evidence and absence of provider/mismatch
failures. The manual path does not affect HTTP, which always composes the harness
without any `ModelProvider` and rejects a run config requesting model execution.

For a later explicitly chosen live run, write an uncommitted UTF-8 JSON file
`.ctxalloc/live-model.json` with **exactly** `apiVersion`, `baseUrl`, `modelId`, and
`timeoutMs`, using an operator-verified endpoint/model and a positive timeout.
Supply the existing adapter's supported API version and base URL (the adapter
appends `/v1/messages`). Do not include a key in that JSON. Set the key in the
operator's environment without putting its value into shell history, then run:

```sh
pnpm --silent acceptance:mvp:live --config .ctxalloc/live-model.json > .ctxalloc/live-acceptance.json
```

The only secret environment variable is `CTXALLOC_ANTHROPIC_API_KEY`, read only
by the manual executable. The adapter reads no environment. Baseline and compiled
calls request the same model; actual identity mismatches retain the existing
harness semantics. Public reports contain no key, prompt, query, context or
answer. This command is never invoked by CI or the API. No live run was performed
for this reference report.

## Warm performance

The committed reference run used the environment above, `SystemMonotonicClock`
(`node-performance-now`, version 1), five warm-up iterations followed by twenty
measured iterations. Percentiles use nearest rank. Units are milliseconds.

| Measurement | p50 | p95 | p99 | Max | p95 target |
| --- | ---: | ---: | ---: | ---: | ---: |
| Compiler only | 8.294 | 8.943 | 9.180 | 9.180 | <= 500 |
| Local retrieval + compile, including trace persistence | 5.361 | 6.997 | 7.269 | 7.269 | <= 2500 |

Compiler-only uses validation `case-05-budget-pressure`, 13 candidates and no
persistence. The local measurement uses the public sample Markdown handbook,
two corpus blocks and one retrieved candidate; it includes file reads,
preparation, retrieval, compilation and settled trace storage in temporary SQLite.
The first insert occurs during warm-up; measured writes are idempotent. Different
workloads explain why the second scope can be faster. These small warmed samples
are reference evidence, not a throughput/load test, cold-start promise, durability
benchmark, cross-machine result or model latency measurement. EvaluationHarness
latency definitions are unchanged. Re-run on the intended deployment hardware.

## Integration, hardening, staging and limits

`scripts/smoke-api.mjs` invokes built entrypoints in fresh processes against two
logically identical fresh databases. Both Markdown and conversation compile
within budget; CLI/HTTP compilation id, rendered context, included ids, usage and
validated settled traces compare equal. API SIGTERM and restart preserve traces;
wrong-scope and absent reads are identical 404 responses. Database bytes contain
neither sample source text nor compiled context. Source registration remains CLI
only. The smoke removes all temporary files and checks journal/WAL/SHM absence.

HTTP regressions cover exact routes/methods, fixed 405 Allow, strict media/UTF-8,
actual chunked limits and early 413 before `100 Continue`, URL decoding once,
trace scope privacy, serialization/dependency-error sanitation, startup failure,
readiness, no-queue saturation, abort and drain. SQLite regressions use separate
real connections, concurrent identical writes and reads, conflict preservation,
a real write lock with sanitized 500 and successful retry after release. Schema
version 1 and journal policy remain unchanged; no WAL setting was added.

The hardening sweep fixed unsafe inspection of provider arrays, nested active or
cyclic compiler input, file-reader and model-adapter configuration/request records.
Revoked proxies and reflection failures now produce project-owned errors; tested
accessors are not invoked and canary wording is not leaked. Anthropic timeout now
covers response-body consumption after headers. The source reader checks realpath
confinement, rejects absolute/separator-invalid locators and nonregular files,
opens with no-follow/nonblocking flags, checks handle identity, and enforces the
actual read limit including growth after stat. UTF-8 behavior is retained. There
is no portable Node directory-handle walk guaranteeing confinement when a
malicious actor concurrently replaces ancestors; operator-owned read-only source
mounts are part of the staging model.

[STAGING.md](STAGING.md) provides bare-process and multi-stage Docker procedures,
built non-root execution, direct Node SIGTERM, explicit read-only config/source
mounts, writable state, readiness healthcheck, graceful restart, stopped-writer
backup and upgrade. Docker is absent locally: **Docker build/run/restart are
NOT_RUN**. Static packaging/mount tests do not establish runtime success. The
container may listen internally on `0.0.0.0`, but host publish is only
`127.0.0.1:8787:8787`; a bare VPS binds loopback. There is no application auth.
Any external access needs operator-controlled proxy/tunnel/firewall restrictions.

No auth/SaaS, semantic/hybrid retrieval, persistent retrieval index, embeddings or
vector database, file watcher/jobs, evaluation persistence, model gateway, or
polished UI is added. Those remain post-MVP deferrals. No claim of general
production readiness or a passed product hypothesis follows from this phase.

## Final local validation

The required sequence passed on the Phase 20 source tree: `pnpm clean`, frozen
install, formatting, lint, typecheck, no `dist`, **171 test files / 3671 tests**,
no `dist`, boundaries, `pnpm check` (including the same full suite), no `dist`,
fresh build, **74 declaration checks**, built CLI smoke, built API smoke and
deterministic acceptance. The API smoke also covers the requested built CLI
source-add/restart/list and compile/restart/trace workflows, both HTTP formats,
API restart/trace and CLI/HTTP parity. `git diff --check` passed. No benchmark
fixture changed, no database/journal/WAL/SHM remained in the workspace or task
temporary directories, and no generated `dist` or private runtime config is
tracked. Build output exists only after the explicit build step and is ignored.

Docker execution remains `NOT_RUN`. Exact PR-head CI, commit metadata and open,
unmerged PR state are separately verified at handoff; local measurement success
cannot substitute for those checks or for missing product-validation evidence.

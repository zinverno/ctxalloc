# Phase 22A: real retrieval calibration (DEVELOPMENT)

This phase measures the shipped MiniSearch adapter without live models. It does
not establish Product Validation PASS or a new held-out result.

## Starting baseline

PR #27 merged as `62a4cd7eb5ebe1e30a813171406d178e71977727`; fetched main and
the clean local checkout matched that exact revision. Integration anchor
`f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c` is an ancestor. Before branching,
`pnpm --silent validation:heldout:v2:reanchored` authenticated the original
Phase 21E PASS (21 artifacts, 220 semantic identities, 142 retained build
identities, 60 input/annotation/policy triples). Phase 21C historical integrity
passed and retained the original FAIL. No orphaned experiment ancestry was required.

The complete unchanged baseline passed 20 command checks, including standalone
and aggregate runs of 186 files / 3,830 tests, 11 workspace boundaries/build
projects, 76 public declarations, CLI smoke and 12 API smoke checks.

## Development methodology, before retrieval observation

1. Select and record a small public, human-annotated training corpus without
   observing MiniSearch scores. Preserve the original questions and annotations.
2. Commit its provenance, deterministic selection rule, input hashes and raw
   observation harness. Run native retrieval before defining any mapping.
3. Examine native scores/ranks, query length and corpus-size perturbations.
   Keep unjudged passages distinct from independently judged negatives.
4. Select a versioned, provider-specific development profile outside the kernel.
   Measure retrieval, admission and allocation losses separately, including
   generous and constrained budgets. Freeze the profile and proposed Phase 22B
   gates only after these development observations.
5. Validate the implementation and privacy boundary, preserve historical artifacts,
   and open the requested PR without merging it.

Public source: [QASPER](https://huggingface.co/datasets/allenai/qasper), version
0.3, **training split only**, CC BY 4.0. Questions and evidence annotations were
authored by NLP practitioners in the original dataset, independently of this
provider and this task. This agent does not author usefulness or fact labels.
Unselected passages are **unjudged**, not proven irrelevant. Human-selected
evidence paragraphs are coarse evidence units, not newly invented atomic facts.
Missing textual evidence and figure/table-only annotations remain visible gaps.

Selection: take the first 12 training papers ordered by SHA-256 of paper ID,
among papers with 10–100 nonblank full-text paragraphs; keep every question for
those papers. This size criterion controls local runtime, not retrieval quality.
Deduplicate exactly equal paragraphs within each paper, keeping the first location.
Original evidence strings are matched exactly; unmatched strings are retained
as unavailable evidence units, never silently relabeled or dropped. No validation
or test split is used and no Phase 22B cases are authored.

The data supplies technical references and related/background material. It does
not independently label all requested project-document, developer-note, tool-result,
conversation-history, stale-version or wrong-meaning categories. Those gaps limit
the conclusion and must be addressed by human annotation of a later local workload;
source-type relabeling would not fill them.


## Provider inventory and target

The repository implements exactly **one real retrieval provider**. No retrieval
library or other dependency is added in this phase.

| Implementation | Algorithm / score semantics | Integration and use |
| --- | --- | --- |
| `MiniSearchCandidateProvider`, `@ctxalloc/adapters`, `packages/adapters/src/minisearch-candidate-provider.ts` | MiniSearch 7.2.0 BM25+: sum of per-term contributions multiplied by matched-query-term count; exact OR search, no prefix/fuzzy/stemming/stop-word removal; k=1.2, b=0.7, d=0.5 | `CompileLocalContextService`; shipped CLI `apps/cli/src/commands/compile.ts`, API `apps/api/src/runtime.ts`, local corpus service and MVP acceptance/performance workflows |
| `FakeCandidateProvider`, `@ctxalloc/testing`, `packages/testing/src/fake-candidate-provider.ts` | **No retrieval algorithm**: wraps explicitly named blocks and caller-supplied evidence; no native range, rank, normalization or cross-query comparability guarantee | Tests only; not a second real target |

MiniSearch's provider ID is `ctxalloc-minisearch-bm25plus`, version
`1+minisearch@7.2.0`. Native semantics are
`minisearch-bm25plus-sum-times-matched-query-terms`. Scores are finite, strictly
positive, unbounded above and **not normalized**. Higher means stronger lexical
matching. Native rank is zero-based. Scores have no established comparability
between queries or corpora. No score is a probability. The index is rebuilt in
memory for each explicit request; there is no persistent index or model.

Prepared `markdown`, `text` and `conversation` blocks are supported. Only
`block.content` is indexed: titles, metadata, dates, required flags and priorities
do not affect retrieval. Project Markdown, developer notes and tool output may
be supplied as Markdown/text; there is no separate tool-result source kind.
`PrepareLocalCorpusService` uses the existing Markdown/text/conversation chunkers.
The public corpus here supplies presegmented text paragraphs, so it measures the
provider/contract seam, not filesystem reading or the production chunkers.

QMD was rejected in the earlier retrieval spike and is not implemented. There
is no vector, embedding, Qdrant, hybrid or LLM-reranking provider to calibrate.
MiniSearch is the appropriate first target because it is the only shipped real
provider and already powers local end-to-end workflows.

## Corpus and annotation boundary

[Corpus provenance](../benchmarks/retrieval-calibration/data/provenance.json)
records **12 papers, 529 paragraphs, 39 unchanged human questions**, 45 positive
block judgments and **zero negative judgments**. Two exactly duplicate paragraphs
were removed before scoring. There are 53 human-selected evidence units: 45 map
exactly to paragraphs and eight do not. The eight unavailable units remain in
the evidence-preservation denominator. Criticality is **not annotated**, so its
preservation is `null` (0/0), not 100%.

This is a narrow public technical-reference calibration attempt. Questions
include factual lookup, multiple evidence units, several answer elements, weak
lexical evidence, an unanswerable question and short contextual questions. Query
lengths (4–16 whitespace-delimited words), all candidate scores/ranks, source types and all per-query results are
in the machine-readable reports. The single unanswerable question does not turn
all its passages into independently judged negatives. Likewise, absence of an
annotation does not prove the absence of other useful information.

Requested realistic project documentation, developer notes, stale-version
judgments, independently labeled conversation/tool histories, explicit noise and
wrong-meaning negatives are **not covered by these human annotations**. Their
metrics are unavailable. The current input loader supports the three existing
source types for a later human-authored local corpus. Adding artificial labels
or changing source-type strings would not resolve this coverage gap.

## Native observations, before profile selection

The score-blind corpus/protocol commit is `070d78c`; first native results were
preserved in `9b58e39`, before any profile implementation. The immutable
[first raw report](evidence/phase22a-native-first.json) records **1,390 candidates**:
41 annotated useful and 1,349 unjudged. Retrieval is scoped to each question's
paper, as in the original task, and the cap covers the entire supplied corpus.
It is not global document discovery and does not measure a production top-20 cap.

Useful block retrieval recall is **41/45 = 91.11%**. Two questions completely
miss their available useful paragraphs. Four available positive paragraphs are
missed overall. Evidence-unit retrieval recall is **41/53 = 77.36%**, including
those four misses and eight unavailable source units. A separate source-preparation
subcount prevents attributing missing figure/table/text material to lexical scoring.

| Native distribution | Useful (41) | Unjudged (1,349) | Irrelevant |
| --- | ---: | ---: | --- |
| Minimum | 0.106026 | 0.074487 | Not measured: no negative labels |
| p10 | 2.693902 | 0.474769 | — |
| Median | 9.226086 | 6.138483 | — |
| p90 | 95.205015 | 30.427970 | — |
| Maximum | 256.679266 | 190.239050 | — |
| Mean rank (zero-based) | 10.54 | 20.91 | — |
| Median rank | 6 | 19 | — |
| Maximum rank | 45 | 64 | — |

40 of 41 useful scores lie within the observed unjudged score range. This is **not** evidence
of measured useful/irrelevant separation. Strong unjudged hits cannot honestly
be called strong false positives. Weak useful hits are proven by positive labels:
q036 scores 0.106026 at rank 22; q008 scores 0.366807 at rank 45.

| k | Retrieved annotated useful / 45 | Recall@k | Returned candidates | Precision over returned candidates: lower–upper |
| --- | ---: | ---: | ---: | ---: |
| 1 | 9/45 | 20.00% | 38 | 23.68%–100% |
| 3 | 15/45 | 33.33% | 112 | 13.39%–100% |
| 5 | 18/45 | 40.00% | 186 | 9.68%–100% |
| 10 | 26/45 | 57.78% | 371 | 7.01%–100% |
| 20 | 32/45 | 71.11% | 721 | 4.44%–100% |

Precision uses actually returned items up to k, not k padded slots. Empty
returned lists yield `null`, and recall with no positive judgments is `null`.
Judged-only precision is 100% because this sample has no negative labels; it is
selection-biased and must not be presented as admission/retrieval accuracy.

### Score scale, corpus size and determinism

Doubling the exact query text multiplies all 1,390 scores by approximately 2
(rounding-level variation) while leaving every rank unchanged. This paired
probe changes query length without adding informational content. Across the
original questions, query word count versus top score has Pearson r=0.70258;
that correlation alone is confounded by topic and corpus differences.

Expanding each query's corpus to all 529 paragraphs changes scores of the same
original candidates by factors ranging **0.17988–13.44825**, median 1.44093.
Median absolute rank movement is 125.5 and maximum movement is 451 because new
competitors enter. Rank is stable to the repeated-query probe, not universally
stable across corpus changes. Neither raw score nor rank supports an absolute
cross-query usefulness claim.

All 39 repeated identical provider requests match exactly. Reversing input
corpus order changes native scores for 13 questions (126 candidate scores),
with maximum absolute difference 2.84217e-14; ranks remain identical in all 39.
This is an observed native arithmetic-order defect, not a compiler failure.
The original raw command intentionally reports `contractChecks: FAIL` and exits
1; its first report is retained unchanged. No tolerance is used to relabel exact
native determinism as PASS. The new calibration command separately verifies
canonical request preparation and exact downstream determinism. The provider
implementation/version is unchanged; a direct-provider determinism fix belongs
in a separate versioned adapter change.

## Transformation decision: Outcome C

**No absolute restrictive threshold is justified.** The available human labels
cannot measure false-positive separation, native scales change with query/corpus,
and known useful blocks can score very weakly or rank very low. Outcome C means
ranking evidence only; Outcome B's query-local transformation is used for
allocation ordering but does not justify restrictive admission.

Development-only counterfactuals illustrate the known preservation cost. They
simulate exclusions outside the compiler, not executable complete-evidence
contracts. They are not held-out tests or recommended cutoffs.

| Counterfactual | Retained / 1,390 | Known admission misses / 41 retrieved useful |
| --- | ---: | ---: |
| native-absolute ≥ 0 | 1390 | 0 |
| native-absolute ≥ 0.501099 | 1251 | 2 |
| native-absolute ≥ 1.81607 | 1042 | 3 |
| native-absolute ≥ 6.45654 | 695 | 13 |
| native-absolute ≥ 15.0809 | 348 | 23 |
| native-absolute ≥ 31.0699 | 139 | 29 |
| native-over-query-max ≥ 0.05 | 981 | 2 |
| native-over-query-max ≥ 0.1 | 726 | 8 |
| native-over-query-max ≥ 0.25 | 421 | 14 |
| native-over-query-max ≥ 0.5 | 186 | 25 |
| top-k = 1 | 38 | 32 |
| top-k = 3 | 112 | 26 |
| top-k = 5 | 186 | 23 |
| top-k = 10 | 371 | 15 |
| top-k = 20 | 721 | 9 |

A cutoff can appear lossless on finitely many positive examples without being
calibrated. No such threshold is selected. Query-local score/max scaling also
loses known useful evidence under every positive cutoff tried.

## Frozen development profile and architecture

[Profile freeze](../benchmarks/retrieval-calibration/profile-freeze.json) pins
`minisearch-query-rank-incomplete-admit@1`, calibration version
`phase22a-development-1`, its policy identity/hash, implementation bytes and first
native report. Profile-and-policy SHA-256 is
`2fa9e503ec5da8b9e3c4a665d26169d4f6d8394ea7eccaa7387daf7146c0c7a7`.

`benchmarks/retrieval-calibration/profile.ts` is a caller-side development profile,
not a compiler feature or a new retrieval provider. It:

1. Sorts corpus blocks/source records by ID using code-unit order before invoking
   the unchanged MiniSearch provider. This makes the index's arithmetic order
   explicit and repeatable; it does not round or alter returned native scores.
2. Retains native evidence separately and emits a distinct mapped contract:
   provider `ctxalloc-minisearch-rank-calibration`, version `1+minisearch@7.2.0`,
   semantics `reciprocal-one-based-native-rank`, value `1/(nativeRank+1)`,
   higher-is-better, range `(0,1]`. The compiler's explicit linear `[0,1]` rule is
   an identity map. This is lexical ordering, not probability.
3. Declares retrieval evidence **incomplete**, with uncertainty behavior `admit`.
   Admission policy `phase22a:minisearch:admit-all@1` configures **no minimum**.
   Every retrieved candidate remains eligible; runtime-required input stays in
   its separate required class. Therefore `ELIGIBLE_POLICY` is expected; the
   threshold-dependent `ELIGIBLE_INCOMPLETE_EVIDENCE` reason is not artificially
   triggered. Phase 21D `onIncompleteEvidence: reject` would reject the compilation
   when applicable, not silently drop a candidate.
4. Lets the unchanged compiler perform score-descending greedy allocation,
   source/location ordering, JSONL rendering and exact O200k token settlement.

The mapping rejects mismatched provider/version/semantics/direction, missing or
noncontiguous ranks, duplicate candidates and invalid native scores. It preserves
original blocks. Full native and mapped per-candidate evidence is emitted with
hashes; compiler traces remain internal to the harness. No compiler, domain,
production adapter, Phase 21B/21D profile, or historical fixture is modified.
The existing CLI/API defaults are not switched to an unvalidated development
profile; local calibration calls the same public provider and compiler APIs.

## Admission, allocation and token results

[Development report](evidence/phase22a-calibration.json) contains every query,
score/rank distribution, probe, counterfactual, mapping and stage outcome. Both
budgets include an explicit runtime-required conversation block carrying the
unchanged public question. This runtime block is not counted as a retrieved
useful fact and does not pretend to be labeled conversation-history coverage.

Full-context comparisons use the same compiler/renderer with ample budget and
no restrictive admission, asserting all candidates survive. There is no raw-text
versus JSONL comparison. Counts use the actual O200k tokenizer; the ample-budget
headroom formula is not reported as a token measurement. Deduplication ambiguity
is rejected in the input corpus before measurement.

| Metric | Generous budget | 2,048 available tokens |
| --- | ---: | ---: |
| Successful queries | 39 | 39 |
| Retrieved candidates admitted | 1,390 | 1,390 |
| Admission recall (retrieved positives) | 41/41 = 100% | 41/41 = 100% |
| Admission precision bound | 41/1,390–1 = 2.95%–100% | 2.95%–100% |
| False admissions bound | 0–1,349 | 0–1,349 |
| Admission false exclusions | 0 | 0 |
| Useful block preservation | 41/45 = 91.11% | 22/45 = 48.89% |
| Coarse human evidence preservation | 41/53 = 77.36% | 22/53 = 41.51% |
| Critical fact preservation | Not annotated (0/0) | Not annotated (0/0) |
| Runtime-required preservation | 39/39 | 39/39 |
| Block losses: retrieval / admission / allocation | 4 / 0 / 0 | 4 / 0 / 19 |
| Evidence losses: retrieval / admission / allocation | 12 / 0 / 0 | 12 / 0 / 19 |
| Of retrieval evidence losses: source unavailable | 8 | 8 |
| Full retrieved rendered tokens, summed over queries | 302,011 | 302,011 |
| Final rendered tokens | 302,011 | 71,284 |
| Incremental admission token reduction | 0% | 0% |
| Rendered reduction versus retrieved full context | 0% | 76.40% |
| Budget violations | 0 | 0 |

The full source-corpus render totals 358,075 tokens over the query workloads.
Retrieval reduces that to 302,011 (15.66%), while losing four available positive
paragraphs; that reduction belongs to retrieval. The 76.40% constrained reduction
belongs to allocation and accompanies 19 further known useful losses. It is
**not a preservation-qualified optimization success**. Permissive incomplete
evidence avoids admission loss but retains all 1,349 unjudged candidates as budget
competitors. Final useful preservation cannot be guaranteed from admission alone.

Constrained per-query token reduction: min 0%, p10 27.79%, median 78.57%,
p90 83.41%, max 84.87%, mean 66.52%. Evidence-preservation median is 50%,
with 16 of the 37 evidence-annotated queries preserving zero evidence units; aggregate averages hide that spread.

### Every query, including pathological results

`U` is retrieved positive paragraphs; `E` is preserved/total human evidence units
under 2,048 tokens. R/A/L are evidence-unit losses owned by retrieval/preparation,
admission and allocation. Unavailable evidence remains in R.

| Query | Candidates | U | E | R / A / L |
| --- | ---: | ---: | ---: | --- |
| q001 | 50 | 2 | 1/2 | 0 / 0 / 1 |
| q002 | 47 | 1 | 0/1 | 0 / 0 / 1 |
| q003 | 44 | 0 | 0/1 | 1 / 0 / 0 |
| q004 | 33 | 4 | 0/6 | 2 / 0 / 4 |
| q005 | 52 | 1 | 1/1 | 0 / 0 / 0 |
| q006 | 53 | 1 | 0/1 | 0 / 0 / 1 |
| q007 | 53 | 1 | 0/1 | 0 / 0 / 1 |
| q008 | 46 | 1 | 0/1 | 0 / 0 / 1 |
| q009 | 40 | 1 | 1/1 | 0 / 0 / 0 |
| q010 | 40 | 1 | 1/1 | 0 / 0 / 0 |
| q011 | 40 | 0 | 0/1 | 1 / 0 / 0 |
| q012 | 36 | 1 | 1/1 | 0 / 0 / 0 |
| q013 | 49 | 0 | 0/1 | 1 / 0 / 0 |
| q014 | 49 | 1 | 1/1 | 0 / 0 / 0 |
| q015 | 42 | 1 | 0/1 | 0 / 0 / 1 |
| q016 | 41 | 1 | 1/1 | 0 / 0 / 0 |
| q017 | 26 | 3 | 1/5 | 2 / 0 / 2 |
| q018 | 41 | 1 | 1/1 | 0 / 0 / 0 |
| q019 | 29 | 2 | 0/2 | 0 / 0 / 2 |
| q020 | 38 | 1 | 1/2 | 1 / 0 / 0 |
| q021 | 27 | 2 | 2/2 | 0 / 0 / 0 |
| q022 | 62 | 1 | 1/1 | 0 / 0 / 0 |
| q023 | 65 | 1 | 1/1 | 0 / 0 / 0 |
| q024 | 28 | 1 | 1/1 | 0 / 0 / 0 |
| q025 | 58 | 1 | 0/1 | 0 / 0 / 1 |
| q026 | 41 | 0 | 0/1 | 1 / 0 / 0 |
| q027 | 40 | 1 | 0/1 | 0 / 0 / 1 |
| q028 | 17 | 1 | 1/2 | 1 / 0 / 0 |
| q029 | 17 | 1 | 1/1 | 0 / 0 / 0 |
| q030 | 17 | 1 | 1/1 | 0 / 0 / 0 |
| q031 | 17 | 0 | 0/0 | 0 / 0 / 0 |
| q032 | 0 | 0 | 0/1 | 1 / 0 / 0 |
| q033 | 17 | 1 | 1/1 | 0 / 0 / 0 |
| q034 | 32 | 1 | 1/1 | 0 / 0 / 0 |
| q035 | 22 | 1 | 1/1 | 0 / 0 / 0 |
| q036 | 32 | 1 | 0/1 | 0 / 0 / 1 |
| q037 | 1 | 0 | 0/0 | 0 / 0 / 0 |
| q038 | 15 | 1 | 0/2 | 1 / 0 / 1 |
| q039 | 33 | 2 | 1/2 | 0 / 0 / 1 |

q003 misses an available positive paragraph despite 44 candidates; q032 retrieves
nothing and misses its available positive paragraph. q004 retrieves four useful
paragraphs but loses all four during allocation, in addition to two unavailable
source evidence units. q008 and q036 demonstrate weak lexical useful evidence.
q031 is the human-unanswerable case; q037 is answerable but has no supplied
evidence annotation. Their 0/0 values are not successes or labeled negatives.

## Local dogfood and privacy

After a build, run:

```sh
pnpm --silent development:retrieval
pnpm --silent development:retrieval:raw
# Explicit local, independently human-annotated JSON; no auto-discovery:
pnpm --silent development:retrieval --local .ctxalloc/retrieval-calibration/corpus.json
```

The raw command's exit 1 is expected for the preserved native score permutation
defect. The development command exits 0 for contract correctness, not retrieval
quality or Product Validation. There are no live-model options.

The local JSON schema is the public corpus shape: version/provenance, explicit
documents containing source type and blocks, and explicit queries containing
human positive/negative block IDs, evidence-unit carrier IDs, optional criticality
and annotation hashes. See `data.ts` and the public example. Author labels while
blinded to provider results; hashes/attestation record supplied provenance but
cannot independently prove a local annotator's identity or blindness. Unknown
passages remain unjudged. A four-megabyte limit and strict schema reject unexpected
fields. Files must resolve inside ignored `.ctxalloc/`; symlink escapes are rejected.
No embedded paths are followed and no directory is scanned.

Existing `.gitignore` and formatter/linter exclusions already protect `.ctxalloc/`.
Put source configurations, raw local materials and local reports there. The runner
writes its report to stdout and never uploads or commits local files. Published
output is projected to fixed metadata, hashes, query ordinals, source-type enums,
counts and metrics: no source text, query text, original user identifiers, paths,
worker identities, raw compiler traces, credentials or timestamps. Errors expose
only a fixed code. Git-safe export still requires review; hashes are identities,
not anonymization or proof of consent. This phase commits only attributed public
research text and sanitized measurements, not personal/project/client data.

## Limitations and Phase 22B recommendation

This attempt establishes a reproducible permissive **development** contract and
measures its cost. It does not fulfill the broader mixed-source usefulness
coverage requested for real project calibration. There are no independently
judged negatives, no atomic fact annotations or criticality labels, only one
unanswerable question, a small domain-specific English corpus, and paper identity
is supplied. No statistical generalization, end-to-end source-reader quality,
answer quality, latency benchmark or Product Validation PASS is claimed.

Proceed with the frozen permissive profile only as a Phase 22B candidate. First
freeze a provider-specific protocol, then collect a separate, unseen, independently
human-labeled local development-project/dogfood workload. Do not reuse these 39
questions to support the final claim. Phase 22B cases are **not authored here**.
The protocol must cover all missing source/query categories and explicitly define
budgets, production retrieval caps, positive/negative evidence, fact alternatives,
criticality and unanswerable cases before observing scores.

Proposed gates: 100% admission recall on retrieved useful units; 100% runtime-required
and annotated critical fact preservation; zero budget/scope/determinism violations;
per-stratum retrieval recall and final useful-fact preservation of at least 95%
at the predeclared production budget. Measure precision, false admissions,
retrieval misses and token reduction separately. Token reduction qualifies only
when preservation gates pass. These are proposed operating gates, not findings
on this calibration corpus. Negative judgments must be sufficiently complete to
interpret precision; otherwise report bounds and mark that gate unevaluated.
If retrieval or constrained allocation fails, investigate that owner separately;
do not invent a restrictive score threshold to make token reduction look better.
A separate adapter issue should fix/version native permutation arithmetic.

Historical evidence remains separate: `ctxalloc-eval-v1` MVP evidence, Phase 21C
frozen FAIL, Phase 21E frozen PASS, Phase 21E-R re-anchor, and Phase 22A DEVELOPMENT.
No original held-out experiment was rerun, relabeled, merged with these results,
or required to restore orphaned ancestry. No live LLM or LLM judge was invoked.

## Final local verification

The implementation at `f977065` passed the complete repository validation sequence;
this final documentation commit records the results. See
[`phase22a-verification.json`](evidence/phase22a-verification.json) for commands,
expected exits, exact counts and report hashes. The 23 command checks comprise
clean, frozen install, format, lint, typecheck, standalone tests, boundaries,
aggregate check, a second clean and build, declarations, CLI/API smoke, historical
v1, Phase 21A/B/C-integrity/D/E-reanchored, native observation, calibration,
whitespace audit and the explicit local-manifest smoke. Native observation
correctly exits **1** for its preserved permutation failure; all other commands
exit 0. A passing engineering sequence does not convert that raw failure into PASS.

Both standalone tests and aggregate check passed **191 files / 3,868 tests**, with
no skips; Phase 22A adds **5 files / 38 tests**. Boundary checks cover **11 workspace
packages** with no forbidden dependencies. The clean build covers **11 TypeScript
projects**, declaration checks validate **76 declarations**, and the built API
smoke passes **12 checks**. The built CLI smoke also passes. All **142 historical
frozen JavaScript artifacts** remain byte-identical after the clean build.

Historical Phase 21A/B/C-integrity/D reports reproduce their re-anchor verification
hashes. The re-anchored Phase 21E verifier authenticates the historical **PASS**;
Phase 21C retains its original **FAIL**. Historical v1 retains all **23 gate
results**, with **13 cases, 11 successful compilations, 2 matched expected failures,
0 unexpected/provider/determinism failures and 0 budget violations**. Its Product
Validation remains **FAIL**; revision, environment/timing and optional performance
execution fields are outside the semantic comparison.

The artifact/privacy/database audit covers **493 tracked or proposed files** and
**25 changed paths**. All **468 protected baseline files** remain byte-identical.
No forbidden generated artifact, credential-pattern match, unexpected protected
change or database side file outside ignored local state was found. Both the
preserved first native report and calibrated report reproduce byte-for-byte; an
explicit ignored local copy of the public manifest reproduces the calibrated
report exactly. No private corpus is committed. These checks validate the stated
privacy boundary; a pattern audit is not a proof that arbitrary future data is safe.

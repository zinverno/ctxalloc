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

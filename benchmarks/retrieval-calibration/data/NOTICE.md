# Public development corpus attribution

This subset is derived from **QASPER v0.3, training split**, by Pradeep Dasigi,
Kyle Lo, Iz Beltagy, Arman Cohan, Noah A. Smith and Matt Gardner (2021),
_A Dataset of Information-Seeking Questions and Answers Anchored in Research Papers_.

- Dataset: https://huggingface.co/datasets/allenai/qasper
- Publication: https://aclanthology.org/2021.naacl-main.365/
- License: Creative Commons Attribution 4.0 International,
  https://creativecommons.org/licenses/by/4.0/
- Original archive: https://qasper-dataset.s3.us-west-2.amazonaws.com/qasper-train-dev-v0.3.tgz

Changes: deterministic training-only subsampling; nonblank full-text paragraphs
become blocks; exactly duplicate paragraphs within a paper are coalesced;
human-selected evidence is joined by exact text; personal annotator identifiers,
free-form answers and unused fields are omitted. Questions and paragraph text
are unchanged. No human-annotation provenance is claimed for agent-written code,
documentation, or unit-test fixtures. No validation/test data is included.

Reproduce from the original training JSON with
`node scripts/import-phase22a-qasper.mjs <training-json>`, then format the output.
The provenance file authenticates the logical JSON independent of formatting.

# Phase 21E-R: historical evidence after squash integration

PR [#26](https://github.com/zinverno/ctxalloc/pull/26) was squash-merged. Its
complete integration tree is identical to the original Phase 21E final tree,
but the original protocol, freeze and results commits are **not ancestors of
merged main**. Phase 21E-R authenticates preserved historical content through
the integration commit. It does not restore ancestry, reconstruct chronology,
rerun the experiment or establish full Product Validation PASS.

Phase 22A has not started. This task adds no retrieval calibration, new held-out
dataset, selection experiment or live model evaluation.

## Independently verified integration

The clean starting branch was created from fetched `origin/main` at
`f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c`. GitHub's PR metadata confirms the
merged integration revision and original final head. The remote PR head ref
and locally available commit independently confirm that final head.

| Original experiment stage | Historical revision |
| --- | --- |
| Protocol, before authoring | `2e1db08110523d532775a041a8406f75c624c088` |
| Dataset/freeze, before execution | `ebebc9b5671fc55acee4eb84fce047821d1c5ea2` |
| First-run results | `210efbd015b98499454a3d48dbe1208b668fdc30` |
| Original final PR head | `8dbba53b3d1d8719f932458f3e2c85e1ca264cd3` |

The original protocol → freeze → results → final-head ancestry was checked
against the available original Git objects during this one-time proof. All
four original commits fail `git merge-base --is-ancestor <original> <integration>`
with exit code 1. They remain provenance identities, not integration ancestors.

| Integration proof | Value |
| --- | --- |
| Canonical integration revision | `f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c` |
| Integration's sole parent | `9dceacbd320ddaaa642b2484d876cec21c302d06` |
| Original final head tree OID | `30c355fa7b079c0f98d91f494fb4feb7e12faef0` |
| Integration tree OID | `30c355fa7b079c0f98d91f494fb4feb7e12faef0` |
| Exact complete Git tree equality | Proven |

Tree equality covers file paths, modes and contents across the complete handoff,
not only selected evidence files. It says nothing about commit chronology. The
squash revision is not the original freeze revision. No history was rewritten;
there was no force-push, cherry-pick, amendment or recreation of old ancestry.

## Immutable evidence

| Artifact or evidence | SHA-256 |
| --- | --- |
| Original first report, 1,097,510 bytes | `4c3114ca7dc301fe79e55559c21bc647fa2290b4356b6389096ea960b2896646` |
| Stable original evidence | `24423484552fb656906888f8d90c96fa0e8140bdc8739451dceec75d5091acff` |
| Original freeze manifest | `f7210ac39e7e5b8fc97bf62608b57994c454c1f4c84ba7f97d28c179df0204b2` |
| New re-anchor manifest, version 1 | `82dc0e77413573478caf9789f79474fcaa66235f9171044456e2b3246c9cf6fe` |

The [re-anchor manifest](evidence/phase21e-reanchor.json) records the experiment
identities, both complete tree OIDs, integration anchor, one-time proof,
21 frozen artifact hashes, original report and evidence hashes, and inventory
digests for 220 semantic files, 142 built artifact identities and 60
input/annotation/policy hash triples. The original manifest and report were
compared byte-for-byte against the original freeze/results commits, respectively.
No first-run report was regenerated or reformatted.

All 220 original semantic hashes were independently checked against the original
freeze during re-anchoring. Of these, 218 match the integration tree. The other
two are the already disclosed post-observation `package.json` and
`.github/workflows/ci.yml` command/CI wiring changes. The new manifest embeds
their exact original UTF-8 bytes and pins both original and integration hashes.
This preserves verification of all 220 original identities without falsely
claiming that the final integration wiring equals the freeze wiring.

The 142 original JavaScript artifact hashes remain authenticated historical
identities in the unchanged freeze manifest. The persistent verifier does not
rebuild them or claim executable reproduction. The original protocol, cases,
annotations, policies, gates, evaluator, report, historical verification output
and Phase 21C artifacts remain byte-preserved in this change.

## New versioned verifier

After a build, run from a checkout containing the committed re-anchor:

```sh
pnpm --silent validation:heldout:v2:reanchored
```

The command runs `benchmarks/reanchored-v2/run.ts`'s built entry point. Version 1:

1. Requires the canonical integration revision to be an ancestor of `HEAD`
   and verifies its pinned complete tree OID.
2. Authenticates the re-anchor manifest's exact bytes against a SHA-256 literal
   in the versioned verifier and requires them to equal the committed `HEAD`
   blob. An uncommitted or modified manifest is rejected.
3. Reads historical files from the integration Git tree, checks its frozen
   inventory and all 21 artifact hashes, and authenticates the original report
   and freeze manifest before parsing them.
4. Recomputes all 60 input/annotation/policy hash triples independently of any
   compiler or evaluator. Checks all 220 semantic identities using the integration
   tree plus the two authenticated original wiring snapshots.
5. Checks the 142 retained built identities, original evidence hash, stored
   experiment identities, and the unchanged original Phase 21E PASS.

The output is deterministic JSON. Its top-level `status: "PASS"` means historical
integrity. The original selection verdict, 60 requests, 43 successful compilations,
17 expected failures and 19 gates are nested under `historicalEvidence`. They
describe the original run only. The output explicitly reports:

```json
{
  "verification": "historical-integrity-after-squash-integration",
  "compilerExecuted": false,
  "selectionExecuted": false,
  "originalExecutableReproduced": false,
  "originalAncestryRestored": false,
  "orphanedCommitsRequired": false
}
```

The verifier imports only Node utilities. It performs no network access or Git
lookup of any original experiment commit. A test repository fetched with only
the integration lineage verifies successfully while all four original objects
are absent. A subsequent test commit changes compiler and working report files
and still verifies the original integration evidence. Future working compiler
files, tests and historical working copies are not a source of historical truth
for this command. Changes to historical bytes at the integration boundary fail
authentication; current working copies are separately covered by change audits.

This is a repository hash trust boundary, not a cryptographic signature or an
independent timestamping service. The one-time tree-equality proof is pinned in
the committed manifest and verifier; future runs authenticate that attestation
and the integration tree rather than requiring orphaned objects forever. The
canonical integration commit and its Git objects must remain locally available;
CI retains full-history checkout. Changing both the verifier and its trust root
requires review as a new integrity policy, not silent acceptance of new evidence.

## Original verifier and separate historical results

The original `validation:heldout:v2:historical` command and its implementation
are unchanged. During this task it passed on an isolated checkout of the original
final PR head, verifying 21 frozen files, 220 semantic identities, 142 built
identities and 60 triples without selection. It correctly rejects the merged
lineage at the original ancestry guard. Its former seven current-tree tests
are replaced with two integration-appropriate tests (implementation bytes and
early ancestry rejection); the separate new suite supplies 26 integrity,
tamper, future-descendant and absent-object checks. No tests are skipped.

CI now invokes the explicitly named re-anchored command. The frozen Phase 21E
executable and its documented report-reader buffer limitation remain unchanged;
neither that executable nor the Phase 21C held-out runner is invoked here.
Routine repository regression tests and Phase 21A/B/D development checks still
exercise compiler behavior on their existing development/toy inputs.

The Phase 21E PASS remains bounded, synthetic, historical evidence. Both
misleading-complete cases still preserve 0/4 useful facts in the original report.
Phase 21C remains its separate frozen FAIL; historical v1 Product Validation
also remains FAIL. No evidence is pooled or reinterpreted as real retrieval
calibration, live answer quality, or full Product Validation PASS.

## Phase 22 prerequisite

Phase 22A may start only from actual merged main after this re-anchor has been
integrated and all of the following hold:

- `f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c` is an ancestor of current main.
- The committed re-anchor manifest is present, authentic and versioned.
- `validation:heldout:v2:reanchored` passes, including the original report hash,
  stable evidence hash and historical Phase 21E PASS.
- `validation:heldout:historical` passes integrity and retains Phase 21C FAIL.
- Complete applicable repository baseline validation passes.

That prerequisite uses the integration anchor in place of the orphaned Phase
21E ancestry requirement. Original experiment SHAs remain recorded, never
relabeled as restored ancestors. This re-anchor PR is opened for review and is
not merged by this task.

## Privacy and validation boundary

New evidence contains repository revisions, public repository file identifiers,
hashes, counts and two public wiring snapshots. It contains no private notes,
conversations, user queries, credentials, machine paths or timestamps. Original
reports and existing historical validation remain separate artifacts.

The final regression and artifact audit results are recorded after the
implementation commit, so the CLI can authenticate an actually committed
re-anchor manifest.

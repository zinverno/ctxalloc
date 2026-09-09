import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const RESULTS_REVISION = '210efbd015b98499454a3d48dbe1208b668fdc30';
const FREEZE_REVISION = 'ebebc9b5671fc55acee4eb84fce047821d1c5ea2';
const PROTOCOL_REVISION = '2e1db08110523d532775a041a8406f75c624c088';
const MANIFEST = 'benchmarks/heldout-v2/v2/freeze.json';
const REPORT = 'docs/evidence/phase21e-first-run.json';
const REPORT_HASH = 'sha256:4c3114ca7dc301fe79e55559c21bc647fa2290b4356b6389096ea960b2896646';
const EVIDENCE_HASH = 'sha256:24423484552fb656906888f8d90c96fa0e8140bdc8739451dceec75d5091acff';
const frozen = (p: string) =>
  p.startsWith('benchmarks/heldout-v2/') ||
  p.startsWith('tests/heldout-v2/') ||
  p === 'docs/PHASE21E_HELD_OUT_PROTOCOL.md' ||
  p === REPORT;
const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// The historical encoding is intentionally independent of executable evaluators and current policies.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Historical JSON must be defined.');
  return encoded;
}
const hashJson = (value: unknown) => hash(canonical(value));
/** Artifact integrity only. Does not import or execute a compiler, scorer, renderer, or evaluator. */
export function verifyPhase21EHistory(
  root: string,
  readCurrent: (path: string) => Buffer = (path) => readFileSync(join(root, path)),
) {
  // The preserved report exceeds Node's default 1 MiB synchronous child-process buffer.
  // This new verifier can read it; the original frozen runner remains unchanged.
  const git = (args: readonly string[]) =>
    execFileSync('git', [...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  git(['merge-base', '--is-ancestor', RESULTS_REVISION, 'HEAD']);
  git(['merge-base', '--is-ancestor', FREEZE_REVISION, RESULTS_REVISION]);
  git(['merge-base', '--is-ancestor', PROTOCOL_REVISION, FREEZE_REVISION]);
  const original = (p: string) => git(['show', `${RESULTS_REVISION}:${p}`]);
  const paths = git(['ls-tree', '-r', '--name-only', RESULTS_REVISION])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(frozen)
    .sort();
  const currentPaths = git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(frozen)
    .sort();
  if (hashJson(paths) !== hashJson(currentPaths))
    throw new Error('Frozen Phase 21E inventory changed.');
  for (const p of paths)
    if (!readCurrent(p).equals(original(p))) throw new Error(`Frozen artifact changed: ${p}`);
  const manifestBytes = readCurrent(MANIFEST);
  if (!manifestBytes.equals(git(['show', `${FREEZE_REVISION}:${MANIFEST}`])))
    throw new Error('Original freeze changed.');
  const reportBytes = readCurrent(REPORT);
  if (hash(reportBytes) !== REPORT_HASH) throw new Error('Original Phase 21E report hash changed.');
  // Types describe bytes authenticated against the original commits, not unchecked external JSON.
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    semanticsFiles: readonly { path: string; sha256: string }[];
    builtArtifacts: readonly unknown[];
    cases: readonly unknown[];
    caseCount: number;
    protocolRevision: string;
  };
  const report = JSON.parse(reportBytes.toString('utf8')) as {
    evidenceHash: string;
    heldOutEvidenceAwareContextSelection: string;
    heldOutFreezeRevision: string;
    protocolRevision: string;
    contractCorrectness: string;
    primarySelectionEffectiveness: string;
    misleadingRiskDisclosure: string;
    cases: readonly { status: string }[];
    gates: readonly { id: string; state: string }[];
  };
  const cases = JSON.parse(
    readCurrent('benchmarks/heldout-v2/v2/cases.json').toString('utf8'),
  ) as readonly {
    id: string;
    input: { policy: unknown };
    annotations: unknown;
    expectedFailure: unknown;
    evidenceCondition: string;
  }[];
  const caseHashes = cases.map((c) => ({
    caseId: c.id,
    inputHash: hashJson(c.input),
    annotationHash: hashJson(c.annotations),
    policyHash: hashJson(c.input.policy),
    expectedFailure: c.expectedFailure,
    evidenceCondition: c.evidenceCondition,
  }));
  if (hashJson(caseHashes) !== hashJson(manifest.cases))
    throw new Error('Historical case hashes changed.');
  for (const row of manifest.semanticsFiles)
    if (hash(git(['show', `${FREEZE_REVISION}:${row.path}`])) !== row.sha256)
      throw new Error(`Original semantic hash changed: ${row.path}`);
  const evidence = Object.fromEntries(
    Object.entries(report).filter(([k]) => k !== 'evidenceHash' && k !== 'runtimeProvenance'),
  );
  if (
    hashJson(evidence) !== EVIDENCE_HASH ||
    report.evidenceHash !== EVIDENCE_HASH ||
    report.heldOutFreezeRevision !== FREEZE_REVISION ||
    report.protocolRevision !== PROTOCOL_REVISION ||
    manifest.protocolRevision !== PROTOCOL_REVISION
  )
    throw new Error('Original evidence or provenance changed.');
  return {
    schemaVersion: 1,
    verification: 'historical-artifact-integrity-only',
    status: 'PASS' as const,
    originalResultsRevision: RESULTS_REVISION,
    protocolRevision: PROTOCOL_REVISION,
    originalFreezeRevision: FREEZE_REVISION,
    immutableWorkingFilesVerified: paths.length,
    originalSemanticsFilesVerifiedAgainstFreezeTree: manifest.semanticsFiles.length,
    originalBuiltArtifactHashesPreserved: manifest.builtArtifacts.length,
    compilerExecuted: false,
    originalExecutableReproduced: false,
    originalRunnerLimitation:
      'Committed first report exceeds default git-show child-process buffer; frozen runner retained unchanged.',
    caseCount: manifest.caseCount,
    caseInputAnnotationPolicyHashesVerified: caseHashes.length,
    successfulCompilations: report.cases.filter((c) => c.status === 'success').length,
    expectedFailures: report.cases.filter((c) => c.status === 'expected-failure').length,
    unexpectedOutcomes: report.cases.filter(
      (c) => c.status === 'unexpected-failure' || c.status === 'unexpected-success',
    ).length,
    contractCorrectness: report.contractCorrectness,
    primarySelectionEffectiveness: report.primarySelectionEffectiveness,
    misleadingRiskDisclosure: report.misleadingRiskDisclosure,
    heldOutEvidenceAwareContextSelection: report.heldOutEvidenceAwareContextSelection,
    gates: report.gates.map(({ id, state }) => ({ id, state })),
    manifestHash: hash(manifestBytes),
    firstReportSha256: REPORT_HASH,
    evidenceHash: EVIDENCE_HASH,
  };
}

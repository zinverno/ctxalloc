import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PHASE21C_MERGED_BASELINE = '087078538adad2f353812117c3fe1353a49cc505';
const MANIFEST = 'benchmarks/heldout/v1/freeze.json';
const REPORT = 'docs/evidence/phase21c-first-run.json';
const MANIFEST_HASH = 'sha256:36a0e5c13243991fe861d40b162a9aaf9eaeb839bb25b26f71c25014174baba3';
const REPORT_HASH = 'sha256:3144a9f8c505f46c45e142dccf1da24feef149a38ed280d630910aa39945a4e1';
const EVIDENCE_HASH = 'sha256:176c9642c61e97f44aa2e02776be2e038c6c1d5363f68e1c8723dd52c78037d5';
const frozen = (path: string) =>
  path.startsWith('benchmarks/heldout/') ||
  path.startsWith('tests/heldout/') ||
  [
    'docs/PHASE21C_HELD_OUT_PROTOCOL.md',
    'docs/PHASE21C_HELD_OUT_VALIDATION.md',
    REPORT,
    'docs/evidence/phase21c-verification.json',
  ].includes(path);
const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// The frozen JSON hash encoding is reproduced here so verification imports no executable evaluator.
function historicalCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(historicalCanonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => JSON.stringify(key) + ':' + historicalCanonicalJson(child))
        .join(',') +
      '}'
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Historical JSON must be defined.');
  return encoded;
}
const hashJson = (value: unknown) => hash(historicalCanonicalJson(value));

/** Artifact integrity only. Never imports or executes either compiler or held-out evaluator. */
export function verifyPhase21CHistory(
  root: string,
  readCurrent: (path: string) => Buffer = (path) => readFileSync(join(root, path)),
) {
  const git = (args: readonly string[]) => execFileSync('git', [...args], { cwd: root });
  git(['merge-base', '--is-ancestor', PHASE21C_MERGED_BASELINE, 'HEAD']);
  const baseline = (path: string) => git(['show', `${PHASE21C_MERGED_BASELINE}:${path}`]);
  const paths = git(['ls-tree', '-r', '--name-only', PHASE21C_MERGED_BASELINE])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(frozen);
  const currentPaths = git(['ls-files', '--cached', '--others', '--exclude-standard'])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(frozen)
    .sort();
  if (JSON.stringify(currentPaths) !== JSON.stringify([...paths].sort()))
    throw new Error('Frozen Phase 21C file inventory changed.');
  for (const path of paths) {
    if (!readCurrent(path).equals(baseline(path)))
      throw new Error(`Frozen artifact changed: ${path}`);
  }
  const manifestBytes = readCurrent(MANIFEST);
  const reportBytes = readCurrent(REPORT);
  if (hash(manifestBytes) !== MANIFEST_HASH || hash(reportBytes) !== REPORT_HASH)
    throw new Error('Original Phase 21C hash anchor changed.');
  // Parsing follows pinned byte verification; these are historical JSON formats, not current policy schemas.
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    semanticsFiles: readonly { path: string; sha256: string }[];
    builtArtifacts: readonly { path: string; sha256: string }[];
    caseCount: number;
    cases: readonly unknown[];
  };
  const report = JSON.parse(reportBytes.toString('utf8')) as {
    evidenceHash: string;
    heldOutContextSelectionValidation: string;
    heldOutFreezeRevision: string;
    protocolRevision: string;
    cases: readonly { status: string }[];
    gates: readonly { id: string; state: string }[];
  };
  const rawCases = JSON.parse(
    readCurrent('benchmarks/heldout/v1/cases.json').toString('utf8'),
  ) as readonly {
    id: string;
    profile: string;
    stratum: string;
    replica: number;
    budgetRegime: string;
    input: { policy: unknown };
    annotations: unknown;
  }[];
  const caseHashes = rawCases.map((c) => ({
    caseId: c.id,
    profile: c.profile,
    stratum: c.stratum,
    replica: c.replica,
    budgetRegime: c.budgetRegime,
    inputHash: hashJson(c.input),
    annotationHash: hashJson(c.annotations),
    policyHash: hashJson(c.input.policy),
  }));
  if (hashJson(caseHashes) !== hashJson(manifest.cases))
    throw new Error('Historical input, annotation or policy hash mismatch.');
  const originalEvidence = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== 'evidenceHash' && key !== 'runtimeProvenance'),
  );
  if (hashJson(originalEvidence) !== EVIDENCE_HASH)
    throw new Error('Historical evidence hash mismatch.');
  for (const row of manifest.semanticsFiles) {
    if (hash(baseline(row.path)) !== row.sha256)
      throw new Error(`Merged baseline differs from frozen semantics: ${row.path}`);
  }
  if (report.evidenceHash !== EVIDENCE_HASH || report.heldOutContextSelectionValidation !== 'FAIL')
    throw new Error('Historical Phase 21C result changed.');
  return {
    schemaVersion: 1,
    verification: 'historical-artifact-integrity-only',
    status: 'PASS' as const,
    mergedBaseline: PHASE21C_MERGED_BASELINE,
    protocolRevision: report.protocolRevision,
    originalFreezeRevision: report.heldOutFreezeRevision,
    immutableWorkingFilesVerified: paths.length,
    originalSemanticsFilesVerifiedAgainstMergedTree: manifest.semanticsFiles.length,
    originalBuiltArtifactHashesPreserved: manifest.builtArtifacts.length,
    changedCompilerExecuted: false,
    originalExecutableReproduced: false,
    caseCount: manifest.caseCount,
    caseInputAnnotationPolicyHashesVerified: caseHashes.length,
    successfulCompilations: report.cases.filter((c) => c.status === 'success').length,
    expectedFailures: report.cases.filter((c) => c.status === 'expected-failure').length,
    unexpectedFailures: report.cases.filter((c) => c.status === 'unexpected-failure').length,
    heldOutContextSelectionValidation: report.heldOutContextSelectionValidation,
    gates: report.gates.map(({ id, state }) => ({ id, state })),
    manifestHash: MANIFEST_HASH,
    firstReportSha256: REPORT_HASH,
    evidenceHash: EVIDENCE_HASH,
  };
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PHASE21E_INTEGRATION = 'f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c';
export const PHASE21E_REANCHOR = 'docs/evidence/phase21e-reanchor.json';
export const PHASE21E_REANCHOR_HASH =
  'sha256:82dc0e77413573478caf9789f79474fcaa66235f9171044456e2b3246c9cf6fe';
const TREE = '30c355fa7b079c0f98d91f494fb4feb7e12faef0';
type HashRow = { path: string; sha256: string };
type GitReader = (args: readonly string[]) => Buffer;
const hash = (bytes: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// Independent historical JSON encoding. No compiler or evaluator imports.
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
const frozen = (p: string) =>
  p.startsWith('benchmarks/heldout-v2/') ||
  p.startsWith('tests/heldout-v2/') ||
  p === 'docs/PHASE21E_HELD_OUT_PROTOCOL.md' ||
  p === 'docs/evidence/phase21e-first-run.json';

/**
 * Version 1: authenticate historical bytes after squash integration.
 * Only the integration anchor and HEAD are read from Git; original experiment
 * SHAs are provenance, never object lookup or ancestry dependencies.
 * Reader seams support corruption tests; the CLI always uses the real defaults.
 */
export function verifyPhase21EReanchor(
  root: string,
  readCurrent: (path: string) => Buffer = (path) => readFileSync(join(root, path)),
  git: GitReader = (args) =>
    execFileSync('git', [...args], { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
) {
  git(['merge-base', '--is-ancestor', PHASE21E_INTEGRATION, 'HEAD']);
  if (
    git(['rev-parse', `${PHASE21E_INTEGRATION}^{tree}`])
      .toString('utf8')
      .trim() !== TREE
  )
    throw new Error('Integration tree identity changed.');

  const reanchorBytes = readCurrent(PHASE21E_REANCHOR);
  if (hash(reanchorBytes) !== PHASE21E_REANCHOR_HASH)
    throw new Error('Re-anchor manifest hash changed.');
  if (!reanchorBytes.equals(git(['show', `HEAD:${PHASE21E_REANCHOR}`])))
    throw new Error('Re-anchor manifest must match committed HEAD.');
  // All JSON below is parsed only after pinned byte authentication.
  const reanchor = JSON.parse(reanchorBytes.toString('utf8')) as {
    schemaVersion: number;
    id: string;
    version: string;
    experiment: {
      id: string;
      version: string;
      phase: string;
      protocolRevision: string;
      freezeRevision: string;
      resultsRevision: string;
      finalHead: string;
      finalTreeOid: string;
    };
    integration: {
      revision: string;
      treeOid: string;
      treeEqualityProven: boolean;
      originalExperimentCommitsAreAncestors: boolean;
    };
    firstReport: HashRow & { evidenceHash: string };
    frozenManifest: HashRow;
    frozenArtifacts: readonly HashRow[];
    semanticInventory: {
      count: number;
      sha256: string;
      unchangedAtIntegration: number;
      postObservationExceptions: readonly {
        path: string;
        originalSha256: string;
        integrationSha256: string;
        originalUtf8: string;
      }[];
    };
    builtArtifactIdentities: { count: number; sha256: string };
    caseHashTriples: { count: number; sha256: string };
  };
  const cache = new Map<string, Buffer>();
  const atIntegration = (path: string): Buffer => {
    let bytes = cache.get(path);
    if (bytes === undefined) {
      bytes = git(['show', `${PHASE21E_INTEGRATION}:${path}`]);
      cache.set(path, bytes);
    }
    return bytes;
  };
  const authenticated = (row: HashRow): Buffer => {
    const bytes = atIntegration(row.path);
    if (hash(bytes) !== row.sha256) throw new Error(`Historical artifact changed: ${row.path}`);
    return bytes;
  };
  const paths = git(['ls-tree', '-r', '--name-only', PHASE21E_INTEGRATION])
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(frozen)
    .sort();
  if (hashJson(paths) !== hashJson(reanchor.frozenArtifacts.map((r) => r.path)))
    throw new Error('Historical frozen inventory changed.');
  for (const row of reanchor.frozenArtifacts) authenticated(row);
  const manifest = JSON.parse(authenticated(reanchor.frozenManifest).toString('utf8')) as {
    dataset: { id: string; version: string };
    protocolRevision: string;
    semanticsFiles: readonly HashRow[];
    builtArtifacts: readonly HashRow[];
    caseCount: number;
    cases: readonly unknown[];
  };
  const report = JSON.parse(authenticated(reanchor.firstReport).toString('utf8')) as {
    evidenceHash: string;
    protocolRevision: string;
    heldOutFreezeRevision: string;
    heldOutEvidenceAwareContextSelection: string;
    contractCorrectness: string;
    primarySelectionEffectiveness: string;
    misleadingRiskDisclosure: string;
    cases: readonly { status: string }[];
    gates: readonly { id: string; state: string }[];
  };
  const cases = JSON.parse(
    atIntegration('benchmarks/heldout-v2/v2/cases.json').toString('utf8'),
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
  if (
    hashJson(caseHashes) !== hashJson(manifest.cases) ||
    hashJson(caseHashes) !== reanchor.caseHashTriples.sha256 ||
    caseHashes.length !== reanchor.caseHashTriples.count ||
    manifest.caseCount !== caseHashes.length
  )
    throw new Error('Historical input, annotation or policy hashes changed.');

  const inventory = reanchor.semanticInventory;
  if (
    hashJson(manifest.semanticsFiles) !== inventory.sha256 ||
    manifest.semanticsFiles.length !== inventory.count
  )
    throw new Error('Original semantic inventory changed.');
  const exceptions = new Map(inventory.postObservationExceptions.map((row) => [row.path, row]));
  let unchanged = 0;
  for (const row of manifest.semanticsFiles) {
    const exception = exceptions.get(row.path);
    if (exception) {
      if (
        exception.originalSha256 !== row.sha256 ||
        hash(exception.originalUtf8) !== row.sha256 ||
        hash(atIntegration(row.path)) !== exception.integrationSha256
      )
        throw new Error(`Historical wiring snapshot changed: ${row.path}`);
      exceptions.delete(row.path);
    } else {
      authenticated(row);
      unchanged++;
    }
  }
  if (exceptions.size !== 0 || unchanged !== inventory.unchangedAtIntegration)
    throw new Error('Historical semantic exceptions changed.');
  if (
    manifest.builtArtifacts.length !== reanchor.builtArtifactIdentities.count ||
    hashJson(manifest.builtArtifacts) !== reanchor.builtArtifactIdentities.sha256
  )
    throw new Error('Original built artifact identities changed.');

  const evidence = Object.fromEntries(
    Object.entries(report).filter(([k]) => k !== 'evidenceHash' && k !== 'runtimeProvenance'),
  );
  if (
    hashJson(evidence) !== reanchor.firstReport.evidenceHash ||
    report.evidenceHash !== reanchor.firstReport.evidenceHash ||
    report.protocolRevision !== reanchor.experiment.protocolRevision ||
    report.heldOutFreezeRevision !== reanchor.experiment.freezeRevision ||
    manifest.protocolRevision !== reanchor.experiment.protocolRevision ||
    hashJson(manifest.dataset) !==
      hashJson({
        id: reanchor.experiment.id,
        version: reanchor.experiment.version,
        split: 'held-out',
      }) ||
    reanchor.integration.revision !== PHASE21E_INTEGRATION ||
    reanchor.integration.treeOid !== TREE ||
    reanchor.experiment.finalTreeOid !== TREE ||
    !reanchor.integration.treeEqualityProven ||
    reanchor.integration.originalExperimentCommitsAreAncestors ||
    report.heldOutEvidenceAwareContextSelection !== 'PASS'
  )
    throw new Error('Original evidence or provenance changed.');

  return {
    schemaVersion: 1,
    verifier: { id: reanchor.id, version: reanchor.version },
    verification: 'historical-integrity-after-squash-integration',
    status: 'PASS' as const,
    integrationRevision: PHASE21E_INTEGRATION,
    integrationTreeOid: TREE,
    originalExperiment: reanchor.experiment,
    treeEqualityProvenAtReanchor: true,
    originalAncestryRestored: false,
    orphanedCommitsRequired: false,
    compilerExecuted: false,
    selectionExecuted: false,
    originalExecutableReproduced: false,
    historicalContentSource: 'canonical-integration-revision',
    immutableIntegrationFilesVerified: paths.length,
    originalSemanticFilesVerified: manifest.semanticsFiles.length,
    semanticFilesMatchingIntegration: unchanged,
    originalWiringSnapshotsVerified: inventory.postObservationExceptions.length,
    originalBuiltArtifactHashesPreserved: manifest.builtArtifacts.length,
    caseInputAnnotationPolicyHashesVerified: caseHashes.length,
    reanchorManifestSha256: PHASE21E_REANCHOR_HASH,
    manifestHash: reanchor.frozenManifest.sha256,
    firstReportSha256: reanchor.firstReport.sha256,
    evidenceHash: reanchor.firstReport.evidenceHash,
    historicalEvidence: {
      interpretation:
        'Original Phase 21E result only; no new selection or Product Validation claim.',
      caseCount: manifest.caseCount,
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
    },
  };
}

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTEXT_RENDERER_ID, CONTEXT_RENDERER_VERSION } from '@ctxalloc/compiler';
import { O200K_BASE_TOKENIZER_ID, O200K_BASE_TOKENIZER_VERSION } from '@ctxalloc/tokenization';
import type { Tokenizer } from '@ctxalloc/ports';
import { artifactPaths, fileHashes, git } from '../heldout/integrity.js';
import { array, fail, hashBytes, hashJson, object, parseCase, validateMatrix } from './data.js';
import { BASELINE, COMPILER, DATASET, GATE_LIMITS, MATRIX, METRICS, PROFILES } from './protocol.js';
import { evaluationProfile } from './profiles.js';
export { artifactPaths, fileHashes, git } from '../heldout/integrity.js';
export const PROTOCOL_PATH = 'docs/PHASE21E_HELD_OUT_PROTOCOL.md';
export const DATA_PATH = 'benchmarks/heldout-v2/v2/cases.json';
export const AUTHORING_PATH = 'benchmarks/heldout-v2/v2/authoring.json';
export const MANIFEST_PATH = 'benchmarks/heldout-v2/v2/freeze.json';
export const FIRST_REPORT_PATH = 'docs/evidence/phase21e-first-run.json';
const protectedPath = (p: string) =>
  p !== MANIFEST_PATH &&
  (((p.startsWith('packages/') || p.startsWith('apps/')) &&
    (p.includes('/src/') || p.endsWith('/package.json') || p.endsWith('/tsconfig.json'))) ||
    (p.startsWith('benchmarks/') && !p.includes('/dist/')) ||
    p.startsWith('tests/heldout-v2/') ||
    p.startsWith('tests/heldout/') ||
    p.startsWith('scripts/') ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.typecheck.json',
      'vitest.config.ts',
      'eslint.config.mjs',
      '.prettierignore',
      '.nvmrc',
      '.github/workflows/ci.yml',
      PROTOCOL_PATH,
      'docs/METRICS.md',
      'docs/PHASE21C_HELD_OUT_PROTOCOL.md',
    ].includes(p));
export function semanticsPaths(root: string): readonly string[] {
  return [
    ...new Set(
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
        .split('\n')
        .filter(protectedPath),
    ),
  ].sort();
}
function introduction(root: string, path: string): string {
  const revisions = git(root, ['log', '--diff-filter=A', '--format=%H', '--', path])
    .split('\n')
    .filter(Boolean);
  if (revisions.length !== 1) fail(`A unique committed ${path} is required before proceeding.`);
  const revision = revisions[0]!;
  execFileSync('git', ['merge-base', '--is-ancestor', revision, 'HEAD'], { cwd: root });
  return revision;
}
export function requireProtocolCommit(root: string): string {
  const revision = introduction(root, PROTOCOL_PATH);
  execFileSync('git', ['merge-base', '--is-ancestor', BASELINE, revision], { cwd: root });
  if (
    git(root, ['ls-tree', '-r', '--name-only', revision, '--', 'benchmarks/heldout-v2/v2']) !== ''
  )
    fail('Protocol must precede held-out authoring.');
  return revision;
}
function verifyFixedSemantics(root: string, protocolRevision: string) {
  const current = semanticsPaths(root).filter((p) => p !== DATA_PATH && p !== AUTHORING_PATH);
  const original = git(root, ['ls-tree', '-r', '--name-only', protocolRevision])
    .split('\n')
    .filter(protectedPath)
    .sort();
  if (hashJson(current) !== hashJson(original))
    fail('Semantic inventory changed after protocol registration.');
  for (const path of current) {
    const bytes = execFileSync('git', ['show', `${protocolRevision}:${path}`], { cwd: root });
    if (!bytes.equals(readFileSync(join(root, path))))
      fail(`Protocol-frozen semantics changed: ${path}`);
  }
  const historicalPath = (p: string) =>
    ((p.startsWith('packages/') || p.startsWith('apps/') || p.startsWith('benchmarks/')) &&
      !p.startsWith('benchmarks/heldout-v2/')) ||
    p === 'pnpm-lock.yaml';
  const baseline = git(root, ['ls-tree', '-r', '--name-only', BASELINE])
    .split('\n')
    .filter(historicalPath)
    .sort();
  const actual = git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter(historicalPath)
    .sort();
  if (hashJson(baseline) !== hashJson(actual))
    fail('Merged compiler or historical inventory changed.');
  for (const path of baseline) {
    const bytes = execFileSync('git', ['show', `${BASELINE}:${path}`], { cwd: root });
    if (!bytes.equals(readFileSync(join(root, path))))
      fail(`Merged compiler or historical evidence changed: ${path}`);
  }
}
export function validateFrozenCases(rawCases: readonly unknown[], tokenizer: Tokenizer) {
  const cases = rawCases.map((c) => parseCase(c, tokenizer));
  validateMatrix(cases);
  return cases;
}
/** Reads hashes and validates schemas/cross-field declarations only; never executes selection. */
export function buildManifest(root: string, rawCases: readonly unknown[], tokenizer: Tokenizer) {
  const protocolRevision = requireProtocolCommit(root);
  verifyFixedSemantics(root, protocolRevision);
  const cases = validateFrozenCases(rawCases, tokenizer);
  return {
    schemaVersion: 1,
    dataset: DATASET,
    caseCount: MATRIX.length,
    baselineRevision: BASELINE,
    protocolRevision,
    matrix: MATRIX,
    tokenizer: { id: O200K_BASE_TOKENIZER_ID, version: O200K_BASE_TOKENIZER_VERSION },
    renderer: { id: CONTEXT_RENDERER_ID, version: CONTEXT_RENDERER_VERSION },
    compiler: COMPILER,
    schemas: { scoring: 2, filtering: 3, trace: 4, evidenceObservation: 1 },
    profiles: PROFILES.map((id) =>
      evaluationProfile(id, {
        tenantId: 'heldout-v2',
        workspaceId: 'second-freeze',
        projectId: 'profile-identity',
      }),
    ),
    metrics: METRICS,
    gates: GATE_LIMITS,
    cases: cases.map((c) => ({
      caseId: c.id,
      inputHash: hashJson(c.input),
      annotationHash: hashJson(c.annotations),
      policyHash: hashJson(object(c.input).policy),
      expectedFailure: c.expectedFailure,
      evidenceCondition: c.evidenceCondition,
    })),
    semanticsFiles: fileHashes(root, semanticsPaths(root)),
    builtArtifacts: fileHashes(root, artifactPaths(root)),
  };
}
/** Must complete before any real held-out observation. A file alone never authorizes execution. */
export function loadVerifiedDataset(root: string, tokenizer: Tokenizer) {
  const heldOutFreezeRevision = introduction(root, MANIFEST_PATH);
  const protocolRevision = requireProtocolCommit(root);
  if (protocolRevision === heldOutFreezeRevision)
    fail('Separate protocol and freeze commits are required.');
  execFileSync('git', ['merge-base', '--is-ancestor', protocolRevision, heldOutFreezeRevision], {
    cwd: root,
  });
  const frozen = execFileSync('git', ['show', `${heldOutFreezeRevision}:${MANIFEST_PATH}`], {
    cwd: root,
  });
  const current = readFileSync(join(root, MANIFEST_PATH));
  if (!frozen.equals(current)) fail('Original second freeze manifest was modified.');
  const raw = array(JSON.parse(readFileSync(join(root, DATA_PATH), 'utf8')));
  const manifest = buildManifest(root, raw, tokenizer);
  if (hashJson(JSON.parse(current.toString('utf8'))) !== hashJson(manifest))
    fail(
      'Second held-out inputs, annotations, semantics or built artifacts differ from the freeze.',
    );
  return {
    cases: raw.map((c) => parseCase(c, tokenizer)),
    manifest,
    heldOutFreezeRevision,
    manifestHash: hashBytes(current),
    runtimeProvenance: { head: git(root, ['rev-parse', 'HEAD']), nodeVersion: process.version },
  };
}

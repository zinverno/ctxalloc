import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { O200K_BASE_TOKENIZER_ID, O200K_BASE_TOKENIZER_VERSION } from '@ctxalloc/tokenization';
import { admissionProfile } from '../admission-development/profiles.js';
import {
  array,
  fail,
  hashBytes,
  hashJson,
  object,
  parseCase,
  string,
  validateMatrix,
} from './data.js';
import { GATE_DEFINITIONS } from './gates.js';
import { METRIC_DEFINITIONS } from './metrics.js';
import { BASELINE, COMPILER, DATASET, PROFILES, PROTOCOL_REVISION } from './types.js';

export const DATA_PATH = 'benchmarks/heldout/v1/cases.json';
export const MANIFEST_PATH = 'benchmarks/heldout/v1/freeze.json';
export const git = (root: string, args: readonly string[]) =>
  execFileSync('git', [...args], { cwd: root, encoding: 'utf8' }).trim();
const protectedPath = (p: string) =>
  p !== MANIFEST_PATH &&
  ((p.startsWith('packages/') &&
    (p.includes('/src/') || p.endsWith('/package.json') || p.endsWith('/tsconfig.json'))) ||
    (p.startsWith('benchmarks/') && !p.includes('/dist/')) ||
    p.startsWith('tests/heldout/') ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.typecheck.json',
      '.nvmrc',
      'docs/PHASE21C_HELD_OUT_PROTOCOL.md',
      '.github/workflows/ci.yml',
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
function jsFiles(root: string, dir: string): readonly string[] {
  const result: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...jsFiles(root, p));
    else if (entry.isFile() && p.endsWith('.js'))
      result.push(relative(root, join(root, p)).replaceAll('\\', '/'));
  }
  return result.sort();
}
export function artifactPaths(root: string): readonly string[] {
  return [
    ...readdirSync(join(root, 'packages')).flatMap((name) =>
      jsFiles(root, `packages/${name}/dist`),
    ),
    ...jsFiles(root, 'benchmarks/dist'),
  ].sort();
}
export function fileHashes(root: string, paths: readonly string[]) {
  return paths.map((path) => ({ path, sha256: hashBytes(readFileSync(join(root, path))) }));
}
export function buildManifest(root: string, rawCases: readonly unknown[]) {
  execFileSync(
    'git',
    [
      'diff',
      '--exit-code',
      BASELINE,
      '--',
      'packages',
      'apps',
      'benchmarks/admission-development',
      'benchmarks/acceptance',
      'benchmarks/diagnostics',
      'benchmarks/evaluation',
      'pnpm-lock.yaml',
    ],
    { cwd: root },
  );
  const cases = rawCases.map(parseCase);
  validateMatrix(cases);
  return {
    schemaVersion: 1,
    dataset: DATASET,
    caseCount: 48,
    baselineRevision: BASELINE,
    protocolRevision: PROTOCOL_REVISION,
    matrix: {
      profiles: 4,
      strata: 6,
      replicas: 2,
      tight: 24,
      generous: 24,
      expectedSuccesses: 44,
      expectedFailures: 4,
    },
    tokenizer: { id: O200K_BASE_TOKENIZER_ID, version: O200K_BASE_TOKENIZER_VERSION },
    compiler: COMPILER,
    policies: PROFILES.map(admissionProfile),
    metrics: METRIC_DEFINITIONS,
    gates: GATE_DEFINITIONS,
    cases: cases.map((c) => ({
      caseId: c.id,
      profile: c.profile,
      stratum: c.stratum,
      replica: c.replica,
      budgetRegime: c.budgetRegime,
      inputHash: hashJson(c.input),
      annotationHash: hashJson(c.annotations),
      policyHash: hashJson(c.input.policy),
    })),
    semanticsFiles: fileHashes(root, semanticsPaths(root)),
    builtArtifacts: fileHashes(root, artifactPaths(root)),
  };
}
function verifyFiles(root: string, expected: unknown, paths: readonly string[]): void {
  const rows = array(expected).map((v) => {
    const r = object(v);
    return { path: string(r.path), sha256: string(r.sha256) };
  });
  if (hashJson(rows) !== hashJson(fileHashes(root, paths)))
    fail('Executable held-out inputs or semantics differ from the freeze.');
}
/** Must finish before observeCases is called. An uncommitted manifest cannot authorize a run. */
export function loadVerifiedDataset(root: string) {
  const revisions = git(root, ['log', '--diff-filter=A', '--format=%H', '--', MANIFEST_PATH])
    .split('\n')
    .filter(Boolean);
  if (revisions.length !== 1)
    fail('A unique committed held-out freeze is required before execution.');
  const heldOutFreezeRevision = revisions[0]!;
  execFileSync('git', ['merge-base', '--is-ancestor', heldOutFreezeRevision, 'HEAD'], {
    cwd: root,
  });
  execFileSync('git', ['merge-base', '--is-ancestor', PROTOCOL_REVISION, heldOutFreezeRevision], {
    cwd: root,
  });
  const frozen = execFileSync('git', ['show', `${heldOutFreezeRevision}:${MANIFEST_PATH}`], {
    cwd: root,
  });
  const current = readFileSync(join(root, MANIFEST_PATH));
  if (!frozen.equals(current)) fail('The original held-out freeze manifest was modified.');
  const manifest = object(JSON.parse(current.toString('utf8')));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.baselineRevision !== BASELINE ||
    manifest.protocolRevision !== PROTOCOL_REVISION ||
    hashJson(manifest.dataset) !== hashJson(DATASET) ||
    hashJson(manifest.metrics) !== hashJson(METRIC_DEFINITIONS) ||
    hashJson(manifest.gates) !== hashJson(GATE_DEFINITIONS) ||
    hashJson(manifest.compiler) !== hashJson(COMPILER) ||
    hashJson(manifest.policies) !== hashJson(PROFILES.map(admissionProfile)) ||
    hashJson(manifest.tokenizer) !==
      hashJson({ id: O200K_BASE_TOKENIZER_ID, version: O200K_BASE_TOKENIZER_VERSION })
  )
    fail();
  verifyFiles(root, manifest.semanticsFiles, semanticsPaths(root));
  verifyFiles(root, manifest.builtArtifacts, artifactPaths(root));
  const cases = array(JSON.parse(readFileSync(join(root, DATA_PATH), 'utf8'))).map(parseCase);
  validateMatrix(cases);
  const rebuilt = cases.map((c) => ({
    caseId: c.id,
    profile: c.profile,
    stratum: c.stratum,
    replica: c.replica,
    budgetRegime: c.budgetRegime,
    inputHash: hashJson(c.input),
    annotationHash: hashJson(c.annotations),
    policyHash: hashJson(c.input.policy),
  }));
  if (hashJson(manifest.cases) !== hashJson(rebuilt))
    fail('Frozen case inputs or annotations changed.');
  return {
    cases,
    manifest,
    heldOutFreezeRevision,
    manifestHash: hashBytes(current),
    runtimeProvenance: { head: git(root, ['rev-parse', 'HEAD']), nodeVersion: process.version },
  };
}

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hash } from '../retrieval-calibration/data.js';
import { PROFILE, profilePolicy } from '../retrieval-calibration/profile.js';
import { verifyProfileFreeze } from '../retrieval-calibration/freeze.js';
import {
  operating,
  reconcileInputs,
  type Settings,
  type Tasks,
  type Annotations,
} from './schema.js';
import { mapEvidence, type Preparation } from './prepare.js';

const MODULES = ['schema', 'prepare', 'metrics', 'evaluate', 'freeze', 'commands', 'run'];
/** Freeze the checked-in implementation and the built code actually executed, not versions alone. */
export function implementationIdentity() {
  const packageSources = execFileSync('git', ['ls-files', '-z', '--', 'packages/*/src/*.ts'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => p && !p.endsWith('.d.ts'));
  const sources = [
    ...packageSources,
    ...MODULES.map((name) => `benchmarks/dogfood/${name}.ts`),
    ...['data', 'observe', 'profile', 'metrics', 'freeze', 'local'].map(
      (name) => `benchmarks/retrieval-calibration/${name}.ts`,
    ),
  ];
  const built = sources.map((p) =>
    p.startsWith('packages/')
      ? p.replace('/src/', '/dist/').replace(/\.ts$/, '.js')
      : p.replace('benchmarks/', 'benchmarks/dist/').replace(/\.ts$/, '.js'),
  );
  const files = [
    ...sources,
    ...built,
    'pnpm-lock.yaml',
    'benchmarks/retrieval-calibration/profile-freeze.json',
  ];
  return hash(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      files: files.map((path) => [path, hash(readFileSync(path, 'utf8'))]),
    }),
  );
}
export function freezeRecord(
  settings: Settings,
  tasks: Tasks,
  annotations: Annotations,
  prepared: Preparation,
  implementationHash: string,
) {
  verifyProfileFreeze();
  operating(settings);
  reconcileInputs(settings, tasks, annotations);
  for (const annotation of annotations.tasks) mapEvidence(annotation, prepared);
  return {
    schemaVersion: 1,
    phase: '22B',
    purpose: 'FROZEN_INPUTS_NOT_AN_EVALUATION_RESULT',
    experimentHash: hash(settings.experimentId!),
    settingsHash: hash(JSON.stringify(settings)),
    tasksHash: hash(JSON.stringify(tasks)),
    annotationHash: hash(JSON.stringify(annotations)),
    sourcePreparationHash: prepared.fingerprint,
    implementationHash,
    protocolHash: hash(readFileSync('docs/PHASE22B_DOGFOOD_PROTOCOL.md', 'utf8')),
    provider: { ...PROFILE.provider, maxCandidates: settings.maxCandidates },
    profile: {
      id: PROFILE.id,
      version: PROFILE.version,
      calibrationVersion: PROFILE.calibrationVersion,
      mapping: PROFILE.mapping,
      completeness: PROFILE.completeness,
      uncertainty: PROFILE.onIncompleteEvidence,
    },
    profileHash: hash(JSON.stringify({ profile: PROFILE, policy: profilePolicy() })),
    scopedPolicyHash: hash(JSON.stringify(profilePolicy(prepared.scope))),
    operatingPoint: operating(settings),
    reader: { id: 'ctxalloc-node-file', version: '1', maxBytes: settings.readerMaxBytes },
    chunking: {
      markdown: settings.markdownChunking,
      text: settings.textChunking,
      conversation: 'existing-v1-one-message-per-block',
    },
    tokenizer: { id: 'js-tiktoken:o200k_base', version: '1.0.21' },
    renderer: 'jsonl-blocks',
    generousControl: 'sum(contentTokens + UTF16Length * 6 + 2048) + 4096; all-included assertion',
    sourceHashes: prepared.sources.map((s) => ({
      sourceHash: hash(s.id),
      available: s.available,
      rawSha256: s.rawSha256,
      logicalContentHash: s.logicalContentHash,
    })),
    annotationAuthority:
      'Operator approval and actual human process; hashes and attestation do not establish authorship or consent.',
    modelExecution: 'disabled',
  };
}
export function verifyFrozen(actual: unknown, expected: ReturnType<typeof freezeRecord>): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('frozen_input_changed');
}

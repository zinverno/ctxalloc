import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { aggregateCases } from './aggregate.js';
import { hashJson, object } from './data.js';
import { evaluateGates, verdict } from './gates.js';
import { FIRST_REPORT_PATH, git, loadVerifiedDataset } from './integrity.js';
import { observeCases } from './observe.js';
export async function runHeldout(root: string) {
  const tokenizer = new O200kBaseTokenizer();
  const frozen = loadVerifiedDataset(root, tokenizer);
  const cases = await observeCases(frozen.cases, tokenizer);
  const aggregates = aggregateCases(cases);
  const gates = evaluateGates(cases, aggregates);
  const evidence = {
    schemaVersion: 1,
    dataset: frozen.manifest.dataset,
    baselineRevision: frozen.manifest.baselineRevision,
    protocolRevision: frozen.manifest.protocolRevision,
    heldOutFreezeRevision: frozen.heldOutFreezeRevision,
    manifestHash: frozen.manifestHash,
    compiler: frozen.manifest.compiler,
    tokenizer: frozen.manifest.tokenizer,
    renderer: frozen.manifest.renderer,
    schemas: frozen.manifest.schemas,
    profiles: frozen.manifest.profiles,
    metrics: frozen.manifest.metrics,
    gateDefinitions: frozen.manifest.gates,
    modelExecution: 'disabled',
    timing: 'NOT_MEASURED',
    liveAnswerQuality: 'NOT_EVALUATED',
    productValidation: 'NOT_EVALUATED',
    contractCorrectness: verdict(gates.filter((g) => g.category === 'contract')),
    primarySelectionEffectiveness: verdict(gates.filter((g) => g.category === 'effectiveness')),
    misleadingRiskDisclosure: verdict(gates.filter((g) => g.category === 'risk-disclosure')),
    heldOutEvidenceAwareContextSelection: verdict(gates),
    aggregates,
    gates,
    cases,
  };
  const evidenceHash = hashJson(evidence);
  const firstPath = resolve(root, FIRST_REPORT_PATH);
  if (existsSync(firstPath)) {
    const original = readFileSync(firstPath);
    const revisions = git(root, ['log', '--diff-filter=A', '--format=%H', '--', FIRST_REPORT_PATH])
      .split('\n')
      .filter(Boolean);
    if (
      revisions.length > 1 ||
      (revisions.length === 1 &&
        !execFileSync('git', ['show', `${revisions[0]}:${FIRST_REPORT_PATH}`], {
          cwd: root,
        }).equals(original))
    )
      throw new Error('First report bytes changed.');
    const report = object(JSON.parse(original.toString('utf8')));
    if (report.evidenceHash !== evidenceHash)
      throw new Error('Frozen observations differ from the first report.');
  }
  return { ...evidence, evidenceHash, runtimeProvenance: frozen.runtimeProvenance };
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (
      process.argv.length > 3 ||
      (process.argv.length === 3 && process.argv[2] !== '--require-pass')
    )
      throw new Error('Unknown arguments.');
    const report = await runHeldout(resolve(import.meta.dirname, '../../..'));
    process.stdout.write(JSON.stringify(report) + '\n');
    if (
      process.argv[2] === '--require-pass' &&
      report.heldOutEvidenceAwareContextSelection !== 'PASS'
    )
      process.exitCode = 2;
  } catch {
    process.stderr.write(
      '{"schemaVersion":1,"error":{"code":"heldout_v2_integrity_or_execution_failed"}}\n',
    );
    process.exitCode = 1;
  }
}

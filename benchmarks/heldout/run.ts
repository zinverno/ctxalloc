import { resolve } from 'node:path';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { aggregateCases } from './aggregate.js';
import { hashJson } from './data.js';
import { evaluateGates } from './gates.js';
import { loadVerifiedDataset } from './integrity.js';
import { observeCases } from './observe.js';
import { BASELINE, DATASET, PROTOCOL_REVISION } from './types.js';

try {
  if (
    process.argv.length > 3 ||
    (process.argv.length === 3 && process.argv[2] !== '--require-pass')
  )
    throw new Error();
  const frozen = loadVerifiedDataset(resolve(import.meta.dirname, '../../..'));
  const cases = await observeCases(frozen.cases, new O200kBaseTokenizer());
  const aggregates = aggregateCases(cases);
  const gates = evaluateGates(cases, aggregates);
  const state = gates.some((g) => g.state === 'FAIL')
    ? 'FAIL'
    : gates.some((g) => g.state !== 'PASS')
      ? 'INCOMPLETE'
      : 'PASS';
  const evidence = {
    schemaVersion: 1,
    dataset: DATASET,
    baselineRevision: BASELINE,
    heldOutFreezeRevision: frozen.heldOutFreezeRevision,
    protocolRevision: PROTOCOL_REVISION,
    manifestHash: frozen.manifestHash,
    policies: frozen.manifest.policies,
    compiler: frozen.manifest.compiler,
    tokenizer: frozen.manifest.tokenizer,
    metrics: frozen.manifest.metrics,
    gateDefinitions: frozen.manifest.gates,
    modelExecution: 'disabled',
    liveAnswerQuality: 'NOT_EVALUATED',
    timing: 'NOT_MEASURED',
    productValidation: 'NOT_EVALUATED',
    heldOutContextSelectionValidation: state,
    aggregates,
    gates,
    cases: cases.map((c, index) => ({
      ...c,
      inputHash: hashJson(frozen.cases[index]!.input),
      annotationHash: hashJson(frozen.cases[index]!.annotations),
    })),
  };
  process.stdout.write(
    JSON.stringify({
      ...evidence,
      evidenceHash: hashJson(evidence),
      runtimeProvenance: frozen.runtimeProvenance,
    }) + '\n',
  );
  if (process.argv[2] === '--require-pass' && state !== 'PASS') process.exitCode = 2;
} catch {
  process.stderr.write(
    '{"schemaVersion":1,"error":{"code":"heldout_integrity_or_execution_failed"}}\n',
  );
  process.exitCode = 1;
}

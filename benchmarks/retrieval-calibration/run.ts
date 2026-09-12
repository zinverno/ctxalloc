import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { loadPublicDataset } from './data.js';
import { loadLocalDataset } from './local.js';
import { verifyProfileFreeze } from './freeze.js';
import { evaluate } from './evaluate.js';

try {
  const args = process.argv.slice(2);
  let data;
  if (!args.length) data = loadPublicDataset();
  else {
    if (args.length !== 2 || args[0] !== '--local') throw new Error('invalid_arguments');
    data = loadLocalDataset(args[1]!);
  }
  verifyProfileFreeze();
  const report = await evaluate(data, new O200kBaseTokenizer());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.contractChecks !== 'PASS') process.exitCode = 1;
} catch {
  // Never echo local paths, input, provider errors, compiler messages, or source text.
  process.stderr.write('{"schemaVersion":1,"error":"phase22a_calibration_failed"}\n');
  process.exitCode = 1;
}

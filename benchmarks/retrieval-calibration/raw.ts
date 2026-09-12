import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { loadPublicDataset } from './data.js';
import { observe, rawReport } from './observe.js';
try {
  if (process.argv.length !== 2) throw new Error('unexpected_arguments');
  const data = loadPublicDataset();
  const report = rawReport(data, await observe(data, new O200kBaseTokenizer()));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.contractChecks !== 'PASS') process.exitCode = 1;
} catch {
  process.stderr.write('{"schemaVersion":1,"error":"phase22a_raw_failed"}\n');
  process.exitCode = 1;
}

import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { evaluateEvidenceDevelopment } from './evaluate.js';
try {
  if (process.argv.length !== 2) throw new Error();
  const report = evaluateEvidenceDevelopment(new O200kBaseTokenizer());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.contractCorrectness === 'FAIL') process.exitCode = 1;
} catch {
  process.stderr.write('{"schemaVersion":1,"error":{"code":"evidence_development_failed"}}\n');
  process.exitCode = 1;
}

import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { evaluateAdmissionDevelopment } from './evaluate.js';

try {
  if (process.argv.length !== 2) throw new Error();
  const report = evaluateAdmissionDevelopment(new O200kBaseTokenizer());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.developmentStatus === 'FAIL') process.exitCode = 1;
} catch {
  process.stderr.write('{"schemaVersion":1,"error":{"code":"admission_development_failed"}}\n');
  process.exitCode = 1;
}

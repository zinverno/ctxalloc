import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { diagnoseValidationSelection } from './validation-selection.js';

try {
  if (process.argv.length !== 2) throw new Error();
  process.stdout.write(
    `${JSON.stringify(diagnoseValidationSelection(new O200kBaseTokenizer()))}\n`,
  );
} catch {
  process.stderr.write('{"schemaVersion":1,"error":{"code":"selection_diagnostic_failed"}}\n');
  process.exitCode = 1;
}

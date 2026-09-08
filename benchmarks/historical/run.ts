import { verifyPhase21CHistory } from './phase21c.js';
try {
  if (process.argv.length !== 2) throw new Error();
  process.stdout.write(`${JSON.stringify(verifyPhase21CHistory(process.cwd()))}\n`);
} catch {
  process.stderr.write('{"schemaVersion":1,"error":{"code":"heldout_history_integrity_failed"}}\n');
  process.exitCode = 1;
}

import { verifyPhase21EHistory } from './phase21e.js';
try {
  if (process.argv.length !== 2) throw new Error('Unknown arguments.');
  process.stdout.write(JSON.stringify(verifyPhase21EHistory(process.cwd())) + '\n');
} catch {
  process.stderr.write(
    '{"schemaVersion":1,"error":{"code":"heldout_v2_history_integrity_failed"}}\n',
  );
  process.exitCode = 1;
}

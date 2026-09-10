import { verifyPhase21EReanchor } from './phase21e.js';

try {
  if (process.argv.length !== 2) throw new Error('Unknown arguments.');
  process.stdout.write(JSON.stringify(verifyPhase21EReanchor(process.cwd())) + '\n');
} catch {
  process.stderr.write(
    '{"schemaVersion":1,"error":{"code":"heldout_v2_reanchor_integrity_failed"}}\n',
  );
  process.exitCode = 1;
}

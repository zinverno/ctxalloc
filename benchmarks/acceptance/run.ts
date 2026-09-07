import { runAcceptance } from './executable.js';
const argv = process.argv.slice(2);
if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--performance')) {
  process.stderr.write('Expected no arguments or --performance.\n');
  process.exitCode = 2;
} else {
  try {
    await runAcceptance(argv[0] === '--performance');
  } catch {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, engineeringAcceptance: 'FAIL', productValidationAcceptance: 'INCOMPLETE', error: 'acceptance_execution_failed' })}\n`,
    );
    process.exitCode = 1;
  }
}

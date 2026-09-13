import { runDogfood } from './commands.js';
const result = await runDogfood(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result.report)}\n`);
process.exitCode = result.exitCode;

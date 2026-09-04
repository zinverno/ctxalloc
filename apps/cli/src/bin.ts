#!/usr/bin/env node
import { runCli } from './run-cli.js';

/**
 * The `ctxalloc` executable (DEC-042).
 *
 * It is deliberately the thinnest possible wrapper: it supplies the real
 * argument vector and the real streams, and sets an exit code. Every decision —
 * which command, which files, what to print — is `runCli`'s, which is what lets
 * nearly the whole CLI be tested without spawning a process.
 *
 * ## Why the warning filter is here
 *
 * `node:sqlite` is a built-in module that emits an `ExperimentalWarning` to
 * stderr the first time it is loaded. This CLI's contract is that stderr carries
 * the error envelope and nothing else, and a warning printed beside — or instead
 * of — that envelope would make a script's error parsing fail on a successful
 * command.
 *
 * The filter is narrow and it belongs at this exact layer. It drops **only**
 * Node's own experimental notice for SQLite: every other warning, including one
 * from any other module, is re-emitted through the default printer. And it lives
 * in the executable rather than in the adapter, because `process` is global
 * state: a library that removed a warning listener would change the behavior of
 * whatever program imported it, and only a composition root may make that
 * decision.
 */
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning: Error & { readonly name?: string }) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  for (const listener of defaultWarningListeners) listener(warning);
});

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});

// `process.exitCode` rather than `process.exit`: the latter can truncate a write
// that has not flushed, which for a large compiled context would hand the caller
// half a JSON document and a success code.
process.exitCode = exitCode;

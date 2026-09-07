#!/usr/bin/env node
import { configArgument, loadApiConfig } from './config.js';
import { toApiError } from './errors.js';
import { startApiServer } from './server.js';

// Match the CLI's deliberate filtering of the Node 22 SQLite experimental notice.
const warningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  for (const listener of warningListeners) listener.call(process, warning);
});
try {
  const config = loadApiConfig(configArgument(process.argv.slice(2)));
  const running = await startApiServer(config);
  const stop = () => {
    void running.close().catch((cause) => {
      process.stderr.write(`${JSON.stringify(toApiError(cause).envelope())}\n`);
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (cause) {
  process.stderr.write(`${JSON.stringify(toApiError(cause).envelope())}\n`);
  process.exitCode = 1;
}

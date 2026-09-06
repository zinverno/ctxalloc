// Explicit manual composition only. Never imported by the offline command or API.
import { readFileSync } from 'node:fs';
import { AnthropicModelProvider } from '@ctxalloc/adapters';
import { runAcceptance } from './executable.js';
try {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--config' || !argv[1]) throw new Error();
  const raw: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(argv[1])),
  );
  if (
    typeof raw !== 'object' ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'apiVersion,baseUrl,modelId,timeoutMs'
  )
    throw new Error();
  const key = process.env.CTXALLOC_ANTHROPIC_API_KEY;
  if (!key?.trim()) throw new Error();
  const provider = new AnthropicModelProvider({ ...raw, apiKey: key });
  await runAcceptance(false, provider);
} catch {
  process.stderr.write(
    'Manual acceptance failed; check explicit model configuration and credential availability.\n',
  );
  process.exitCode = 1;
}

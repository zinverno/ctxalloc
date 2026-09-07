import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
it('keeps API a transport composition with no app-to-app imports, compiler stages, model execution or CORS', () => {
  const api = readdirSync(new URL('apps/api/src', root))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => code(read(`apps/api/src/${name}`)))
    .join('\n');
  for (const forbidden of [
    '@ctxalloc/cli',
    'AnthropicModelProvider',
    'ModelProvider',
    'new ContextCompiler',
    'new CandidateScorer',
    'new BudgetAllocator',
    'Access-Control-Allow-Origin',
    'Set-Cookie',
  ])
    expect(api).not.toContain(forbidden);
  const cli = readdirSync(new URL('apps/cli/src', root))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => read(`apps/cli/src/${name}`))
    .join('\n');
  expect(cli).not.toContain('@ctxalloc/api');
  expect(code(read('apps/api/src/index.ts')).trim()).toBe('export const API_CONTRACT_VERSION = 1;');
  expect(read('apps/api/src/runtime.ts')).toContain('CompileAndPersistLocalContextService');
  expect(read('apps/cli/src/commands/compile.ts')).toContain(
    'CompileAndPersistLocalContextService',
  );
});
it('packages runtime builds without corpus, local configuration or database input', () => {
  const docker = read('Dockerfile');
  expect(docker).toContain('node:22-bookworm-slim');
  expect(docker).toContain('pnpm install --frozen-lockfile');
  expect(docker).toContain('pnpm build');
  expect(docker).toContain('USER node');
  expect(docker).toContain('ENTRYPOINT ["node", "apps/api/dist/bin.js"]');
  expect(docker).toContain('/ready');
  expect(docker).not.toContain('curl');
  const staging = read('scripts/stage-runtime.mjs');
  expect(staging).toContain("['package.json', 'dist', 'node_modules']");
  expect(staging).not.toContain("'src'");
  expect(staging).not.toContain("'sources'");
  const ignore = read('.dockerignore');
  expect(ignore.startsWith('**\n')).toBe(true);
  expect(ignore).not.toContain('!examples');
  expect(ignore).not.toContain('!staging');
  expect(ignore).not.toContain('!.ctxalloc');
  const guide = read('docs/STAGING.md');
  expect(guide).toContain('127.0.0.1:8787:8787');
  expect(guide).toContain('dst=/data/sources,readonly');
  expect(guide).toContain('dst=/data/state"');
  expect(guide).toContain('dst=/config,readonly');
});

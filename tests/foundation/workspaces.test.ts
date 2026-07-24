import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const WORKSPACES = [
  'packages/domain',
  'packages/ports',
  'packages/compiler',
  'packages/application',
  'packages/tokenization',
  'packages/evaluation',
  'packages/testing',
  'apps/api',
  'apps/cli',
] as const;

interface Manifest {
  name?: string;
  private?: boolean;
}

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(new URL(`${relativeDir}/package.json`, rootUrl), 'utf8'),
  ) as Manifest;
}

describe('foundation: workspace packages', () => {
  it.each(WORKSPACES)('%s has a manifest, tsconfig, and source entry point', (relativeDir) => {
    expect(existsSync(new URL(`${relativeDir}/package.json`, rootUrl))).toBe(true);
    expect(existsSync(new URL(`${relativeDir}/tsconfig.json`, rootUrl))).toBe(true);
    expect(existsSync(new URL(`${relativeDir}/src/index.ts`, rootUrl))).toBe(true);
  });

  it.each(WORKSPACES)('%s uses the @ctxalloc/* scope and is private', (relativeDir) => {
    const manifest = readManifest(relativeDir);
    expect(manifest.name).toMatch(/^@ctxalloc\/[a-z]+$/);
    expect(manifest.private).toBe(true);
  });

  it('marks the root project as private', () => {
    const root = JSON.parse(readFileSync(new URL('package.json', rootUrl), 'utf8')) as Manifest;
    expect(root.private).toBe(true);
  });
});

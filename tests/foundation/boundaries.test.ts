import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const INTERNAL_SCOPE = '@ctxalloc/';

const WORKSPACES = [
  'packages/domain',
  'packages/ports',
  'packages/compiler',
  'packages/application',
  'packages/adapters',
  'packages/tokenization',
  'packages/evaluation',
  'packages/testing',
  'apps/api',
  'apps/cli',
] as const;

type Manifest = { name: string } & Partial<
  Record<(typeof DEP_FIELDS)[number], Record<string, string>>
>;

const allowlist = JSON.parse(
  readFileSync(new URL('scripts/internal-dependency-allowlist.json', rootUrl), 'utf8'),
) as Record<string, string[]>;

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(new URL(`${relativeDir}/package.json`, rootUrl), 'utf8'),
  ) as Manifest;
}

function internalDependencies(manifest: Manifest): string[] {
  const deps = new Set<string>();
  for (const field of DEP_FIELDS) {
    const section = manifest[field];
    if (!section) continue;
    for (const name of Object.keys(section)) {
      if (name.startsWith(INTERNAL_SCOPE)) deps.add(name);
    }
  }
  return [...deps].sort();
}

describe('foundation: internal dependency boundaries', () => {
  it('declares every workspace package in the allowlist', () => {
    for (const relativeDir of WORKSPACES) {
      expect(allowlist).toHaveProperty(readManifest(relativeDir).name);
    }
  });

  it.each(WORKSPACES)('%s declares no forbidden internal dependency', (relativeDir) => {
    const manifest = readManifest(relativeDir);
    const allowed = allowlist[manifest.name] ?? [];
    for (const dependency of internalDependencies(manifest)) {
      expect(allowed, `${manifest.name} may not depend on ${dependency}`).toContain(dependency);
    }
  });
});

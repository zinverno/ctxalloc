import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Tokenizer } from '@ctxalloc/ports';
import * as tokenization from '@ctxalloc/tokenization';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(relativeDir: string): Manifest {
  return JSON.parse(
    readFileSync(new URL(`${relativeDir}/package.json`, rootUrl), 'utf8'),
  ) as Manifest;
}

const manifest = readManifest('packages/tokenization');

/** Every workspace manifest, so a dependency cannot spread beyond this package. */
function allWorkspaceManifests(): { dir: string; manifest: Manifest }[] {
  const found: { dir: string; manifest: Manifest }[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = new URL(`${group}/`, rootUrl);
    for (const entry of readdirSync(groupDir).sort()) {
      if (!statSync(new URL(entry, groupDir)).isDirectory()) continue;
      found.push({ dir: `${group}/${entry}`, manifest: readManifest(`${group}/${entry}`) });
    }
  }
  return found;
}

const SOURCE_FILES = [
  'packages/tokenization/src/index.ts',
  'packages/tokenization/src/o200k-base-tokenizer.ts',
];

function importSpecifiers(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, rootUrl), 'utf8');
  return [...source.matchAll(/from '(?<specifier>[^']+)'/g)].map(
    (match) => match.groups?.specifier ?? '',
  );
}

describe('@ctxalloc/tokenization public API', () => {
  it('exports the adapter, its identity constants, and its error types', () => {
    expect(Object.keys(tokenization).sort()).toEqual([
      'O200K_BASE_ENCODING',
      'O200K_BASE_TOKENIZER_ID',
      'O200K_BASE_TOKENIZER_VERSION',
      'O200kBaseTokenizer',
      'TokenizerEncodingFailedError',
      'TokenizerInvalidUnicodeError',
    ]);
  });

  it('INV-ADAPTER-005: provides an implementation assignable to the Tokenizer port', () => {
    const tokenizer: Tokenizer = new O200kBaseTokenizer();
    expect(tokenizer.countTokens('')).toBe(0);
    expect(tokenizer.id).toBe('js-tiktoken:o200k_base');
    expect(tokenizer.version).toBe('1.0.21');
  });

  it('INV-TRACE-005: hard-codes the adapter version declared in its manifest', () => {
    // A tokenizer version is correctness data recorded in traces. It is not read
    // from the filesystem at runtime, so this regression test keeps the constant
    // and the pinned dependency from drifting apart.
    expect(manifest.dependencies?.['js-tiktoken']).toBe(tokenization.O200K_BASE_TOKENIZER_VERSION);
  });

  it('pins the tokenizer library to one exact version', () => {
    const pinned = manifest.dependencies?.['js-tiktoken'];
    expect(pinned).toBe('1.0.21');
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares only the port and the tokenizer library', () => {
    expect(manifest.dependencies).toEqual({
      '@ctxalloc/ports': 'workspace:*',
      'js-tiktoken': '1.0.21',
    });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-ADAPTER-001: is the only workspace package depending on the tokenizer library', () => {
    const dependencyFields = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const;
    const dependants = allWorkspaceManifests()
      .filter((entry) =>
        dependencyFields.some((field) => Object.hasOwn(entry.manifest[field] ?? {}, 'js-tiktoken')),
      )
      .map((entry) => entry.dir);
    expect(dependants).toEqual(['packages/tokenization']);
  });

  it('INV-ADAPTER-001: imports the project-owned port, never another package surface', () => {
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(file)) {
        expect(
          specifier.startsWith('./') ||
            specifier === '@ctxalloc/ports' ||
            specifier.startsWith('js-tiktoken'),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('loads only the bundled lite build and the o200k_base ranks', () => {
    const external = importSpecifiers('packages/tokenization/src/o200k-base-tokenizer.ts').filter(
      (specifier) => specifier.startsWith('js-tiktoken'),
    );
    expect(external.sort()).toEqual(['js-tiktoken/lite', 'js-tiktoken/ranks/o200k_base']);
  });

  it('INV-DET-003, INV-DET-004: performs no I/O, model mapping, or nondeterministic lookup', () => {
    for (const file of SOURCE_FILES) {
      const source = readFileSync(new URL(file, rootUrl), 'utf8');
      for (const forbidden of [
        'fetch(',
        'node:fs',
        'readFileSync',
        'process.env',
        'Math.random',
        'Date.now',
        'new Date',
        'encodingForModel',
        'getEncodingNameForModel',
        'https://',
      ]) {
        expect(source, `${file} must not use ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

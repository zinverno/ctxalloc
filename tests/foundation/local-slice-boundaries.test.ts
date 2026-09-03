import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

/**
 * The architecture rules the local vertical slice must not break (DEC-039).
 *
 * The rules are checked against the sources rather than against a diagram, so a
 * later change that quietly reverses a dependency direction fails here instead of
 * being discovered in review.
 */

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

function sourcesOf(relativeDir: string): { path: string; code: string }[] {
  const directory = new URL(`${relativeDir}/src/`, rootUrl);
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()
    .map((entry) => ({
      path: `${relativeDir}/src/${entry}`,
      code: readFileSync(new URL(entry, directory), 'utf8'),
    }));
}

function internalDependencies(manifest: Manifest): string[] {
  const fields = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;
  const names = new Set<string>();
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith('@ctxalloc/')) names.add(name);
    }
  }
  return [...names].sort();
}

describe('local slice boundaries: dependency direction', () => {
  it('INV-DEP-002: the compiler gains no application or adapter dependency', () => {
    expect(internalDependencies(readManifest('packages/compiler'))).toEqual([
      '@ctxalloc/domain',
      '@ctxalloc/ports',
    ]);
  });

  it('INV-DEP-001: the domain gains no dependency at all', () => {
    const manifest = readManifest('packages/domain');
    expect(internalDependencies(manifest)).toEqual([]);
    expect(manifest.dependencies).toEqual({ zod: '^4.4.3' });
  });

  it('the adapters package depends on the ports and nothing else', () => {
    const manifest = readManifest('packages/adapters');
    expect(manifest.dependencies).toEqual({ '@ctxalloc/ports': 'workspace:*' });
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('INV-DEP-003: an adapter never imports the compiler or the application', () => {
    // Documentation comments legitimately name the packages the adapter must
    // stay away from, so only import statements are inspected.
    for (const { path, code } of sourcesOf('packages/adapters')) {
      const specifiers = [...code.matchAll(/from '(?<specifier>[^']+)'/g)].map(
        (match) => match.groups?.specifier ?? '',
      );
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith('./') ||
            specifier === '@ctxalloc/ports' ||
            specifier.startsWith('node:'),
          `${path} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('the ports package depends only on the domain, and only for types', () => {
    const manifest = readManifest('packages/ports');
    expect(manifest.dependencies).toEqual({ '@ctxalloc/domain': 'workspace:*' });
    for (const { path, code } of sourcesOf('packages/ports')) {
      expect(code, `${path} imports a value`).not.toMatch(
        /^import (?!type )[^;]*from '@ctxalloc\/domain'/m,
      );
    }
  });
});

describe('local slice boundaries: infrastructure stays in the adapter', () => {
  it('INV-DEP-001: neither the domain nor the compiler touches the filesystem', () => {
    for (const workspace of ['packages/domain', 'packages/compiler']) {
      for (const { path, code } of sourcesOf(workspace)) {
        for (const forbidden of ['node:fs', 'node:path', 'node:os', 'node:child_process']) {
          expect(code, `${path} imports ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('INV-DEP-002: the application layer never reads a file itself', () => {
    for (const { path, code } of sourcesOf('packages/application')) {
      for (const forbidden of ['node:fs', 'node:path', 'readFile', 'existsSync']) {
        expect(code, `${path} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the test doubles reach no filesystem, database, or network', () => {
    for (const { path, code } of sourcesOf('packages/testing')) {
      for (const forbidden of ['node:fs', 'node:path', 'node:http', 'fetch(']) {
        expect(code, `${path} uses ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('local slice boundaries: no Phase 18 to 20 scope creep', () => {
  const WORKSPACES = [
    'packages/domain',
    'packages/ports',
    'packages/compiler',
    'packages/application',
    'packages/adapters',
    'packages/testing',
    'packages/tokenization',
  ] as const;

  it('adds no retrieval, persistence, model, or HTTP dependency', () => {
    for (const workspace of WORKSPACES) {
      const declared = Object.keys({
        ...readManifest(workspace).dependencies,
        ...readManifest(workspace).devDependencies,
      });
      for (const forbidden of [
        'better-sqlite3',
        'node-sqlite3',
        'sqlite3',
        'qdrant',
        '@qdrant/js-client-rest',
        'express',
        'fastify',
        'hono',
        '@anthropic-ai/sdk',
        'openai',
        'commander',
        'yargs',
        'chokidar',
      ]) {
        expect(declared, `${workspace} declares ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('implements no retrieval index, trace store, or CLI flow', () => {
    // `ModelProvider` left this list in Phase 17: the port and its one adapter
    // are real, and both serve evaluation only. Retrieval, persistence, the CLI,
    // and the HTTP API remain later phases (DEC-040).
    for (const workspace of WORKSPACES) {
      for (const { path, code } of sourcesOf(workspace)) {
        const declarations = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const forbidden of [
          'TraceStore',
          'BM25',
          'embedding',
          'QmdClient',
          'createServer',
          'process.argv',
        ]) {
          expect(declarations, `${path} implements ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('keeps the model provider out of every layer that is not evaluation', () => {
    // The one place a model may be called is the evaluation harness, through the
    // adapter that implements the port. Nothing in the kernel, the application
    // slice, or the domain may name it (INV-DEP-002).
    for (const workspace of [
      'packages/domain',
      'packages/compiler',
      'packages/application',
      'packages/tokenization',
    ] as const) {
      for (const { path, code } of sourcesOf(workspace)) {
        const declarations = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(declarations, `${path} implements ModelProvider`).not.toContain('ModelProvider');
      }
    }
  });
});

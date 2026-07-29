import { readFileSync } from 'node:fs';
import * as ports from '@ctxalloc/ports';
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

describe('@ctxalloc/ports public API', () => {
  it('exposes the tokenizer capability as a type-only contract', () => {
    // The port is an interface, so the compiled entry point has no runtime export.
    // A runtime export here would mean a port started carrying behavior.
    expect(Object.keys(ports)).toEqual([]);
  });

  it('exports only the Tokenizer contract from its entry point', () => {
    const entry = readFileSync(new URL('packages/ports/src/index.ts', rootUrl), 'utf8');
    const exported = [...entry.matchAll(/export type \{ (?<names>[^}]+) \} from/g)].flatMap(
      (match) => (match.groups?.names ?? '').split(',').map((name) => name.trim()),
    );
    expect(exported).toEqual(['Tokenizer']);
    expect(entry).not.toMatch(/export (const|function|class|enum|let|var)/);
  });

  it('defines no speculative port for this phase', () => {
    const entry = readFileSync(new URL('packages/ports/src/index.ts', rootUrl), 'utf8');
    for (const name of [
      'CandidateProvider',
      'SourceReader',
      'TraceStore',
      'ControlStore',
      'ModelProvider',
      'Clock',
      'DocumentConverter',
      'EmbeddingProvider',
      'TelemetrySink',
    ]) {
      expect(entry).not.toContain(name);
    }
  });

  it('INV-ADAPTER-001: declares no dependency, internal or external', () => {
    const manifest = readManifest('packages/ports');
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('INV-ADAPTER-001: imports nothing in its sources', () => {
    for (const file of ['packages/ports/src/index.ts', 'packages/ports/src/tokenizer.ts']) {
      const source = readFileSync(new URL(file, rootUrl), 'utf8');
      const specifiers = [...source.matchAll(/from '(?<specifier>[^']+)'/g)].map(
        (match) => match.groups?.specifier ?? '',
      );
      for (const specifier of specifiers) {
        expect(specifier.startsWith('./'), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('describes a synchronous non-negative integer count', () => {
    const source = readFileSync(new URL('packages/ports/src/tokenizer.ts', rootUrl), 'utf8');
    expect(source).toContain('countTokens(text: string): number;');
    expect(source).not.toContain('Promise');
  });
});

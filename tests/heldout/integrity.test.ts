import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextCompiler } from '@ctxalloc/compiler';
import { hashBytes, hashJson } from '../../benchmarks/heldout/data.js';
import {
  fileHashes,
  loadVerifiedDataset,
  MANIFEST_PATH,
  semanticsPaths,
} from '../../benchmarks/heldout/integrity.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ctxalloc-freeze-toy-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=zinverno',
      '-c',
      'user.email=107344294+zinverno@users.noreply.github.com',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'toy integrity fixture',
    ],
    { cwd: root },
  );
  return root;
}
describe('held-out freeze guard before any compilation', () => {
  it('refuses an uncommitted manifest before inspecting or compiling cases', () => {
    const root = repository();
    mkdirSync(join(root, 'benchmarks/heldout/v1'), { recursive: true });
    writeFileSync(join(root, MANIFEST_PATH), '{}');
    const compile = vi.spyOn(ContextCompiler.prototype, 'compile');
    expect(() => loadVerifiedDataset(root)).toThrow(
      'A unique committed held-out freeze is required',
    );
    expect(compile).not.toHaveBeenCalled();
  });
  it('hashes canonical input keys while preserving authoritative array order', () => {
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
    expect(hashBytes('alpha')).not.toBe(hashBytes('alpha\n'));
  });
  it('includes new executable source paths while excluding report evidence and manifest self-reference', () => {
    const root = repository();
    for (const p of [
      'benchmarks/heldout/measure.ts',
      'benchmarks/heldout/v1/freeze.json',
      'docs/evidence/toy.json',
    ]) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), '{}');
    }
    expect(semanticsPaths(root)).toEqual(['benchmarks/heldout/measure.ts']);
  });
  it('changes a semantic file hash when its executable bytes change', () => {
    const root = repository();
    writeFileSync(join(root, 'package.json'), '{}');
    const before = fileHashes(root, ['package.json']);
    writeFileSync(join(root, 'package.json'), '{"changed":true}');
    expect(fileHashes(root, ['package.json'])).not.toEqual(before);
  });
});

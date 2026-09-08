import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextCompiler } from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import {
  buildManifest,
  fileHashes,
  MANIFEST_PATH,
  PROTOCOL_PATH,
  requireProtocolCommit,
  semanticsPaths,
} from '../../benchmarks/heldout-v2/integrity.js';
import { runHeldout } from '../../benchmarks/heldout-v2/run.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ctxalloc-v2-freeze-toy-'));
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
      'unrelated toy history',
    ],
    { cwd: root },
  );
  return root;
}
describe('INV-DET / Phase 21E irreversible stage guard', () => {
  it('refuses the entire execution route before compilation when a freeze is only a file', async () => {
    const root = repository();
    mkdirSync(join(root, 'benchmarks/heldout-v2/v2'), { recursive: true });
    writeFileSync(join(root, MANIFEST_PATH), '{}');
    const compile = vi.spyOn(ContextCompiler.prototype, 'compile');
    await expect(runHeldout(root)).rejects.toThrow('unique committed');
    expect(compile).not.toHaveBeenCalled();
  });
  it('refuses preparation/freeze without a committed protocol', () => {
    const root = repository();
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, PROTOCOL_PATH), 'uncommitted');
    const compile = vi.spyOn(ContextCompiler.prototype, 'compile');
    expect(() => requireProtocolCommit(root)).toThrow('unique committed');
    expect(() => buildManifest(root, [], new O200kBaseTokenizer())).toThrow('unique committed');
    expect(compile).not.toHaveBeenCalled();
  });
  it('protects source, evaluator, CI, cases and annotations while excluding final reports and self-reference', () => {
    const root = repository();
    const paths = [
      'benchmarks/heldout-v2/run.ts',
      MANIFEST_PATH,
      'benchmarks/heldout-v2/v2/authoring.json',
      'docs/evidence/phase21e-first-run.json',
      'tests/heldout-v2/metrics.test.ts',
      '.github/workflows/ci.yml',
    ];
    for (const p of paths) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), '{}');
    }
    expect(semanticsPaths(root)).toEqual(
      paths.filter((p) => p !== MANIFEST_PATH && !p.startsWith('docs/evidence/')).sort(),
    );
    const before = fileHashes(root, semanticsPaths(root));
    writeFileSync(join(root, paths[0]!), 'changed');
    expect(fileHashes(root, semanticsPaths(root))).not.toEqual(before);
  });
});

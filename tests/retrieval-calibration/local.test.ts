import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalDataset } from '../../benchmarks/retrieval-calibration/local.js';
import { loadPublicDataset } from '../../benchmarks/retrieval-calibration/data.js';
import { verifyProfileFreeze } from '../../benchmarks/retrieval-calibration/freeze.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'phase22a-local-'));
  directories.push(dir);
  const ignored = join(dir, '.ctxalloc');
  mkdirSync(ignored);
  return { dir, ignored };
}
describe('Phase 22A local data and profile freeze boundaries', () => {
  it('loads explicit local JSON inside the caller-designated ignored root', () => {
    const { ignored } = temporary(),
      file = join(ignored, 'corpus.json');
    const data = loadPublicDataset();
    writeFileSync(file, JSON.stringify(data));
    expect(loadLocalDataset(file, ignored)).toEqual(data);
  });
  it('rejects source paths outside ignored local storage', () => {
    const { dir, ignored } = temporary(),
      file = join(dir, 'outside.json');
    writeFileSync(file, '{}');
    expect(() => loadLocalDataset(file, ignored)).toThrow('local_input_boundary');
  });
  it('rejects symlink escape from ignored local storage', () => {
    const { dir, ignored } = temporary(),
      outside = join(dir, 'outside.json'),
      link = join(ignored, 'link.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, link);
    expect(() => loadLocalDataset(link, ignored)).toThrow('local_input_boundary');
  });
  it('rejects oversized local JSON before parsing it', () => {
    const { ignored } = temporary(),
      file = join(ignored, 'large.json');
    writeFileSync(file, ' '.repeat(4_000_001));
    expect(() => loadLocalDataset(file, ignored)).toThrow('local_input_boundary');
  });
  it('authenticates the frozen interpretation and first raw evidence', () => {
    expect(() => verifyProfileFreeze()).not.toThrow();
  });
});

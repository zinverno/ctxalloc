import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { parseDataset } from './data.js';

/** Explicit JSON only: never scan directories, follow embedded paths or accept executable config. */
export function loadLocalJson(path: string, ignoredRoot = resolve('.ctxalloc')): unknown {
  const root = realpathSync(ignoredRoot);
  const file = realpathSync(resolve(path));
  const rel = relative(root, file);
  if (
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    !statSync(file).isFile() ||
    statSync(file).size > 4_000_000
  )
    throw new Error('local_input_boundary');
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

export function loadLocalDataset(path: string, ignoredRoot = resolve('.ctxalloc')) {
  return parseDataset(loadLocalJson(path, ignoredRoot));
}

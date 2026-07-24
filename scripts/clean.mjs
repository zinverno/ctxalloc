#!/usr/bin/env node
// Removes generated build artifacts (declarations, compiled output, build info,
// coverage) so `pnpm build` can run from a clean state.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_GROUPS = ['packages', 'apps'];

const targets = [];
for (const group of WORKSPACE_GROUPS) {
  const groupDir = join(rootDir, group);
  if (!existsSync(groupDir)) continue;
  for (const entry of readdirSync(groupDir)) {
    const packageDir = join(groupDir, entry);
    if (!statSync(packageDir).isDirectory()) continue;
    targets.push(join(packageDir, 'dist'));
    targets.push(join(packageDir, 'tsconfig.tsbuildinfo'));
  }
}
targets.push(join(rootDir, 'tsconfig.tsbuildinfo'));
targets.push(join(rootDir, 'coverage'));

let removed = 0;
for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  removed += 1;
  console.log(`removed ${relative(rootDir, target)}`);
}

console.log(`Clean complete: removed ${removed} path(s).`);

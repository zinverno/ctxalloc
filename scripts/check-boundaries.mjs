#!/usr/bin/env node
// Lightweight, project-owned architecture boundary checker.
//
// It validates the internal (@ctxalloc/*) workspace dependencies declared in
// each package manifest against an explicit allowlist. External dependencies
// are ignored. The check is deterministic and exits non-zero on any violation.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const WORKSPACE_GROUPS = ['packages', 'apps'];
const INTERNAL_SCOPE = '@ctxalloc/';

const allowlist = JSON.parse(
  readFileSync(join(rootDir, 'scripts', 'internal-dependency-allowlist.json'), 'utf8'),
);

function readWorkspaceManifests() {
  const manifests = [];
  for (const group of WORKSPACE_GROUPS) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir).sort()) {
      const packageDir = join(groupDir, entry);
      if (!statSync(packageDir).isDirectory()) continue;
      const manifestPath = join(packageDir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      manifests.push({
        dir: `${group}/${entry}`,
        manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
      });
    }
  }
  return manifests;
}

function internalDependencies(manifest) {
  const deps = new Set();
  for (const field of DEP_FIELDS) {
    const section = manifest[field];
    if (!section) continue;
    for (const name of Object.keys(section)) {
      if (name.startsWith(INTERNAL_SCOPE)) deps.add(name);
    }
  }
  return [...deps].sort();
}

const manifests = readWorkspaceManifests();

const undeclared = manifests
  .map(({ manifest }) => manifest.name)
  .filter((name) => !(name in allowlist))
  .sort();

if (undeclared.length > 0) {
  console.error('Boundary check failed: workspace packages missing from the allowlist:');
  for (const name of undeclared) console.error(`  - ${name}`);
  process.exit(1);
}

const violations = [];
for (const { dir, manifest } of manifests) {
  const allowed = allowlist[manifest.name] ?? [];
  for (const dependency of internalDependencies(manifest)) {
    if (dependency === manifest.name) continue;
    if (!allowed.includes(dependency)) {
      violations.push({ package: manifest.name, dir, dependency, allowed });
    }
  }
}

violations.sort(
  (a, b) => a.package.localeCompare(b.package) || a.dependency.localeCompare(b.dependency),
);

if (violations.length > 0) {
  console.error('Boundary check failed: forbidden internal dependencies detected.\n');
  for (const violation of violations) {
    console.error(`  ${violation.package} (${violation.dir})`);
    console.error(`    forbidden dependency: ${violation.dependency}`);
    console.error(
      `    allowed internal dependencies: ${
        violation.allowed.length > 0 ? violation.allowed.join(', ') : '(none)'
      }`,
    );
  }
  process.exit(1);
}

console.log(
  `Boundary check passed: ${manifests.length} workspace packages, no forbidden internal dependencies.`,
);

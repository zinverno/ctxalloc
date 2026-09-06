#!/usr/bin/env node
// Lightweight, project-owned architecture boundary checker.
//
// It validates the internal (@ctxalloc/*) workspace dependencies declared in
// each package manifest against an explicit allowlist. Production imports also
// enforce transport, persistence and model boundaries. The check is deterministic.

import ts from 'typescript';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
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
  const benchmarkManifest = join(rootDir, 'benchmarks', 'package.json');
  if (existsSync(benchmarkManifest))
    manifests.push({
      dir: 'benchmarks',
      manifest: JSON.parse(readFileSync(benchmarkManifest, 'utf8')),
    });
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

const sourceViolations = [];
const frameworks = /^(?:express|fastify|koa|hono|h3|@hapi\/hapi)(?:$|\/)/;
const persistentRetrieval = /^(?:@qdrant\/|chromadb|@lancedb\/|pgvector|@elastic\/)/;
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}
for (const { dir, manifest } of manifests) {
  for (const field of DEP_FIELDS)
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (frameworks.test(dependency) || persistentRetrieval.test(dependency))
        sourceViolations.push(`${dir}: forbidden infrastructure dependency ${dependency}`);
    }
  for (const path of files(join(rootDir, dir, dir === 'benchmarks' ? '' : 'src'))) {
    const source = readFileSync(path, 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function inspect(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        specifier = node.argument.literal.text;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifier = node.arguments[0].text;
      if (specifier !== undefined) {
        const problem = (message) =>
          sourceViolations.push(`${relative(rootDir, path)}: ${message}`);
        if (/^(?:node:)?https?$/.test(specifier) && dir !== 'apps/api')
          problem('HTTP transport belongs to apps/api');
        if (/^(?:node:)?sqlite$/.test(specifier) && dir !== 'packages/adapters')
          problem('SQLite belongs to adapters');
        if (frameworks.test(specifier) || persistentRetrieval.test(specifier))
          problem('forbidden infrastructure import');
        let target = specifier.startsWith('@ctxalloc/')
          ? specifier.split('/').slice(0, 2).join('/')
          : undefined;
        if (specifier.startsWith('.')) {
          const resolved = resolve(dirname(path), specifier);
          target = manifests.find(
            (entry) => resolved.startsWith(`${join(rootDir, entry.dir)}/`) && entry.dir !== dir,
          )?.manifest.name;
        }
        if (
          target &&
          target !== manifest.name &&
          !(allowlist[manifest.name] ?? []).includes(target)
        )
          problem(`forbidden source dependency ${target}`);
      }
      if (
        dir === 'apps/api' &&
        ts.isIdentifier(node) &&
        [
          'AnthropicModelProvider',
          'ModelProvider',
          'FakeModelProvider',
          'ContextCompiler',
          'CandidateFilter',
          'ContextOrderer',
          'TraceBuilder',
          'CandidateScorer',
          'BudgetAllocator',
          'CandidateDeduplicator',
          'ContextRenderer',
        ].includes(node.text)
      )
        sourceViolations.push(
          `${relative(rootDir, path)}: API owns neither model execution nor compiler stages`,
        );
      ts.forEachChild(node, inspect);
    }
    inspect(ast);
  }
}
if (sourceViolations.length > 0) {
  console.error('Source boundary check failed:');
  for (const failure of sourceViolations.sort()) console.error(`  - ${failure}`);
  process.exit(1);
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

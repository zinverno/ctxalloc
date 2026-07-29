#!/usr/bin/env node
// Validates the generated public declaration surface of the workspace packages.
//
// The published contract of a package is its emitted `.d.ts` file, so the build
// output is inspected rather than trusted: the expected declarations must exist,
// the Tokenizer port must keep its documented shape, FakeTokenizer must still
// implement it, and no external library type may appear in the public surface
// (INV-ADAPTER-001).
//
// Run this after `pnpm build`. It never builds and never writes.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The packages whose public surface this check owns. Other packages have no
// public API yet; they are covered when they gain one.
const DECLARATIONS = [
  'packages/ports/dist/index.d.ts',
  'packages/ports/dist/tokenizer.d.ts',
  'packages/testing/dist/index.d.ts',
  'packages/testing/dist/fake-tokenizer.d.ts',
];

// Declarations may reference workspace packages and their own relative files
// only. Anything else means an external type reached the public surface.
const INTERNAL_SCOPE = '@ctxalloc/';

const failures = [];

function fail(message) {
  failures.push(message);
}

function readDeclaration(relativePath) {
  const absolutePath = join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, 'utf8');
}

const contents = new Map();
for (const relativePath of DECLARATIONS) {
  const content = readDeclaration(relativePath);
  if (content === null) {
    fail(`missing declaration: ${relativePath} (run "pnpm build" first)`);
    continue;
  }
  if (content.trim().length === 0) {
    fail(`empty declaration: ${relativePath}`);
    continue;
  }
  contents.set(relativePath, content);
}

function requireContains(relativePath, expected) {
  const content = contents.get(relativePath);
  if (content === undefined) return;
  if (!content.includes(expected)) {
    fail(`${relativePath} does not declare: ${expected}`);
  }
}

// The Tokenizer port keeps its documented shape.
requireContains('packages/ports/dist/tokenizer.d.ts', 'interface Tokenizer');
requireContains('packages/ports/dist/tokenizer.d.ts', 'readonly id: string;');
requireContains('packages/ports/dist/tokenizer.d.ts', 'readonly version: string;');
requireContains('packages/ports/dist/tokenizer.d.ts', 'countTokens(text: string): number;');
requireContains(
  'packages/ports/dist/index.d.ts',
  "export type { Tokenizer } from './tokenizer.js'",
);

// The fake still implements the port it stands in for.
requireContains(
  'packages/testing/dist/fake-tokenizer.d.ts',
  'class FakeTokenizer implements Tokenizer',
);

// No external library type reaches a public declaration.
for (const [relativePath, content] of contents) {
  const specifiers = [...content.matchAll(/from ["'](?<from>[^"']+)["']/g)]
    .map((match) => match.groups?.from ?? '')
    .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'));
  for (const specifier of specifiers) {
    if (!specifier.startsWith(INTERNAL_SCOPE)) {
      fail(`${relativePath} exposes an external type from "${specifier}"`);
    }
  }
}

if (failures.length > 0) {
  console.error('Declaration check failed:\n');
  for (const failure of failures.sort()) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Declaration check passed: ${contents.size} declarations validated.`);

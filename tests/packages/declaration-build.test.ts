import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The published surface of a package is its generated declaration file, so the
 * build is exercised here instead of trusted. The emitted `.d.ts` files must also
 * show that no external library type reaches the port or its test double
 * (INV-ADAPTER-001).
 */

const rootUrl = new URL('../../', import.meta.url);
const rootDir = fileURLToPath(rootUrl);
const tscPath = fileURLToPath(new URL('node_modules/typescript/bin/tsc', rootUrl));

const DECLARATIONS = [
  'packages/ports/dist/index.d.ts',
  'packages/ports/dist/tokenizer.d.ts',
  'packages/testing/dist/index.d.ts',
  'packages/testing/dist/fake-tokenizer.d.ts',
] as const;

function readDeclaration(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

describe('generated declarations', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [tscPath, '-b', 'packages/ports', 'packages/testing'], {
      cwd: rootDir,
      stdio: 'pipe',
    });
  }, 120_000);

  it('emits declarations for the port and its test double', () => {
    for (const relativePath of DECLARATIONS) {
      expect(readDeclaration(relativePath).length).toBeGreaterThan(0);
    }
  });

  it('declares the Tokenizer contract', () => {
    const declaration = readDeclaration('packages/ports/dist/tokenizer.d.ts');
    expect(declaration).toContain('interface Tokenizer');
    expect(declaration).toContain('readonly id: string;');
    expect(declaration).toContain('readonly version: string;');
    expect(declaration).toContain('countTokens(text: string): number;');
  });

  it('declares FakeTokenizer as an implementation of the port', () => {
    const declaration = readDeclaration('packages/testing/dist/fake-tokenizer.d.ts');
    expect(declaration).toContain('class FakeTokenizer implements Tokenizer');
  });

  it('INV-ADAPTER-001: exposes no external library type', () => {
    for (const relativePath of DECLARATIONS) {
      const specifiers = [
        ...readDeclaration(relativePath).matchAll(/from ["'](?<from>[^"']+)["']/g),
      ]
        .map((match) => match.groups?.from ?? '')
        .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'));
      for (const specifier of specifiers) {
        expect(specifier.startsWith('@ctxalloc/'), `${relativePath} imports ${specifier}`).toBe(
          true,
        );
      }
    }
  });
});

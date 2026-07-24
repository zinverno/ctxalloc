import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

const REQUIRED_DOCS = [
  'docs/PRODUCT_CONTRACT.md',
  'docs/MVP_SCOPE.md',
  'docs/ARCHITECTURE.md',
  'docs/INVARIANTS.md',
  'docs/METRICS.md',
  'docs/DECISIONS.md',
] as const;

function readDoc(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

describe('foundation: architecture documentation', () => {
  it.each(REQUIRED_DOCS)('includes required document %s', (relativePath) => {
    expect(readDoc(relativePath).trim().length).toBeGreaterThan(0);
  });

  it.each(REQUIRED_DOCS)('declares CtxAlloc as the current product name in %s', (relativePath) => {
    const declaredName = readDoc(relativePath).match(/^\*\s*Product name:\s*(.+)$/m);
    expect(declaredName?.[1]?.trim()).toBe('CtxAlloc');
  });
});

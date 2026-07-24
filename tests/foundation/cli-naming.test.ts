import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

// Regression: the CLI was renamed from the old "Token OS" working name to
// "ctxalloc" (see docs/DECISIONS.md, DEC-001). docs/MVP_SCOPE.md previously
// still listed stale `token-os <command>` invocations. This test guards only
// against the hyphenated CLI command form leaking back into MVP_SCOPE.md; it
// deliberately does not touch the historical "Token OS" discussion elsewhere.
describe('foundation: MVP scope CLI naming', () => {
  it('docs/MVP_SCOPE.md contains no active token-os CLI invocations', () => {
    const contents = readFileSync(new URL('docs/MVP_SCOPE.md', rootUrl), 'utf8');
    const staleInvocations = contents.match(/token-os\b/gi) ?? [];
    expect(staleInvocations).toEqual([]);
  });
});

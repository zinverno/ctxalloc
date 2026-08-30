import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootUrl = new URL('../../', import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, rootUrl), 'utf8');
}

/**
 * Source and documentation that asserts the deterministic-input boundary
 * (DEC-036).
 *
 * These files state the contract to a reader. `docs/DECISIONS.md` is excluded
 * from the forbidden-claim scan on purpose: DEC-036 quotes the withdrawn wording
 * in order to record what was corrected, and a decision log that could not quote
 * a superseded claim could not explain one.
 */
const ASSERTING_SOURCES = [
  'packages/compiler/src/compilation-request.ts',
  'docs/ARCHITECTURE.md',
  'docs/MVP_SCOPE.md',
  'README.md',
] as const;

/**
 * Claims that the request alone determines the compiled result.
 *
 * Each contradicts INV-DET-001, which defines determinism over the request plus
 * the tokenizer implementation and version, the compiler version, and the
 * supplied reference time, and DEC-035, which keeps tokenizer identity out of
 * every stage contract.
 */
const WITHDRAWN_CLAIMS = [
  'self-contained input',
  'complete, self-contained',
  'complete input of one compilation',
  'Everything a deterministic compilation needs',
  'all information required for deterministic compilation',
  'same policy version and request must produce the same result',
  'the same request compiled twice cannot differ',
] as const;

describe('DEC-036: the request is not claimed to be the whole deterministic input', () => {
  it.each(ASSERTING_SOURCES)('%s makes no withdrawn self-containment claim', (relativePath) => {
    const content = read(relativePath);
    for (const claim of WITHDRAWN_CLAIMS) {
      expect(content, `${relativePath} still claims "${claim}"`).not.toContain(claim);
    }
  });

  it('DECISIONS records the correction, quoting the claim it withdrew', () => {
    const decisions = read('docs/DECISIONS.md');
    expect(decisions).toContain('### CompilationRequest Is Request Data, Not the Composition Root');
    expect(decisions).toContain('complete, self-contained input of one compilation');
    expect(decisions).toContain('the request alone is not the complete deterministic input');
  });

  it('names the composition inputs the request deliberately omits', () => {
    for (const relativePath of [
      'packages/compiler/src/compilation-request.ts',
      'docs/ARCHITECTURE.md',
      'README.md',
    ]) {
      const content = read(relativePath);
      expect(content, `${relativePath} omits INV-DET-001`).toContain('INV-DET-001');
      expect(content, `${relativePath} omits DEC-035`).toContain('DEC-035');
      expect(content.toLowerCase(), `${relativePath} omits the tokenizer input`).toContain(
        'tokenizer',
      );
    }
  });

  it('defines CompilationRequest as caller-supplied request data', () => {
    for (const relativePath of ASSERTING_SOURCES) {
      expect(read(relativePath).toLowerCase(), `${relativePath} omits the definition`).toContain(
        'caller-supplied',
      );
    }
  });

  it('ARCHITECTURE 5.6 states determinism over more than request and policy', () => {
    const architecture = read('docs/ARCHITECTURE.md');
    expect(architecture).toContain(
      'Given the same validated request, policy composition, tokenizer implementation and',
    );
    expect(architecture).toContain('Policy and\nrequest are not the only determinism inputs');
  });

  it('forbids a hidden dependency from filling the gap', () => {
    // The missing inputs are explicit configuration, never an ambient default.
    expect(read('docs/DECISIONS.md')).toContain(
      'The gap between the request and the full deterministic input is filled by **explicit** configuration, never by a clock, a random value, an environment variable, or an ambient default',
    );
  });

  it('adds no tokenizer or compiler-version field to the request or the policy', () => {
    const request = read('packages/compiler/src/compilation-request.ts');
    const policy = read('packages/compiler/src/compilation-policy.ts');
    // The interface bodies stay exactly the Phase 13 shapes.
    for (const field of [
      'readonly tokenizer',
      'readonly tokenizerId',
      'readonly tokenizerVersion',
      'readonly compilerVersion',
      'readonly renderer',
    ]) {
      expect(request, `request declares ${field}`).not.toContain(field);
      expect(policy, `policy declares ${field}`).not.toContain(field);
    }
    expect(request).toContain('readonly referenceTime: Timestamp;');
  });
});

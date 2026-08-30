import {
  CONTEXT_RENDERING_POLICY_SCHEMA_VERSION,
  ContextRenderer,
  ContextRenderingError,
  type ContextRenderingPolicy,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  issueCodesOf,
  issuesOf,
  orderSpecs,
  render,
  renderingPolicy,
  wordTokenizer,
} from './rendering-fixtures.js';

/** The reported issues, projected onto the fields these tests assert on. */
function problemsOf(
  run: () => unknown,
): readonly { readonly code: string; readonly pointer: string; readonly message: string }[] {
  return issuesOf(run).map(({ code, pointer, message }) => ({ code, pointer, message }));
}

/**
 * The rendering policy and the tokenizer are external configuration and an
 * injected dependency: both are runtime boundaries of this stage, so both are
 * validated strictly before anything is rendered (DEC-035).
 */

describe('context rendering: policy validation', () => {
  it('accepts the minimal valid policy and preserves its exact strings', () => {
    const result = render(
      orderSpecs([{ id: 'block-1' }]),
      wordTokenizer,
      renderingPolicy({ policyId: '  Rendering  Policy  ', policyVersion: '1.0.0-RC.1' }),
    );

    expect(result.renderingPolicyId).toBe('  Rendering  Policy  ');
    expect(result.renderingPolicyVersion).toBe('1.0.0-RC.1');
  });

  it('publishes the current policy schema version', () => {
    expect(CONTEXT_RENDERING_POLICY_SCHEMA_VERSION).toBe(1);
  });

  it('rejects a policy that is not the current schema version', () => {
    expect(
      issueCodesOf(() => new ContextRenderer(renderingPolicy({ schemaVersion: 2 }), wordTokenizer)),
    ).toEqual(['invalid_policy']);
    expect(
      issueCodesOf(
        () => new ContextRenderer(renderingPolicy({ schemaVersion: '1' }), wordTokenizer),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('rejects a blank policy identity without rewriting it', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(
        problemsOf(() => new ContextRenderer(renderingPolicy({ policyId: blank }), wordTokenizer)),
      ).toEqual([
        {
          code: 'invalid_policy',
          pointer: 'policyId',
          message: 'must not be empty or whitespace-only',
        },
      ]);
      expect(
        problemsOf(
          () => new ContextRenderer(renderingPolicy({ policyVersion: blank }), wordTokenizer),
        ),
      ).toEqual([
        {
          code: 'invalid_policy',
          pointer: 'policyVersion',
          message: 'must not be empty or whitespace-only',
        },
      ]);
    }
  });

  it('INV-BLOCK-007: rejects malformed UTF-16 in a policy identity', () => {
    const lone = `policy-${String.fromCharCode(0xd800)}`;
    expect(
      problemsOf(() => new ContextRenderer(renderingPolicy({ policyId: lone }), wordTokenizer)),
    ).toEqual([
      { code: 'invalid_policy', pointer: 'policyId', message: 'must be well-formed UTF-16' },
    ]);
    expect(
      problemsOf(
        () => new ContextRenderer(renderingPolicy({ policyVersion: lone }), wordTokenizer),
      ),
    ).toEqual([
      { code: 'invalid_policy', pointer: 'policyVersion', message: 'must be well-formed UTF-16' },
    ]);
  });

  it('rejects an unknown field rather than stripping it', () => {
    expect(
      issueCodesOf(
        () => new ContextRenderer(renderingPolicy({ includeSourceTitle: true }), wordTokenizer),
      ),
    ).toEqual(['invalid_policy']);
  });

  it('rejects every format but the one v1 format', () => {
    for (const format of ['markdown-sections', 'xml-blocks', 'jsonl', 'JSONL-BLOCKS', '']) {
      expect(
        issueCodesOf(() => new ContextRenderer(renderingPolicy({ format }), wordTokenizer)),
        `format ${format}`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('injects no default: every field must be supplied', () => {
    for (const field of ['schemaVersion', 'policyId', 'policyVersion', 'format']) {
      const partial: Record<string, unknown> = renderingPolicy();
      delete partial[field];
      expect(
        issueCodesOf(() => new ContextRenderer(partial, wordTokenizer)),
        `missing ${field}`,
      ).toEqual(['invalid_policy']);
    }
  });

  it('coerces nothing at the runtime boundary', () => {
    for (const policy of [
      null,
      undefined,
      'jsonl-blocks',
      42,
      [],
      renderingPolicy({ policyId: 7 }),
      renderingPolicy({ policyVersion: null }),
    ]) {
      expect(
        () => new ContextRenderer(policy, wordTokenizer),
        `policy ${JSON.stringify(policy) ?? 'undefined'}`,
      ).toThrow(ContextRenderingError);
    }
  });

  it('publishes a stable top-level error code', () => {
    try {
      new ContextRenderer({}, wordTokenizer);
    } catch (error) {
      expect((error as ContextRenderingError).code).toBe('CONTEXT_RENDERING_FAILED');
      expect((error as ContextRenderingError).name).toBe('ContextRenderingError');
      expect(error).toBeInstanceOf(Error);
      return;
    }
    throw new Error('expected the empty policy to be rejected');
  });

  it('accepts an unknown value at the runtime boundary when it is a valid policy', () => {
    const untyped: unknown = {
      schemaVersion: 1,
      policyId: 'p',
      policyVersion: '1',
      format: 'jsonl-blocks',
    };
    expect(() => new ContextRenderer(untyped, wordTokenizer)).not.toThrow();
  });

  it('accepts the typed policy interface', () => {
    const policy: ContextRenderingPolicy = {
      schemaVersion: CONTEXT_RENDERING_POLICY_SCHEMA_VERSION,
      policyId: 'rendering',
      policyVersion: '1.0.0',
      format: 'jsonl-blocks',
    };
    expect(() => new ContextRenderer(policy, wordTokenizer)).not.toThrow();
  });
});

describe('context rendering: tokenizer construction contract', () => {
  it('accepts a valid Tokenizer and preserves its exact identity', () => {
    const tokenizer: Tokenizer = {
      id: '  js-tiktoken:o200k_base  ',
      version: ' 1.0.21 ',
      countTokens: (): number => 0,
    };
    const result = render(orderSpecs([{ id: 'block-1' }]), tokenizer);

    expect(result.tokenizerId).toBe('  js-tiktoken:o200k_base  ');
    expect(result.tokenizerVersion).toBe(' 1.0.21 ');
  });

  it('rejects a tokenizer that is not an object', () => {
    for (const invalid of [null, undefined, 'tokenizer', 42]) {
      expect(
        problemsOf(() => new ContextRenderer(renderingPolicy(), invalid as unknown as Tokenizer)),
        `tokenizer ${String(invalid)}`,
      ).toEqual([
        { code: 'invalid_tokenizer', pointer: 'tokenizer', message: 'must be a Tokenizer' },
      ]);
    }
  });

  it('rejects a blank tokenizer identity', () => {
    for (const blank of ['', '   ']) {
      expect(
        problemsOf(
          () =>
            new ContextRenderer(renderingPolicy(), {
              id: blank,
              version: '1',
              countTokens: (): number => 0,
            }),
        ),
      ).toEqual([
        {
          code: 'invalid_tokenizer',
          pointer: 'tokenizer.id',
          message: 'must not be empty or whitespace-only',
        },
      ]);
      expect(
        problemsOf(
          () =>
            new ContextRenderer(renderingPolicy(), {
              id: 'fake',
              version: blank,
              countTokens: (): number => 0,
            }),
        ),
      ).toEqual([
        {
          code: 'invalid_tokenizer',
          pointer: 'tokenizer.version',
          message: 'must not be empty or whitespace-only',
        },
      ]);
    }
  });

  it('rejects a missing or non-function countTokens', () => {
    for (const countTokens of [undefined, null, 'count', 7]) {
      expect(
        problemsOf(
          () =>
            new ContextRenderer(renderingPolicy(), {
              id: 'fake',
              version: '1',
              countTokens,
            } as unknown as Tokenizer),
        ),
        `countTokens ${String(countTokens)}`,
      ).toEqual([
        {
          code: 'invalid_tokenizer',
          pointer: 'tokenizer.countTokens',
          message: 'must be a function',
        },
      ]);
    }
  });

  it('reports every dependency problem from one construction attempt', () => {
    expect(
      issueCodesOf(
        () =>
          new ContextRenderer({}, {
            id: '',
            version: '',
            countTokens: undefined,
          } as unknown as Tokenizer),
      ),
    ).toEqual([
      'invalid_policy',
      'invalid_policy',
      'invalid_policy',
      'invalid_policy',
      'invalid_tokenizer',
      'invalid_tokenizer',
      'invalid_tokenizer',
    ]);
  });
});

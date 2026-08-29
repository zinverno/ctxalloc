import { CandidateValidationError, CandidateValidator } from '@ctxalloc/compiler';
import { FakeTokenizer } from '@ctxalloc/testing';
import type { Tokenizer } from '@ctxalloc/ports';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT,
  SCOPE,
  candidate,
  countWords,
  input,
  retrieval,
  sourceDocument,
  wordTokenizer,
} from './fixtures.js';

/**
 * Strict candidate validation (DEC-030).
 *
 * Nothing here reads the clock, the filesystem, the environment, the network, a
 * database, a model API, or a retrieval provider.
 */

const validator = new CandidateValidator(wordTokenizer);

function expectRejected(
  input: unknown,
  usedValidator: CandidateValidator = validator,
): CandidateValidationError {
  try {
    usedValidator.validate(input);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateValidationError);
    return error as CandidateValidationError;
  }
  throw new Error('expected CandidateValidator to reject the batch');
}

function codes(error: CandidateValidationError): string[] {
  return error.issues.map((issue) => issue.code);
}

function pointers(error: CandidateValidationError): string[] {
  return error.issues.map((issue) => issue.pointer);
}

/* -------------------------------------------------------------------------- */

describe('CandidateValidator construction validates the injected Tokenizer', () => {
  it('accepts a valid FakeTokenizer', () => {
    const tokenizer = new FakeTokenizer([{ text: DEFAULT_CONTENT, tokens: 5 }]);
    expect(() => new CandidateValidator(tokenizer)).not.toThrow();
  });

  it('accepts any object satisfying the port', () => {
    expect(() => new CandidateValidator(wordTokenizer)).not.toThrow();
  });

  it.each([
    ['blank id', { id: '   ', version: '1', countTokens: countWords }, 'tokenizer.id'],
    ['empty id', { id: '', version: '1', countTokens: countWords }, 'tokenizer.id'],
    ['blank version', { id: 'x', version: '\t', countTokens: countWords }, 'tokenizer.version'],
    ['empty version', { id: 'x', version: '', countTokens: countWords }, 'tokenizer.version'],
  ])('rejects a tokenizer with a %s', (_label, tokenizer, pointer) => {
    const error = expectRejectedConstruction(tokenizer as Tokenizer);
    expect(pointers(error)).toContain(pointer);
  });

  it('rejects a tokenizer without countTokens', () => {
    const error = expectRejectedConstruction({ id: 'x', version: '1' } as unknown as Tokenizer);
    expect(pointers(error)).toEqual(['tokenizer.countTokens']);
  });

  it('rejects a non-function countTokens', () => {
    const error = expectRejectedConstruction({
      id: 'x',
      version: '1',
      countTokens: 'nope',
    } as unknown as Tokenizer);
    expect(pointers(error)).toEqual(['tokenizer.countTokens']);
  });

  it.each([[null], [undefined], ['tokenizer'], [7]])('rejects %s as a tokenizer', (value) => {
    const error = expectRejectedConstruction(value as unknown as Tokenizer);
    expect(pointers(error)).toEqual(['tokenizer']);
  });

  it('collects every construction problem at once', () => {
    const error = expectRejectedConstruction({ id: ' ', version: ' ' } as unknown as Tokenizer);
    expect(pointers(error)).toEqual(['tokenizer.id', 'tokenizer.version', 'tokenizer.countTokens']);
  });

  it('does not rewrite the caller tokenizer identity', () => {
    const tokenizer: Tokenizer = {
      id: '  Padded-Id  ',
      version: ' 1.0.0 ',
      countTokens: countWords,
    };
    new CandidateValidator(tokenizer);
    expect(tokenizer.id).toBe('  Padded-Id  ');
    expect(tokenizer.version).toBe(' 1.0.0 ');
  });

  it('reports the tokenizer message with the CANDIDATE_VALIDATION_FAILED code', () => {
    const error = expectRejectedConstruction({ id: '', version: '1' } as unknown as Tokenizer);
    expect(error.code).toBe('CANDIDATE_VALIDATION_FAILED');
    expect(error.name).toBe('CandidateValidationError');
  });
});

function expectRejectedConstruction(tokenizer: Tokenizer): CandidateValidationError {
  try {
    new CandidateValidator(tokenizer);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateValidationError);
    return error as CandidateValidationError;
  }
  throw new Error('expected the constructor to reject the tokenizer');
}

/* -------------------------------------------------------------------------- */

describe('INV-BLOCK-005: the batch is validated at the runtime boundary', () => {
  it('accepts an empty batch with no sources and no candidates', () => {
    const result = validator.validate({
      scope: { ...SCOPE },
      sourceDocuments: [],
      candidates: [],
    });
    expect(result.candidates).toEqual([]);
    expect(result.sourceDocuments).toEqual([]);
    expect(result.scope).toEqual(SCOPE);
  });

  it('accepts one valid source and one valid candidate', () => {
    const result = validator.validate(input());
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.block.id).toBe('block-1');
  });

  it('accepts multiple valid sources and candidates', () => {
    const result = validator.validate(
      input({
        sourceDocuments: [sourceDocument(), sourceDocument({ id: 'doc-2' })],
        candidates: [
          candidate(),
          candidate({ id: 'block-2', content: 'Another block body.', sourceDocumentId: 'doc-2' }),
          candidate({ id: 'block-3', content: 'A third block body here.' }),
        ],
      }),
    );
    expect(result.candidates.map((entry) => entry.block.id)).toEqual([
      'block-1',
      'block-2',
      'block-3',
    ]);
  });

  it('accepts an empty candidate array alongside a populated registry', () => {
    const result = validator.validate(input({ candidates: [] }));
    expect(result.candidates).toEqual([]);
    expect(result.sourceDocuments).toHaveLength(1);
  });

  it('rejects an unknown top-level field', () => {
    const error = expectRejected(input({ policy: {} }));
    expect(codes(error)).toEqual(['invalid_input']);
    expect(error.issues[0]?.message).toContain('policy');
  });

  it.each(['scope', 'sourceDocuments', 'candidates'])('rejects a missing %s', (field) => {
    const batch = input();
    delete batch[field];
    expect(pointers(expectRejected(batch))).toEqual([field]);
  });

  it.each([
    ['a non-array sourceDocuments', { sourceDocuments: {} }],
    ['a null sourceDocuments', { sourceDocuments: null }],
    ['a string sourceDocuments', { sourceDocuments: 'doc-1' }],
  ])('rejects %s', (_label, overrides) => {
    expect(pointers(expectRejected(input(overrides)))).toEqual(['sourceDocuments']);
  });

  it.each([
    ['a non-array candidates', { candidates: {} }],
    ['a null candidates', { candidates: null }],
    ['a numeric candidates', { candidates: 7 }],
  ])('rejects %s', (_label, overrides) => {
    expect(pointers(expectRejected(input(overrides)))).toEqual(['candidates']);
  });

  it.each([[null], [undefined], ['batch'], [7], [[]], [true]])(
    'rejects %s as a whole batch',
    (value) => {
      expect(() => validator.validate(value)).toThrow(CandidateValidationError);
    },
  );

  it('rejects an invalid scope', () => {
    expect(pointers(expectRejected(input({ scope: { tenantId: 'local' } })))).toEqual([
      'scope.workspaceId',
    ]);
  });

  it('reports deterministic indexed paths for malformed records', () => {
    const error = expectRejected(
      input({
        candidates: [candidate(), candidate({ tokenCount: 'seven' }), candidate()],
      }),
    );
    expect(pointers(error)).toEqual(['candidates[1].block.tokenCount']);
  });

  it('collects every schema problem in the batch before failing', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ contentHash: 'not-a-hash' })],
        candidates: [candidate({ tokenCount: -1 }), candidate({ content: '   ' })],
      }),
    );
    expect(pointers(error)).toEqual([
      'sourceDocuments[0].contentHash',
      'candidates[0].block.tokenCount',
      'candidates[1].block.content',
    ]);
  });

  it('does not mutate the caller batch, arrays, or nested objects', () => {
    const batch = input({
      sourceDocuments: [sourceDocument({ metadata: { vault: 'notes', tags: ['a', 'b'] } })],
      candidates: [candidate({ metadata: { path: 'a.md' } }, retrieval({ rank: 1 }))],
    });
    const before = JSON.stringify(batch);
    validator.validate(batch);
    expect(JSON.stringify(batch)).toBe(before);
  });

  it('returns data that does not share objects with the caller batch', () => {
    const sources = [sourceDocument()];
    const candidates = [candidate()];
    const batch = { scope: { ...SCOPE }, sourceDocuments: sources, candidates };
    const result = validator.validate(batch);

    expect(result.sourceDocuments).not.toBe(sources);
    expect(result.candidates).not.toBe(candidates);
    expect(result.candidates[0]).not.toBe(candidates[0]);
    expect(result.scope).not.toBe(batch.scope);
  });

  it('keeps absent optional fields absent in the result', () => {
    const result = validator.validate(input());
    const block = result.candidates[0]?.block;
    expect(block === undefined ? null : 'headingPath' in block).toBe(false);
    expect(block === undefined ? null : 'createdAt' in block).toBe(false);
    expect(result.candidates[0] === undefined ? null : 'retrieval' in result.candidates[0]).toBe(
      false,
    );
    expect('projectId' in result.scope).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('INV-BLOCK-005: wrapped ContextBlock records are runtime validated', () => {
  it.each([
    ['a blank block ID', { id: '  ' }, 'candidates[0].block.id'],
    ['a blank sourceDocumentId', { sourceDocumentId: ' ' }, 'candidates[0].block.sourceDocumentId'],
    ['blank content', { content: '   ' }, 'candidates[0].block.content'],
    ['empty content', { content: '' }, 'candidates[0].block.content'],
    [
      'a malformed normalizedContentHash',
      { normalizedContentHash: 'sha256:XYZ' },
      'candidates[0].block.normalizedContentHash',
    ],
    ['a negative tokenCount', { tokenCount: -1 }, 'candidates[0].block.tokenCount'],
    ['a fractional tokenCount', { tokenCount: 1.5 }, 'candidates[0].block.tokenCount'],
    ['an unsupported schemaVersion', { schemaVersion: 2 }, 'candidates[0].block.schemaVersion'],
    ['an unsupported sourceType', { sourceType: 'pdf' }, 'candidates[0].block.sourceType'],
  ])('rejects %s', (_label, overrides, pointer) => {
    expect(pointers(expectRejected(input({ candidates: [candidate(overrides)] })))).toContain(
      pointer,
    );
  });

  it('rejects an invalid source location', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({ sourceLocation: { kind: 'text-range', startOffset: 10, endOffset: 3 } }),
        ],
      }),
    );
    expect(pointers(error)).toEqual(['candidates[0].block.sourceLocation.endOffset']);
  });

  it('rejects an unknown source location kind', () => {
    expectRejected(
      input({ candidates: [candidate({ sourceLocation: { kind: 'page', page: 3 } })] }),
    );
  });

  it('rejects metadata that is not JSON-safe', () => {
    for (const metadata of [
      { when: new Date(0) },
      { size: Number.NaN },
      { fn: 'ok', bad: () => 1 },
    ]) {
      expectRejected(input({ candidates: [candidate({ metadata })] }));
    }
  });

  it('rejects an unknown block field', () => {
    const error = expectRejected(input({ candidates: [candidate({ relevanceScore: 0.9 })] }));
    expect(error.issues[0]?.message).toContain('relevanceScore');
  });

  it('INV-ADAPTER-001: lets no raw validation-library error escape', () => {
    const error = expectRejected(input({ candidates: [candidate({ tokenCount: 'x' })] }));
    expect(error.constructor.name).toBe('CandidateValidationError');
    expect(error).not.toHaveProperty('issues.0.expected');
    for (const issue of error.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
  });

  it('produces JSON-serializable issues', () => {
    const error = expectRejected(input({ candidates: [candidate({ tokenCount: 'x' })] }));
    expect(JSON.parse(JSON.stringify(error.issues))).toEqual(error.issues);
  });
});

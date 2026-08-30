import { CandidateValidationError, CandidateValidator } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import { SCOPE, candidate, input, sourceDocument, wordTokenizer } from './fixtures.js';

/** Exact scope matching and explicit source-registry membership (DEC-030). */

const validator = new CandidateValidator(wordTokenizer);

function expectRejected(batch: unknown): CandidateValidationError {
  try {
    validator.validate(batch);
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateValidationError);
    return error as CandidateValidationError;
  }
  throw new Error('expected CandidateValidator to reject the batch');
}

function issueAt(error: CandidateValidationError, pointer: string): { code: string } | undefined {
  return error.issues.find((issue) => issue.pointer === pointer);
}

const PROJECT_SCOPE = { ...SCOPE, projectId: 'ctxalloc' };

/* -------------------------------------------------------------------------- */

describe('INV-SCOPE-003: candidate scope must match the request scope exactly', () => {
  it('accepts an exactly matching scope without a project', () => {
    expect(() => validator.validate(input())).not.toThrow();
  });

  it('accepts an exactly matching scope with a project', () => {
    expect(() =>
      validator.validate({
        scope: { ...PROJECT_SCOPE },
        sourceDocuments: [sourceDocument({ scope: { ...PROJECT_SCOPE } })],
        candidates: [candidate({ scope: { ...PROJECT_SCOPE } })],
      }),
    ).not.toThrow();
  });

  it('rejects a tenant mismatch', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ scope: { ...SCOPE, tenantId: 'other' } })] }),
    );
    expect(issueAt(error, 'candidates[0].block.scope')?.code).toBe('scope_mismatch');
  });

  it('rejects a workspace mismatch', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ scope: { ...SCOPE, workspaceId: 'other' } })] }),
    );
    expect(issueAt(error, 'candidates[0].block.scope')?.code).toBe('scope_mismatch');
  });

  it('rejects a project mismatch', () => {
    const error = expectRejected({
      scope: { ...PROJECT_SCOPE },
      sourceDocuments: [sourceDocument({ scope: { ...PROJECT_SCOPE } })],
      candidates: [candidate({ scope: { ...SCOPE, projectId: 'other-project' } })],
    });
    expect(issueAt(error, 'candidates[0].block.scope')?.code).toBe('scope_mismatch');
  });

  it('treats an absent projectId and an explicit projectId as different scopes', () => {
    const withProject = expectRejected(
      input({ candidates: [candidate({ scope: { ...PROJECT_SCOPE } })] }),
    );
    expect(issueAt(withProject, 'candidates[0].block.scope')?.code).toBe('scope_mismatch');

    const withoutProject = expectRejected({
      scope: { ...PROJECT_SCOPE },
      sourceDocuments: [sourceDocument({ scope: { ...PROJECT_SCOPE } })],
      candidates: [candidate({ scope: { ...SCOPE } })],
    });
    expect(issueAt(withoutProject, 'candidates[0].block.scope')?.code).toBe('scope_mismatch');
  });

  it('rejects a cross-scope source document', () => {
    const error = expectRejected(
      input({ sourceDocuments: [sourceDocument({ scope: { ...SCOPE, tenantId: 'other' } })] }),
    );
    expect(issueAt(error, 'sourceDocuments[0].scope')?.code).toBe('scope_mismatch');
  });

  it('INV-SCOPE-004: rejects the batch rather than silently removing a cross-scope candidate', () => {
    const batch = input({
      candidates: [
        candidate(),
        candidate({ id: 'block-2', scope: { ...SCOPE, tenantId: 'other' } }),
      ],
    });
    expect(() => validator.validate(batch)).toThrow(CandidateValidationError);
    // The batch is unchanged: nothing was filtered out on the way to the failure.
    expect((batch['candidates'] as unknown[]).length).toBe(2);
  });

  it('reports a cross-scope source and a cross-scope candidate together', () => {
    const error = expectRejected({
      scope: { ...SCOPE },
      sourceDocuments: [sourceDocument({ scope: { ...SCOPE, workspaceId: 'w2' } })],
      candidates: [candidate({ scope: { ...SCOPE, workspaceId: 'w2' } })],
    });
    expect(error.issues.map((issue) => issue.code)).toContain('scope_mismatch');
    expect(error.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('names both scopes in the message without rewriting either', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ scope: { ...SCOPE, tenantId: 'other' } })] }),
    );
    const message = issueAt(error, 'candidates[0].block.scope')
      ? error.issues.find((issue) => issue.pointer === 'candidates[0].block.scope')?.message
      : '';
    expect(message).toContain('"local"');
    expect(message).toContain('"other"');
    expect(message).toContain('projectId: absent');
  });
});

/* -------------------------------------------------------------------------- */

describe('INV-PROV-001: a block source is proven by explicit registry membership', () => {
  it('accepts a candidate whose source is declared', () => {
    expect(() => validator.validate(input())).not.toThrow();
  });

  it('allows an unreferenced source document', () => {
    const result = validator.validate(
      input({ sourceDocuments: [sourceDocument(), sourceDocument({ id: 'doc-unused' })] }),
    );
    expect(result.sourceDocuments.map((document) => document.id)).toEqual(['doc-1', 'doc-unused']);
  });

  it('rejects a candidate whose source is missing from the registry', () => {
    const error = expectRejected(
      input({ candidates: [candidate({ sourceDocumentId: 'doc-absent' })] }),
    );
    expect(issueAt(error, 'candidates[0].block.sourceDocumentId')?.code).toBe('source_not_found');
  });

  it('rejects every candidate whose source is missing', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({ sourceDocumentId: 'doc-absent' }),
          candidate({ id: 'block-2', content: 'Second body here.', sourceDocumentId: 'doc-gone' }),
        ],
      }),
    );
    expect(error.issues.filter((issue) => issue.code === 'source_not_found')).toHaveLength(2);
  });

  it('rejects any candidate when the registry is empty', () => {
    const error = expectRejected(input({ sourceDocuments: [] }));
    expect(issueAt(error, 'candidates[0].block.sourceDocumentId')?.code).toBe('source_not_found');
  });

  it('accepts an empty registry when there are no candidates', () => {
    expect(() =>
      validator.validate({ scope: { ...SCOPE }, sourceDocuments: [], candidates: [] }),
    ).not.toThrow();
  });

  it('INV-ADAPTER-002: does not infer a source from a path, metadata, or array position', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ id: 'doc-real' })],
        candidates: [
          candidate({
            sourceDocumentId: 'doc-1',
            metadata: { path: 'notes/architecture.md', providerDocId: 'doc-real' },
          }),
        ],
      }),
    );
    expect(issueAt(error, 'candidates[0].block.sourceDocumentId')?.code).toBe('source_not_found');
  });
});

describe('INV-BLOCK-002: the source registry is an unambiguous lookup table', () => {
  it('rejects a duplicate source ID even when the two records are identical', () => {
    const error = expectRejected(input({ sourceDocuments: [sourceDocument(), sourceDocument()] }));
    expect(issueAt(error, 'sourceDocuments[1].id')?.code).toBe('duplicate_source_document_id');
  });

  it('rejects a duplicate source ID carrying different data', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument(), sourceDocument({ title: 'Renamed' })],
      }),
    );
    expect(issueAt(error, 'sourceDocuments[1].id')?.code).toBe('duplicate_source_document_id');
  });

  it('reports every repetition of a duplicated ID', () => {
    const error = expectRejected(
      input({ sourceDocuments: [sourceDocument(), sourceDocument(), sourceDocument()] }),
    );
    expect(
      error.issues.filter((issue) => issue.code === 'duplicate_source_document_id'),
    ).toHaveLength(2);
  });

  it('names the first declaration in the message', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ id: 'doc-x' }), sourceDocument({ id: 'doc-x' })],
      }),
    );
    expect(error.issues[0]?.message).toContain('sourceDocuments[0]');
  });
});

describe('the referenced source must agree with the block', () => {
  it('rejects a source whose sourceType differs from the block sourceType', () => {
    const error = expectRejected(
      input({
        sourceDocuments: [sourceDocument({ sourceType: 'text' })],
        candidates: [candidate({ sourceType: 'markdown' })],
      }),
    );
    expect(issueAt(error, 'candidates[0].block.sourceType')?.code).toBe('source_type_mismatch');
  });

  it('accepts a matching non-Markdown source type', () => {
    expect(() =>
      validator.validate(
        input({
          sourceDocuments: [sourceDocument({ sourceType: 'conversation' })],
          candidates: [
            candidate({
              sourceType: 'conversation',
              sourceLocation: { kind: 'conversation-message', messageId: 'msg-1' },
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a source whose scope differs from the block scope', () => {
    const error = expectRejected({
      scope: { ...SCOPE },
      sourceDocuments: [sourceDocument({ scope: { ...PROJECT_SCOPE } })],
      candidates: [candidate({ scope: { ...SCOPE } })],
    });
    const found = error.issues.map((issue) => issue.code);
    expect(found).toContain('scope_mismatch');
    expect(found).toContain('source_scope_mismatch');
  });

  it('INV-DET-002: registry order does not change acceptance', () => {
    const documents = [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })];
    const candidates = [
      candidate({ sourceDocumentId: 'doc-2' }),
      candidate({ id: 'block-2', content: 'Second body here.', sourceDocumentId: 'doc-1' }),
    ];

    const forward = validator.validate({
      scope: { ...SCOPE },
      sourceDocuments: documents,
      candidates,
    });
    const reversed = validator.validate({
      scope: { ...SCOPE },
      sourceDocuments: [...documents].reverse(),
      candidates,
    });

    expect(forward.candidates).toEqual(reversed.candidates);
    expect(forward.sourceDocuments).toEqual([...reversed.sourceDocuments].reverse());
  });

  it('INV-DET-002: registry order does not change rejection', () => {
    const build = (documents: unknown[]): unknown => ({
      scope: { ...SCOPE },
      sourceDocuments: documents,
      candidates: [candidate({ sourceDocumentId: 'doc-missing' })],
    });
    const documents = [sourceDocument({ id: 'doc-1' }), sourceDocument({ id: 'doc-2' })];

    expect(expectRejected(build(documents)).issues.map((issue) => issue.code)).toEqual(
      expectRejected(build([...documents].reverse())).issues.map((issue) => issue.code),
    );
  });
});

describe('SourceLocation validation is limited to the schema and the reference', () => {
  it('validates the SourceLocation shape', () => {
    const error = expectRejected(
      input({
        candidates: [
          candidate({ sourceLocation: { kind: 'text-range', startOffset: -1, endOffset: 4 } }),
        ],
      }),
    );
    expect(pointerCodes(error)).toContainEqual([
      'candidates[0].block.sourceLocation.startOffset',
      'invalid_input',
    ]);
  });

  it('accepts an offset beyond any plausible source length, which it cannot check', () => {
    // `SourceDocument` deliberately does not carry full content, so
    // `endOffset <= sourceLength` is the source and chunker contract, verified by
    // source-reconstruction tests, not something this stage can prove
    // (INV-BLOCK-006).
    expect(() =>
      validator.validate(
        input({
          candidates: [
            candidate({
              sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: 10_000_000 },
            }),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('accepts a candidate with no source location at all', () => {
    const block = candidate();
    delete (block['block'] as Record<string, unknown>)['sourceLocation'];
    expect(() => validator.validate(input({ candidates: [block] }))).not.toThrow();
  });

  it('does not recompute SourceDocument.contentHash', () => {
    // The complete original source content is intentionally absent during
    // compilation, so the source-level hash is carried, never rechecked.
    expect(() =>
      validator.validate(
        input({ sourceDocuments: [sourceDocument({ contentHash: `sha256:${'f'.repeat(64)}` })] }),
      ),
    ).not.toThrow();
  });
});

function pointerCodes(error: CandidateValidationError): [string, string][] {
  return error.issues.map((issue) => [issue.pointer, issue.code]);
}

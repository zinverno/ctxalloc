import { SourceIngestionValidationError, ingestSource } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { DomainValidationError } from '../../packages/domain/src/index.js';
import { validInput } from './fixtures.js';

/** Invokes ingestion and returns the structured error it must have thrown. */
function expectRejected(input: unknown): SourceIngestionValidationError {
  try {
    ingestSource(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceIngestionValidationError);
    return error as SourceIngestionValidationError;
  }
  throw new Error('expected ingestSource to reject the input');
}

describe('source ingestion accepts explicit valid input', () => {
  it('accepts a minimal Markdown source', () => {
    const { document } = ingestSource(validInput());

    expect(document.schemaVersion).toBe(1);
    expect(document.scope).toEqual({ tenantId: 'local', workspaceId: 'default' });
    expect(document.sourceType).toBe('markdown');
    expect(document.metadata).toEqual({});
  });

  it('accepts a plain text source', () => {
    const { document } = ingestSource(validInput({ sourceType: 'text' }));
    expect(document.sourceType).toBe('text');
  });

  it('accepts a conversation source', () => {
    const { document } = ingestSource(
      validInput({
        sourceType: 'conversation',
        identity: { namespace: 'chat:acme', key: 'conversation-42' },
      }),
    );
    expect(document.sourceType).toBe('conversation');
  });

  it('accepts every optional field and keeps the supplied values exactly', () => {
    const { document } = ingestSource(
      validInput({
        scope: { tenantId: 'local', workspaceId: 'default', projectId: 'ctxalloc' },
        title: 'Project notes',
        createdAt: '2026-01-31T09:15:00.000Z',
        updatedAt: '2026-02-01T10:00:00Z',
        metadata: { path: 'projects/ctxalloc.md', tags: ['notes'], depth: 2, pinned: true },
      }),
    );

    expect(document.title).toBe('Project notes');
    expect(document.createdAt).toBe('2026-01-31T09:15:00.000Z');
    expect(document.updatedAt).toBe('2026-02-01T10:00:00Z');
    expect(document.scope.projectId).toBe('ctxalloc');
    expect(document.metadata).toEqual({
      path: 'projects/ctxalloc.md',
      tags: ['notes'],
      depth: 2,
      pinned: true,
    });
  });

  it('leaves absent optional fields absent instead of injecting a default', () => {
    const { document } = ingestSource(validInput());

    expect(Object.keys(document).sort()).toEqual([
      'contentHash',
      'id',
      'metadata',
      'schemaVersion',
      'scope',
      'sourceType',
    ]);
    expect('title' in document).toBe(false);
    expect('createdAt' in document).toBe(false);
    expect('updatedAt' in document).toBe(false);
    expect('projectId' in document.scope).toBe(false);
  });

  it('does not add the logical identity or the content to the record', () => {
    const { document } = ingestSource(validInput({ metadata: {} }));

    expect('identity' in document).toBe(false);
    expect('content' in document).toBe(false);
    expect(document.metadata).toEqual({});
  });
});

describe('INV-BLOCK-005: source ingestion rejects invalid input at the runtime boundary', () => {
  it('rejects an unknown top-level field instead of stripping it', () => {
    const error = expectRejected(validInput({ filePath: '/home/user/notes.md' }));
    expect(error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
  });

  it('rejects an unknown identity field instead of stripping it', () => {
    const error = expectRejected(
      validInput({ identity: { namespace: 'vault:notes', key: 'a.md', vaultPath: '/vault' } }),
    );
    expect(error.issues[0]?.pointer).toBe('identity');
  });

  it('rejects a blank identity namespace', () => {
    expect(
      expectRejected(validInput({ identity: { namespace: '', key: 'a.md' } })).issues[0]?.pointer,
    ).toBe('identity.namespace');
    expect(
      expectRejected(validInput({ identity: { namespace: '   ', key: 'a.md' } })).issues[0]
        ?.pointer,
    ).toBe('identity.namespace');
  });

  it('rejects a blank identity key', () => {
    expect(
      expectRejected(validInput({ identity: { namespace: 'vault', key: '' } })).issues[0]?.pointer,
    ).toBe('identity.key');
    expect(
      expectRejected(validInput({ identity: { namespace: 'vault', key: '\t\n' } })).issues[0]
        ?.pointer,
    ).toBe('identity.key');
  });

  it('rejects a non-string identity namespace without coercing it', () => {
    for (const namespace of [7, true, null, {}, ['vault']]) {
      const error = expectRejected(validInput({ identity: { namespace, key: 'a.md' } }));
      expect(error.issues[0]?.pointer).toBe('identity.namespace');
    }
  });

  it('rejects a non-string identity key without coercing it', () => {
    for (const key of [7, false, null, {}, ['a.md']]) {
      const error = expectRejected(validInput({ identity: { namespace: 'vault', key } }));
      expect(error.issues[0]?.pointer).toBe('identity.key');
    }
  });

  it('rejects a missing or non-string content value', () => {
    for (const content of [undefined, 7, null, true, ['text'], { text: 'x' }]) {
      const error = expectRejected(validInput({ content }));
      expect(error.issues[0]?.pointer).toBe('content');
    }
  });

  it('INV-SCOPE-001: rejects a missing, incomplete, or malformed scope', () => {
    for (const scope of [
      undefined,
      {},
      { tenantId: 'local' },
      { tenantId: '', workspaceId: 'default' },
      { tenantId: 'local', workspaceId: '  ' },
      { tenantId: 'local', workspaceId: 'default', region: 'eu' },
      'local/default',
    ]) {
      const error = expectRejected(validInput({ scope }));
      expect(error.issues[0]?.pointer.startsWith('scope')).toBe(true);
    }
  });

  it('rejects a source type outside the closed set', () => {
    for (const sourceType of ['pdf', 'MARKDOWN', '', 1, null]) {
      const error = expectRejected(validInput({ sourceType }));
      expect(error.issues[0]?.pointer).toBe('sourceType');
    }
  });

  it('INV-DET-004: rejects a malformed or impossible timestamp', () => {
    for (const value of ['2026-01-31', '2026-02-31T00:00:00Z', 'now', 1_764_000_000_000]) {
      expect(expectRejected(validInput({ createdAt: value })).issues[0]?.pointer).toBe('createdAt');
      expect(expectRejected(validInput({ updatedAt: value })).issues[0]?.pointer).toBe('updatedAt');
    }
  });

  it('rejects metadata that is not JSON-safe', () => {
    for (const metadata of [
      undefined,
      null,
      'none',
      ['a'],
      { when: new Date(0) },
      { size: Number.NaN },
      { size: Number.POSITIVE_INFINITY },
      { load: () => 'x' },
    ]) {
      const error = expectRejected(validInput({ metadata }));
      expect(error.issues[0]?.pointer.startsWith('metadata')).toBe(true);
    }
  });

  it('rejects an input that is not an object at all', () => {
    for (const input of [undefined, null, 'text', 42, ['a'], true]) {
      expect(expectRejected(input).issues.length).toBeGreaterThan(0);
    }
  });
});

describe('INV-ADAPTER-001: validation failures stay project-owned', () => {
  it('throws a project-owned error with a stable machine-readable code', () => {
    const error = expectRejected(validInput({ sourceType: 'pdf' }));

    expect(error.name).toBe('SourceIngestionValidationError');
    expect(error.code).toBe('SOURCE_INGESTION_INVALID_INPUT');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DomainValidationError);
  });

  it('does not let a validation-library error escape', () => {
    const error = expectRejected(validInput({ content: 7 }));

    const prototypes: string[] = [];
    for (
      let current: unknown = Object.getPrototypeOf(error) as unknown;
      current !== null;
      current = Object.getPrototypeOf(current) as unknown
    ) {
      prototypes.push((current as { constructor?: { name?: string } }).constructor?.name ?? '');
    }
    expect(prototypes).toEqual(['SourceIngestionValidationError', 'Error', 'Object']);
    expect(prototypes.some((name) => name.startsWith('Zod'))).toBe(false);
  });

  it('reports serializable issues with a stable shape', () => {
    const error = expectRejected(validInput({ sourceType: 'pdf', content: 7 }));

    expect(error.issues.length).toBeGreaterThan(0);
    for (const issue of error.issues) {
      expect(Object.keys(issue).sort()).toEqual(['code', 'message', 'path', 'pointer']);
      expect(typeof issue.code).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(Array.isArray(issue.path)).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(error.issues))).toEqual(error.issues);
  });

  it('INV-DET-001: reports identical issues for identical invalid input', () => {
    const first = expectRejected(validInput({ sourceType: 'pdf' }));
    const second = expectRejected(validInput({ sourceType: 'pdf' }));
    expect(first.issues).toEqual(second.issues);
    expect(first.message).toBe(second.message);
  });
});

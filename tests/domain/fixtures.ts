/**
 * Shared plain-object fixtures for domain tests.
 *
 * Fixtures are deliberately untyped input: schemas accept `unknown`, so tests
 * exercise the same path that real file, database, and HTTP input will take.
 * No fixture uses the current time, randomness, or any external system.
 */

export const VALID_HASH = `sha256:${'a'.repeat(64)}`;
export const OTHER_HASH = `sha256:${'b'.repeat(64)}`;

export const VALID_SCOPE = { tenantId: 'local', workspaceId: 'default' };

export function validSourceDocument(): Record<string, unknown> {
  return {
    id: 'doc-1',
    schemaVersion: 1,
    scope: { ...VALID_SCOPE },
    sourceType: 'markdown',
    title: 'Architecture Notes',
    contentHash: VALID_HASH,
    createdAt: '2026-01-31T09:15:00.000Z',
    updatedAt: '2026-02-01T10:00:00Z',
    metadata: { vault: 'notes', tags: ['architecture', 'mvp'] },
  };
}

export function validContextBlock(): Record<string, unknown> {
  return {
    id: 'block-1',
    schemaVersion: 1,
    scope: { ...VALID_SCOPE },
    sourceDocumentId: 'doc-1',
    sourceType: 'markdown',
    sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: 42 },
    content: '# Heading\n\nBody text.',
    normalizedContentHash: VALID_HASH,
    tokenCount: 7,
    headingPath: ['Heading'],
    attributes: { required: true, priority: 10, category: 'documentation' },
    metadata: { path: 'notes/architecture.md' },
  };
}

/**
 * Shared literal fixtures for the source-ingestion tests.
 *
 * Inputs are built as plain records because `ingestSource` accepts `unknown`:
 * the tests must be able to supply the invalid shapes a runtime boundary has to
 * reject. No fixture reads the clock, the filesystem, the environment, or the
 * network.
 */

/** Canonical valid input. `overrides` replaces top-level fields. */
export function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: { tenantId: 'local', workspaceId: 'default' },
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'projects/ctxalloc.md' },
    content: '# Title\n\nBody.\n',
    metadata: {},
    ...overrides,
  };
}

/**
 * Committed golden identity vector.
 *
 * It is the SHA-256 of the canonical identity payload
 * `["ctxalloc-source-document-id",1,"local","default",null,"markdown","vault:notes","projects/ctxalloc.md"]`
 * encoded as UTF-8. A change to the payload shape, its order, or its algorithm
 * version breaks this vector, which is the point: document identity must not
 * drift silently (DEC-028).
 */
export const GOLDEN_SOURCE_DOCUMENT_ID =
  'source-document:sha256:3969ce07c67a1802abd4e1fe17dbf2a2ecef80da63cf3c7f3240411f02d5b474';

/** SHA-256 of the empty string, the documented empty-input digest. */
export const EMPTY_CONTENT_HASH =
  'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

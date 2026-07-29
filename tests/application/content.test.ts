import { createHash } from 'node:crypto';
import { ingestSource } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { ContentHashSchema, safeParse } from '../../packages/domain/src/index.js';
import { EMPTY_CONTENT_HASH, validInput } from './fixtures.js';

/** Independent reference implementation of the documented hash algorithm. */
function referenceHash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function ingestContent(content: string): { content: string; contentHash: string } {
  const result = ingestSource(validInput({ content }));
  return { content: result.content, contentHash: result.document.contentHash };
}

const NFC_CAFE = 'caf\u00E9';
const NFD_CAFE = 'cafe\u0301';

describe('INV-ALLOC-004: source ingestion never modifies source content', () => {
  it('accepts empty content', () => {
    expect(ingestContent('').content).toBe('');
  });

  it('accepts whitespace-only content', () => {
    expect(ingestContent('   \n\t').content).toBe('   \n\t');
  });

  it('returns the exact string value that was supplied', () => {
    const content = '# Title\r\n\r\n  spaced  \n\ttabbed\n';
    const result = ingestSource(validInput({ content }));
    expect(result.content).toBe(content);
  });

  it('preserves leading and trailing whitespace', () => {
    expect(ingestContent('   body   ').content).toBe('   body   ');
    expect(ingestContent('\n\nbody\n\n').content).toBe('\n\nbody\n\n');
  });

  it('preserves the presence or absence of a trailing newline', () => {
    expect(ingestContent('body').content).toBe('body');
    expect(ingestContent('body\n').content).toBe('body\n');
  });

  it('preserves LF and CRLF line endings exactly', () => {
    expect(ingestContent('a\nb').content).toBe('a\nb');
    expect(ingestContent('a\r\nb').content).toBe('a\r\nb');
  });

  it('INV-BLOCK-007: preserves composed and decomposed Unicode as distinct strings', () => {
    expect(ingestContent(NFC_CAFE).content).toBe(NFC_CAFE);
    expect(ingestContent(NFD_CAFE).content).toBe(NFD_CAFE);
    expect(ingestContent(NFC_CAFE).content).not.toBe(ingestContent(NFD_CAFE).content);
  });

  it('INV-BLOCK-007: preserves emoji and supplementary-plane characters', () => {
    const content = '\u{1F600} \u{1F469}\u{200D}\u{1F4BB} \u{20BB7} \u{10437}';
    expect(ingestContent(content).content).toBe(content);
  });

  it('does not remove a byte order mark', () => {
    expect(ingestContent('\uFEFF# Title').content).toBe('\uFEFF# Title');
  });

  it('does not parse Markdown, frontmatter, or split the content', () => {
    const content = '---\ntitle: Note\n---\n\n# Heading\n\nBody.\n';
    const result = ingestSource(validInput({ content, sourceType: 'markdown' }));

    expect(result.content).toBe(content);
    expect(result.document.title).toBeUndefined();
    expect(result.document.metadata).toEqual({});
  });

  it('does not mutate the input object or its metadata', () => {
    const metadata = { path: 'projects/ctxalloc.md', tags: ['notes'] };
    const input = validInput({ metadata, title: 'Project notes' });
    const snapshot = structuredClone(input);

    ingestSource(input);

    expect(input).toEqual(snapshot);
    expect(metadata).toEqual({ path: 'projects/ctxalloc.md', tags: ['notes'] });
  });
});

describe('INV-PROV-005: content hash is derived from the exact source content', () => {
  it('produces the standard SHA-256 digest for empty input', () => {
    expect(ingestContent('').contentHash).toBe(EMPTY_CONTENT_HASH);
  });

  it('matches an independent Node crypto calculation', () => {
    for (const content of [
      '',
      ' ',
      '# Title\n\nBody.\n',
      'a\r\nb',
      NFD_CAFE,
      '\u{1F600}\u{20BB7}',
      '\uFEFFbom',
    ]) {
      expect(ingestContent(content).contentHash).toBe(referenceHash(content));
    }
  });

  it('matches the domain content hash representation', () => {
    const { contentHash } = ingestContent('# Title\n');
    expect(safeParse(ContentHashSchema, contentHash).ok).toBe(true);
    expect(contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('INV-DET-001: identical exact content always produces the identical hash', () => {
    expect(ingestContent('# Title\n').contentHash).toBe(ingestContent('# Title\n').contentHash);
  });

  it('changes when the content changes', () => {
    expect(ingestContent('a').contentHash).not.toBe(ingestContent('b').contentHash);
  });

  it('differs between LF and CRLF variants', () => {
    expect(ingestContent('a\nb').contentHash).not.toBe(ingestContent('a\r\nb').contentHash);
  });

  it('differs when a trailing newline is added or removed', () => {
    expect(ingestContent('body').contentHash).not.toBe(ingestContent('body\n').contentHash);
  });

  it('differs when leading or trailing whitespace changes', () => {
    expect(ingestContent('body').contentHash).not.toBe(ingestContent(' body ').contentHash);
  });

  it('differs between composed and decomposed Unicode forms', () => {
    expect(ingestContent(NFC_CAFE).contentHash).not.toBe(ingestContent(NFD_CAFE).contentHash);
  });

  it('does not depend on identity, scope, title, timestamps, or metadata', () => {
    const content = '# Title\n\nBody.\n';
    const base = ingestSource(validInput({ content }));
    const decorated = ingestSource(
      validInput({
        content,
        scope: { tenantId: 'other', workspaceId: 'other', projectId: 'p' },
        sourceType: 'text',
        identity: { namespace: 'chat:acme', key: 'conversation-42' },
        title: 'Another title',
        createdAt: '2026-01-31T09:15:00.000Z',
        updatedAt: '2026-02-01T10:00:00Z',
        metadata: { path: 'elsewhere.md' },
      }),
    );

    expect(decorated.document.contentHash).toBe(base.document.contentHash);
  });
});

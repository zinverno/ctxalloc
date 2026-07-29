import { createHash } from 'node:crypto';
import { SourceIngestionValidationError, ingestSource } from '@ctxalloc/application';
import { describe, expect, it } from 'vitest';
import { validInput } from './fixtures.js';

const LONE_HIGH_SURROGATE = '\uD800';
const LONE_LOW_SURROGATE = '\uDC00';
/** A low surrogate followed by a high surrogate: two lone surrogates, not a pair. */
const REVERSED_PAIR = '\uDC00\uD800';
const VALID_PAIR = '\u{1F600}';

function expectRejected(input: unknown): SourceIngestionValidationError {
  try {
    ingestSource(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SourceIngestionValidationError);
    return error as SourceIngestionValidationError;
  }
  throw new Error('expected ingestSource to reject malformed UTF-16');
}

describe('INV-BLOCK-007: malformed UTF-16 is rejected before hashing', () => {
  it('rejects a lone high surrogate in the content', () => {
    const error = expectRejected(validInput({ content: `a${LONE_HIGH_SURROGATE}b` }));
    expect(error.issues).toEqual([
      {
        code: 'invalid_unicode',
        path: ['content'],
        pointer: 'content',
        message: 'must be well-formed UTF-16: lone surrogate at code unit 1',
      },
    ]);
  });

  it('rejects a lone low surrogate in the content', () => {
    const error = expectRejected(validInput({ content: LONE_LOW_SURROGATE }));
    expect(error.issues[0]?.pointer).toBe('content');
    expect(error.issues[0]?.code).toBe('invalid_unicode');
  });

  it('rejects a reversed surrogate pair in the content', () => {
    const error = expectRejected(validInput({ content: REVERSED_PAIR }));
    expect(error.issues[0]?.pointer).toBe('content');
  });

  it('rejects a lone surrogate in the identity namespace', () => {
    const error = expectRejected(
      validInput({ identity: { namespace: `vault${LONE_HIGH_SURROGATE}`, key: 'a.md' } }),
    );
    expect(error.issues[0]?.path).toEqual(['identity', 'namespace']);
    expect(error.issues[0]?.pointer).toBe('identity.namespace');
  });

  it('rejects a lone surrogate in the identity key', () => {
    const error = expectRejected(
      validInput({ identity: { namespace: 'vault', key: `a${LONE_LOW_SURROGATE}.md` } }),
    );
    expect(error.issues[0]?.path).toEqual(['identity', 'key']);
  });

  it('reports every malformed value in a fixed order', () => {
    const error = expectRejected(
      validInput({
        identity: { namespace: LONE_HIGH_SURROGATE, key: LONE_LOW_SURROGATE },
        content: LONE_HIGH_SURROGATE,
      }),
    );
    expect(error.issues.map((issue) => issue.pointer)).toEqual([
      'identity.namespace',
      'identity.key',
      'content',
    ]);
  });

  it('fails with the stable ingestion error code', () => {
    expect(expectRejected(validInput({ content: LONE_HIGH_SURROGATE })).code).toBe(
      'SOURCE_INGESTION_INVALID_INPUT',
    );
  });

  it('never returns a replacement-character hash for malformed content', () => {
    const malformed = `note ${LONE_HIGH_SURROGATE} end`;
    const replaced = malformed.replaceAll(LONE_HIGH_SURROGATE, '\uFFFD');
    const replacementHash = `sha256:${createHash('sha256').update(replaced, 'utf8').digest('hex')}`;

    expectRejected(validInput({ content: malformed }));

    // The substituted text is a different source, and only that different source
    // may ever produce that hash.
    const substituted = ingestSource(validInput({ content: replaced }));
    expect(substituted.document.contentHash).toBe(replacementHash);
    expect(substituted.content).toBe(replaced);
    expect(substituted.content).not.toBe(malformed);
  });

  it('accepts a valid surrogate pair', () => {
    const content = `emoji ${VALID_PAIR} end`;
    const result = ingestSource(validInput({ content }));

    expect(result.content).toBe(content);
    expect(result.document.contentHash).toBe(
      `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`,
    );
  });

  it('accepts supplementary-plane characters in the identity', () => {
    const identity = { namespace: `vault:${VALID_PAIR}`, key: `notes/${VALID_PAIR}.md` };
    expect(ingestSource(validInput({ identity })).document.id).toMatch(
      /^source-document:sha256:[0-9a-f]{64}$/,
    );
  });
});

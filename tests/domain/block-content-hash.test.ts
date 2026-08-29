import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ContentHashSchema,
  DomainValidationError,
  calculateNormalizedContentHash,
  normalizeContextBlockContentForHash,
} from '../../packages/domain/src/index.js';

/**
 * The canonical `ContextBlock.normalizedContentHash` rule (DEC-030).
 *
 * These tests use literal fixtures only. They read no clock, generate no random
 * value, and touch no network, filesystem, database, or model API.
 */

const LONE_HIGH_SURROGATE = '\uD800';
const LONE_LOW_SURROGATE = '\uDC00';
/** A low surrogate followed by a high surrogate: two lone surrogates, not a pair. */
const REVERSED_PAIR = '\uDC00\uD800';

/** An independent recomputation of the documented algorithm. */
function expectedHash(normalized: string): string {
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

function expectRejected(content: string): DomainValidationError {
  try {
    calculateNormalizedContentHash(content);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    return error as DomainValidationError;
  }
  throw new Error('expected calculateNormalizedContentHash to reject malformed UTF-16');
}

describe('DEC-030: canonical normalization unifies line endings only', () => {
  it('leaves text without line endings unchanged', () => {
    expect(normalizeContextBlockContentForHash('plain text')).toBe('plain text');
  });

  it('leaves LF unchanged', () => {
    expect(normalizeContextBlockContentForHash('a\nb\n')).toBe('a\nb\n');
  });

  it('rewrites CRLF to LF', () => {
    expect(normalizeContextBlockContentForHash('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('rewrites a lone CR to LF', () => {
    expect(normalizeContextBlockContentForHash('a\rb\r')).toBe('a\nb\n');
  });

  it('rewrites a mixed run of line endings', () => {
    expect(normalizeContextBlockContentForHash('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('does not trim leading or trailing whitespace', () => {
    expect(normalizeContextBlockContentForHash('  a  ')).toBe('  a  ');
  });

  it('does not remove trailing spaces before a line ending', () => {
    expect(normalizeContextBlockContentForHash('a   \nb')).toBe('a   \nb');
  });

  it('does not collapse blank lines', () => {
    expect(normalizeContextBlockContentForHash('a\n\n\n\nb')).toBe('a\n\n\n\nb');
  });

  it('does not normalize Unicode composition', () => {
    const nfd = 'é';
    expect(normalizeContextBlockContentForHash(nfd)).toBe(nfd);
  });

  it('does not remove a BOM', () => {
    expect(normalizeContextBlockContentForHash('﻿a')).toBe('﻿a');
  });
});

describe('INV-PROV-005: the hash is content-derived and matches the documented algorithm', () => {
  it('hashes the empty string to the standard SHA-256 empty digest', () => {
    expect(calculateNormalizedContentHash('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes ordinary ASCII text', () => {
    expect(calculateNormalizedContentHash('Hello, world.')).toBe(expectedHash('Hello, world.'));
  });

  it('hashes LF content', () => {
    expect(calculateNormalizedContentHash('a\nb\n')).toBe(expectedHash('a\nb\n'));
  });

  it('hashes CRLF content through the normalized form', () => {
    expect(calculateNormalizedContentHash('a\r\nb\r\n')).toBe(expectedHash('a\nb\n'));
  });

  it('hashes lone-CR content through the normalized form', () => {
    expect(calculateNormalizedContentHash('a\rb\r')).toBe(expectedHash('a\nb\n'));
  });

  it('gives LF, CRLF, and lone-CR copies of one text the same hash', () => {
    const lf = calculateNormalizedContentHash('# Title\n\nBody.\n');
    expect(calculateNormalizedContentHash('# Title\r\n\r\nBody.\r\n')).toBe(lf);
    expect(calculateNormalizedContentHash('# Title\r\rBody.\r')).toBe(lf);
  });

  it('keeps trailing spaces significant', () => {
    expect(calculateNormalizedContentHash('a   \nb')).not.toBe(
      calculateNormalizedContentHash('a\nb'),
    );
  });

  it('keeps the blank-line count significant', () => {
    expect(calculateNormalizedContentHash('a\n\nb')).not.toBe(
      calculateNormalizedContentHash('a\n\n\nb'),
    );
  });

  it('keeps leading and trailing whitespace significant', () => {
    expect(calculateNormalizedContentHash(' a ')).not.toBe(calculateNormalizedContentHash('a'));
  });

  it('keeps a trailing newline significant', () => {
    expect(calculateNormalizedContentHash('a\n')).not.toBe(calculateNormalizedContentHash('a'));
  });

  it('keeps NFC and NFD forms different', () => {
    const nfc = 'é';
    const nfd = 'é';
    expect(nfc.normalize('NFD')).toBe(nfd);
    expect(calculateNormalizedContentHash(nfc)).not.toBe(calculateNormalizedContentHash(nfd));
  });

  it('keeps indentation significant', () => {
    expect(calculateNormalizedContentHash('    code')).not.toBe(
      calculateNormalizedContentHash('code'),
    );
  });

  it('INV-BLOCK-007: hashes emoji and supplementary characters', () => {
    const text = 'a \u{1F600} b \u{10437} c';
    expect(calculateNormalizedContentHash(text)).toBe(expectedHash(text));
  });

  it('INV-BLOCK-007: hashes a multi-code-point emoji sequence intact', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(calculateNormalizedContentHash(family)).toBe(expectedHash(family));
  });

  it('returns a value that passes ContentHashSchema', () => {
    for (const text of ['', 'a', '# Title\r\nBody', '\u{1F600}']) {
      const parsed = ContentHashSchema.safeParse(calculateNormalizedContentHash(text));
      expect(parsed.success, `hash of ${JSON.stringify(text)}`).toBe(true);
    }
  });

  it('returns lowercase hexadecimal only', () => {
    expect(calculateNormalizedContentHash('Mixed Case Text')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('INV-DET-001: hashing is deterministic', () => {
  it('returns the same value for repeated calls', () => {
    const text = '# Title\r\n\r\nBody with  spaces  \n\n\n\u{1F600}\n';
    const first = calculateNormalizedContentHash(text);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(calculateNormalizedContentHash(text)).toBe(first);
    }
  });

  it('returns the same value for two equal strings built differently', () => {
    const built = ['a', '\r\n', 'b'].join('');
    expect(calculateNormalizedContentHash(built)).toBe(calculateNormalizedContentHash('a\r\nb'));
  });
});

describe('INV-BLOCK-007: malformed UTF-16 is rejected before hashing', () => {
  it('rejects a lone high surrogate', () => {
    const error = expectRejected(`a${LONE_HIGH_SURROGATE}b`);
    expect(error.issues).toEqual([
      {
        code: 'invalid_unicode',
        path: ['content'],
        pointer: 'content',
        message: 'must be well-formed UTF-16: lone surrogate at code unit 1',
      },
    ]);
  });

  it('rejects a lone low surrogate', () => {
    const error = expectRejected(LONE_LOW_SURROGATE);
    expect(error.issues[0]?.code).toBe('invalid_unicode');
    expect(error.issues[0]?.message).toContain('code unit 0');
  });

  it('rejects a reversed surrogate pair', () => {
    expect(expectRejected(REVERSED_PAIR).issues[0]?.code).toBe('invalid_unicode');
  });

  it('rejects a high surrogate at the end of the string', () => {
    expect(expectRejected(`ab${LONE_HIGH_SURROGATE}`).issues[0]?.message).toContain('code unit 2');
  });

  it('does not silently hash U+FFFD replacement text', () => {
    const replaced = 'a�b';
    // The replacement text is itself valid and hashes normally, which is exactly
    // why substituting it for a lone surrogate would be undetectable.
    expect(calculateNormalizedContentHash(replaced)).toBe(expectedHash(replaced));
    expect(() => calculateNormalizedContentHash(`a${LONE_HIGH_SURROGATE}b`)).toThrow(
      DomainValidationError,
    );
  });

  it('accepts a well-formed surrogate pair', () => {
    expect(() => calculateNormalizedContentHash('\u{1F600}')).not.toThrow();
  });

  it('accepts a well-formed pair adjacent to ordinary text', () => {
    expect(() => calculateNormalizedContentHash('a\u{1F600}b\u{1F600}')).not.toThrow();
  });
});

describe('DEC-029 golden hashes survive the move into the domain', () => {
  /**
   * The Phase 6 chunker computed these values with its own private
   * implementation of the same rule. Phase 7 replaced that implementation with
   * this shared helper, and the committed vectors must stay byte-identical: a
   * changed hash is a changed `ContextBlock.id`, which is a silent migration of
   * every stored block (INV-BLOCK-001).
   */
  it.each([
    ['First body.', 'sha256:ff30085e1616a5a5fde4fb8f215684cf9ff5e19aee7849823aac8d29462a158e'],
    ['Second body.', 'sha256:1b7c2530fe0fe41892191627f1c1cb78052a3eae0ed5354c158fa4abcb0bff81'],
  ])('reproduces the committed hash of %j', (content, hash) => {
    expect(calculateNormalizedContentHash(content)).toBe(hash);
  });
});

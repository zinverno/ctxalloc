import {
  InMemorySourceReader,
  InMemorySourceReaderConfigurationError,
  InMemorySourceReaderUnknownLocatorError,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

describe('InMemorySourceReader', () => {
  it('returns the exact configured content for the exact locator', async () => {
    const reader = new InMemorySourceReader([
      { locator: 'notes/a.md', content: '# A\r\n\r\nBody  \n' },
    ]);
    await expect(reader.read({ locator: 'notes/a.md' })).resolves.toEqual({
      content: '# A\r\n\r\nBody  \n',
    });
  });

  it('normalizes nothing: line endings, trailing spaces, and a BOM all survive', async () => {
    const content = '﻿first\r\nsecond   \n\n\n';
    const reader = new InMemorySourceReader([{ locator: 'x.txt', content }]);
    const result = await reader.read({ locator: 'x.txt' });
    expect(result.content).toBe(content);
    expect(result.content.codePointAt(0)).toBe(0xfeff);
  });

  it('INV-ADAPTER-003: fails explicitly for an unknown locator', async () => {
    const reader = new InMemorySourceReader([{ locator: 'known.md', content: 'x' }]);
    await expect(reader.read({ locator: 'missing.md' })).rejects.toBeInstanceOf(
      InMemorySourceReaderUnknownLocatorError,
    );
    await expect(reader.read({ locator: 'missing.md' })).rejects.toMatchObject({
      code: 'IN_MEMORY_SOURCE_READER_UNKNOWN_LOCATOR',
      locator: 'missing.md',
    });
  });

  it('resolves no path: a locator is matched exactly, never normalized', async () => {
    const reader = new InMemorySourceReader([{ locator: 'notes/a.md', content: 'x' }]);
    for (const locator of ['./notes/a.md', 'notes//a.md', 'Notes/a.md', '/notes/a.md']) {
      await expect(reader.read({ locator })).rejects.toBeInstanceOf(
        InMemorySourceReaderUnknownLocatorError,
      );
    }
  });

  it('copies its configuration, so a later mutation cannot change what it returns', async () => {
    const entries = [{ locator: 'a.md', content: 'original' }];
    const reader = new InMemorySourceReader(entries);
    entries.push({ locator: 'b.md', content: 'added' });
    entries[0] = { locator: 'a.md', content: 'replaced' };

    await expect(reader.read({ locator: 'a.md' })).resolves.toEqual({ content: 'original' });
    await expect(reader.read({ locator: 'b.md' })).rejects.toBeInstanceOf(
      InMemorySourceReaderUnknownLocatorError,
    );
  });

  it('rejects a duplicate locator rather than resolving it by configuration order', () => {
    expect(
      () =>
        new InMemorySourceReader([
          { locator: 'a.md', content: 'first' },
          { locator: 'a.md', content: 'second' },
        ]),
    ).toThrow(InMemorySourceReaderConfigurationError);
  });

  it('rejects a blank identity without rewriting it', () => {
    expect(() => new InMemorySourceReader([], { id: '  ' })).toThrow(
      InMemorySourceReaderConfigurationError,
    );
    expect(() => new InMemorySourceReader([], { version: '' })).toThrow(
      InMemorySourceReaderConfigurationError,
    );
    expect(new InMemorySourceReader([], { id: ' spaced ' }).id).toBe(' spaced ');
  });

  it('INV-DET-001: returns the same content for repeated reads', async () => {
    const reader = new InMemorySourceReader([{ locator: 'a.md', content: 'stable' }]);
    const first = await reader.read({ locator: 'a.md' });
    const second = await reader.read({ locator: 'a.md' });
    expect(first).toEqual(second);
  });
});

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NODE_FILE_SOURCE_READER_ID,
  NODE_FILE_SOURCE_READER_VERSION,
  NodeFileSourceReader,
  NodeFileSourceReaderError,
} from '@ctxalloc/adapters';
import type { SourceReader } from '@ctxalloc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The one suite in the repository that touches a real filesystem, because it is
 * the one component whose contract is about a real filesystem (INV-ADAPTER-005).
 * Everything is created inside a temporary directory and removed afterwards; no
 * network, model, or database is reached.
 */

let root: string;
let outside: string;
let reader: SourceReader;

const MAX_BYTES = 4096;

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), 'ctxalloc-reader-'));
  root = join(base, 'vault');
  outside = join(base, 'outside');
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(join(root, 'notes', 'deep'), { recursive: true });

  await writeFile(join(root, 'lf.md'), '# Title\n\nBody line\n', 'utf8');
  await writeFile(join(root, 'crlf.md'), '# Title\r\n\r\nBody line\r\n', 'utf8');
  await writeFile(join(root, 'no-trailing-newline.txt'), 'last line without newline', 'utf8');
  await writeFile(join(root, 'spaces.txt'), 'trailing   \n\tindented\n', 'utf8');
  await writeFile(join(root, 'unicode.txt'), 'héllo 🌍 中文\n', 'utf8');
  await writeFile(join(root, 'bom.txt'), '﻿# Title\n', 'utf8');
  await writeFile(join(root, 'notes', 'deep', 'nested.md'), 'nested body\n', 'utf8');
  await writeFile(join(root, 'large.txt'), 'x'.repeat(MAX_BYTES + 1), 'utf8');

  // A byte sequence that is not valid UTF-8: a lone continuation byte.
  await writeFile(join(root, 'invalid.bin'), Buffer.from([0x68, 0x69, 0x80, 0x0a]));

  await writeFile(join(outside, 'secret.txt'), 'secret content\n', 'utf8');
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.md'));
  await symlink(join(root, 'lf.md'), join(root, 'inside-link.md'));

  reader = new NodeFileSourceReader({ rootDirectory: root, maxBytes: MAX_BYTES });
});

afterAll(async () => {
  if (root !== undefined) await rm(join(root, '..'), { recursive: true, force: true });
});

async function readCode(locator: string): Promise<string> {
  try {
    await reader.read({ locator });
  } catch (cause) {
    expect(cause).toBeInstanceOf(NodeFileSourceReaderError);
    return (cause as NodeFileSourceReaderError).code;
  }
  throw new Error(`expected ${locator} to be rejected`);
}

describe('NodeFileSourceReader: exact reads', () => {
  it('publishes a stable project-owned identity', () => {
    expect(reader.id).toBe(NODE_FILE_SOURCE_READER_ID);
    expect(reader.version).toBe(NODE_FILE_SOURCE_READER_VERSION);
    expect(NODE_FILE_SOURCE_READER_ID).toBe('ctxalloc-node-file');
  });

  it('returns exact UTF-8 text', async () => {
    await expect(reader.read({ locator: 'lf.md' })).resolves.toEqual({
      content: '# Title\n\nBody line\n',
    });
  });

  it('INV-PROV-005: preserves CRLF exactly, without converting it to LF', async () => {
    const result = await reader.read({ locator: 'crlf.md' });
    expect(result.content).toBe('# Title\r\n\r\nBody line\r\n');
    expect(result.content).toContain('\r\n');
  });

  it('preserves a missing trailing newline', async () => {
    const result = await reader.read({ locator: 'no-trailing-newline.txt' });
    expect(result.content).toBe('last line without newline');
    expect(result.content.endsWith('\n')).toBe(false);
  });

  it('preserves trailing spaces and indentation', async () => {
    await expect(reader.read({ locator: 'spaces.txt' })).resolves.toEqual({
      content: 'trailing   \n\tindented\n',
    });
  });

  it('INV-BLOCK-007: preserves Unicode beyond the basic plane', async () => {
    const result = await reader.read({ locator: 'unicode.txt' });
    expect(result.content).toBe('héllo 🌍 中文\n');
    expect([...result.content]).toContain('🌍');
  });

  it('keeps an initial byte-order mark as text rather than stripping it', async () => {
    const result = await reader.read({ locator: 'bom.txt' });
    expect(result.content).toBe('﻿# Title\n');
    expect(result.content.codePointAt(0)).toBe(0xfeff);
  });

  it('reads a safe nested relative path', async () => {
    await expect(reader.read({ locator: 'notes/deep/nested.md' })).resolves.toEqual({
      content: 'nested body\n',
    });
  });

  it('follows a symlink that stays inside the root', async () => {
    await expect(reader.read({ locator: 'inside-link.md' })).resolves.toEqual({
      content: '# Title\n\nBody line\n',
    });
  });

  it('INV-DET-001: returns identical content for repeated reads', async () => {
    const first = await reader.read({ locator: 'lf.md' });
    const second = await reader.read({ locator: 'lf.md' });
    expect(first).toEqual(second);
  });
});

describe('NodeFileSourceReader: confinement', () => {
  it('INV-SEC-001: rejects an absolute path', async () => {
    await expect(readCode(join(root, 'lf.md'))).resolves.toBe(
      'NODE_FILE_SOURCE_READER_LOCATOR_ABSOLUTE',
    );
    await expect(readCode('/etc/passwd')).resolves.toBe('NODE_FILE_SOURCE_READER_LOCATOR_ABSOLUTE');
  });

  it('INV-SEC-001: rejects traversal above the root', async () => {
    for (const locator of ['../outside/secret.txt', 'notes/../../outside/secret.txt', '..']) {
      await expect(readCode(locator)).resolves.toBe('NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT');
    }
  });

  it('INV-SEC-001: rejects a symlink whose target escapes the root', async () => {
    // The lexical path never leaves the root, so only the real-path check can
    // catch this one. It is the whole reason containment is proved twice.
    await expect(readCode('escape.md')).resolves.toBe(
      'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT',
    );
  });

  it('rejects a blank locator and one containing a NUL code unit', async () => {
    await expect(readCode('')).resolves.toBe('NODE_FILE_SOURCE_READER_LOCATOR_BLANK');
    await expect(readCode('   ')).resolves.toBe('NODE_FILE_SOURCE_READER_LOCATOR_BLANK');
    await expect(readCode('a\u0000b.md')).resolves.toBe('NODE_FILE_SOURCE_READER_LOCATOR_INVALID');
  });

  it('carries the exact requested locator on every rejection', async () => {
    await expect(reader.read({ locator: '../outside/secret.txt' })).rejects.toMatchObject({
      locator: '../outside/secret.txt',
    });
  });
});

describe('NodeFileSourceReader: explicit failures', () => {
  it('INV-ADAPTER-003: rejects a missing file rather than returning empty content', async () => {
    await expect(readCode('missing.md')).resolves.toBe('NODE_FILE_SOURCE_READER_SOURCE_NOT_FOUND');
  });

  it('rejects a directory', async () => {
    await expect(readCode('notes')).resolves.toBe('NODE_FILE_SOURCE_READER_SOURCE_NOT_A_FILE');
  });

  it('rejects a file above maxBytes', async () => {
    await expect(readCode('large.txt')).resolves.toBe('NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE');
  });

  it('enforces maxBytes for every configured limit, not only the default one', async () => {
    const tiny = new NodeFileSourceReader({ rootDirectory: root, maxBytes: 1 });
    await expect(tiny.read({ locator: 'lf.md' })).rejects.toMatchObject({
      code: 'NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE',
    });
  });

  it('accepts a file whose size is exactly maxBytes', async () => {
    // The bound is inclusive, so a file at the limit is a read rather than a
    // rejection. The reader also re-checks the obtained bytes after reading,
    // which a same-process test cannot force but which covers a file that grew
    // between the stat and the read.
    const exact = new NodeFileSourceReader({
      rootDirectory: root,
      maxBytes: Buffer.byteLength('# Title\n\nBody line\n', 'utf8'),
    });
    await expect(exact.read({ locator: 'lf.md' })).resolves.toEqual({
      content: '# Title\n\nBody line\n',
    });
  });

  it('INV-BLOCK-007: rejects malformed UTF-8 instead of substituting U+FFFD', async () => {
    await expect(readCode('invalid.bin')).resolves.toBe('NODE_FILE_SOURCE_READER_SOURCE_NOT_UTF8');
  });

  it('INV-ADAPTER-001: exposes no filesystem error, errno, or resolved path', async () => {
    try {
      await reader.read({ locator: 'missing.md' });
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(NodeFileSourceReaderError);
      const error = cause as NodeFileSourceReaderError & Record<string, unknown>;
      expect(error.name).toBe('NodeFileSourceReaderError');
      expect(error.errno).toBeUndefined();
      expect(error.syscall).toBeUndefined();
      expect(error.path).toBeUndefined();
      expect(error.message).not.toContain(root);
      expect(error.message).not.toContain('ENOENT');
    }
  });

  it('rejects an unusable configuration with no default substituted', () => {
    for (const config of [
      { rootDirectory: '', maxBytes: 10 },
      { rootDirectory: '   ', maxBytes: 10 },
      { rootDirectory: root, maxBytes: 0 },
      { rootDirectory: root, maxBytes: -1 },
      { rootDirectory: root, maxBytes: 1.5 },
      { rootDirectory: root, maxBytes: Number.POSITIVE_INFINITY },
      { rootDirectory: root, maxBytes: Number.NaN },
    ]) {
      expect(() => new NodeFileSourceReader(config)).toThrow(NodeFileSourceReaderError);
    }
  });

  it('rejects a request that is not an object carrying a string locator', async () => {
    for (const request of [null, undefined, {}, { locator: 7 }]) {
      await expect(reader.read(request as unknown as { locator: string })).rejects.toMatchObject({
        code: 'NODE_FILE_SOURCE_READER_INVALID_REQUEST',
      });
    }
  });
});

describe('NodeFileSourceReader: refuses every job that is not its own', () => {
  it('infers no source type and derives no timestamp from filesystem metadata', async () => {
    const result = await reader.read({ locator: 'lf.md' });
    expect(Object.keys(result)).toEqual(['content']);
    const record = result as unknown as Record<string, unknown>;
    for (const field of ['sourceType', 'createdAt', 'updatedAt', 'mtime', 'size', 'path']) {
      expect(record[field], `reports ${field}`).toBeUndefined();
    }
  });

  it('exposes no directory walk, glob, or watch capability', () => {
    const surface = reader as unknown as Record<string, unknown>;
    for (const method of ['list', 'walk', 'glob', 'watch', 'readDirectory', 'stat']) {
      expect(typeof surface[method], `defines ${method}`).toBe('undefined');
    }
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(reader)).sort()).toEqual([
      'constructor',
      'read',
    ]);
  });
});

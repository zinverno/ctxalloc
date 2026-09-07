import { appendFileSync } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import {
  NodeFileSourceReader,
  NodeFileSourceReaderError,
  AnthropicModelProvider,
  AnthropicModelProviderError,
} from '@ctxalloc/adapters';
import type { ModelProviderRequest, SourceReadRequest } from '@ctxalloc/ports';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.open).mockImplementation(
    (await vi.importActual<typeof filesystem>('node:fs/promises')).open,
  );
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const revoked = () => {
  const value = Proxy.revocable({}, {});
  value.revoke();
  return value.proxy;
};
const modelConfig = {
  apiKey: 'synthetic-private-key',
  modelId: 'test',
  apiVersion: '2023-06-01',
  baseUrl: 'http://127.0.0.1:1',
  timeoutMs: 10,
};
const modelRequest: ModelProviderRequest = {
  schemaVersion: 1,
  systemPrompt: 'system',
  userPrompt: 'prompt',
  maxOutputTokens: 10,
  temperature: 0,
};

describe('passive reachable adapter input boundaries', () => {
  it('turns revoked configs and requests into project-owned errors', async () => {
    expect(() => new NodeFileSourceReader(revoked())).toThrow(NodeFileSourceReaderError);
    expect(() => new AnthropicModelProvider(revoked())).toThrow(AnthropicModelProviderError);
    await expect(
      new NodeFileSourceReader({ rootDirectory: tmpdir(), maxBytes: 10 }).read(
        revoked() as SourceReadRequest,
      ),
    ).rejects.toBeInstanceOf(NodeFileSourceReaderError);
    await expect(
      new AnthropicModelProvider(modelConfig).generate(revoked() as ModelProviderRequest),
    ).rejects.toBeInstanceOf(AnthropicModelProviderError);
  });
  it('does not invoke config or request accessors and never copies unknown-key canaries', async () => {
    const getter = vi.fn(() => {
      throw new Error('CANARY /absolute/private');
    });
    const readerConfig = { rootDirectory: tmpdir(), maxBytes: 10 };
    Object.defineProperty(readerConfig, 'maxBytes', { get: getter });
    expect(() => new NodeFileSourceReader(readerConfig)).toThrow(NodeFileSourceReaderError);
    const config = { ...modelConfig };
    Object.defineProperty(config, 'apiKey', { get: getter });
    expect(() => new AnthropicModelProvider(config)).toThrow(AnthropicModelProviderError);
    const request = { ...modelRequest };
    Object.defineProperty(request, 'userPrompt', { get: getter });
    await expect(new AnthropicModelProvider(modelConfig).generate(request)).rejects.toBeInstanceOf(
      AnthropicModelProviderError,
    );
    const read = { locator: 'x' };
    Object.defineProperty(read, 'locator', { get: getter });
    await expect(
      new NodeFileSourceReader({ rootDirectory: tmpdir(), maxBytes: 10 }).read(read),
    ).rejects.toBeInstanceOf(NodeFileSourceReaderError);
    expect(getter).not.toHaveBeenCalled();
    for (const make of [
      () =>
        new NodeFileSourceReader({
          rootDirectory: tmpdir(),
          maxBytes: 1,
          'CANARY /absolute/private': true,
        }),
      () => new AnthropicModelProvider({ ...modelConfig, 'CANARY /absolute/private': true }),
    ]) {
      try {
        make();
        throw new Error('expected error');
      } catch (cause) {
        expect(String(cause)).not.toContain('CANARY');
        expect(String(cause)).not.toContain('/absolute/private');
      }
    }
  });
  it('contains reflection trap errors', async () => {
    const config = new Proxy(
      { ...modelConfig },
      {
        ownKeys() {
          throw new Error('CANARY');
        },
      },
    );
    expect(() => new AnthropicModelProvider(config)).toThrow(AnthropicModelProviderError);
    const input = new Proxy(
      { locator: 'x' },
      {
        getOwnPropertyDescriptor() {
          throw new Error('CANARY');
        },
      },
    );
    await expect(
      new NodeFileSourceReader({ rootDirectory: tmpdir(), maxBytes: 1 }).read(input),
    ).rejects.toBeInstanceOf(NodeFileSourceReaderError);
  });
});

describe('source descriptor and actual-byte limits', () => {
  it('bounds actual reads when the file grows after fstat and closes the handle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctxalloc-growth-'));
    roots.push(root);
    const path = join(root, 'source');
    await writeFile(path, 'a');
    const actual = await vi.importActual<typeof filesystem>('node:fs/promises');
    const sizes: number[] = [];
    let closeCalls = 0;
    vi.mocked(filesystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      let first = true;
      // Instrument the real handle: growth happens after the reader's fstat.
      handle.read = vi.fn(
        async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
          if (first) {
            first = false;
            appendFileSync(path, 'x'.repeat(10000));
          }
          sizes.push(length);
          return read(buffer, offset, length, position);
        },
      ) as unknown as typeof handle.read;
      handle.close = async () => {
        closeCalls += 1;
        return close();
      };
      return handle;
    });
    await expect(
      new NodeFileSourceReader({ rootDirectory: root, maxBytes: 16 }).read({ locator: 'source' }),
    ).rejects.toMatchObject({ code: 'NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE' });
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(17);
    expect(closeCalls).toBe(1);
  });
  it('rejects FIFO, directory, socket and device before reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctxalloc-special-'));
    roots.push(root);
    await mkdir(join(root, 'directory'));
    const reader = new NodeFileSourceReader({ rootDirectory: root, maxBytes: 100 });
    expect(spawnSync('mkfifo', [join(root, 'pipe')]).status).toBe(0);
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(join(root, 'socket'), resolve));
    try {
      for (const locator of ['directory', 'pipe', 'socket'])
        await expect(reader.read({ locator })).rejects.toMatchObject({
          code: 'NODE_FILE_SOURCE_READER_SOURCE_NOT_A_FILE',
        });
      await symlink('/dev/null', join(root, 'device'));
      await expect(reader.read({ locator: 'device' })).rejects.toMatchObject({
        code: 'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT',
      });
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });
  it.each([
    'C:\\private\\secret',
    '\\\\server\\secret',
    '/absolute/private',
    '..\\secret',
    'a\0b',
    'a\ud800b',
  ])('rejects unsafe locator %# with no absolute path', async (locator) => {
    const reader = new NodeFileSourceReader({ rootDirectory: tmpdir(), maxBytes: 1 });
    try {
      await reader.read({ locator });
      throw new Error('expected failure');
    } catch (cause) {
      expect(cause).toBeInstanceOf(NodeFileSourceReaderError);
      expect(String(cause)).not.toContain(locator);
      if (locator.startsWith('/') || locator.startsWith('C:'))
        expect(JSON.stringify(cause)).not.toContain(locator);
    }
  });
  it('rejects sibling-prefix traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ctxalloc-prefix-'));
    roots.push(root);
    await mkdir(join(root, 'vault'));
    await mkdir(join(root, 'vault-backup'));
    await writeFile(join(root, 'vault-backup', 'secret'), 'secret');
    await expect(
      new NodeFileSourceReader({ rootDirectory: join(root, 'vault'), maxBytes: 10 }).read({
        locator: '../vault-backup/secret',
      }),
    ).rejects.toMatchObject({ code: 'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT' });
  });
});

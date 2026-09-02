import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SourceReadRequest, SourceReadResult, SourceReader } from '@ctxalloc/ports';

/**
 * Local filesystem `SourceReader` (DEC-039).
 *
 * This adapter is the only place in the vertical slice that touches a disk. It
 * answers exactly one question — *what exact text does this locator hold?* — and
 * refuses everything else: it infers no source type, derives no timestamp from
 * `mtime`, walks no directory, expands no glob, watches no file, normalizes no
 * whitespace or line ending, and strips no byte-order mark (INV-DEP-003).
 *
 * Two properties are load-bearing.
 *
 * **Confinement.** A locator is a relative path *inside* a configured root, and
 * containment is proved against the resolved real path, not against the
 * lexically resolved one. A lexical check alone accepts `notes/link.md` when
 * `link.md` is a symlink to `/etc/passwd`, because nothing in the spelling of
 * that path leaves the root. Reading source content is precisely where such an
 * escape matters, so the real path decides (INV-SEC-001).
 *
 * **Exactness.** Bytes are decoded as UTF-8 in fatal mode. A malformed sequence
 * fails rather than becoming U+FFFD, because a replacement character produces a
 * `contentHash` describing text the file never contained (INV-BLOCK-007,
 * INV-PROV-005). An initial U+FEFF is kept as ordinary text for the same reason:
 * removing it would silently change the content that is about to be hashed.
 *
 * No `fs` error, `Stats`, `Dirent`, `Buffer`, or path type reaches the public
 * surface: every failure is a project-owned {@link NodeFileSourceReaderError}
 * (INV-ADAPTER-001, INV-ADAPTER-003).
 */

/** Stable identity of this reader, recorded wherever a reader identity is reported. */
export const NODE_FILE_SOURCE_READER_ID = 'ctxalloc-node-file';

/** Stable version of this reader's read semantics. */
export const NODE_FILE_SOURCE_READER_VERSION = '1';

/**
 * Explicit reader configuration.
 *
 * Nothing is defaulted and nothing is discovered: no root is taken from the
 * working directory or an environment variable, and no size limit is invented
 * (INV-DET-003).
 *
 * The constructor takes `unknown` and validates this shape at runtime, because
 * configuration routinely arrives from a file, an environment, or a caller in
 * another language, where a compile-time type proves nothing (INV-BLOCK-005).
 * The interface stays exported for callers that do build it in TypeScript.
 */
export interface NodeFileSourceReaderConfig {
  /** Directory every locator is resolved inside and confined to. */
  readonly rootDirectory: string;
  /** Hard upper bound, in bytes, on one source file. */
  readonly maxBytes: number;
}

/** Machine-readable categories of a local file read failure (INV-TRACE-002). */
export type NodeFileSourceReaderErrorCode =
  | 'NODE_FILE_SOURCE_READER_INVALID_CONFIG'
  | 'NODE_FILE_SOURCE_READER_INVALID_REQUEST'
  | 'NODE_FILE_SOURCE_READER_LOCATOR_BLANK'
  | 'NODE_FILE_SOURCE_READER_LOCATOR_ABSOLUTE'
  | 'NODE_FILE_SOURCE_READER_LOCATOR_INVALID'
  | 'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT'
  | 'NODE_FILE_SOURCE_READER_ROOT_UNAVAILABLE'
  | 'NODE_FILE_SOURCE_READER_SOURCE_NOT_FOUND'
  | 'NODE_FILE_SOURCE_READER_SOURCE_NOT_A_FILE'
  | 'NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE'
  | 'NODE_FILE_SOURCE_READER_SOURCE_NOT_UTF8'
  | 'NODE_FILE_SOURCE_READER_READ_FAILED';

/**
 * The single error this adapter raises.
 *
 * It carries a stable code and the exact locator that was requested. It
 * deliberately does not carry the underlying `Error`, its `errno`, the resolved
 * absolute path, or any part of the file's content: the first two are runtime
 * types the port forbids to escape, and the last two are information the caller
 * did not ask this component to disclose.
 */
export class NodeFileSourceReaderError extends Error {
  readonly code: NodeFileSourceReaderErrorCode;
  /** The exact locator the caller supplied, or the empty string when there was none. */
  readonly locator: string;

  constructor(code: NodeFileSourceReaderErrorCode, message: string, locator = '') {
    super(message);
    this.name = 'NodeFileSourceReaderError';
    this.code = code;
    this.locator = locator;
  }
}

/** The NUL code unit, which terminates a path in the operating system interface. */
const NUL = '\u0000';

/** The complete set of configuration fields. Anything else is rejected. */
const CONFIG_KEYS: readonly string[] = ['maxBytes', 'rootDirectory'];

/** The complete set of read-request fields. Anything else is rejected. */
const REQUEST_KEYS: readonly string[] = ['locator'];

/** Bounded rendering of a locator for a message, so a long path cannot flood a log. */
const LOCATOR_PREVIEW_CODE_POINTS = 120;

function previewLocator(locator: string): string {
  const codePoints = [...locator];
  if (codePoints.length <= LOCATOR_PREVIEW_CODE_POINTS) return JSON.stringify(locator);
  const head = codePoints.slice(0, LOCATOR_PREVIEW_CODE_POINTS).join('');
  return `${JSON.stringify(head)}... (${String(codePoints.length)} code points)`;
}

/**
 * True when `candidate` is `root` itself or lies underneath it.
 *
 * The separator is appended before the prefix comparison, so a sibling directory
 * whose name merely starts with the root's name — `/vault-backup` beside
 * `/vault` — is not accepted as being inside it.
 */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The operating system error code of a rejected filesystem call, when it has one. */
function errorCodeOf(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const code: unknown = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export class NodeFileSourceReader implements SourceReader {
  readonly id = NODE_FILE_SOURCE_READER_ID;
  readonly version = NODE_FILE_SOURCE_READER_VERSION;

  readonly #rootDirectory: string;
  readonly #maxBytes: number;

  /**
   * Validates the configuration strictly: exactly the two documented fields, no
   * unknown field, no default, and no coercion.
   *
   * An unknown field is rejected rather than ignored. Silently accepting one
   * means a misspelled `maxByte` leaves the reader with no size limit the caller
   * believes they configured, and a future field name would be swallowed by an
   * older build instead of failing visibly (INV-BLOCK-005).
   *
   * @throws {NodeFileSourceReaderError} when the configuration is not usable.
   */
  constructor(config: unknown) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_CONFIG',
        'NodeFileSourceReader configuration must be an object.',
      );
    }

    const unknownKeys = Object.keys(config)
      .filter((key) => !CONFIG_KEYS.includes(key))
      .sort();
    if (unknownKeys.length > 0) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_CONFIG',
        `NodeFileSourceReader configuration has unknown field(s): ${unknownKeys.join(', ')}.`,
      );
    }

    const { rootDirectory, maxBytes } = config as Partial<NodeFileSourceReaderConfig>;

    if (typeof rootDirectory !== 'string' || rootDirectory.trim().length === 0) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_CONFIG',
        'NodeFileSourceReader rootDirectory must not be empty or whitespace-only.',
      );
    }
    if (rootDirectory.includes(NUL)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_CONFIG',
        'NodeFileSourceReader rootDirectory must not contain a NUL code unit.',
      );
    }
    if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_CONFIG',
        `NodeFileSourceReader maxBytes must be a positive safe integer, received ${String(maxBytes)}.`,
      );
    }

    // The root is resolved once so every later containment comparison uses one
    // absolute spelling. It is deliberately *not* real-pathed here: the root may
    // legitimately be created after construction, and a constructor that touched
    // the filesystem would make configuring a reader an IO operation.
    this.#rootDirectory = resolve(rootDirectory);
    this.#maxBytes = maxBytes;
  }

  /**
   * Reads the exact text one locator holds.
   *
   * @throws {NodeFileSourceReaderError} for every rejection and every read failure.
   */
  async read(request: SourceReadRequest): Promise<SourceReadResult> {
    const locator = this.#validateLocator(request);
    const target = await this.#resolveConfinedPath(locator);
    const bytes = await this.#readBytes(locator, target);
    return { content: this.#decode(locator, bytes) };
  }

  /**
   * Rejects a request that is not a usable read request, before any IO happens.
   *
   * The request shape is checked strictly for the same reason the configuration
   * is: an unknown field is a caller believing they asked for something this
   * reader does not do — a range, an encoding, a follow-symlinks flag — and
   * ignoring it would answer a different question than the one asked
   * (INV-BLOCK-005).
   */
  #validateLocator(request: SourceReadRequest): string {
    if (typeof request !== 'object' || request === null || Array.isArray(request)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_REQUEST',
        'NodeFileSourceReader request must be an object carrying a locator.',
      );
    }
    const unknownKeys = Object.keys(request)
      .filter((key) => !REQUEST_KEYS.includes(key))
      .sort();
    if (unknownKeys.length > 0) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_REQUEST',
        `NodeFileSourceReader request has unknown field(s): ${unknownKeys.join(', ')}.`,
      );
    }
    const locator: unknown = request.locator;
    if (typeof locator !== 'string') {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_INVALID_REQUEST',
        'NodeFileSourceReader locator must be a string.',
      );
    }
    if (locator.trim().length === 0) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_LOCATOR_BLANK',
        'NodeFileSourceReader locator must not be empty or whitespace-only.',
        locator,
      );
    }
    if (locator.includes(NUL)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_LOCATOR_INVALID',
        'NodeFileSourceReader locator must not contain a NUL code unit.',
        locator,
      );
    }
    // A locator names a source *inside* the configured root. An absolute path
    // would ignore the root rather than be confined by it.
    if (isAbsolute(locator)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_LOCATOR_ABSOLUTE',
        `NodeFileSourceReader locator must be relative to the configured root: ${previewLocator(locator)}.`,
        locator,
      );
    }
    return locator;
  }

  /**
   * Resolves the locator inside the root and proves containment twice.
   *
   * The lexical check rejects `../` traversal without touching the disk. The
   * real-path check then rejects a symlink whose target escapes the root, which
   * the lexical check cannot see. Both sides are compared in real form, so a root
   * that is itself reached through a symlink still matches its own contents.
   */
  async #resolveConfinedPath(locator: string): Promise<string> {
    const lexical = resolve(this.#rootDirectory, locator);
    if (!isInside(this.#rootDirectory, lexical)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT',
        `NodeFileSourceReader locator resolves outside the configured root: ${previewLocator(locator)}.`,
        locator,
      );
    }

    let realRoot: string;
    try {
      realRoot = await realpath(this.#rootDirectory);
    } catch {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_ROOT_UNAVAILABLE',
        'NodeFileSourceReader root directory is not readable.',
        locator,
      );
    }

    let realTarget: string;
    try {
      realTarget = await realpath(lexical);
    } catch (cause) {
      const code = errorCodeOf(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new NodeFileSourceReaderError(
          'NODE_FILE_SOURCE_READER_SOURCE_NOT_FOUND',
          `NodeFileSourceReader found no source at ${previewLocator(locator)}.`,
          locator,
        );
      }
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_READ_FAILED',
        `NodeFileSourceReader could not resolve ${previewLocator(locator)}.`,
        locator,
      );
    }

    if (!isInside(realRoot, realTarget)) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_LOCATOR_OUTSIDE_ROOT',
        `NodeFileSourceReader locator resolves outside the configured root: ${previewLocator(locator)}.`,
        locator,
      );
    }
    return realTarget;
  }

  /**
   * Reads the file, checking the size limit before and after.
   *
   * The check is repeated because `stat` describes the file at one instant and
   * the read happens at another. A file that grew in between would otherwise
   * enter the pipeline above the configured limit.
   */
  async #readBytes(locator: string, target: string): Promise<Uint8Array> {
    let size: number;
    let isRegularFile: boolean;
    try {
      const stats = await stat(target);
      size = stats.size;
      isRegularFile = stats.isFile();
    } catch (cause) {
      if (errorCodeOf(cause) === 'ENOENT') {
        throw new NodeFileSourceReaderError(
          'NODE_FILE_SOURCE_READER_SOURCE_NOT_FOUND',
          `NodeFileSourceReader found no source at ${previewLocator(locator)}.`,
          locator,
        );
      }
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_READ_FAILED',
        `NodeFileSourceReader could not inspect ${previewLocator(locator)}.`,
        locator,
      );
    }

    if (!isRegularFile) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_SOURCE_NOT_A_FILE',
        `NodeFileSourceReader locator does not name a regular file: ${previewLocator(locator)}.`,
        locator,
      );
    }
    if (size > this.#maxBytes) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE',
        `NodeFileSourceReader source ${previewLocator(locator)} is ${String(size)} bytes, above the configured limit of ${String(this.#maxBytes)}.`,
        locator,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await readFile(target);
    } catch (cause) {
      const code = errorCodeOf(cause);
      if (code === 'ENOENT') {
        throw new NodeFileSourceReaderError(
          'NODE_FILE_SOURCE_READER_SOURCE_NOT_FOUND',
          `NodeFileSourceReader found no source at ${previewLocator(locator)}.`,
          locator,
        );
      }
      if (code === 'EISDIR') {
        throw new NodeFileSourceReaderError(
          'NODE_FILE_SOURCE_READER_SOURCE_NOT_A_FILE',
          `NodeFileSourceReader locator does not name a regular file: ${previewLocator(locator)}.`,
          locator,
        );
      }
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_READ_FAILED',
        `NodeFileSourceReader could not read ${previewLocator(locator)}.`,
        locator,
      );
    }

    if (bytes.byteLength > this.#maxBytes) {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_SOURCE_TOO_LARGE',
        `NodeFileSourceReader source ${previewLocator(locator)} is ${String(bytes.byteLength)} bytes, above the configured limit of ${String(this.#maxBytes)}.`,
        locator,
      );
    }
    return bytes;
  }

  /**
   * Decodes UTF-8 strictly.
   *
   * `fatal` makes a malformed sequence an error instead of U+FFFD, and
   * `ignoreBOM` keeps an initial U+FEFF in the string instead of consuming it —
   * the option name describes the byte-order-mark *protocol*, not the character.
   * Both choices exist so the returned string is exactly what the file holds.
   */
  #decode(locator: string, bytes: Uint8Array): string {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new NodeFileSourceReaderError(
        'NODE_FILE_SOURCE_READER_SOURCE_NOT_UTF8',
        `NodeFileSourceReader source ${previewLocator(locator)} is not valid UTF-8.`,
        locator,
      );
    }
  }
}

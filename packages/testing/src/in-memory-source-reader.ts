import type { SourceReadRequest, SourceReadResult, SourceReader } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link SourceReader} port.
 *
 * The fake resolves nothing: it returns exactly the content configured for
 * exactly the supplied locator. There is no path resolution, no root, no
 * extension handling, no case folding, and no fallback, because any of those
 * would let a test pass against a locator the real adapter would reject.
 * An unconfigured locator fails explicitly (INV-ADAPTER-003) so a missing
 * fixture is visible instead of silently producing an empty source.
 *
 * It normalizes nothing. Line endings, trailing whitespace, a byte-order mark,
 * and Unicode composition are returned exactly as configured, which is what makes
 * a test over the fake meaningful for the real reader (INV-ADAPTER-005).
 *
 * It reads no file, environment variable, clock, random value, or network
 * resource (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'in-memory-source-reader';
const DEFAULT_VERSION = '1';
const LOCATOR_PREVIEW_CODE_POINTS = 60;

/** One exact-locator-to-content mapping. */
export interface InMemorySourceEntry {
  /** Exact locator, matched exactly. */
  readonly locator: string;
  /** Exact content returned for `locator`, byte for byte. */
  readonly content: string;
}

/** Optional reader identity, used when a test asserts on a reported identity. */
export interface InMemorySourceReaderOptions {
  readonly id?: string;
  readonly version?: string;
}

/** Rejected {@link InMemorySourceReader} configuration. */
export class InMemorySourceReaderConfigurationError extends Error {
  readonly code = 'IN_MEMORY_SOURCE_READER_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'InMemorySourceReaderConfigurationError';
  }
}

/** A read of a locator the {@link InMemorySourceReader} was not configured with. */
export class InMemorySourceReaderUnknownLocatorError extends Error {
  readonly code = 'IN_MEMORY_SOURCE_READER_UNKNOWN_LOCATOR';
  /** The exact locator that was requested. */
  readonly locator: string;

  constructor(message: string, locator: string) {
    super(message);
    this.name = 'InMemorySourceReaderUnknownLocatorError';
    this.locator = locator;
  }
}

function previewLocator(locator: string): string {
  const codePoints = [...locator];
  if (codePoints.length <= LOCATOR_PREVIEW_CODE_POINTS) return JSON.stringify(locator);
  const head = codePoints.slice(0, LOCATOR_PREVIEW_CODE_POINTS).join('');
  return `${JSON.stringify(head)}... (${String(codePoints.length)} code points)`;
}

/**
 * Rejects a blank identity without rewriting it: an identity may be reported, so
 * trimming here would store a value the caller never configured.
 */
function requireNonBlank(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new InMemorySourceReaderConfigurationError(
      `InMemorySourceReader ${field} must not be empty or whitespace-only.`,
    );
  }
  return value;
}

export class InMemorySourceReader implements SourceReader {
  readonly id: string;
  readonly version: string;

  /**
   * A `Map` keyed by the exact locator avoids the prototype-key collisions of a
   * plain object, and the entries are copied so later changes to the caller's
   * array cannot alter what the reader returns.
   */
  readonly #contents: ReadonlyMap<string, string>;

  constructor(entries: readonly InMemorySourceEntry[], options: InMemorySourceReaderOptions = {}) {
    this.id = requireNonBlank(options.id ?? DEFAULT_ID, 'id');
    this.version = requireNonBlank(options.version ?? DEFAULT_VERSION, 'version');

    const contents = new Map<string, string>();
    for (const entry of entries) {
      // A repeated locator is rejected rather than resolved by first or last
      // write: either rule would make the configuration order significant.
      if (contents.has(entry.locator)) {
        throw new InMemorySourceReaderConfigurationError(
          `InMemorySourceReader received a duplicate entry for ${previewLocator(entry.locator)}.`,
        );
      }
      if (typeof entry.content !== 'string') {
        throw new InMemorySourceReaderConfigurationError(
          `InMemorySourceReader content for ${previewLocator(entry.locator)} must be a string.`,
        );
      }
      contents.set(entry.locator, entry.content);
    }
    this.#contents = contents;
  }

  read(request: SourceReadRequest): Promise<SourceReadResult> {
    const locator = request.locator;
    const content = this.#contents.get(locator);
    if (content === undefined) {
      return Promise.reject(
        new InMemorySourceReaderUnknownLocatorError(
          `InMemorySourceReader has no configured source for ${previewLocator(locator)}.`,
          locator,
        ),
      );
    }
    return Promise.resolve({ content });
  }
}

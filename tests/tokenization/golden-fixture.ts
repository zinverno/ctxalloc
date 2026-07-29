import { readFileSync } from 'node:fs';

/**
 * Loader for the committed golden token-count fixture.
 *
 * The fixture is the only external data the tokenizer suite reads. It requires
 * no network, no Python, and no oracle package: the counts were cross-checked
 * against the official `openai/tiktoken` package before they were committed, and
 * the committed file is what the suite asserts against from then on.
 */

export interface GoldenTokenizerCase {
  /** Stable case identifier, used in test titles. */
  readonly id: string;
  /** What the case demonstrates. */
  readonly description: string;
  /** Exact text to count, preserved character for character. */
  readonly text: string;
  /** Independently verified token count for `text`. */
  readonly expectedTokens: number;
}

export interface GoldenTokenizerFixture {
  readonly fixtureSchemaVersion: number;
  readonly encoding: string;
  readonly adapter: { readonly package: string; readonly version: string };
  readonly oracle: { readonly package: string; readonly version: string; readonly method: string };
  readonly cases: readonly GoldenTokenizerCase[];
}

export const O200K_BASE_GOLDEN_FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/tokenization/o200k-base.json', import.meta.url), 'utf8'),
) as GoldenTokenizerFixture;

/** Returns one case by identifier, failing loudly when a fixture case is removed. */
export function goldenCase(id: string): GoldenTokenizerCase {
  const found = O200K_BASE_GOLDEN_FIXTURE.cases.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`Golden fixture has no case with id "${id}".`);
  }
  return found;
}

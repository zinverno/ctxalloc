import { CandidateValidator, type ValidatedCandidateSet } from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import {
  candidate,
  contextBlock,
  countingTokenizer,
  input,
  sourceDocument,
  wordTokenizer,
} from './fixtures.js';

/**
 * Shared fixtures for the exact deduplication tests.
 *
 * Every batch is built through `CandidateValidator`, so the deduplicator is
 * exercised against a genuinely validated stage contract rather than a
 * hand-assembled structure that might not survive validation (DEC-031).
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network,
 * and nothing shuffles randomly: permutations are enumerated.
 */

export { candidate, contextBlock, countingTokenizer, input, sourceDocument, wordTokenizer };

/** One token per character: makes a CRLF copy and an LF copy count differently. */
export const charTokenizer: Tokenizer = {
  id: 'test:char',
  version: '1',
  countTokens: (text: string): number => text.length,
};

export function validate(
  overrides: Record<string, unknown> = {},
  tokenizer: Tokenizer = wordTokenizer,
): ValidatedCandidateSet {
  return new CandidateValidator(tokenizer).validate(input(overrides));
}

/** Builds a batch from candidates alone, keeping the default single registry. */
export function validateCandidates(
  candidates: readonly Record<string, unknown>[],
  tokenizer: Tokenizer = wordTokenizer,
): ValidatedCandidateSet {
  return validate({ candidates: [...candidates] }, tokenizer);
}

/** Removes one key entirely, so an optional field is absent rather than `undefined`. */
export function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Every permutation of an array, enumerated deterministically. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index] as T;
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([head, ...tail]);
  }
  return result;
}

import {
  CandidateDeduplicator,
  CandidateScorer,
  type DeduplicatedCandidateSet,
  type ScoredCandidateSet,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import {
  candidate,
  contextBlock,
  input,
  retrieval,
  sourceDocument,
  wordTokenizer,
} from './fixtures.js';
import { omit, permutations, validate, validateCandidates } from './deduplication-fixtures.js';

/**
 * Shared fixtures for the deterministic scoring tests.
 *
 * Every batch is built through `CandidateValidator` and `CandidateDeduplicator`,
 * so the scorer is exercised against a genuinely produced stage contract rather
 * than a hand-assembled structure that might not survive the earlier stages
 * (DEC-032).
 *
 * Nothing here reads the clock, the filesystem, the environment, or the network.
 * The reference time is an explicit constant, and permutations are enumerated
 * rather than shuffled randomly.
 */

export {
  candidate,
  contextBlock,
  input,
  omit,
  permutations,
  retrieval,
  sourceDocument,
  wordTokenizer,
};

/** The explicit instant every scoring test measures recency against. */
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

const HOUR_SECONDS = 3600;

/** An ISO UTC timestamp a whole number of seconds before {@link REFERENCE_TIME}. */
export function secondsBeforeReference(seconds: number): string {
  const referenceMilliseconds = Date.UTC(2026, 5, 1, 12, 0, 0);
  return new Date(referenceMilliseconds - seconds * 1000).toISOString();
}

/** An ISO UTC timestamp a whole number of seconds after {@link REFERENCE_TIME}. */
export function secondsAfterReference(seconds: number): string {
  return secondsBeforeReference(-seconds);
}

export const ONE_HOUR = HOUR_SECONDS;
export const ONE_DAY = 24 * HOUR_SECONDS;

/** The smallest valid policy: an identity with no configured signal at all. */
export function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, policyId: 'baseline', policyVersion: '1.0.0', ...overrides };
}

/** One retrieval normalization rule, defaulting to a cosine-similarity contract. */
export function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'cosine',
    providerId: 'sqlite-fts5',
    providerVersion: '1.2.3',
    semantics: 'cosine-similarity',
    higherIsBetter: true,
    min: 0,
    max: 1,
    ...overrides,
  };
}

/** A retrieval wrapper carrying a provider score, matching {@link rule} by default. */
export function scoredRetrieval(
  value: number,
  overrides: Record<string, unknown> = {},
  scoreOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return retrieval({
    ...overrides,
    score: { value, semantics: 'cosine-similarity', higherIsBetter: true, ...scoreOverrides },
  });
}

export function deduplicate(
  overrides: Record<string, unknown> = {},
  tokenizer: Tokenizer = wordTokenizer,
): DeduplicatedCandidateSet {
  return new CandidateDeduplicator().deduplicate(validate(overrides, tokenizer));
}

export function deduplicateCandidates(
  candidates: readonly Record<string, unknown>[],
  tokenizer: Tokenizer = wordTokenizer,
): DeduplicatedCandidateSet {
  return new CandidateDeduplicator().deduplicate(validateCandidates(candidates, tokenizer));
}

/** Validates, deduplicates, and scores one batch in one call. */
export function score(
  candidates: readonly Record<string, unknown>[],
  scoringPolicy: Record<string, unknown> = policy(),
  options: { readonly referenceTime?: unknown; readonly sourceDocuments?: readonly unknown[] } = {},
): ScoredCandidateSet {
  const batch = deduplicate({
    candidates: [...candidates],
    ...(options.sourceDocuments === undefined
      ? {}
      : { sourceDocuments: [...options.sourceDocuments] }),
  });
  return new CandidateScorer(scoringPolicy).score(
    batch,
    'referenceTime' in options ? options.referenceTime : REFERENCE_TIME,
  );
}

/** The issue codes of a rejected call, in the order they were reported. */
export function issueCodesOf(run: () => unknown): readonly string[] {
  try {
    run();
  } catch (error) {
    const issues = (error as { issues?: readonly { code: string }[] }).issues ?? [];
    return issues.map((issue) => issue.code);
  }
  throw new Error('expected the call to be rejected');
}

/** The structured issues of a rejected call. */
export function issuesOf(
  run: () => unknown,
): readonly { readonly code: string; readonly pointer: string; readonly message: string }[] {
  try {
    run();
  } catch (error) {
    return (
      (error as { issues?: readonly { code: string; pointer: string; message: string }[] })
        .issues ?? []
    );
  }
  throw new Error('expected the call to be rejected');
}

/** Reverses a deduplicated set's candidates and every group's members. */
export function reversed(set: DeduplicatedCandidateSet): DeduplicatedCandidateSet {
  return {
    scope: set.scope,
    sourceDocuments: [...set.sourceDocuments].reverse(),
    candidates: [...set.candidates]
      .reverse()
      .map((group) => ({ ...group, members: [...group.members].reverse() })),
  };
}

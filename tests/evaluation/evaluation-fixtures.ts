import {
  calculateNormalizedContentHash,
  type CandidateBlock,
  type CandidateRetrieval,
  type ContextBlock,
  type Scope,
  type SourceDocument,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

/**
 * Shared fixtures for the evaluation-harness suite (DEC-040).
 *
 * Hashes and token counts are derived, never asserted: `CandidateValidator`
 * recomputes both, so a hand-written value would go stale the first time a
 * fixture's text changed.
 *
 * Nothing here reads a clock, a random value, the filesystem, or the network.
 */

export const SCOPE: Scope = { tenantId: 'eval', workspaceId: 'tests' };
export const OTHER_SCOPE: Scope = { tenantId: 'eval', workspaceId: 'other' };
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

/**
 * A tokenizer that counts whitespace-separated words.
 *
 * Deterministic, offline, and cheap. Where a test needs the real vocabulary it
 * uses `O200kBaseTokenizer` instead.
 */
export const wordTokenizer: Tokenizer = {
  id: 'eval-word',
  version: '1',
  countTokens: (text: string): number =>
    text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length,
};

/** Counts what {@link wordTokenizer} counts, for a test that needs the number. */
export function countWords(text: string): number {
  return wordTokenizer.countTokens(text);
}

export function evaluationPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    policyId: 'eval-tests',
    policyVersion: '1.0.0',
    scoring: {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '1.0.0',
      authoredPriority: { weight: 1, min: 0, max: 1000 },
    },
    filtering: {
      schemaVersion: 1,
      policyId: 'filtering',
      policyVersion: '1.0.0',
      minimumTotalScore: 0,
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'allocation',
      policyVersion: '1.0.0',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'ordering',
      policyVersion: '1.0.0',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'rendering',
      policyVersion: '1.0.0',
      format: 'jsonl-blocks',
    },
    ...overrides,
  };
}

export function compilerConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    compilerId: 'ctxalloc-eval-test',
    compilerVersion: '1.0.0',
    maxCorrectionSelections: 128,
    ...overrides,
  };
}

export function runConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    executedAt: REFERENCE_TIME,
    datasetId: 'eval-tests',
    datasetVersion: '1',
    referenceEnvironment: 'unit-test',
    systemPrompt: 'You answer only from the supplied context.',
    maxOutputTokens: 256,
    temperature: 0,
    modelExecution: 'disabled',
    determinismRepeats: 2,
    severeQualityLossThreshold: 0.05,
    ...overrides,
  };
}

export function sourceDocument(id: string, content: string, scope: Scope = SCOPE): SourceDocument {
  return {
    id,
    schemaVersion: 1,
    scope,
    sourceType: 'markdown',
    contentHash: calculateNormalizedContentHash(content),
    metadata: {},
  } as SourceDocument;
}

export interface TestBlockOptions {
  readonly headingPath?: readonly string[];
  readonly required?: boolean;
  readonly priority?: number;
  readonly scope?: Scope;
  readonly startLine?: number;
  readonly sourceDocumentId?: string;
}

export function contextBlock(
  id: string,
  content: string,
  tokenizer: Tokenizer = wordTokenizer,
  options: TestBlockOptions = {},
): ContextBlock {
  return {
    id,
    schemaVersion: 1,
    scope: options.scope ?? SCOPE,
    sourceDocumentId: options.sourceDocumentId ?? 'doc:main',
    sourceType: 'markdown',
    sourceLocation: {
      kind: 'text-range',
      startOffset: 0,
      endOffset: content.length,
      startLine: options.startLine ?? 1,
    },
    content,
    normalizedContentHash: calculateNormalizedContentHash(content),
    tokenCount: tokenizer.countTokens(content),
    ...(options.headingPath === undefined ? {} : { headingPath: options.headingPath }),
    attributes: {
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    },
    metadata: {},
  } as ContextBlock;
}

export function candidateBlock(
  block: ContextBlock,
  retrieval?: CandidateRetrieval,
): CandidateBlock {
  return {
    schemaVersion: 1,
    block,
    ...(retrieval === undefined ? {} : { retrieval }),
  } as CandidateBlock;
}

export function retrieval(fields: {
  readonly providerId?: string;
  readonly providerVersion?: string;
  readonly rank?: number;
  readonly score?: number;
  readonly semantics?: string;
  readonly higherIsBetter?: boolean;
}): CandidateRetrieval {
  return {
    providerId: fields.providerId ?? 'test-retriever',
    providerVersion: fields.providerVersion ?? '1',
    ...(fields.rank === undefined ? {} : { rank: fields.rank }),
    ...(fields.score === undefined
      ? {}
      : {
          score: {
            value: fields.score,
            semantics: fields.semantics ?? 'cosine-similarity',
            higherIsBetter: fields.higherIsBetter ?? true,
          },
        }),
  } as CandidateRetrieval;
}

/** One compilation request over the given candidates. */
export function compilationRequest(fields: {
  readonly id?: string;
  readonly query?: string;
  readonly candidates: readonly CandidateBlock[];
  readonly documents?: readonly SourceDocument[];
  readonly totalTokens?: number;
  readonly reservedOutputTokens?: number;
  readonly scope?: Scope;
}): Record<string, unknown> {
  return {
    id: fields.id ?? 'request-1',
    schemaVersion: 1,
    scope: fields.scope ?? SCOPE,
    query: fields.query ?? 'What does the note say?',
    referenceTime: REFERENCE_TIME,
    candidates: fields.candidates,
    sourceDocuments: fields.documents ?? [sourceDocument('doc:main', 'main')],
    budget: {
      totalTokens: fields.totalTokens ?? 400,
      reservedOutputTokens: fields.reservedOutputTokens ?? 100,
    },
    policy: evaluationPolicy(),
  };
}

/** One evaluation case wrapping a compilation request. */
export function evaluationCase(fields: {
  readonly id?: string;
  readonly split?: 'development' | 'validation' | 'regression';
  readonly request: Record<string, unknown>;
  readonly requiredBlockIds?: readonly string[];
  readonly requiredFacts?: readonly unknown[];
  readonly relevantBlockIds?: readonly string[];
  readonly irrelevantBlockIds?: readonly string[];
  readonly expectedCompilationFailure?: { readonly stage: string; readonly issueCode: string };
  readonly answerCriteria?: readonly unknown[];
  readonly tags?: readonly string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: fields.id ?? 'case-1',
    datasetSplit: fields.split ?? 'development',
    compilationRequest: fields.request,
    requiredBlockIds: fields.requiredBlockIds ?? [],
    requiredFacts: fields.requiredFacts ?? [],
    relevantBlockIds: fields.relevantBlockIds ?? [],
    irrelevantBlockIds: fields.irrelevantBlockIds ?? [],
    ...(fields.expectedCompilationFailure === undefined
      ? {}
      : { expectedCompilationFailure: fields.expectedCompilationFailure }),
    answerCriteria: fields.answerCriteria ?? [],
    tags: fields.tags ?? [],
  };
}

/** A model result carrying exactly the fields a test asked for. */
export function modelResult(
  outputText: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { schemaVersion: 1, outputText, ...extra };
}

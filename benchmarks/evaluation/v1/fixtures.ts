import type { CompilationPolicy, ContextCompilerConfig } from '@ctxalloc/compiler';
import {
  TimestampSchema,
  calculateNormalizedContentHash,
  type CandidateBlock,
  type CandidateRetrieval,
  type ContextBlock,
  type Scope,
  type SourceDocument,
  type Timestamp,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

/**
 * Deterministic construction helpers for the v1 benchmark dataset (DEC-040).
 *
 * Every block is built here rather than written out as literal JSON, for one
 * reason: a case carries a `normalizedContentHash` and a `tokenCount` that
 * `CandidateValidator` recomputes and rejects if they disagree. Hand-written
 * hashes drift the first time a fixture's text is edited, and a hand-written
 * token count is only correct for one tokenizer — so both are derived, the hash
 * by the domain's own canonical helper and the count by the tokenizer the run
 * will actually use.
 *
 * That is why the dataset is TypeScript rather than checked-in JSON, and why the
 * builders take a `Tokenizer`. Nothing here reads a clock, a random value, the
 * filesystem, the network, or the environment: two runs over one tokenizer
 * produce byte-identical cases (INV-DET-001, INV-DET-003, INV-DET-004).
 */

/** The one scope every in-scope benchmark record belongs to. */
export const BENCHMARK_SCOPE: Scope = { tenantId: 'bench', workspaceId: 'v1' };

/** A second scope, used only to prove scope isolation. */
export const FOREIGN_SCOPE: Scope = { tenantId: 'bench', workspaceId: 'other' };

/**
 * The explicit instant every benchmark compilation measures recency against.
 *
 * Parsed through the domain schema rather than asserted, so the dataset cannot
 * carry a value the compiler would reject.
 */
export const BENCHMARK_REFERENCE_TIME: Timestamp = TimestampSchema.parse(
  '2026-06-01T12:00:00.000Z',
);

/** Stable dataset identity, reported by every run over this suite. */
export const BENCHMARK_DATASET_ID = 'ctxalloc-eval-v1';

/** Stable dataset version. Bumped when a case is added, removed, or changed. */
export const BENCHMARK_DATASET_VERSION = '1';

/**
 * The five-slice compilation policy every benchmark case compiles under.
 *
 * It is a real policy the compiler validates itself; nothing here reimplements a
 * compiler rule. Authored priority is normalized over `[0, 1000]` with weight
 * `1`, one retrieval rule covers the single benchmark retriever, and the
 * filtering threshold is zero, so an ordinary block is eligible with no
 * authored attribute at all — which keeps a case's selection about its budget
 * and its content rather than about policy tuning.
 *
 * The weights are **not** tuned against these cases. Tuning a policy on the
 * fixtures it is measured with would make every number a description of the
 * tuning (METRICS 18).
 */
export function benchmarkPolicy(): CompilationPolicy {
  return {
    schemaVersion: 1,
    policyId: 'ctxalloc-eval-v1',
    policyVersion: '1.0.0',
    scoring: {
      schemaVersion: 1,
      policyId: 'scoring',
      policyVersion: '1.0.0',
      authoredPriority: { weight: 1, min: 0, max: 1000 },
      // One explicit normalization rule per provider, metric, and direction. A
      // raw provider score is never normalized by guesswork: a candidate whose
      // evidence no rule covers is rejected rather than scored, which is what
      // keeps two providers' numbers from being averaged together
      // (INV-SCORE-002).
      retrieval: {
        weight: 1,
        aggregation: 'max',
        rules: [
          {
            ruleId: 'bench-cosine',
            providerId: 'bench-retriever',
            providerVersion: '1',
            semantics: 'cosine-similarity',
            higherIsBetter: true,
            min: 0,
            max: 1,
          },
        ],
      },
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
  };
}

/** The compiler configuration every benchmark run uses. */
export function benchmarkCompilerConfig(): ContextCompilerConfig {
  return {
    schemaVersion: 1,
    compilerId: 'ctxalloc-eval',
    compilerVersion: '1.0.0',
    maxCorrectionSelections: 256,
  };
}

/** One source document, hashed over the exact text it stands for. */
export function document(
  id: string,
  sourceType: 'markdown' | 'text' | 'conversation',
  content: string,
  scope: Scope = BENCHMARK_SCOPE,
): SourceDocument {
  return {
    id,
    schemaVersion: 1,
    scope,
    sourceType,
    contentHash: calculateNormalizedContentHash(content),
    metadata: {},
  } as SourceDocument;
}

/** Optional per-block annotations a case may set. */
export interface BlockOptions {
  readonly headingPath?: readonly string[];
  readonly required?: boolean;
  readonly priority?: number;
  readonly category?: string;
  readonly scope?: Scope;
  readonly startLine?: number;
  readonly sourceType?: 'markdown' | 'text' | 'conversation';
  /** Message identity, for a conversation block. */
  readonly messageId?: string;
  readonly messageIndex?: number;
}

/**
 * One canonical block whose hash and token count are derived, never asserted.
 *
 * The token count is the tokenizer's exact count of the block's own content, and
 * the hash is the domain's canonical hash of it. Both are what
 * `CandidateValidator` recomputes, so a fixture can never be silently stale.
 */
export function block(
  id: string,
  sourceDocumentId: string,
  content: string,
  tokenizer: Tokenizer,
  options: BlockOptions = {},
): ContextBlock {
  const startLine = options.startLine ?? 1;
  const sourceType = options.sourceType ?? 'markdown';
  // A conversation block names a message, not a byte range: `SourceLocation`
  // cannot address a range inside one message, and `CandidateValidator` requires
  // the location kind to suit the source type.
  const sourceLocation =
    sourceType === 'conversation'
      ? {
          kind: 'conversation-message',
          messageId: options.messageId ?? id,
          ...(options.messageIndex === undefined ? {} : { messageIndex: options.messageIndex }),
        }
      : { kind: 'text-range', startOffset: 0, endOffset: content.length, startLine };

  return {
    id,
    schemaVersion: 1,
    scope: options.scope ?? BENCHMARK_SCOPE,
    sourceDocumentId,
    sourceType,
    sourceLocation,
    content,
    normalizedContentHash: calculateNormalizedContentHash(content),
    tokenCount: tokenizer.countTokens(content),
    ...(options.headingPath === undefined ? {} : { headingPath: options.headingPath }),
    attributes: {
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.category === undefined ? {} : { category: options.category }),
    },
    metadata: {},
  } as ContextBlock;
}

/** One candidate wrapper, with retrieval evidence only when a case supplies it. */
export function candidate(
  contextBlock: ContextBlock,
  retrieval?: CandidateRetrieval,
): CandidateBlock {
  return {
    schemaVersion: 1,
    block: contextBlock,
    ...(retrieval === undefined ? {} : { retrieval }),
  } as CandidateBlock;
}

/** Retrieval evidence carrying a comparable score from one named provider. */
export function scoredRetrieval(
  rank: number,
  value: number,
  options: { readonly providerId?: string; readonly semantics?: string } = {},
): CandidateRetrieval {
  return {
    providerId: options.providerId ?? 'bench-retriever',
    providerVersion: '1',
    rank,
    score: {
      value,
      semantics: options.semantics ?? 'cosine-similarity',
      higherIsBetter: true,
    },
  } as CandidateRetrieval;
}

/** Retrieval evidence carrying a rank and no score. */
export function rankedRetrieval(rank: number): CandidateRetrieval {
  return { providerId: 'bench-retriever', providerVersion: '1', rank } as CandidateRetrieval;
}

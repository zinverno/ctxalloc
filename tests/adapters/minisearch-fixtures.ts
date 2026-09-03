import {
  calculateNormalizedContentHash,
  type ContextBlock,
  type Scope,
  type SourceDocument,
} from '@ctxalloc/domain';
import type { CandidateProviderRequest } from '@ctxalloc/ports';

/**
 * Shared fixtures for the lexical candidate provider suite (DEC-041).
 *
 * Hashes and token counts are derived rather than asserted, so a block built
 * here is also a block `CandidateValidator` accepts — which is what lets one
 * corpus serve both a retrieval test and a real compilation.
 *
 * Nothing here reads a clock, a random value, the filesystem, or the network.
 */

export const SCOPE: Scope = { tenantId: 'adapters', workspaceId: 'retrieval' };
export const OTHER_SCOPE: Scope = { tenantId: 'adapters', workspaceId: 'other' };
export const REFERENCE_TIME = '2026-06-01T12:00:00.000Z';

/** Counts whitespace-separated words: deterministic, offline, and cheap. */
export const wordTokenizer = {
  id: 'adapters-word',
  version: '1',
  countTokens: (text: string): number =>
    text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length,
};

export interface BlockOptions {
  readonly scope?: Scope;
  readonly sourceDocumentId?: string;
  readonly headingPath?: readonly string[];
  readonly required?: boolean;
  readonly priority?: number;
  readonly category?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export function block(id: string, content: string, options: BlockOptions = {}): ContextBlock {
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
      startLine: 1,
    },
    content,
    normalizedContentHash: calculateNormalizedContentHash(content),
    tokenCount: wordTokenizer.countTokens(content),
    ...(options.headingPath === undefined ? {} : { headingPath: options.headingPath }),
    ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
    ...(options.updatedAt === undefined ? {} : { updatedAt: options.updatedAt }),
    attributes: {
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
      ...(options.category === undefined ? {} : { category: options.category }),
    },
    metadata: options.metadata ?? {},
  } as ContextBlock;
}

export function document(id: string, content: string, scope: Scope = SCOPE): SourceDocument {
  return {
    id,
    schemaVersion: 1,
    scope,
    sourceType: 'markdown',
    contentHash: calculateNormalizedContentHash(content),
    metadata: {},
  } as SourceDocument;
}

/** One provider request over an explicit corpus. */
export function providerRequest(fields: {
  readonly query: string;
  readonly blocks: readonly ContextBlock[];
  readonly sourceDocuments?: readonly SourceDocument[];
  readonly scope?: Scope;
  readonly referenceTime?: string;
}): CandidateProviderRequest {
  return {
    scope: fields.scope ?? SCOPE,
    query: fields.query,
    referenceTime: fields.referenceTime ?? REFERENCE_TIME,
    sourceDocuments: fields.sourceDocuments ?? [document('doc:main', 'main')],
    blocks: fields.blocks,
  } as CandidateProviderRequest;
}

/** Every ordering of `values`, for an input-permutation test. */
export function permutations<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [values];
  const result: T[][] = [];
  values.forEach((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([value, ...tail]);
  });
  return result;
}

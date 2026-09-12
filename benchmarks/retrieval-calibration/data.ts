import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ContextBlockSchema,
  SourceDocumentSchema,
  SourceTypeSchema,
  calculateNormalizedContentHash,
  findLoneSurrogate,
  TimestampSchema,
  type SourceType,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

export const SCOPE = { tenantId: 'phase22a-development', workspaceId: 'local-calibration' };
export const REFERENCE_TIME = TimestampSchema.parse('2026-09-01T00:00:00.000Z');
export const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
export interface Document {
  id: string;
  sourceType: SourceType;
  blocks: { id: string; content: string }[];
}
export interface Query {
  id: string;
  documentId: string;
  query: string;
  answerability: 'answerable' | 'unanswerable' | 'disputed';
  useful: string[];
  irrelevant: string[];
  facts: { id: string; blockIds: string[]; critical: boolean | null }[];
  annotationHashes: string[];
}
export interface Dataset {
  schemaVersion: 1;
  labelProvenance: 'independent-human-annotations';
  documents: Document[];
  queries: Query[];
}
function record(v: unknown, keys: string[]): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('invalid_data');
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((k) => !(k in r)))
    throw new Error('invalid_fields');
  return r;
}
function string(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || findLoneSurrogate(v) !== null)
    throw new Error('invalid_string');
  return v;
}
function array<T>(v: unknown, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new Error('invalid_array');
  return v.map(parse);
}
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error('duplicate_id');
}

/** Explicit annotation attestation is required; validation cannot prove who authored local labels. */
export function parseDataset(value: unknown): Dataset {
  const r = record(value, ['schemaVersion', 'labelProvenance', 'documents', 'queries']);
  if (r.schemaVersion !== 1 || r.labelProvenance !== 'independent-human-annotations')
    throw new Error('annotation_provenance_required');
  const documents = array(r.documents, (v): Document => {
    const d = record(v, ['id', 'sourceType', 'blocks']);
    return {
      id: string(d.id),
      sourceType: SourceTypeSchema.parse(d.sourceType),
      blocks: array(d.blocks, (v) => {
        const b = record(v, ['id', 'content']);
        return { id: string(b.id), content: string(b.content) };
      }),
    };
  });
  const queries = array(r.queries, (v): Query => {
    const q = record(v, [
      'id',
      'documentId',
      'query',
      'answerability',
      'useful',
      'irrelevant',
      'facts',
      'annotationHashes',
    ]);
    if (!['answerable', 'unanswerable', 'disputed'].includes(string(q.answerability)))
      throw new Error('invalid_answerability');
    return {
      id: string(q.id),
      documentId: string(q.documentId),
      query: string(q.query),
      answerability: q.answerability as Query['answerability'],
      useful: array(q.useful, string),
      irrelevant: array(q.irrelevant, string),
      facts: array(q.facts, (v) => {
        const f = record(v, ['id', 'blockIds', 'critical']);
        if (f.critical !== null && typeof f.critical !== 'boolean')
          throw new Error('invalid_criticality');
        return { id: string(f.id), blockIds: array(f.blockIds, string), critical: f.critical };
      }),
      annotationHashes: array(q.annotationHashes, string),
    };
  });
  if (!documents.length || !queries.length) throw new Error('empty_dataset');
  unique(documents.map((d) => d.id));
  unique(documents.flatMap((d) => d.blocks.map((b) => b.id)));
  unique(queries.map((q) => q.id));
  for (const d of documents) {
    // Exact duplicate content would make block-level loss attribution ambiguous.
    unique(d.blocks.map((b) => calculateNormalizedContentHash(b.content)));
  }
  for (const q of queries) {
    const d = documents.find((d) => d.id === q.documentId);
    if (!d) throw new Error('orphan_query');
    unique([...q.useful, ...q.irrelevant]);
    unique(q.facts.map((f) => f.id));
    const ids = new Set(d.blocks.map((b) => b.id));
    if ([...q.useful, ...q.irrelevant].some((id) => !ids.has(id))) throw new Error('orphan_label');
    for (const f of q.facts) {
      unique(f.blockIds);
      if (f.blockIds.some((id) => !q.useful.includes(id))) throw new Error('orphan_fact');
    }
    if (!q.annotationHashes.length || q.annotationHashes.some((h) => !/^[a-f0-9]{64}$/.test(h)))
      throw new Error('annotation_hash_required');
  }
  return { schemaVersion: 1, labelProvenance: 'independent-human-annotations', documents, queries };
}

export function loadPublicDataset(): Dataset {
  const value: unknown = JSON.parse(
    readFileSync('benchmarks/retrieval-calibration/data/corpus.json', 'utf8'),
  );
  const provenance: unknown = JSON.parse(
    readFileSync('benchmarks/retrieval-calibration/data/provenance.json', 'utf8'),
  );
  if (
    typeof provenance !== 'object' ||
    provenance === null ||
    !('logicalCorpusSha256' in provenance) ||
    provenance.logicalCorpusSha256 !== hash(JSON.stringify(value))
  )
    throw new Error('corpus_hash_mismatch');
  return parseDataset(value);
}

export function prepareDocument(d: Document, tokenizer: Tokenizer) {
  const sourceDocument = SourceDocumentSchema.parse({
    schemaVersion: 1,
    id: `doc:${hash(d.id)}`,
    scope: SCOPE,
    sourceType: d.sourceType,
    contentHash: `sha256:${hash(d.blocks.map((b) => b.content).join('\n\n'))}`,
    metadata: {},
  });
  let offset = 0;
  const blocks = d.blocks.map((b, index) => {
    const startOffset = offset;
    offset += b.content.length + 2;
    return ContextBlockSchema.parse({
      schemaVersion: 1,
      id: `block:${hash(b.id)}`,
      scope: SCOPE,
      sourceDocumentId: sourceDocument.id,
      sourceType: d.sourceType,
      sourceLocation:
        d.sourceType === 'conversation'
          ? { kind: 'conversation-message', messageId: hash(b.id), messageIndex: index }
          : { kind: 'text-range', startOffset, endOffset: startOffset + b.content.length },
      content: b.content,
      normalizedContentHash: calculateNormalizedContentHash(b.content),
      tokenCount: tokenizer.countTokens(b.content),
      attributes: {},
      metadata: {},
    });
  });
  return { sourceDocument, blocks };
}
export const blockId = (id: string): string => `block:${hash(id)}`;

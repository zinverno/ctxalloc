import { realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { NodeFileSourceReader } from '@ctxalloc/adapters';
import { PrepareLocalCorpusService, parseConversationSourceJson } from '@ctxalloc/application';
import { scopesEqual } from '@ctxalloc/domain';
import type { Tokenizer, SourceRegistration } from '@ctxalloc/ports';
import { hash } from '../retrieval-calibration/data.js';
import { loadLocalJson } from '../retrieval-calibration/local.js';
import { parseSettings, type Settings, type Annotation } from './schema.js';

export function confined(path: string, root = resolve('.ctxalloc')): string {
  const base = realpathSync(root),
    target = realpathSync(path),
    rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('local_boundary');
  return target;
}
/** Exclusive local artifacts: never replace a first freeze, observation or source. */
export function writeLocal(path: string, value: unknown, root = resolve('.ctxalloc')): void {
  const target = resolve(path),
    parent = confined(dirname(target), root);
  const file = resolve(parent, relative(dirname(target), target));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export function loadSettings(path: string, ignoredRoot = resolve('.ctxalloc')) {
  const file = confined(path, ignoredRoot);
  return {
    settings: parseSettings(loadLocalJson(file, ignoredRoot)),
    baseDirectory: dirname(file),
  };
}
export async function prepare(
  settings: Settings,
  baseDirectory: string,
  tokenizer: Tokenizer,
  ignoredRoot = resolve('.ctxalloc'),
) {
  const {
    scope,
    snapshotRoot,
    sourceApprovalReference,
    readerMaxBytes,
    markdownChunking,
    textChunking,
  } = settings;
  if (
    !scope ||
    !snapshotRoot ||
    !sourceApprovalReference ||
    !readerMaxBytes ||
    !markdownChunking ||
    !textChunking ||
    !settings.sources.length
  )
    throw new Error('source_decisions_required');
  const root = confined(resolve(baseDirectory, snapshotRoot), ignoredRoot);
  if (!statSync(root).isDirectory()) throw new Error('snapshot_not_directory');
  const reader = new NodeFileSourceReader({ rootDirectory: root, maxBytes: readerMaxBytes });
  const contents = new Map<string, string>();
  let bytes = 0;
  const registrations: SourceRegistration[] = settings.sources
    .filter((s) => s.available)
    .map((s) => ({
      schemaVersion: 1,
      scope,
      sourceType: s.sourceType,
      identity: { namespace: 'phase22b-dogfood', key: s.id },
      locator: s.locator!,
      metadata: { dogfoodSourceKey: s.id },
    }));
  const service = new PrepareLocalCorpusService(
    { schemaVersion: 1, markdownChunking, textChunking },
    tokenizer,
    {
      id: reader.id,
      version: reader.version,
      async read(request) {
        const result = await reader.read(request);
        bytes += Buffer.byteLength(result.content, 'utf8');
        if (bytes > 2_000_000) throw new Error('pilot_source_limit');
        contents.set(request.locator, result.content);
        return result;
      },
    },
    {
      id: 'phase22b-explicit-snapshot',
      version: '1',
      async listSources(requestScope) {
        if (!scopesEqual(scope, requestScope)) throw new Error('scope_mismatch');
        return registrations;
      },
    },
  );
  const corpus = await service.execute({ schemaVersion: 1, scope });
  if (corpus.blocks.length > 2000) throw new Error('pilot_chunk_limit');
  const sources = settings.sources.map((s) => {
    const rawContent = s.locator === null ? null : (contents.get(s.locator) ?? null);
    const document = corpus.sourceDocuments.find((d) => d.metadata.dogfoodSourceKey === s.id);
    if (s.available && (rawContent === null || !document))
      throw new Error('incomplete_preparation');
    return {
      id: s.id,
      origin: s.origin,
      sourceType: s.sourceType,
      language: s.language,
      available: s.available,
      rawContent,
      rawSha256: rawContent === null ? null : hash(rawContent),
      documentId: document?.id ?? null,
      logicalContentHash: document?.contentHash ?? null,
    };
  });
  return {
    scope,
    corpus,
    sources,
    sourceBytes: bytes,
    fingerprint: hash(JSON.stringify({ corpus, sources })),
  };
}
export type Preparation = Awaited<ReturnType<typeof prepare>>;
export function worksheet(p: Preparation) {
  return {
    schemaVersion: 1,
    purpose: 'LOCAL_HUMAN_REVIEW_NO_RETRIEVAL',
    preparationHash: p.fingerprint,
    sources: p.sources,
    blocks: p.corpus.blocks.map((b) => ({
      id: b.id,
      reportBlockHash: hash(b.id),
      sourceDocumentId: b.sourceDocumentId,
      sourceType: b.sourceType,
      location: b.sourceLocation,
      content: b.content,
      contentHash: b.normalizedContentHash,
    })),
    annotationInstructions:
      'Read source and chunks without retrieval results. Author useful source spans, negative block judgments and fact alternatives separately. Unmarked material is unjudged.',
  };
}
/** Every non-whitespace code unit in a source span must survive preparation. */
export type MappedEvidence = {
  id: string;
  sourceAvailable: boolean;
  blockIds: string[];
  preparationComplete?: boolean;
}[];
export function mapEvidence(annotation: Annotation, p: Preparation): MappedEvidence {
  const evidence = annotation.useful.map((e) => {
    const source = p.sources.find((s) => s.id === e.sourceId);
    if (!source) throw new Error('orphan_source');
    if (source.rawContent === null || e.location === null)
      return { id: e.id, sourceAvailable: false, blockIds: [] as string[] };
    let blockIds: string[];
    let preparationComplete = true;
    if (e.location.kind === 'conversation-message') {
      if (source.sourceType !== 'conversation') throw new Error('carrier_type_mismatch');
      const payload = parseConversationSourceJson(source.rawContent);
      const location = e.location;
      const messageIndex = payload.messages.findIndex((m) => m.id === location.messageId);
      const message = payload.messages[messageIndex];
      if (
        !message ||
        message.content !== e.quote ||
        (location.messageIndex !== undefined && location.messageIndex !== messageIndex)
      )
        throw new Error('annotation_source_mismatch');
      blockIds = p.corpus.blocks
        .filter(
          (b) =>
            b.sourceDocumentId === source.documentId &&
            b.sourceLocation?.kind === 'conversation-message' &&
            b.sourceLocation.messageId === location.messageId,
        )
        .map((b) => String(b.id));
    } else {
      if (source.sourceType === 'conversation') throw new Error('carrier_type_mismatch');
      const location = e.location,
        start = location.startOffset,
        end = location.endOffset;
      if (
        end <= start ||
        end > source.rawContent.length ||
        source.rawContent.slice(start, end) !== e.quote
      )
        throw new Error('annotation_source_mismatch');
      const blocks = p.corpus.blocks.filter(
        (b) =>
          b.sourceDocumentId === source.documentId &&
          b.sourceLocation?.kind === 'text-range' &&
          b.sourceLocation.startOffset < end &&
          b.sourceLocation.endOffset > start,
      );
      const spans = blocks.flatMap((b) =>
        b.sourceLocation?.kind === 'text-range' ? [b.sourceLocation] : [],
      );
      let cursor = start,
        covered = true;
      for (const span of spans.sort((a, b) => a.startOffset - b.startOffset)) {
        if (
          span.startOffset > cursor &&
          source.rawContent.slice(cursor, Math.min(span.startOffset, end)).trim()
        )
          covered = false;
        cursor = Math.max(cursor, Math.min(span.endOffset, end));
      }
      if (source.rawContent.slice(cursor, end).trim()) covered = false;
      blockIds = blocks.map((b) => String(b.id));
      preparationComplete = covered;
    }
    return {
      id: e.id,
      sourceAvailable: true,
      blockIds,
      ...(preparationComplete ? {} : { preparationComplete: false }),
    };
  });
  const ids = new Set(p.corpus.blocks.map((b) => String(b.id)));
  const positive = new Set(evidence.flatMap((e) => e.blockIds));
  if (annotation.irrelevantBlockIds.some((id) => !ids.has(id) || positive.has(id)))
    throw new Error('invalid_negative_judgment');
  return evidence;
}

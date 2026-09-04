import {
  ScopeSchema,
  safeParse,
  scopesEqual,
  type ContextBlock,
  type Scope,
  type SourceDocument,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { ControlStore, SourceReader, SourceRegistration, Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';
import { issue } from './chunking-primitives.js';
import { ConversationChunker } from './conversation-chunker.js';
import { ingestConversationSource, parseConversationSourceJson } from './conversation-source.js';
import {
  LocalSourcePipelineError,
  build,
  compareCodeUnits,
  issuesOf,
  underField,
  validatePort,
} from './local-source-pipeline.js';
import { MarkdownChunker, type MarkdownChunkingOptions } from './markdown-chunker.js';
import {
  compareSourceRegistrations,
  parseSourceRegistration,
  sourceRegistrationLogicalKey,
} from './source-registration.js';
import { ingestSource, type IngestedSource } from './source-ingestion.js';
import { TextChunker, type TextChunkingOptions } from './text-chunker.js';

/**
 * The local source-preparation use case (DEC-042).
 *
 * Preparation is the first half of `CompileLocalContextService`, and it is a
 * question worth asking on its own: *what blocks does this scope actually
 * contain?* Before this service the only way to ask it was to run a whole
 * compilation — which needs a query, a budget, a policy, a reference time, a
 * retrieval provider, and a tokenizer's rendering measurement, none of which an
 * operator inspecting a vault has any reason to invent. `ctxalloc inspect-blocks`
 * would have had to fabricate a compilation to see a corpus, and any answer it
 * gave would have been shaped by the fabricated parts.
 *
 * ```text
 * ControlStore.listSources(scope)
 *   -> SourceRegistration validation
 *   -> canonical registration order
 *   -> SourceReader.read({ locator })
 *   -> ingestSource / ingestConversationSource
 *   -> MarkdownChunker / TextChunker / ConversationChunker
 *   -> canonical SourceDocument order
 *   -> canonical ContextBlock order
 *   -> PreparedLocalCorpus
 * ```
 *
 * It retrieves nothing, scores nothing, selects nothing, and renders nothing.
 * The compiler is not reachable from here, and neither is a candidate provider:
 * this service decides only what the corpus **is** (INV-ALLOC-002, INV-DEP-003).
 *
 * It reads no file itself — filesystem access lives behind the `SourceReader`
 * port — and reads no clock, no environment variable, and no random value
 * (INV-DEP-002, INV-DET-003, INV-DET-004).
 *
 * `CompileLocalContextService` uses this exact service for its own preparation,
 * so the corpus an operator inspects and the corpus a compilation is built from
 * are produced by one implementation rather than two that agree today
 * (INV-DEP-003).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link PrepareLocalCorpusConfig} (INV-STORE-004). */
export const PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION = 1;

/** Current schema version of {@link PrepareLocalCorpusRequest} (INV-STORE-004). */
export const PREPARE_LOCAL_CORPUS_REQUEST_SCHEMA_VERSION = 1;

/**
 * The explicit chunking composition this service is configured with.
 *
 * The two chunking policies are separate because a prose vault and a log file
 * need different sizes. There is deliberately no conversation chunking policy:
 * `ConversationChunker` has no size decision to make, so a target and a maximum
 * it could not honor would be configuration that means nothing.
 *
 * There is no compiler configuration here, and that is the point: preparation
 * has no budget, no policy, and no rendering, so a compiler configuration would
 * be a value this service could only ignore.
 */
export interface PrepareLocalCorpusConfig {
  readonly schemaVersion: typeof PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION;
  readonly markdownChunking: MarkdownChunkingOptions;
  readonly textChunking: TextChunkingOptions;
}

/**
 * One preparation request: the scope, and nothing else.
 *
 * A query, a budget, a policy, and a reference time are all absent because
 * preparation consumes none of them. Accepting them would let a caller believe
 * they changed the corpus, and they cannot (INV-SCOPE-001).
 */
export interface PrepareLocalCorpusRequest {
  readonly schemaVersion: typeof PREPARE_LOCAL_CORPUS_REQUEST_SCHEMA_VERSION;
  readonly scope: Scope;
}

/**
 * The prepared corpus of one scope, in canonical project-owned order.
 *
 * Both orders are total and derived from the records themselves, so the result
 * is a function of the registrations and their contents alone — never of the
 * order the control store happened to list them in (INV-DET-002).
 */
export interface PreparedLocalCorpus {
  /** Prepared source documents, ordered by identifier code units. */
  readonly sourceDocuments: readonly SourceDocument[];
  /** The prepared corpus, in canonical project-owned order. */
  readonly blocks: readonly ContextBlock[];
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The runtime boundary of the preparation configuration.
 *
 * The two nested chunking policies are accepted as objects here and validated by
 * the components that own them, so one rule never has two implementations
 * (INV-DEP-003).
 */
const PrepareLocalCorpusConfigShapeSchema = z.strictObject({
  schemaVersion: z.literal(PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION),
  markdownChunking: z.looseObject({}),
  textChunking: z.looseObject({}),
});

const PrepareLocalCorpusRequestSchema = z.strictObject({
  schemaVersion: z.literal(PREPARE_LOCAL_CORPUS_REQUEST_SCHEMA_VERSION),
  scope: ScopeSchema,
});

/* -------------------------------------------------------------------------- */
/* Canonical corpus order                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rank of one source location kind, so a total order exists across kinds.
 *
 * A block with no location sorts last: it has nothing to compare, and putting it
 * first would let an unlocated block displace located ones.
 */
function locationRank(block: ContextBlock): number {
  if (block.sourceLocation === undefined) return 2;
  return block.sourceLocation.kind === 'text-range' ? 0 : 1;
}

/**
 * Canonical corpus order: source document, then position inside it, then block
 * identifier.
 *
 * The final comparison on the block identifier makes the order **total**: two
 * blocks that agree on document and position still compare deterministically, so
 * the prepared corpus never depends on the order the control store happened to
 * list its sources in (INV-DET-002, INV-DET-005).
 */
export function compareContextBlocks(a: ContextBlock, b: ContextBlock): number {
  const byDocument = compareCodeUnits(a.sourceDocumentId, b.sourceDocumentId);
  if (byDocument !== 0) return byDocument;

  const byKind = locationRank(a) - locationRank(b);
  if (byKind !== 0) return byKind;

  const left = a.sourceLocation;
  const right = b.sourceLocation;
  if (left?.kind === 'text-range' && right?.kind === 'text-range') {
    const byStart = left.startOffset - right.startOffset;
    if (byStart !== 0) return byStart;
    const byEnd = left.endOffset - right.endOffset;
    if (byEnd !== 0) return byEnd;
  } else if (left?.kind === 'conversation-message' && right?.kind === 'conversation-message') {
    const byIndex = (left.messageIndex ?? 0) - (right.messageIndex ?? 0);
    if (byIndex !== 0) return byIndex;
    const byMessage = compareCodeUnits(left.messageId, right.messageId);
    if (byMessage !== 0) return byMessage;
  }

  return compareCodeUnits(a.id, b.id);
}

/** `namespace/key`, which names the logical source without disclosing its location. */
function identityLabel(registration: SourceRegistration): string {
  return `${registration.identity.namespace}/${registration.identity.key}`;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/** Prepares the local corpus registered for one scope. */
export class PrepareLocalCorpusService {
  readonly #markdownChunker: MarkdownChunker;
  readonly #textChunker: TextChunker;
  readonly #conversationChunker: ConversationChunker;
  readonly #sourceReader: SourceReader;
  readonly #controlStore: ControlStore;

  /**
   * @throws {LocalSourcePipelineError} when the configuration or a dependency is invalid.
   */
  constructor(
    config: unknown,
    tokenizer: Tokenizer,
    sourceReader: SourceReader,
    controlStore: ControlStore,
  ) {
    const parsed = safeParse(PrepareLocalCorpusConfigShapeSchema, config);
    if (!parsed.ok) {
      throw new LocalSourcePipelineError('configuration', underField('config', parsed.issues));
    }

    const portIssues = [
      ...validatePort('sourceReader', sourceReader, 'read'),
      ...validatePort('controlStore', controlStore, 'listSources'),
    ];
    if (portIssues.length > 0) {
      throw new LocalSourcePipelineError('configuration', portIssues);
    }

    // The two chunker constructors take a typed policy, and the validated shape
    // above proves only that an object arrived. The value is passed through
    // `unknown` because the chunker itself is the runtime boundary for its own
    // policy: it rejects a fraction, a zero, or a reversed pair with its own
    // issues, and restating those rules here would create a second owner of one
    // truth (INV-BLOCK-005, INV-DEP-003).
    this.#markdownChunker = build(
      () =>
        new MarkdownChunker(
          tokenizer,
          parsed.value.markdownChunking as unknown as MarkdownChunkingOptions,
        ),
      'config.markdownChunking',
    );
    this.#textChunker = build(
      () => new TextChunker(tokenizer, parsed.value.textChunking as unknown as TextChunkingOptions),
      'config.textChunking',
    );
    this.#conversationChunker = build(() => new ConversationChunker(tokenizer), 'tokenizer');

    this.#sourceReader = sourceReader;
    this.#controlStore = controlStore;
  }

  /**
   * Prepares the corpus of one scope.
   *
   * Every registration is validated, checked against the request scope, and
   * checked for logical duplication **before any source is read**: a control
   * plane that contradicts itself must not cause half a corpus to be loaded
   * (INV-ADAPTER-004).
   *
   * @throws {LocalSourcePipelineError} for every failure.
   */
  async execute(input: unknown): Promise<PreparedLocalCorpus> {
    const parsed = safeParse(PrepareLocalCorpusRequestSchema, input);
    if (!parsed.ok) {
      throw new LocalSourcePipelineError('request-validation', parsed.issues);
    }
    return this.prepare(parsed.value.scope);
  }

  /**
   * Prepares the corpus of one already-validated scope.
   *
   * `CompileLocalContextService` validates a larger request that carries its own
   * scope, and re-parsing a `PrepareLocalCorpusRequest` around it would report a
   * second, differently addressed issue for one already-rejected value.
   */
  async prepare(scope: Scope): Promise<PreparedLocalCorpus> {
    const registrations = this.#canonicalRegistrations(await this.#listSources(scope), scope);

    const documents: SourceDocument[] = [];
    const blocks: ContextBlock[] = [];
    for (const [index, registration] of registrations.entries()) {
      const content = await this.#read(index, registration);
      const prepared = this.#prepare(index, registration, content);
      documents.push(prepared.document);
      blocks.push(...prepared.blocks);
    }

    return {
      sourceDocuments: [...documents].sort((a, b) => compareCodeUnits(a.id, b.id)),
      blocks: [...blocks].sort(compareContextBlocks),
    };
  }

  async #listSources(scope: Scope): Promise<readonly unknown[]> {
    let listed: unknown;
    try {
      listed = await this.#controlStore.listSources(scope);
    } catch {
      // The thrown value is deliberately not inspected. A port implementation
      // chooses its own message, and a control plane's may carry a connection
      // string, a query, or a credential; copying it into a project-owned issue
      // would publish whatever the dependency happened to say (INV-SEC-001).
      throw new LocalSourcePipelineError('control-store', [
        issue(['controlStore'], 'ControlStore listSources failed.', 'control_store_unavailable'),
      ]);
    }
    if (!Array.isArray(listed)) {
      throw new LocalSourcePipelineError('control-store', [
        issue(['controlStore'], 'listSources must resolve to an array', 'invalid_type'),
      ]);
    }
    return listed;
  }

  /**
   * Validates every registration, rejects scope mismatches and logical
   * duplicates, and returns the canonical order.
   */
  #canonicalRegistrations(listed: readonly unknown[], scope: Scope): readonly SourceRegistration[] {
    const issues: ValidationIssue[] = [];
    const registrations: SourceRegistration[] = [];

    listed.forEach((entry, index) => {
      const parsed = parseSourceRegistration(entry);
      if (!parsed.ok) {
        issues.push(...underField(String(index), parsed.issues));
        return;
      }
      registrations.push(parsed.value);
    });
    if (issues.length > 0) {
      throw new LocalSourcePipelineError('source-registration', issues);
    }

    registrations.forEach((registration, index) => {
      if (!scopesEqual(registration.scope, scope)) {
        issues.push(
          issue(
            [String(index), 'scope'],
            'must equal the request scope: the control store returned a cross-scope registration',
            'scope_mismatch',
          ),
        );
      }
    });

    const seen = new Map<string, number>();
    registrations.forEach((registration, index) => {
      const key = sourceRegistrationLogicalKey(registration);
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push(
          issue(
            [String(index), 'identity'],
            `must be unique within the scope: registration ${String(first)} declares the same logical source`,
            'duplicate_registration',
          ),
        );
        return;
      }
      seen.set(key, index);
    });

    if (issues.length > 0) {
      throw new LocalSourcePipelineError('source-registration', issues);
    }

    return [...registrations].sort(compareSourceRegistrations);
  }

  async #read(index: number, registration: SourceRegistration): Promise<string> {
    let result: unknown;
    try {
      result = await this.#sourceReader.read({ locator: registration.locator });
    } catch {
      // The reader's own message is not copied: a filesystem error routinely
      // names an absolute path, and another reader's could carry a token or a
      // fragment of the file itself. The logical identity is registration data
      // the caller already holds; the locator is not repeated (INV-SEC-001).
      throw new LocalSourcePipelineError('source-read', [
        issue(
          [String(index), 'locator'],
          `SourceReader failed for logical source ${identityLabel(registration)}.`,
          'source_unreadable',
        ),
      ]);
    }
    if (
      typeof result !== 'object' ||
      result === null ||
      typeof (result as { content?: unknown }).content !== 'string'
    ) {
      throw new LocalSourcePipelineError('source-read', [
        issue(
          [String(index), 'locator'],
          `read for ${identityLabel(registration)} must resolve to an object carrying string content`,
          'invalid_type',
        ),
      ]);
    }
    return (result as { content: string }).content;
  }

  /** Ingests and chunks one source according to its declared type. */
  #prepare(
    index: number,
    registration: SourceRegistration,
    content: string,
  ): { readonly document: SourceDocument; readonly blocks: readonly ContextBlock[] } {
    if (registration.sourceType === 'conversation') {
      return this.#prepareConversation(index, registration, content);
    }

    let ingested: IngestedSource;
    try {
      ingested = ingestSource({
        scope: registration.scope,
        sourceType: registration.sourceType,
        identity: registration.identity,
        content,
        ...(registration.title !== undefined ? { title: registration.title } : {}),
        ...(registration.createdAt !== undefined ? { createdAt: registration.createdAt } : {}),
        ...(registration.updatedAt !== undefined ? { updatedAt: registration.updatedAt } : {}),
        metadata: registration.metadata,
      });
    } catch (cause) {
      throw new LocalSourcePipelineError(
        'source-ingestion',
        underField(
          String(index),
          issuesOf(cause, [], `ingestion failed for ${identityLabel(registration)}`),
        ),
      );
    }

    try {
      const blocks =
        registration.sourceType === 'markdown'
          ? this.#markdownChunker.chunk(ingested)
          : this.#textChunker.chunk(ingested);
      return { document: ingested.document, blocks };
    } catch (cause) {
      throw new LocalSourcePipelineError(
        'source-chunking',
        underField(
          String(index),
          issuesOf(cause, [], `chunking failed for ${identityLabel(registration)}`),
        ),
      );
    }
  }

  #prepareConversation(
    index: number,
    registration: SourceRegistration,
    content: string,
  ): { readonly document: SourceDocument; readonly blocks: readonly ContextBlock[] } {
    let ingested;
    try {
      const payload = parseConversationSourceJson(content);
      ingested = ingestConversationSource({
        scope: registration.scope,
        identity: registration.identity,
        payload,
        ...(registration.title !== undefined ? { title: registration.title } : {}),
        ...(registration.createdAt !== undefined ? { createdAt: registration.createdAt } : {}),
        ...(registration.updatedAt !== undefined ? { updatedAt: registration.updatedAt } : {}),
        metadata: registration.metadata,
      });
    } catch (cause) {
      throw new LocalSourcePipelineError(
        'source-ingestion',
        underField(
          String(index),
          issuesOf(cause, [], `ingestion failed for ${identityLabel(registration)}`),
        ),
      );
    }

    try {
      return { document: ingested.document, blocks: this.#conversationChunker.chunk(ingested) };
    } catch (cause) {
      throw new LocalSourcePipelineError(
        'source-chunking',
        underField(
          String(index),
          issuesOf(cause, [], `chunking failed for ${identityLabel(registration)}`),
        ),
      );
    }
  }
}

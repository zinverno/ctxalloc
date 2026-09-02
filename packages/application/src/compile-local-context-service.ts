import {
  ContextCompiler,
  type CompilationPolicy,
  type CompilationResult,
  type ContextCompilerConfig,
} from '@ctxalloc/compiler';
import {
  ScopeSchema,
  SourceTypeSchema,
  TimestampSchema,
  JsonObjectSchema,
  findLoneSurrogate,
  safeParse,
  scopesEqual,
  type CandidateBlock,
  type ContextBlock,
  type Scope,
  type SourceDocument,
  type Timestamp,
  type TokenBudget,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { TokenBudgetSchema } from '@ctxalloc/domain';
import type {
  CandidateProvider,
  ControlStore,
  SourceReader,
  SourceRegistration,
  Tokenizer,
} from '@ctxalloc/ports';
import { z } from 'zod';
import {
  cloneRecord,
  tryCanonicalRecordJson,
  tryCloneJsonRecord,
  tryReadArrayItems,
  tryReadOwnDataProperty,
  type CanonicalRecordAttempt,
} from './canonical-record.js';
import { issue } from './chunking-primitives.js';
import { ConversationChunker } from './conversation-chunker.js';
import { ingestConversationSource, parseConversationSourceJson } from './conversation-source.js';
import { MarkdownChunker, type MarkdownChunkingOptions } from './markdown-chunker.js';
import { ingestSource, type IngestedSource } from './source-ingestion.js';
import { TextChunker, type TextChunkingOptions } from './text-chunker.js';

/**
 * The local source-to-compilation vertical slice (DEC-039).
 *
 * `CompileLocalContextService` is the **application composition root**: it joins
 * the control plane, the source reader, ingestion, chunking, the candidate
 * provider, and the compiler kernel into one path from registered local sources
 * to a `CompilationResult`.
 *
 * ```text
 * ControlStore.listSources(scope)
 *   -> SourceRegistration validation
 *   -> SourceReader.read({ locator })
 *   -> ingestSource / ingestConversationSource
 *   -> MarkdownChunker / TextChunker / ConversationChunker
 *   -> canonical corpus order
 *   -> CandidateProvider.getCandidates(...)
 *   -> ContextCompiler.compile(...)
 *   -> LocalCompilationResult
 * ```
 *
 * It adds **no** selection behavior. Scoring, filtering, allocation, ordering,
 * rendering, correction, and tracing all stay inside `ContextCompiler`, which
 * remains the compiler composition root (DEC-038, INV-DEP-003). This service
 * decides only what the corpus is and hands it over.
 *
 * It reads no file itself: filesystem access lives behind the `SourceReader`
 * port, so the whole slice runs in memory in a test (INV-DEP-002). It reads no
 * clock, no environment variable, and no random value; `referenceTime` arrives
 * with the request (INV-DET-003, INV-DET-004).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/** Current schema version of {@link LocalCompileServiceConfig} (INV-STORE-004). */
export const LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION = 1;

/** Current schema version of {@link LocalCompilationRequest} (INV-STORE-004). */
export const LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION = 1;

/**
 * The explicit composition this service is configured with.
 *
 * Nothing is defaulted and nothing is discovered. The compiler configuration is
 * the kernel's own, passed through untouched, and the two chunking policies are
 * separate because a prose vault and a log file need different sizes.
 *
 * There is deliberately no conversation chunking policy: `ConversationChunker`
 * has no size decision to make, so a target and a maximum it could not honor
 * would be configuration that means nothing.
 */
export interface LocalCompileServiceConfig {
  readonly schemaVersion: typeof LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION;
  readonly compiler: ContextCompilerConfig;
  readonly markdownChunking: MarkdownChunkingOptions;
  readonly textChunking: TextChunkingOptions;
}

/**
 * One local compilation request.
 *
 * It carries request data only. The candidates are not here: they are produced
 * by the configured provider from the corpus this service prepares, which is the
 * whole difference between this request and the kernel's `CompilationRequest`.
 *
 * `referenceTime` is required and has no default, exactly as the kernel requires
 * (INV-DET-004), and `scope` is required with no local fallback: an unscoped
 * request is a rejected request, never an assumed default (INV-SCOPE-001).
 */
export interface LocalCompilationRequest {
  readonly schemaVersion: typeof LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION;
  readonly id: string;
  readonly scope: Scope;
  readonly query: string;
  readonly referenceTime: Timestamp;
  readonly budget: TokenBudget;
  /**
   * The kernel's five-slice compilation policy.
   *
   * It is passed through untouched and validated at runtime by
   * `CompilationPolicyValidator`, which owns its rules. Restating them here would
   * create a second place for one truth to drift (INV-DEP-003).
   */
  readonly policy: CompilationPolicy;
}

/**
 * One successful local compilation.
 *
 * The prepared corpus is published beside the compilation because this slice is
 * where a local operator inspects what was actually read from disk. It is *not*
 * a relaxation of trace privacy: the settled `CompilationTrace` inside
 * `compilation` still carries no raw query, no block content, no compiled
 * context, and no arbitrary source metadata (DEC-037).
 */
export interface LocalCompilationResult {
  /** Prepared source documents, ordered by identifier code units. */
  readonly sourceDocuments: readonly SourceDocument[];
  /** The prepared corpus, in canonical project-owned order. */
  readonly blocks: readonly ContextBlock[];
  /** Exactly what the provider proposed, in exactly the provider's order. */
  readonly candidates: readonly CandidateBlock[];
  readonly compilation: CompilationResult;
}

/** Where one local pipeline run failed, before the compiler was reached. */
export type LocalSourcePipelineStage =
  | 'configuration'
  | 'request-validation'
  | 'control-store'
  | 'source-registration'
  | 'source-read'
  | 'source-ingestion'
  | 'source-chunking'
  | 'candidate-provider';

/**
 * The single error this service raises for a pre-compiler failure.
 *
 * The issues are project-owned, serializable, and deterministically ordered.
 * They carry no raw file content, no conversation content, no filesystem error
 * object, no `SyntaxError`, and no validation-library error: an adapter failure
 * is translated at this boundary rather than re-thrown (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 *
 * A failure *inside* the compiler is not wrapped. `ContextCompilationError`
 * already names its stage, its issues, and its compilation identifier, and
 * replacing it with a weaker application error would discard exactly the detail
 * a caller needs (INV-DEP-003).
 */
export class LocalSourcePipelineError extends Error {
  readonly code = 'LOCAL_SOURCE_PIPELINE_FAILED';
  readonly stage: LocalSourcePipelineStage;
  readonly issues: readonly ValidationIssue[];

  constructor(stage: LocalSourcePipelineStage, issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Local source pipeline failed at ${stage}: ${summary}`);
    this.name = 'LocalSourcePipelineError';
    this.stage = stage;
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Validation schemas                                                          */
/* -------------------------------------------------------------------------- */

/** A caller-owned identity string: non-blank, well-formed UTF-16, preserved exactly. */
const exactIdentityString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })
  .refine((value) => findLoneSurrogate(value) === null, { message: 'must be well-formed UTF-16' });

/**
 * The runtime boundary of the service configuration.
 *
 * The two nested component policies are accepted as objects here and validated
 * by the components that own them, so one rule never has two implementations
 * (INV-DEP-003).
 */
const LocalCompileServiceConfigShapeSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION),
  compiler: z.looseObject({}),
  markdownChunking: z.looseObject({}),
  textChunking: z.looseObject({}),
});

/**
 * The runtime boundary of the request.
 *
 * Unknown fields are rejected rather than stripped, nothing is coerced, and no
 * default is injected: no scope is assumed, no reserve is guessed into the
 * budget, no reference time is read from a clock, and no identifier is generated
 * (INV-BLOCK-005, INV-DET-003).
 *
 * The policy is checked here only for being an object. Its five slices belong to
 * `CompilationPolicyValidator`, and restating its rules would create a second
 * place for one truth to drift.
 */
const LocalCompilationRequestSchema = z.strictObject({
  schemaVersion: z.literal(LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION),
  id: exactIdentityString,
  scope: ScopeSchema,
  query: z.string().refine((value) => findLoneSurrogate(value) === null, {
    message: 'must be well-formed UTF-16',
  }),
  referenceTime: TimestampSchema,
  budget: TokenBudgetSchema,
  policy: z.looseObject({}),
});

/**
 * The runtime boundary of one control-plane record.
 *
 * A registration arrives from an external control plane, so compile-time types
 * prove nothing (INV-BLOCK-005). Unknown fields are rejected, nothing is
 * coerced, and no value is defaulted — least of all the source type, which
 * decides how the bytes are interpreted.
 */
const SourceRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: ScopeSchema,
  sourceType: SourceTypeSchema,
  identity: z.strictObject({
    namespace: exactIdentityString,
    key: exactIdentityString,
  }),
  locator: exactIdentityString,
  title: z.string().optional(),
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
  metadata: JsonObjectSchema,
});

/* -------------------------------------------------------------------------- */
/* Dependency validation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Checks one injected port implementation for the shape it must have.
 *
 * The dependencies arrive as objects, and their identities may travel into a
 * report, so the port shape is checked once at construction rather than trusted
 * from the compile-time type alone.
 */
function validatePort(
  name: string,
  candidate: unknown,
  method: string,
): readonly ValidationIssue[] {
  if (typeof candidate !== 'object' || candidate === null) {
    return [issue([name], `must be a ${name}`, 'invalid_type')];
  }
  const port = candidate as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  if (typeof port.id !== 'string' || port.id.trim().length === 0) {
    issues.push(issue([name, 'id'], 'must not be empty or whitespace-only'));
  }
  if (typeof port.version !== 'string' || port.version.trim().length === 0) {
    issues.push(issue([name, 'version'], 'must not be empty or whitespace-only'));
  }
  if (typeof port[method] !== 'function') {
    issues.push(issue([name, method], 'must be a function', 'invalid_type'));
  }
  return issues;
}

/** Re-addresses one component's issues under the configuration field that carries it. */
function underField(field: string, issues: readonly ValidationIssue[]): readonly ValidationIssue[] {
  return issues.map((detail) => {
    const path = [field, ...detail.path];
    return { code: detail.code, path, pointer: path.join('.'), message: detail.message };
  });
}

/**
 * The structured issues of a project-owned error, or one fixed generic issue.
 *
 * Only a project-owned `issues` array is carried through: those are already
 * serializable, deterministic, and written by this project. The thrown value's
 * `message` is never read, because an error raised inside an injected component
 * may quote source content or a machine path (INV-SEC-001).
 *
 * An empty `issues` array falls back too. A chunker reports a tokenizer failure
 * with a message and no issues, and passing that empty array through would
 * produce a pipeline failure that names its stage but says nothing at all.
 */
function issuesOf(
  cause: unknown,
  path: readonly string[],
  fallback: string,
): readonly ValidationIssue[] {
  if (typeof cause === 'object' && cause !== null) {
    const nested: unknown = (cause as { issues?: unknown }).issues;
    if (Array.isArray(nested) && nested.length > 0) {
      return nested as readonly ValidationIssue[];
    }
  }
  return [issue(path, fallback)];
}

/**
 * Rebuilds one validated registration with absent optional fields left absent.
 *
 * The validated value carries an explicit `undefined` for every omitted optional
 * field. Writing that through would produce a record claiming *there is a title,
 * and it is nothing*, and it would change what a serializer emits for the
 * record. Exact values are copied unchanged (INV-ADAPTER-002).
 */
function toRegistration(registration: {
  readonly schemaVersion: 1;
  readonly scope: Scope;
  readonly sourceType: SourceRegistration['sourceType'];
  readonly identity: { readonly namespace: string; readonly key: string };
  readonly locator: string;
  readonly title?: string | undefined;
  readonly createdAt?: Timestamp | undefined;
  readonly updatedAt?: Timestamp | undefined;
  readonly metadata: SourceRegistration['metadata'];
}): SourceRegistration {
  return {
    schemaVersion: registration.schemaVersion,
    scope: registration.scope,
    sourceType: registration.sourceType,
    identity: registration.identity,
    locator: registration.locator,
    ...(registration.title !== undefined ? { title: registration.title } : {}),
    ...(registration.createdAt !== undefined ? { createdAt: registration.createdAt } : {}),
    ...(registration.updatedAt !== undefined ? { updatedAt: registration.updatedAt } : {}),
    metadata: registration.metadata,
  };
}

/* -------------------------------------------------------------------------- */
/* Canonical ordering                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Compares two strings by UTF-16 code unit.
 *
 * `localeCompare` is deliberately not used anywhere in this module: its result
 * depends on the machine's locale data, which would make one corpus order on a
 * developer's laptop and another in a container (INV-DET-001).
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Canonical registration order: source type, then identity namespace, then key.
 *
 * The locator is deliberately absent. Ordering by it would make the prepared
 * corpus depend on where files happen to live, so moving one source could change
 * another source's position — and identity, not location, is what a registration
 * means (DEC-028).
 */
function compareRegistrations(a: SourceRegistration, b: SourceRegistration): number {
  return (
    compareCodeUnits(a.sourceType, b.sourceType) ||
    compareCodeUnits(a.identity.namespace, b.identity.namespace) ||
    compareCodeUnits(a.identity.key, b.identity.key)
  );
}

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
function compareBlocks(a: ContextBlock, b: ContextBlock): number {
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

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compiles context from the local sources registered for one scope.
 *
 * **One tokenizer, owned here.** The service receives exactly one `Tokenizer`
 * object and injects that same object into `MarkdownChunker`, `TextChunker`,
 * `ConversationChunker`, and `ContextCompiler`. It deliberately does not accept
 * a pre-built compiler plus a second tokenizer: block token counts would then be
 * produced by one tokenizer and validated by another, and `CandidateValidator`
 * would reject a corpus that is in fact correct — or, worse, accept one that is
 * not. Owning the composition is what makes the compiler's
 * `tokenizerCoverage: "validation-and-rendering"` claim true of this slice as
 * well (DEC-038, INV-BLOCK-003).
 */
export class CompileLocalContextService {
  readonly #compiler: ContextCompiler;
  readonly #markdownChunker: MarkdownChunker;
  readonly #textChunker: TextChunker;
  readonly #conversationChunker: ConversationChunker;
  readonly #sourceReader: SourceReader;
  readonly #controlStore: ControlStore;
  readonly #candidateProvider: CandidateProvider;

  /**
   * @throws {LocalSourcePipelineError} when the configuration or a dependency is invalid.
   */
  constructor(
    config: unknown,
    tokenizer: Tokenizer,
    sourceReader: SourceReader,
    controlStore: ControlStore,
    candidateProvider: CandidateProvider,
  ) {
    const parsed = safeParse(LocalCompileServiceConfigShapeSchema, config);
    if (!parsed.ok) {
      throw new LocalSourcePipelineError('configuration', underField('config', parsed.issues));
    }

    const portIssues = [
      ...validatePort('sourceReader', sourceReader, 'read'),
      ...validatePort('controlStore', controlStore, 'listSources'),
      ...validatePort('candidateProvider', candidateProvider, 'getCandidates'),
    ];
    if (portIssues.length > 0) {
      throw new LocalSourcePipelineError('configuration', portIssues);
    }

    // Each component validates its own slice, and its issues are re-addressed
    // under the field that carried them. The tokenizer is validated three times
    // over, by each chunker, and once more by the compiler — which is the point:
    // one object, checked by every component that will use it.
    this.#compiler = build(
      () => new ContextCompiler(parsed.value.compiler, tokenizer),
      'config.compiler',
    );
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
    this.#candidateProvider = candidateProvider;
  }

  /**
   * Runs the whole local slice for one request.
   *
   * Every registration is validated, checked against the request scope, and
   * checked for logical duplication **before any source is read**: a control
   * plane that contradicts itself must not cause half a corpus to be loaded
   * (INV-ADAPTER-004).
   *
   * Nothing the service is given is mutated: registrations, read results,
   * documents, blocks, candidates, and the request all leave exactly as they
   * arrived.
   *
   * @throws {LocalSourcePipelineError} for every failure before the compiler is called.
   * @throws {ContextCompilationError} for every failure inside the compiler, unchanged.
   */
  async execute(input: unknown): Promise<LocalCompilationResult> {
    const parsed = safeParse(LocalCompilationRequestSchema, input);
    if (!parsed.ok) {
      throw new LocalSourcePipelineError('request-validation', parsed.issues);
    }
    const request = parsed.value;

    const registrations = this.#canonicalRegistrations(
      await this.#listSources(request.scope),
      request.scope,
    );

    const documents: SourceDocument[] = [];
    const blocks: ContextBlock[] = [];
    for (const [index, registration] of registrations.entries()) {
      const content = await this.#read(index, registration);
      const prepared = this.#prepare(index, registration, content);
      documents.push(prepared.document);
      blocks.push(...prepared.blocks);
    }

    // Both orders are project-owned and total, so the prepared corpus is a
    // function of the registrations and their contents alone — never of the
    // order the control store listed them in (INV-DET-002).
    const sourceDocuments = [...documents].sort((a, b) => compareCodeUnits(a.id, b.id));
    const corpus = [...blocks].sort(compareBlocks);

    const candidates = await this.#getCandidates(request, sourceDocuments, corpus);

    // The provider's order is preserved exactly. It is the provider's own
    // ranking, and re-sorting it here would overwrite retrieval's answer with
    // one this layer has no basis to give (INV-ALLOC-002).
    const compilation = this.#compiler.compile({
      id: request.id,
      schemaVersion: 1,
      scope: request.scope,
      query: request.query,
      referenceTime: request.referenceTime,
      candidates,
      sourceDocuments,
      budget: request.budget,
      policy: request.policy,
    });

    return { sourceDocuments, blocks: corpus, candidates, compilation };
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
   *
   * Logical uniqueness is exact scope plus source type plus identity namespace
   * plus identity key. The locator takes no part: two registrations of one
   * logical source pointing at two paths are a contradiction the control plane
   * must resolve, not a pair of sources that happen to look alike (DEC-028).
   */
  #canonicalRegistrations(listed: readonly unknown[], scope: Scope): readonly SourceRegistration[] {
    const issues: ValidationIssue[] = [];
    const registrations: SourceRegistration[] = [];

    listed.forEach((entry, index) => {
      const parsed = safeParse(SourceRegistrationSchema, entry);
      if (!parsed.ok) {
        issues.push(...underField(String(index), parsed.issues));
        return;
      }
      registrations.push(toRegistration(parsed.value));
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
      const key = JSON.stringify([
        registration.scope.tenantId,
        registration.scope.workspaceId,
        registration.scope.projectId ?? null,
        registration.sourceType,
        registration.identity.namespace,
        registration.identity.key,
      ]);
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

    return [...registrations].sort(compareRegistrations);
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

  /**
   * Asks the provider for candidates, then proves every one of them came from
   * the prepared corpus.
   *
   * The provider is handed an **isolated deep copy** of the corpus. It would
   * otherwise receive the very objects this service later compiles and returns,
   * and `readonly` stops nothing at runtime: a provider could mutate a block in
   * place and the compiled result would silently carry the change
   * (INV-ADAPTER-004).
   */
  async #getCandidates(
    request: {
      readonly scope: Scope;
      readonly query: string;
      readonly referenceTime: Timestamp;
    },
    sourceDocuments: readonly SourceDocument[],
    blocks: readonly ContextBlock[],
  ): Promise<readonly CandidateBlock[]> {
    let candidates: unknown;
    try {
      candidates = await this.#candidateProvider.getCandidates({
        scope: request.scope,
        query: request.query,
        referenceTime: request.referenceTime,
        sourceDocuments: sourceDocuments.map(cloneRecord),
        blocks: blocks.map(cloneRecord),
      });
    } catch {
      // A retrieval provider's message may echo the raw query, a provider
      // payload, or an index error carrying stored content, so none of it is
      // copied into a project-owned issue (INV-SEC-001).
      throw new LocalSourcePipelineError('candidate-provider', [
        issue(
          ['candidateProvider'],
          'CandidateProvider getCandidates failed.',
          'provider_unavailable',
        ),
      ]);
    }
    if (!Array.isArray(candidates)) {
      throw new LocalSourcePipelineError('candidate-provider', [
        issue(['candidateProvider'], 'getCandidates must resolve to an array', 'invalid_type'),
      ]);
    }

    // `Array.isArray` is also true of a `Proxy` around an array, whose element
    // reads run provider code. Taking the spine defensively keeps ordinary
    // iteration — the very first thing done with the result — from throwing a
    // raw provider error out of this boundary.
    const items = tryReadArrayItems(candidates);
    if (items === null) {
      throw new LocalSourcePipelineError('candidate-provider', [
        issue(
          ['candidateProvider'],
          'getCandidates must resolve to a readable array',
          'invalid_type',
        ),
      ]);
    }

    // Snapshot first, then verify and compile the snapshot. Everything after
    // this line is application-owned.
    const owned = snapshotCandidates(items);
    verifyPreparedCorpusMembership(owned, blocks);
    return owned as readonly CandidateBlock[];
  }
}

/* -------------------------------------------------------------------------- */
/* Provider output ownership                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Copies the provider's output into application-owned values (DEC-039).
 *
 * The provider is handed an isolated corpus, but until now what it *returned*
 * stayed its own: the same array and the same wrapper objects were verified,
 * compiled, and published as `LocalCompilationResult.candidates`. A provider
 * that retained them could mutate them after `execute()` resolved, and the
 * returned result would change underneath its caller — while `compiledContext`,
 * `usage`, and the trace, all fixed at compile time, stayed as they were. The
 * result became internally contradictory *after* being handed over
 * (INV-ADAPTER-004).
 *
 * The kernel was never exposed to this: `CandidateValidator` re-parses the batch
 * and returns a fresh deep structure, so `CompilationResult.includedBlocks` has
 * always been isolated. Relying on that would be relying on another component's
 * implementation detail to protect this component's published value, so the
 * snapshot is taken here and the same snapshot is used for all three purposes:
 * provenance verification, compiler input, and the returned result.
 *
 * A wrapper that cannot be copied is not JSON data, so it is passed through
 * **unchanged** rather than dropped or rewritten. `CandidateValidator` owns that
 * rejection, and an un-copyable value cannot be aliased into a *successful*
 * result anyway, because no compilation containing it succeeds (INV-DEP-003).
 *
 * Array order, repeated wrappers, retrieval evidence, and every block value are
 * reproduced exactly — including own JSON keys such as `__proto__`, which plain
 * assignment would silently move onto the copy's prototype and drop from its own
 * keys. `JsonObject` reserves no key names, so that is valid data.
 */
function snapshotCandidates(candidates: readonly unknown[]): readonly unknown[] {
  return candidates.map((candidate) => {
    const copied = tryCloneJsonRecord(candidate);
    return copied.ok ? copied.value : candidate;
  });
}

/* -------------------------------------------------------------------------- */
/* Prepared-corpus provenance boundary                                         */
/* -------------------------------------------------------------------------- */

/**
 * Proves that every inspectable candidate block is one this service prepared
 * (DEC-039).
 *
 * **Why the kernel cannot prove this.** `CandidateValidator` receives a scope, a
 * source-document registry, and candidate wrappers — and nothing else. It can
 * prove a candidate names a source in the registry, that its scope and type
 * agree with it, that its `tokenCount` matches its content under the configured
 * tokenizer, that its `normalizedContentHash` is the canonical hash of its
 * content, and that its location kind suits its source type. It cannot prove
 * *prepared-corpus membership*, because it never receives the prepared corpus:
 * that registry exists only in this phase, above the kernel (DEC-030,
 * INV-DEP-003).
 *
 * The gap is reachable. Suppose the service prepares source `D` with blocks `A`
 * and `B`. A provider returns a block `F` that names `D`, sits in the right
 * scope, carries a well-formed location, and whose hash and token count were
 * recomputed from its own text — text that appears in no local source. Every
 * kernel rule holds, so `F` is accepted, and the compiled context contains
 * content the local corpus never held (INV-PROV-001).
 *
 * The rule enforced here is therefore membership **and** exact equality: the
 * candidate's block must carry the identifier of a prepared block, and must be
 * structurally identical to that prepared block in every field — schema version,
 * scope, source document, source type, location, content, hash, token count,
 * heading path, timestamps, attributes, and metadata. Comparing only the
 * identifier, the content, and the hash would accept a block whose location,
 * attributes, or metadata were rewritten, and `attributes.required` alone can
 * change what the allocator must include.
 *
 * Comparison is by canonical serialization, so property insertion order does not
 * matter: a provider that rebuilt a block field by field, or round-tripped it
 * through JSON, is proposing the same record and is accepted.
 *
 * A mismatch is **rejected, never repaired**. Substituting the prepared block for
 * the one the provider returned would silently compile something other than what
 * was proposed, and would hide a provider that is malfunctioning or hostile
 * (INV-ADAPTER-003).
 *
 * Retrieval evidence takes no part: `candidate.retrieval` is the provider's own,
 * and two wrappers around one prepared block with different evidence are both
 * legitimate. Repeated wrappers are legitimate too — deciding what to do with a
 * duplicate belongs to `CandidateDeduplicator` (DEC-031).
 *
 * A candidate too malformed to expose a block identifier is passed through
 * untouched, so `CandidateValidator` keeps sole ownership of `CandidateBlock`
 * schema validation. This boundary owns exactly one question: *did this block
 * come from the prepared corpus?*
 *
 * Inspection is **total**. The values examined here have not been validated yet,
 * so a block may carry a `bigint`, a `Date`, a reference cycle, a throwing
 * accessor, or a `Proxy` — each of which makes a naive `JSON.stringify` or a
 * naive property read throw, or worse, makes a `Date` serialize as `{}` and
 * compare equal to an empty object. A value that cannot be canonicalized is
 * neither compared nor accused: the candidate travels on to
 * `CandidateValidator`, which is the component that owns rejecting a malformed
 * `CandidateBlock` (INV-DEP-003). No runtime exception escapes this check.
 *
 * Totality here is a property of **this** boundary, not of the pipeline behind
 * it. A candidate this check declines to inspect still reaches the kernel, whose
 * recursive `JsonValueSchema` has no cycle guard and no accessor guard; a cyclic
 * or accessor-bearing block can therefore still fail inside `CandidateValidator`
 * as a raw runtime error. That is a pre-existing kernel limitation recorded in
 * DEC-039, and Phase 16 does not change compiler behavior to hide it.
 *
 * Array order is preserved exactly.
 */
function verifyPreparedCorpusMembership(
  candidates: readonly unknown[],
  corpus: readonly ContextBlock[],
): void {
  const prepared = new Map<string, CanonicalRecordAttempt>();
  for (const block of corpus) prepared.set(String(block.id), tryCanonicalRecordJson(block));

  const issues: ValidationIssue[] = [];
  candidates.forEach((candidate, index) => {
    const block = blockOf(candidate);
    // Not inspectable as a block: the kernel's schema validation owns it.
    if (block === null) return;

    const expected = prepared.get(block.id);
    if (expected === undefined) {
      issues.push(
        issue(
          [String(index), 'block', 'id'],
          `must identify a block of the prepared local corpus: no prepared block has the identifier ${JSON.stringify(block.id)}`,
          'candidate_outside_prepared_corpus',
        ),
      );
      return;
    }

    const actual = tryCanonicalRecordJson(block.value);
    // Either side un-canonicalizable means this comparison cannot be made, not
    // that it failed. The provider's block is then not JSON data at all, and
    // `CandidateValidator` rejects it as a malformed `CandidateBlock`; calling it
    // a provenance mismatch here would claim a finding this check did not make.
    // A prepared block that cannot be canonicalized would be an internal defect,
    // since every one of them is a validated domain record.
    if (!expected.ok || !actual.ok) return;

    if (actual.json !== expected.json) {
      issues.push(
        issue(
          [String(index), 'block'],
          `must equal the prepared block ${JSON.stringify(block.id)} exactly: the provider returned a modified block`,
          'candidate_block_mismatch',
        ),
      );
    }
  });

  if (issues.length > 0) {
    throw new LocalSourcePipelineError('candidate-provider', issues);
  }
}

/**
 * The candidate's block and its identifier, or `null` when the candidate is not
 * shaped like one at all.
 *
 * Only enough structure is read to look the block up. Everything else about the
 * wrapper — its schema version, its retrieval evidence, its block's own fields —
 * belongs to `CandidateValidator`.
 *
 * Both reads go through own data properties only. `candidate.block` would follow
 * the prototype chain and invoke an accessor, and an accessor on an untrusted
 * wrapper can throw — which would make this boundary, rather than the kernel,
 * the thing that failed on a malformed candidate.
 */
function blockOf(candidate: unknown): { readonly id: string; readonly value: unknown } | null {
  const value = tryReadOwnDataProperty(candidate, 'block');
  if (typeof value !== 'object' || value === null) return null;
  const id = tryReadOwnDataProperty(value, 'id');
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id, value };
}

/** `namespace/key`, which names the logical source without disclosing its location. */
function identityLabel(registration: SourceRegistration): string {
  return `${registration.identity.namespace}/${registration.identity.key}`;
}

/**
 * Builds one component, re-addressing its construction issues under the
 * configuration field that carried them.
 */
function build<T>(construct: () => T, field: string): T {
  try {
    return construct();
  } catch (cause) {
    const issues = issuesOf(cause, [], `is not a valid ${field}`);
    throw new LocalSourcePipelineError(
      'configuration',
      issues.map((detail) => {
        const path = [...field.split('.'), ...detail.path];
        return { code: detail.code, path, pointer: path.join('.'), message: detail.message };
      }),
    );
  }
}

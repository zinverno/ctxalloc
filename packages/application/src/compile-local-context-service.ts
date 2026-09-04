import {
  ContextCompiler,
  type CompilationPolicy,
  type CompilationResult,
  type ContextCompilerConfig,
} from '@ctxalloc/compiler';
import {
  ScopeSchema,
  TimestampSchema,
  findLoneSurrogate,
  safeParse,
  type CandidateBlock,
  type ContextBlock,
  type Scope,
  type SourceDocument,
  type Timestamp,
  type TokenBudget,
  type ValidationIssue,
} from '@ctxalloc/domain';
import { TokenBudgetSchema } from '@ctxalloc/domain';
import type { CandidateProvider, ControlStore, SourceReader, Tokenizer } from '@ctxalloc/ports';
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
import {
  LocalSourcePipelineError,
  build,
  underField,
  validatePort,
} from './local-source-pipeline.js';
import type { MarkdownChunkingOptions } from './markdown-chunker.js';
import {
  PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION,
  PrepareLocalCorpusService,
} from './prepare-local-corpus-service.js';
import type { TextChunkingOptions } from './text-chunker.js';

/**
 * The local source-to-compilation vertical slice (DEC-039).
 *
 * `CompileLocalContextService` is the **application composition root**: it joins
 * the control plane, the source reader, ingestion, chunking, the candidate
 * provider, and the compiler kernel into one path from registered local sources
 * to a `CompilationResult`.
 *
 * ```text
 * PrepareLocalCorpusService
 *   -> ControlStore.listSources(scope)
 *   -> SourceRegistration validation
 *   -> SourceReader.read({ locator })
 *   -> ingestSource / ingestConversationSource
 *   -> MarkdownChunker / TextChunker / ConversationChunker
 *   -> canonical corpus order
 * CandidateProvider.getCandidates(...)
 *   -> ContextCompiler.compile(...)
 *   -> LocalCompilationResult
 * ```
 *
 * Everything above the provider call is `PrepareLocalCorpusService`, which owns
 * source preparation for this service and for `ctxalloc inspect-blocks` alike
 * (DEC-042). Delegating rather than duplicating is what keeps the corpus an
 * operator inspects identical to the corpus a compilation is built from
 * (INV-DEP-003).
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
 *
 * Persisting the settled trace is deliberately **not** here. A compilation is a
 * pure function of its inputs, and a service that wrote to a store as part of
 * producing a result would make the result depend on whether the write
 * succeeded. `CompilationTracePersistenceService` owns that, and a caller
 * composes the two (DEC-042).
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

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compiles context from the local sources registered for one scope.
 *
 * **One tokenizer, owned here.** The service receives exactly one `Tokenizer`
 * object and injects that same object into `PrepareLocalCorpusService` — and so
 * into `MarkdownChunker`, `TextChunker`, and `ConversationChunker` — and into
 * `ContextCompiler`. It deliberately does not accept a pre-built compiler plus a
 * second tokenizer: block token counts would then be produced by one tokenizer
 * and validated by another, and `CandidateValidator` would reject a corpus that
 * is in fact correct — or, worse, accept one that is not. Owning the composition
 * is what makes the compiler's `tokenizerCoverage: "validation-and-rendering"`
 * claim true of this slice as well (DEC-038, INV-BLOCK-003).
 */
export class CompileLocalContextService {
  readonly #compiler: ContextCompiler;
  readonly #preparation: PrepareLocalCorpusService;
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
    // The preparation service is constructed rather than wrapped: it raises the
    // same `LocalSourcePipelineError`, already addressed under
    // `config.markdownChunking`, `config.textChunking`, and `tokenizer`, so
    // re-addressing it here would prefix a path that is already complete.
    this.#preparation = new PrepareLocalCorpusService(
      {
        schemaVersion: PREPARE_LOCAL_CORPUS_CONFIG_SCHEMA_VERSION,
        markdownChunking: parsed.value.markdownChunking,
        textChunking: parsed.value.textChunking,
      },
      tokenizer,
      sourceReader,
      controlStore,
    );

    this.#candidateProvider = candidateProvider;
  }

  /**
   * Runs the whole local slice for one request.
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

    const { sourceDocuments, blocks: corpus } = await this.#preparation.prepare(request.scope);

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

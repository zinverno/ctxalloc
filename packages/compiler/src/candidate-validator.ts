import {
  CandidateBlockSchema,
  ScopeSchema,
  SourceDocumentSchema,
  calculateNormalizedContentHash,
  findLoneSurrogate,
  safeParse,
  scopesEqual,
  type CandidateBlock,
  type Scope,
  type SourceDocument,
  type ValidationIssue,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { z } from 'zod';

/**
 * Strict candidate validation (DEC-030).
 *
 * `CandidateValidator` is the first stage of the compiler kernel and the last
 * point at which a malformed, stale, cross-scope, or forged candidate can be
 * stopped before policy filtering, deduplication, scoring, allocation, ordering,
 * rendering, and trace construction rely on it (ARCHITECTURE section 4).
 *
 * It is synchronous and deterministic. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, and it
 * calls no model and no retrieval provider (INV-DET-001, INV-DET-003,
 * INV-DET-004, INV-DEP-002). Its only injected dependency is the project-owned
 * `Tokenizer` port.
 *
 * What it deliberately does not do: it does not retrieve candidates, filter them
 * by policy, deduplicate them, choose a canonical duplicate, score them,
 * normalize or compare a provider score, resolve required blocks, judge whether
 * required content fits a budget, allocate, order, render, or build a trace.
 * Required-budget feasibility in particular belongs to the allocator, which is
 * the only component that knows the complete required allocation and its
 * rendering overhead (ARCHITECTURE section 6.4, INV-BUDGET-004).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One batch of candidates to validate, together with the scope they must belong
 * to and the source documents they may reference.
 *
 * `sourceDocuments` is an explicit validation registry, not a content store. A
 * block's source is proven by membership in this array and by nothing else: not
 * by a path, not by metadata, not by the adapter that produced it, and not by
 * array position (INV-PROV-001, INV-ADAPTER-002).
 */
export interface CandidateValidationInput {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly candidates: readonly CandidateBlock[];
}

/**
 * A batch that passed every check, carrying validated project-owned data only.
 *
 * Candidates stay in input order and are never removed, repaired, reordered, or
 * collapsed. Equivalent wrappers that repeat one block ID are preserved for the
 * deduplication phase, which owns canonical selection (INV-DEDUP-001).
 */
export interface ValidatedCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly candidates: readonly CandidateBlock[];
}

/**
 * Machine-readable categories of a candidate validation problem.
 *
 * Every issue carries one of these instead of a free-text explanation, so a
 * later compiler trace can turn a batch failure into rejected-candidate
 * decisions without re-deriving meaning from a message (INV-TRACE-002).
 */
export type CandidateValidationIssueCode =
  | 'invalid_input'
  | 'invalid_priority'
  | 'duplicate_source_document_id'
  | 'scope_mismatch'
  | 'source_not_found'
  | 'source_scope_mismatch'
  | 'source_type_mismatch'
  | 'conflicting_block_id'
  | 'invalid_unicode'
  | 'invalid_normalized_content_hash'
  | 'invalid_token_count'
  | 'tokenizer_failed';

/**
 * The single error this component raises, for construction and for validation
 * alike.
 *
 * Its issues are project-owned, serializable, and deterministically ordered. No
 * validation-library error, `DomainValidationError`, tokenizer-library error, or
 * external provider error escapes this boundary (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 */
export class CandidateValidationError extends Error {
  readonly code = 'CANDIDATE_VALIDATION_FAILED';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Candidate validation failed: ${summary}`);
    this.name = 'CandidateValidationError';
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* Issue construction                                                          */
/* -------------------------------------------------------------------------- */

type IssuePath = readonly (string | number)[];

/**
 * Renders a path the same way the domain renders one, so an issue raised by the
 * top-level schema and an issue raised by a cross-record rule are addressed
 * identically by a consumer.
 */
function pointerFor(path: IssuePath): string {
  return path.reduce<string>((pointer, segment) => {
    if (typeof segment === 'number') return `${pointer}[${String(segment)}]`;
    return pointer.length === 0 ? segment : `${pointer}.${segment}`;
  }, '');
}

function issue(
  code: CandidateValidationIssueCode,
  path: IssuePath,
  message: string,
): ValidationIssue {
  return { code, path, pointer: pointerFor(path), message };
}

/** Bounded rendering of an untrusted string for an issue message. */
function quote(value: string): string {
  const MAX_CODE_POINTS = 60;
  const codePoints = [...value];
  if (codePoints.length <= MAX_CODE_POINTS) return JSON.stringify(value);
  return `${JSON.stringify(codePoints.slice(0, MAX_CODE_POINTS).join(''))}... (${String(codePoints.length)} code points)`;
}

function describeScope(scope: Scope): string {
  return `{tenantId: ${quote(scope.tenantId)}, workspaceId: ${quote(scope.workspaceId)}, projectId: ${
    scope.projectId === undefined ? 'absent' : quote(scope.projectId)
  }}`;
}

/* -------------------------------------------------------------------------- */
/* Canonical comparison                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic serialization of validated JSON-safe data.
 *
 * Object keys are sorted recursively and array order is preserved, so two
 * records that differ only in JavaScript property insertion order serialize
 * identically. A plain `JSON.stringify` would not: it emits keys in insertion
 * order, which an adapter, a database driver, or a JSON parser can vary between
 * runs, and comparing blocks with it would invent conflicts that do not exist
 * (INV-DET-002).
 *
 * The input is always a parsed `ContextBlock`, which the domain schemas have
 * already restricted to JSON-safe values, so no cyclic, `undefined`, `NaN`, or
 * class-instance value can reach this function.
 */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/* -------------------------------------------------------------------------- */
/* Top-level input schema                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The runtime boundary of the compiler kernel.
 *
 * The batch may have been persisted, transported over HTTP, rebuilt by hand, or
 * assembled by an adapter, so compile-time types prove nothing here
 * (INV-BLOCK-005). Unknown fields are rejected rather than stripped, nothing is
 * coerced, and no default is injected: an unsupported or future shape must be a
 * visible failure, not a silently reinterpreted one.
 */
const CandidateValidationInputSchema = z.strictObject({
  scope: ScopeSchema,
  sourceDocuments: z.array(SourceDocumentSchema),
  candidates: z.array(CandidateBlockSchema),
});

/**
 * `ContextBlockSchema` types `priority` as an integer, and Zod's integer check
 * already enforces the safe-integer range, which is exactly the Phase 7 rule:
 * absent is valid, any finite safe integer is valid including a negative one,
 * and a fraction or an unsafe magnitude is not (DEC-030).
 *
 * The rule therefore has one enforcement point rather than two that could drift.
 * What this mapping adds is the focused issue code, so a consumer can tell a
 * rejected priority from any other malformed field. Semantic minimum and maximum
 * priority remain deferred to the versioned `CompilationPolicy`.
 */
function isPriorityPath(path: IssuePath): boolean {
  return (
    path.length === 5 &&
    path[0] === 'candidates' &&
    typeof path[1] === 'number' &&
    path[2] === 'block' &&
    path[3] === 'attributes' &&
    path[4] === 'priority'
  );
}

function toInputIssue(parsed: ValidationIssue): ValidationIssue {
  const code: CandidateValidationIssueCode = isPriorityPath(parsed.path)
    ? 'invalid_priority'
    : 'invalid_input';
  return { ...parsed, code };
}

/* -------------------------------------------------------------------------- */
/* Tokenizer validation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The tokenizer is an injected dependency whose counts are correctness data, so
 * its port shape is checked once at construction rather than trusted from the
 * compile-time type alone. Identity values are checked for blankness and never
 * rewritten: a trace records them verbatim, and trimming here would store a
 * value the caller never configured (INV-TRACE-005).
 */
function validateTokenizer(tokenizer: Tokenizer): readonly ValidationIssue[] {
  if (typeof tokenizer !== 'object' || tokenizer === null) {
    return [issue('invalid_input', ['tokenizer'], 'must be a Tokenizer')];
  }
  const issues: ValidationIssue[] = [];
  if (typeof tokenizer.id !== 'string' || tokenizer.id.trim().length === 0) {
    issues.push(
      issue('invalid_input', ['tokenizer', 'id'], 'must not be empty or whitespace-only'),
    );
  }
  if (typeof tokenizer.version !== 'string' || tokenizer.version.trim().length === 0) {
    issues.push(
      issue('invalid_input', ['tokenizer', 'version'], 'must not be empty or whitespace-only'),
    );
  }
  if (typeof tokenizer.countTokens !== 'function') {
    issues.push(issue('invalid_input', ['tokenizer', 'countTokens'], 'must be a function'));
  }
  return issues;
}

/** Outcome of counting one exact string, cached so identical content is counted once. */
type CountOutcome =
  { readonly ok: true; readonly tokens: number } | { readonly ok: false; readonly reason: string };

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `a non-Error value (${typeof error})`;
}

/* -------------------------------------------------------------------------- */
/* Validator                                                                   */
/* -------------------------------------------------------------------------- */

export class CandidateValidator {
  readonly #tokenizer: Tokenizer;

  /**
   * @throws {CandidateValidationError} when the tokenizer does not satisfy the port.
   */
  constructor(tokenizer: Tokenizer) {
    const issues = validateTokenizer(tokenizer);
    if (issues.length > 0) throw new CandidateValidationError(issues);
    this.#tokenizer = tokenizer;
  }

  /**
   * Validates one batch, all or nothing.
   *
   * Every discoverable problem is collected before failing, so one call reports
   * the whole batch rather than its first defect. On any problem the batch is
   * rejected: no candidate is silently removed, repaired, re-counted, re-hashed,
   * or reordered, and no partial result is returned (INV-SCOPE-004,
   * INV-BLOCK-003, INV-ALLOC-004). A later compiler trace may translate these
   * issues into rejected-candidate decisions (INV-TRACE-001).
   *
   * @throws {CandidateValidationError} when the batch is not valid.
   */
  validate(input: unknown): ValidatedCandidateSet {
    const parsed = safeParse(CandidateValidationInputSchema, input);
    if (!parsed.ok) {
      // Cross-record rules read fields the schema has not established yet, so
      // running them over unparsed data could only guess. The schema issues are
      // everything that is safely discoverable at this point.
      throw new CandidateValidationError(parsed.issues.map(toInputIssue));
    }

    const { scope, sourceDocuments, candidates } = parsed.value;
    const issues: ValidationIssue[] = [
      ...this.#validateRegistry(scope, sourceDocuments),
      ...this.#validateCandidates(scope, sourceDocuments, candidates),
      ...detectConflictingBlockIds(candidates),
    ];

    if (issues.length > 0) throw new CandidateValidationError(issues);

    // `parsed.value` is a fresh deep structure produced by the schemas, so the
    // result shares no object with the caller's input and neither can mutate the
    // other.
    return { scope, sourceDocuments, candidates };
  }

  /**
   * The registry must be an unambiguous lookup table. A repeated source ID is
   * rejected even when the two records are byte-identical: resolving it by first
   * or last write would make the array's order significant, and accepting it
   * would hide an upstream merge defect that a later duplicate with *different*
   * data would silently exploit (INV-BLOCK-002).
   */
  #validateRegistry(scope: Scope, sourceDocuments: readonly SourceDocument[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const firstIndexById = new Map<string, number>();

    sourceDocuments.forEach((document, index) => {
      const firstIndex = firstIndexById.get(document.id);
      if (firstIndex === undefined) {
        firstIndexById.set(document.id, index);
      } else {
        issues.push(
          issue(
            'duplicate_source_document_id',
            ['sourceDocuments', index, 'id'],
            `source document ID ${quote(document.id)} is already declared at sourceDocuments[${String(firstIndex)}]`,
          ),
        );
      }

      if (!scopesEqual(document.scope, scope)) {
        issues.push(
          issue(
            'scope_mismatch',
            ['sourceDocuments', index, 'scope'],
            `must equal the request scope ${describeScope(scope)}, received ${describeScope(document.scope)}`,
          ),
        );
      }
    });

    return issues;
  }

  #validateCandidates(
    scope: Scope,
    sourceDocuments: readonly SourceDocument[],
    candidates: readonly CandidateBlock[],
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Built from the first occurrence of each ID. A repeated ID has already been
    // reported, and the batch is failing regardless, so reference checks stay
    // deterministic rather than depending on which duplicate wins.
    const registry = new Map<string, SourceDocument>();
    for (const document of sourceDocuments) {
      if (!registry.has(document.id)) registry.set(document.id, document);
    }

    // Identical content always hashes and counts identically, so each distinct
    // string is processed once no matter how many wrappers carry it. Every
    // candidate still receives its own issue, so the reported result does not
    // depend on how often a block is repeated.
    const hashes = new Map<string, string>();
    const counts = new Map<string, CountOutcome>();

    candidates.forEach((candidate, index) => {
      const { block } = candidate;
      const at = (...rest: readonly (string | number)[]): IssuePath => [
        'candidates',
        index,
        'block',
        ...rest,
      ];

      if (!scopesEqual(block.scope, scope)) {
        issues.push(
          issue(
            'scope_mismatch',
            at('scope'),
            `must equal the request scope ${describeScope(scope)}, received ${describeScope(block.scope)}`,
          ),
        );
      }

      const source = registry.get(block.sourceDocumentId);
      if (source === undefined) {
        issues.push(
          issue(
            'source_not_found',
            at('sourceDocumentId'),
            `references source document ${quote(block.sourceDocumentId)}, which is not declared in sourceDocuments`,
          ),
        );
      } else {
        if (!scopesEqual(source.scope, block.scope)) {
          issues.push(
            issue(
              'source_scope_mismatch',
              at('scope'),
              `must equal the scope of source document ${quote(source.id)} ${describeScope(source.scope)}, received ${describeScope(block.scope)}`,
            ),
          );
        }
        if (source.sourceType !== block.sourceType) {
          issues.push(
            issue(
              'source_type_mismatch',
              at('sourceType'),
              `must equal the source type of source document ${quote(source.id)} (${quote(source.sourceType)}), received ${quote(block.sourceType)}`,
            ),
          );
        }
      }

      // A lone surrogate has no UTF-8 encoding, so both the hash and the token
      // count derived from it would describe text the caller never supplied. The
      // defect is reported once, at the content, and the two derived checks are
      // skipped for this candidate rather than repeating the same cause
      // (INV-BLOCK-007).
      const loneSurrogate = findLoneSurrogate(block.content);
      if (loneSurrogate !== null) {
        issues.push(
          issue(
            'invalid_unicode',
            at('content'),
            `must be well-formed UTF-16: lone surrogate at code unit ${String(loneSurrogate)}`,
          ),
        );
        return;
      }

      const expectedHash = cached(hashes, block.content, () =>
        calculateNormalizedContentHash(block.content),
      );
      if (block.normalizedContentHash !== expectedHash) {
        issues.push(
          issue(
            'invalid_normalized_content_hash',
            at('normalizedContentHash'),
            `must equal the canonical hash of the block content (${expectedHash}), received ${block.normalizedContentHash}`,
          ),
        );
      }

      const outcome = cached(counts, block.content, () => this.#count(block.content));
      if (!outcome.ok) {
        issues.push(issue('tokenizer_failed', at('content'), outcome.reason));
      } else if (outcome.tokens !== block.tokenCount) {
        issues.push(
          issue(
            'invalid_token_count',
            at('tokenCount'),
            `must equal the count of the block content under tokenizer ${quote(this.#tokenizer.id)} version ${quote(this.#tokenizer.version)} (${String(outcome.tokens)}), received ${String(block.tokenCount)}`,
          ),
        );
      }
    });

    return issues;
  }

  /**
   * Counts one exact string, converting any failure into a project-owned
   * outcome.
   *
   * The count describes `block.content` only. Heading path rendering, source
   * labels, separators, compiler wrappers, and protocol overhead are not counted
   * here: the compiled total is measured by tokenizing the rendered context,
   * which remains a later compiler responsibility (INV-BUDGET-002,
   * INV-RENDER-004).
   *
   * A returned value that is not a usable count is a failure, never a value to
   * repair, and no character or word estimate substitutes for it (DEC-027).
   */
  #count(content: string): CountOutcome {
    let tokens: number;
    try {
      tokens = this.#tokenizer.countTokens(content);
    } catch (error: unknown) {
      return {
        ok: false,
        reason: `tokenizer ${quote(this.#tokenizer.id)} version ${quote(this.#tokenizer.version)} failed to count the block content: ${describeThrown(error)}`,
      };
    }
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
      return {
        ok: false,
        reason: `tokenizer ${quote(this.#tokenizer.id)} version ${quote(this.#tokenizer.version)} returned ${String(tokens)} for the block content: expected a non-negative safe integer`,
      };
    }
    return { ok: true, tokens };
  }
}

function cached<T>(store: Map<string, T>, key: string, compute: () => T): T {
  const existing = store.get(key);
  if (existing !== undefined) return existing;
  const value = compute();
  store.set(key, value);
  return value;
}

/**
 * Rejects one block ID that is attached to different canonical block data.
 *
 * Two wrappers may legitimately carry the same block: a provider can return it
 * twice, and two providers can return it with different retrieval metadata.
 * Those wrappers pass through unchanged, because collapsing them is
 * deduplication's decision and its canonical selection rules, not validation's
 * (INV-DEDUP-001). What cannot pass is one identifier standing for two different
 * records: a stable identifier that means two things makes every later provenance
 * and deduplication decision unsound (INV-BLOCK-002).
 *
 * Comparison uses the canonical serialization of `block` alone, so retrieval
 * data never creates a conflict and property insertion order never creates a
 * false one. The decision depends only on the set of distinct records, never on
 * input order; the reported path names the earliest wrapper so that the message
 * points somewhere useful.
 */
function detectConflictingBlockIds(candidates: readonly CandidateBlock[]): ValidationIssue[] {
  interface Group {
    readonly indices: number[];
    readonly variants: Set<string>;
    readonly firstIndex: number;
  }

  const groups = new Map<string, Group>();
  candidates.forEach((candidate, index) => {
    const id: string = candidate.block.id;
    const group = groups.get(id) ?? { indices: [], variants: new Set<string>(), firstIndex: index };
    group.indices.push(index);
    group.variants.add(canonicalize(candidate.block));
    groups.set(id, group);
  });

  return [...groups.entries()]
    .filter(([, group]) => group.variants.size > 1)
    .sort(([, a], [, b]) => a.firstIndex - b.firstIndex)
    .map(([id, group]) =>
      issue(
        'conflicting_block_id',
        ['candidates', group.firstIndex, 'block', 'id'],
        `block ID ${quote(id)} is attached to ${String(group.variants.size)} different canonical ContextBlock records at candidates ${group.indices.join(', ')}`,
      ),
    );
}

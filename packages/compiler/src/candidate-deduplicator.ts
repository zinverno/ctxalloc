import {
  normalizeContextBlockContentForHash,
  type CandidateBlock,
  type ContextBlock,
  type Scope,
  type SourceDocument,
} from '@ctxalloc/domain';
import { canonicalJson, compareCodeUnits } from './canonical-json.js';
import type { ValidatedCandidateSet } from './candidate-validator.js';

/**
 * Deterministic exact candidate deduplication (DEC-031).
 *
 * `CandidateDeduplicator` is the second stage of the compiler kernel. It turns a
 * `ValidatedCandidateSet` into a `DeduplicatedCandidateSet`: independently
 * selectable logical content is collapsed into one group per distinct piece of
 * text, and every candidate wrapper survives inside exactly one group as
 * evidence (INV-DEDUP-003, INV-TRACE-001).
 *
 * It is synchronous, pure, and offline. It reads no clock, no random value, no
 * file, no environment variable, no database, and no network resource, calls no
 * model, no retrieval provider, and no tokenizer, and takes no injected
 * dependency at all (INV-DET-001, INV-DET-003, INV-DET-004, INV-DEP-002).
 *
 * What it deliberately does not do: it does not retrieve candidates, revalidate
 * them, re-count tokens, re-hash content, filter them by policy, score them,
 * normalize or compare a provider score, resolve required blocks against a
 * budget, allocate, order for rendering, render, or build a trace. It also
 * implements no near-duplicate rule of any kind: no embedding, similarity
 * threshold, edit distance, stemming, containment, or heading heuristic
 * (INV-DEDUP-004).
 */

/* -------------------------------------------------------------------------- */
/* Public contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Why one candidate wrapper belongs to the group whose canonical block was
 * selected.
 *
 * `same-block-id` means the wrapper carries the canonical block itself.
 * `CandidateValidator` has already established that one block ID cannot stand
 * for two different canonical records, so repeated wrappers of one ID are the
 * same block even when their retrieval metadata differs (INV-BLOCK-002).
 *
 * `same-normalized-content` means the wrapper carries a different block whose
 * canonical normalized content is exactly equal to the canonical block's.
 */
export type DuplicateMatchReason = 'same-block-id' | 'same-normalized-content';

/**
 * Which ordered rule selected the canonical block of a group (INV-DEDUP-001).
 *
 * `single-block` — the group holds one distinct block ID, however many wrappers
 * carry it.
 * `required-block` — several distinct block IDs, exactly one of them required.
 * `required-then-stable-block-id` — several distinct block IDs, more than one
 * required, so required status narrowed the pool and the stable block ID broke
 * the remaining tie.
 * `stable-block-id` — several distinct block IDs, none required, so the stable
 * block ID decided alone.
 */
export type CanonicalSelectionReason =
  'single-block' | 'required-block' | 'required-then-stable-block-id' | 'stable-block-id';

/**
 * One preserved candidate wrapper, exactly as it was validated.
 *
 * The wrapper is carried whole rather than summarized: a later scorer may need
 * its retrieval evidence, and a later trace builder must be able to recover the
 * duplicate's own block ID, source document, source location, heading path, and
 * metadata (INV-DEDUP-003, INV-PROV-002, INV-SCORE-002).
 */
export interface DeduplicatedCandidateMember {
  readonly candidate: CandidateBlock;
  readonly matchReason: DuplicateMatchReason;
}

/**
 * One group of exact duplicates and the existing block chosen to represent it.
 *
 * `canonicalBlock` is always one of the group's own blocks, carried unchanged.
 * No merged, rewritten, or synthesized block is ever produced, so the canonical
 * record keeps its own identity and its own provenance (INV-ALLOC-004,
 * INV-PROV-001).
 */
export interface DeduplicatedCandidate {
  readonly canonicalBlock: ContextBlock;
  readonly canonicalSelectionReason: CanonicalSelectionReason;
  readonly members: readonly DeduplicatedCandidateMember[];
}

/**
 * The deduplicated batch: an ephemeral compiler-stage result, never persisted.
 *
 * It carries no schema version for that reason: `schemaVersion` marks persisted
 * domain records so an unsupported stored shape fails clearly (INV-STORE-004),
 * and this structure is produced and consumed inside one compilation.
 *
 * `scope` and `sourceDocuments` are the validated records unchanged; only the
 * registry's order is normalized.
 */
export interface DeduplicatedCandidateSet {
  readonly scope: Scope;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly candidates: readonly DeduplicatedCandidate[];
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

/** One exact-duplicate group under construction. */
interface Group {
  /** The canonical normalized content shared by every member, and the group key. */
  readonly normalizedContent: string;
  readonly wrappers: CandidateBlock[];
  /** The distinct canonical blocks in the group, keyed by their stable block ID. */
  readonly blocksById: Map<string, ContextBlock>;
}

function isRequired(block: ContextBlock): boolean {
  // `required` is optional, and an absent declaration and an explicit `false`
  // are both simply "not required". Neither is treated as a large score
  // (INV-SCORE-003).
  return block.attributes.required === true;
}

/**
 * Selects the canonical block of one group and records which rule decided it.
 *
 * The rules are ordered and use only semantics the active invariants already
 * define. Retrieval score, retrieval rank, provider identity, authored numeric
 * priority, category, timestamps, token count, metadata richness, source
 * location completeness, and input position are all deliberately excluded; the
 * reasoning is recorded in DEC-031.
 */
function selectCanonical(group: Group): {
  readonly block: ContextBlock;
  readonly reason: CanonicalSelectionReason;
} {
  const distinct = [...group.blocksById.values()].sort((a, b) => compareCodeUnits(a.id, b.id));

  // A group is never empty: it exists only because a wrapper created it.
  const first = distinct[0];
  if (first === undefined) {
    throw new Error('unreachable: a duplicate group always holds at least one block');
  }
  if (distinct.length === 1) {
    return { block: first, reason: 'single-block' };
  }

  // Rule 1: required status. A required block wins over every optional
  // duplicate, so required content survives deduplication and no block is ever
  // mutated or copied to carry it (INV-DEDUP-002).
  const required = distinct.filter(isRequired);
  const firstRequired = required[0];
  if (firstRequired !== undefined) {
    return {
      block: firstRequired,
      // `distinct` is already sorted, so `required` is too and its first element
      // is the lexicographically smallest required block ID.
      reason: required.length === 1 ? 'required-block' : 'required-then-stable-block-id',
    };
  }

  // Rule 2: the stable block identifier, the project-owned final tie-breaker
  // (INV-DET-005).
  return { block: first, reason: 'stable-block-id' };
}

/* -------------------------------------------------------------------------- */
/* Deduplicator                                                                */
/* -------------------------------------------------------------------------- */

export class CandidateDeduplicator {
  /**
   * Groups one validated batch by exact canonical normalized content.
   *
   * The input is a stage contract, not a runtime boundary. `CandidateValidator`
   * is the trust boundary of the compiler kernel: it has already proved the
   * schema, the scope, the source registry, the token counts, the content
   * hashes, and that no block ID stands for two different records. This stage
   * therefore revalidates nothing, repairs nothing, and re-derives nothing, and
   * a future compiler orchestration will guarantee the stage order (DEC-031).
   *
   * The supplied set and everything reachable from it are treated as immutable:
   * no candidate, block, attribute, metadata object, source location, retrieval
   * record, or array is mutated, and the result reuses those records by
   * reference rather than rewriting them (INV-ALLOC-004).
   *
   * Every input wrapper appears exactly once across the returned members, so no
   * evidence is lost between stages (INV-TRACE-001, INV-DEDUP-003).
   */
  deduplicate(input: ValidatedCandidateSet): DeduplicatedCandidateSet {
    const resolved = groupByExactContent(input.candidates).map((group) => ({
      group,
      canonical: selectCanonical(group),
    }));

    // Groups are ordered by the canonical block's stable ID. The group's own
    // normalized content is the final tie-breaker: group keys are distinct by
    // construction, so the order stays total even if a caller bypassed the
    // validator and supplied one block ID attached to two different records
    // (INV-DET-005).
    resolved.sort(
      (a, b) =>
        compareCodeUnits(a.canonical.block.id, b.canonical.block.id) ||
        compareCodeUnits(a.group.normalizedContent, b.group.normalizedContent),
    );

    const candidates: readonly DeduplicatedCandidate[] = resolved.map(({ group, canonical }) => ({
      canonicalBlock: canonical.block,
      canonicalSelectionReason: canonical.reason,
      members: orderMembers(group.wrappers, canonical.block.id),
    }));

    return {
      scope: input.scope,
      // The same validated records, in a normalized order. The array is copied
      // before sorting, so the caller's registry is never reordered in place.
      sourceDocuments: [...input.sourceDocuments].sort((a, b) => compareCodeUnits(a.id, b.id)),
      candidates,
    };
  }
}

/**
 * Buckets wrappers by exact canonical normalized block content.
 *
 * The validated `normalizedContentHash` is used as an outer bucket only, because
 * comparing 64 hexadecimal characters is cheaper than comparing whole documents.
 * It is never the semantic test: inside a bucket, membership is decided by
 * comparing the canonical normalized content strings themselves, so a
 * hypothetical hash collision could never merge two different texts into one
 * group. The pre-bucket cannot split a real group either, because
 * `CandidateValidator` has proved every hash is the canonical hash of its own
 * content, and equal normalized content therefore always hashes equally.
 *
 * `normalizeContextBlockContentForHash` is the shared domain rule and the single
 * definition of equivalence (DEC-030): CRLF and lone CR become LF, and nothing
 * else changes. Trailing spaces, blank-line runs, indentation, letter case,
 * punctuation, and Unicode composition therefore all stay significant, so blocks
 * that merely discuss the same subject with different text are never collapsed
 * (INV-DEDUP-005).
 */
function groupByExactContent(candidates: readonly CandidateBlock[]): Group[] {
  const buckets = new Map<string, Map<string, Group>>();
  const ordered: Group[] = [];

  for (const candidate of candidates) {
    const { block } = candidate;
    const normalizedContent = normalizeContextBlockContentForHash(block.content);

    let bucket = buckets.get(block.normalizedContentHash);
    if (bucket === undefined) {
      bucket = new Map<string, Group>();
      buckets.set(block.normalizedContentHash, bucket);
    }

    let group = bucket.get(normalizedContent);
    if (group === undefined) {
      group = { normalizedContent, wrappers: [], blocksById: new Map<string, ContextBlock>() };
      bucket.set(normalizedContent, group);
      ordered.push(group);
    }

    group.wrappers.push(candidate);
    if (!group.blocksById.has(block.id)) group.blocksById.set(block.id, block);
  }

  // `ordered` follows input order, which is not an output order: every consumer
  // sorts before reading (INV-DET-002).
  return ordered;
}

/**
 * Orders one group's preserved wrappers deterministically.
 *
 * The stable block ID comes first, and the canonical serialization of the whole
 * wrapper breaks the remaining ties, so wrappers that share a block ID but carry
 * different retrieval evidence still have a fixed relative order that does not
 * depend on input position or on JavaScript property insertion order
 * (INV-DET-002, INV-DET-005). Two wrappers that serialize identically are
 * indistinguishable, so their relative order has no observable effect.
 */
function orderMembers(
  wrappers: readonly CandidateBlock[],
  canonicalBlockId: string,
): readonly DeduplicatedCandidateMember[] {
  interface Ordered {
    readonly candidate: CandidateBlock;
    readonly matchReason: DuplicateMatchReason;
    readonly key: string;
  }

  const ordered: Ordered[] = wrappers.map((candidate) => ({
    candidate,
    matchReason:
      candidate.block.id === canonicalBlockId ? 'same-block-id' : 'same-normalized-content',
    key: canonicalJson(candidate),
  }));

  return ordered
    .sort(
      (a, b) =>
        compareCodeUnits(a.candidate.block.id, b.candidate.block.id) ||
        compareCodeUnits(a.key, b.key),
    )
    .map(({ candidate, matchReason }) => ({ candidate, matchReason }));
}

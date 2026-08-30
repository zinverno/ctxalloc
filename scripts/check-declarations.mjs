#!/usr/bin/env node
// Validates the generated public declaration surface of the workspace packages.
//
// The published contract of a package is its emitted `.d.ts` file, so the build
// output is inspected rather than trusted: the expected declarations must exist,
// the Tokenizer port must keep its documented shape, FakeTokenizer must still
// implement it, and no external library type may appear in the public surface
// (INV-ADAPTER-001).
//
// Run this after `pnpm build`. It never builds and never writes.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The packages whose public surface this check owns. Other packages have no
// public API yet; they are covered when they gain one.
const DECLARATIONS = [
  'packages/ports/dist/index.d.ts',
  'packages/ports/dist/tokenizer.d.ts',
  'packages/testing/dist/index.d.ts',
  'packages/testing/dist/fake-tokenizer.d.ts',
  'packages/tokenization/dist/index.d.ts',
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'packages/application/dist/index.d.ts',
  'packages/application/dist/source-ingestion.d.ts',
  'packages/application/dist/markdown-chunker.d.ts',
  'packages/domain/dist/index.d.ts',
  'packages/domain/dist/candidate-block.d.ts',
  'packages/domain/dist/block-content-hash.d.ts',
  'packages/compiler/dist/index.d.ts',
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
];

// Declarations may reference workspace packages and their own relative files
// only. Anything else means an external type reached the public surface.
const INTERNAL_SCOPE = '@ctxalloc/';

const failures = [];

function fail(message) {
  failures.push(message);
}

function readDeclaration(relativePath) {
  const absolutePath = join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  return readFileSync(absolutePath, 'utf8');
}

const contents = new Map();
for (const relativePath of DECLARATIONS) {
  const content = readDeclaration(relativePath);
  if (content === null) {
    fail(`missing declaration: ${relativePath} (run "pnpm build" first)`);
    continue;
  }
  if (content.trim().length === 0) {
    fail(`empty declaration: ${relativePath}`);
    continue;
  }
  contents.set(relativePath, content);
}

function requireContains(relativePath, expected) {
  const content = contents.get(relativePath);
  if (content === undefined) return;
  if (!content.includes(expected)) {
    fail(`${relativePath} does not declare: ${expected}`);
  }
}

// The Tokenizer port keeps its documented shape.
requireContains('packages/ports/dist/tokenizer.d.ts', 'interface Tokenizer');
requireContains('packages/ports/dist/tokenizer.d.ts', 'readonly id: string;');
requireContains('packages/ports/dist/tokenizer.d.ts', 'readonly version: string;');
requireContains('packages/ports/dist/tokenizer.d.ts', 'countTokens(text: string): number;');
requireContains(
  'packages/ports/dist/index.d.ts',
  "export type { Tokenizer } from './tokenizer.js'",
);

// The fake still implements the port it stands in for.
requireContains(
  'packages/testing/dist/fake-tokenizer.d.ts',
  'class FakeTokenizer implements Tokenizer',
);

// The real adapter implements the port and publishes its stable identity.
requireContains(
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'class O200kBaseTokenizer implements Tokenizer',
);
requireContains(
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'O200K_BASE_TOKENIZER_ID = "js-tiktoken:o200k_base"',
);
requireContains(
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'O200K_BASE_TOKENIZER_VERSION = "1.0.21"',
);
requireContains(
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'O200K_BASE_ENCODING = "o200k_base"',
);
requireContains(
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'countTokens(text: string)',
);
requireContains('packages/tokenization/dist/index.d.ts', "} from './o200k-base-tokenizer.js'");

// The tokenizer library stays behind the adapter: no js-tiktoken type may appear
// in the published tokenization surface (INV-ADAPTER-001). Documentation
// comments are removed first, because they legitimately name the library that the
// adapter wraps; only declared code is inspected. The stable tokenizer id also
// names the library on purpose and is the one accepted occurrence.
function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const TOKENIZER_LIBRARY_TYPES = ['Tiktoken', 'TiktokenBPE', 'TiktokenEncoding', 'TiktokenModel'];

for (const relativePath of [
  'packages/tokenization/dist/index.d.ts',
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of TOKENIZER_LIBRARY_TYPES) {
    if (declarations.includes(type)) {
      fail(`${relativePath} exposes the tokenizer library type "${type}"`);
    }
  }
  if (declarations.replaceAll('"js-tiktoken:o200k_base"', '').includes('js-tiktoken')) {
    fail(`${relativePath} references "js-tiktoken" outside the stable tokenizer identity`);
  }
}

// Source ingestion keeps its documented runtime-boundary signature and its
// project-owned error type.
requireContains(
  'packages/application/dist/source-ingestion.d.ts',
  'declare function ingestSource(input: unknown): IngestedSource;',
);
requireContains(
  'packages/application/dist/source-ingestion.d.ts',
  'declare class SourceIngestionValidationError extends Error',
);
requireContains(
  'packages/application/dist/source-ingestion.d.ts',
  'readonly code = "SOURCE_INGESTION_INVALID_INPUT"',
);
requireContains('packages/application/dist/index.d.ts', "} from './source-ingestion.js'");

// The Markdown chunker keeps its documented constructor, its token policy, and
// its project-owned error types, and exposes no internal scanner type.
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'interface MarkdownChunkingOptions',
);
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'readonly targetTokens: number;',
);
requireContains('packages/application/dist/markdown-chunker.d.ts', 'readonly maxTokens: number;');
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'declare class MarkdownChunkingValidationError extends Error',
);
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'readonly code = "MARKDOWN_CHUNKING_INVALID_INPUT"',
);
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'declare class MarkdownChunkingError extends Error',
);
requireContains('packages/application/dist/markdown-chunker.d.ts', 'declare class MarkdownChunker');
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'constructor(tokenizer: Tokenizer, options: MarkdownChunkingOptions);',
);
requireContains(
  'packages/application/dist/markdown-chunker.d.ts',
  'chunk(source: IngestedSource): readonly ContextBlock[];',
);
requireContains('packages/application/dist/index.d.ts', "} from './markdown-chunker.js'");

// Internal scanner vocabulary stays private to the module (DEC-029).
const CHUNKER_INTERNAL_TYPES = [
  'SourceLine',
  'LogicalBlock',
  'BlockGroup',
  'HeadingInfo',
  'Section',
  'Fence',
  'PieceBoundary',
  'CountSlice',
];

{
  const content = contents.get('packages/application/dist/markdown-chunker.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const type of CHUNKER_INTERNAL_TYPES) {
      if (declarations.includes(type)) {
        fail(`packages/application/dist/markdown-chunker.d.ts exposes the internal type "${type}"`);
      }
    }
    // No Obsidian type may ever reach the public surface (INV-ADAPTER-001).
    for (const type of ['obsidian', 'CachedMetadata', 'HeadingCache', 'TFile', 'Vault']) {
      if (declarations.includes(type)) {
        fail(`packages/application/dist/markdown-chunker.d.ts exposes the Obsidian type "${type}"`);
      }
    }
  }
}

// The validation library and the Node standard library stay implementation
// details of the use case: neither may appear in its published surface
// (INV-ADAPTER-001).
const APPLICATION_LEAKED_TYPES = [
  'zod',
  'ZodType',
  'ZodError',
  'node:crypto',
  'Buffer',
  'BinaryLike',
  'Hash',
];

for (const relativePath of [
  'packages/application/dist/index.d.ts',
  'packages/application/dist/source-ingestion.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of APPLICATION_LEAKED_TYPES) {
    if (declarations.includes(type)) {
      fail(`${relativePath} exposes the implementation type "${type}"`);
    }
  }
}

// The candidate wrapper keeps its documented shape: a complete ContextBlock plus
// optional retrieval data, and no independent candidate identifier (DEC-030).
requireContains('packages/domain/dist/candidate-block.d.ts', 'CANDIDATE_BLOCK_SCHEMA_VERSION = 1');
requireContains('packages/domain/dist/candidate-block.d.ts', 'declare const CandidateBlockSchema');
requireContains('packages/domain/dist/candidate-block.d.ts', 'type CandidateBlock =');
requireContains(
  'packages/domain/dist/candidate-block.d.ts',
  'declare const CandidateRetrievalSchema',
);
requireContains('packages/domain/dist/candidate-block.d.ts', 'type CandidateRetrieval =');
requireContains(
  'packages/domain/dist/candidate-block.d.ts',
  'declare const CandidateRetrievalScoreSchema',
);
requireContains('packages/domain/dist/candidate-block.d.ts', 'type CandidateRetrievalScore =');
requireContains('packages/domain/dist/index.d.ts', "} from './candidate-block.js'");

{
  const content = contents.get('packages/domain/dist/candidate-block.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The wrapper carries the canonical block; it never redeclares block fields
    // and never gains query-dependent scoring or decision data (DEC-026).
    if (!declarations.includes('block')) {
      fail('packages/domain/dist/candidate-block.d.ts does not declare the wrapped block');
    }
    for (const forbidden of [
      'relevanceScore',
      'recencyScore',
      'redundancyScore',
      'utilityScore',
      'finalScore',
      'candidateId',
      'normalizedScore',
      'renderedText',
      'decision',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/domain/dist/candidate-block.d.ts exposes the query-dependent field "${forbidden}"`,
        );
      }
    }
    // The retrieval score exposes project-owned primitives only: no provider SDK
    // type may reach it (INV-ADAPTER-001).
    for (const forbidden of ['Qdrant', 'Qmd', 'QMD', 'Tiktoken', 'SearchResult', 'ScoredPoint']) {
      if (declarations.includes(forbidden)) {
        fail(`packages/domain/dist/candidate-block.d.ts exposes the provider type "${forbidden}"`);
      }
    }
  }
}

// The shared hash helper publishes project-owned values only: no crypto
// implementation type reaches its surface (INV-ADAPTER-001).
requireContains(
  'packages/domain/dist/block-content-hash.d.ts',
  'declare function normalizeContextBlockContentForHash(content: string): string;',
);
requireContains(
  'packages/domain/dist/block-content-hash.d.ts',
  'declare function calculateNormalizedContentHash(content: string): ContentHash;',
);
requireContains('packages/domain/dist/index.d.ts', "} from './block-content-hash.js'");

{
  const content = contents.get('packages/domain/dist/block-content-hash.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // Word-bounded, because `ContentHash` and `calculateNormalizedContentHash`
    // are the project-owned names this module is supposed to publish.
    for (const forbidden of [
      /node:crypto/,
      /createHash/,
      /\bHash\b/,
      /\bBuffer\b/,
      /\bBinaryLike\b/,
      /\bcrypto\b/,
    ]) {
      if (forbidden.test(declarations)) {
        fail(
          `packages/domain/dist/block-content-hash.d.ts exposes the crypto implementation type ${forbidden.source}`,
        );
      }
    }
  }
}

// The candidate validator keeps its documented runtime-boundary signature, its
// project-owned error type, and its project-owned result.
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'declare class CandidateValidator',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'constructor(tokenizer: Tokenizer);',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'validate(input: unknown): ValidatedCandidateSet;',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'declare class CandidateValidationError extends Error',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'readonly code = "CANDIDATE_VALIDATION_FAILED"',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'interface CandidateValidationInput',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'interface ValidatedCandidateSet',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'readonly candidates: readonly CandidateBlock[];',
);
requireContains(
  'packages/compiler/dist/candidate-validator.d.ts',
  'readonly sourceDocuments: readonly SourceDocument[];',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './candidate-validator.js'");

// The candidate deduplicator keeps its documented stage signature: it consumes a
// ValidatedCandidateSet, needs no injected dependency, and returns readonly
// project-owned types (DEC-031).
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'declare class CandidateDeduplicator',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'deduplicate(input: ValidatedCandidateSet): DeduplicatedCandidateSet;',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'type DuplicateMatchReason = ',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'type CanonicalSelectionReason = ',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'interface DeduplicatedCandidateMember',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'readonly candidate: CandidateBlock;',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'readonly matchReason: DuplicateMatchReason;',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'interface DeduplicatedCandidate ',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'readonly canonicalBlock: ContextBlock;',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'readonly canonicalSelectionReason: CanonicalSelectionReason;',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'readonly members: readonly DeduplicatedCandidateMember[];',
);
requireContains(
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'interface DeduplicatedCandidateSet',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './candidate-deduplicator.js'");

{
  const content = contents.get('packages/compiler/dist/candidate-deduplicator.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The stage takes no constructor argument at all: no tokenizer, no policy,
    // no clock, and no provider (INV-DET-003, INV-DEP-002).
    if (/constructor\s*\(/.test(declarations)) {
      fail('packages/compiler/dist/candidate-deduplicator.d.ts declares a constructor dependency');
    }
    // The deduplicated set is an ephemeral compiler-stage result, not a
    // persisted record, so it carries no schema version (INV-STORE-004).
    if (declarations.includes('schemaVersion')) {
      fail('packages/compiler/dist/candidate-deduplicator.d.ts declares a persisted schemaVersion');
    }
    // No near-duplicate, scoring, or policy vocabulary may appear before its
    // phase implements it (INV-DEDUP-004).
    for (const forbidden of [
      'similarity',
      'Similarity',
      'threshold',
      'embedding',
      'Embedding',
      'nearDuplicate',
      'NearDuplicate',
      'CompilationPolicy',
      'CandidateFilter',
      'normalizedScore',
      'finalScore',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/candidate-deduplicator.d.ts exposes the future concept "${forbidden}"`,
        );
      }
    }
  }
}

// The candidate scorer keeps its documented stage signature: it takes one
// versioned policy at construction, consumes a DeduplicatedCandidateSet with an
// explicit reference time, and returns readonly project-owned types (DEC-032).
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'declare class CandidateScorer');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'constructor(policy: unknown);');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'score(input: DeduplicatedCandidateSet, referenceTime: unknown): ScoredCandidateSet;',
);
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'declare class CandidateScoringError extends Error',
);
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly code = "CANDIDATE_SCORING_FAILED"',
);
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'CANDIDATE_SCORING_POLICY_SCHEMA_VERSION = 1',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'interface CandidateScoringPolicy');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'interface RetrievalNormalizationRule',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly ruleId: string;');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly higherIsBetter: boolean;',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'interface ScoredCandidateSet');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly policyId: string;');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly policyVersion: string;');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly referenceTime: Timestamp;',
);
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly candidates: readonly ScoredCandidate[];',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'interface ScoredCandidate ');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly candidate: DeduplicatedCandidate;',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly score: CandidateScore;');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'interface CandidateScore ');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly total: number;');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'type ScoreAggregation = ');
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly contribution: number;');
requireContains(
  'packages/compiler/dist/candidate-scorer.d.ts',
  'readonly normalizedValue: number;',
);
requireContains('packages/compiler/dist/candidate-scorer.d.ts', 'readonly weight: number;');
requireContains('packages/compiler/dist/index.d.ts', "} from './candidate-scorer.js'");

{
  const content = contents.get('packages/compiler/dist/candidate-scorer.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The scored set is an ephemeral compiler-stage result, not a persisted
    // record, so only the policy carries a schema version (INV-STORE-004).
    if (/interface ScoredCandidateSet\s*\{[^}]*schemaVersion/.test(declarations)) {
      fail('packages/compiler/dist/candidate-scorer.d.ts declares a persisted schemaVersion');
    }
    // Time is an explicit argument. No Date instance may reach the surface
    // (INV-DET-004).
    if (/\bDate\b/.test(declarations)) {
      fail('packages/compiler/dist/candidate-scorer.d.ts exposes a Date');
    }
    // Required status is an allocation class, never a number (INV-SCORE-003),
    // and no filtering, allocation, or future relevance vocabulary may appear
    // before its phase implements it.
    for (const forbidden of [
      'requiredScore',
      'requiredBoost',
      'requiredWeight',
      'scorePerToken',
      'minimumScore',
      'minScore',
      'threshold',
      'excluded',
      'included',
      'TokenBudget',
      'tokenBudget',
      'redundancy',
      'Redundancy',
      'nearDuplicate',
      'NearDuplicate',
      'embedding',
      'Embedding',
      'similarity',
      'Similarity',
      'bm25',
      'BM25',
      'CompilationPolicy',
      'CompilationTrace',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/candidate-scorer.d.ts exposes the future or forbidden concept "${forbidden}"`,
        );
      }
    }
  }
}

// The budget allocator keeps its documented stage signature: it takes one
// versioned policy at construction, consumes a ScoredCandidateSet with an
// unknown budget, and returns readonly project-owned data (DEC-033).
requireContains('packages/compiler/dist/budget-allocator.d.ts', 'declare class BudgetAllocator');
requireContains('packages/compiler/dist/budget-allocator.d.ts', 'constructor(policy: unknown);');
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'allocate(input: ScoredCandidateSet, budget: unknown): AllocatedCandidateSet;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'declare class BudgetAllocationError extends Error',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly code = "BUDGET_ALLOCATION_FAILED"',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'BUDGET_ALLOCATION_POLICY_SCHEMA_VERSION = 1',
);
requireContains('packages/compiler/dist/budget-allocator.d.ts', 'interface BudgetAllocationPolicy');
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  "readonly optionalSelection: 'score-desc-greedy';",
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'interface CategoryAllocationConstraint',
);
// Category constraints are block counts in schema version 1, never token quotas.
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly minBlocks?: number | undefined;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly maxBlocks?: number | undefined;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly categoryConstraints?: readonly CategoryAllocationConstraint[] | undefined;',
);
requireContains('packages/compiler/dist/budget-allocator.d.ts', 'interface AllocatedCandidateSet');
// The budget is project-owned, and so is every published metric.
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly tokenBudget: TokenBudget;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly availableInputTokens: number;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly selectedBlockContentTokens: number;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly unallocatedBlockContentTokens: number;',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly included: readonly IncludedCandidateDecision[];',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly excluded: readonly ExcludedCandidateDecision[];',
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'readonly optionalEvictionOrder: readonly ContextBlockId[];',
);
// The decision reason union stays visible: a machine-readable reason is the
// primary contract, not a free-text message (INV-TRACE-002).
requireContains('packages/compiler/dist/budget-allocator.d.ts', 'type AllocationDecisionReason = ');
requireContains('packages/compiler/dist/budget-allocator.d.ts', "'INCLUDED_REQUIRED'");
requireContains('packages/compiler/dist/budget-allocator.d.ts', "'INCLUDED_CATEGORY_MINIMUM'");
requireContains('packages/compiler/dist/budget-allocator.d.ts', "'INCLUDED_SCORE_ORDER'");
requireContains('packages/compiler/dist/budget-allocator.d.ts', "'EXCLUDED_CATEGORY_MAXIMUM'");
requireContains('packages/compiler/dist/budget-allocator.d.ts', "'EXCLUDED_BUDGET_EXHAUSTED'");
// Each decision record is discriminated: an inclusion accepts only INCLUDED_*
// reasons and an exclusion only EXCLUDED_* ones, so the published contract
// cannot express a state the runtime never produces (DEC-033, INV-TRACE-002).
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  "readonly reason: 'INCLUDED_REQUIRED' | 'INCLUDED_CATEGORY_MINIMUM' | 'INCLUDED_SCORE_ORDER';",
);
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  "readonly reason: 'EXCLUDED_CATEGORY_MAXIMUM' | 'EXCLUDED_BUDGET_EXHAUSTED';",
);

{
  const content = contents.get('packages/compiler/dist/budget-allocator.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // Catches a regression that widens either record back to the full union.
    if (declarations.includes('readonly reason: AllocationDecisionReason;')) {
      fail(
        'packages/compiler/dist/budget-allocator.d.ts widens a decision reason back to AllocationDecisionReason',
      );
    }
    for (const [record, forbidden] of [
      ['IncludedCandidateDecision', /'EXCLUDED_/],
      ['ExcludedCandidateDecision', /'INCLUDED_/],
    ]) {
      const start = declarations.indexOf(`interface ${record} `);
      if (start === -1) {
        fail(`packages/compiler/dist/budget-allocator.d.ts does not declare interface ${record}`);
        continue;
      }
      const body = declarations.slice(start, declarations.indexOf('}', start));
      if (forbidden.test(body)) {
        fail(
          `packages/compiler/dist/budget-allocator.d.ts lets ${record} carry a ${forbidden.source} reason`,
        );
      }
    }
  }
}
requireContains(
  'packages/compiler/dist/budget-allocator.d.ts',
  'type BudgetAllocationIssueCode = ',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './budget-allocator.js'");

{
  const content = contents.get('packages/compiler/dist/budget-allocator.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The allocated set is an ephemeral compiler-stage result, not a persisted
    // record, so only the policy carries a schema version (INV-STORE-004).
    if (/interface AllocatedCandidateSet\s*\{[^}]*schemaVersion/.test(declarations)) {
      fail('packages/compiler/dist/budget-allocator.d.ts declares a persisted schemaVersion');
    }
    // Time is carried through, never read. No Date instance may reach the
    // surface (INV-DET-004).
    if (/\bDate\b/.test(declarations)) {
      fail('packages/compiler/dist/budget-allocator.d.ts exposes a Date');
    }
    // Phase 10 allocates block content. It must not publish a final rendered
    // token count, a final unused budget, a fabricated rendering overhead, or
    // any renderer vocabulary: INV-BUDGET-002 belongs to the future renderer and
    // its orchestration loop (DEC-033).
    for (const forbidden of [
      'compiledTokens',
      'unusedTokens',
      'renderingOverheadTokens',
      'renderedTokens',
      'includedContentTokens',
      'compiledContext',
      'renderedContext',
      'sourceLabel',
      'separator',
      'renderingPolicy',
      // Category constraints are counts in schema version 1: no token,
      // percentage, byte, or character quota exists.
      'minTokens',
      'maxTokens',
      'tokenQuota',
      'tokenShare',
      'percentage',
      // Scoring and allocation stay separate responsibilities.
      'scorePerToken',
      'utilityPerToken',
      'knapsack',
      'requiredBoost',
      'requiredScore',
      // No tokenizer, renderer, or trace reaches this stage.
      'Tokenizer',
      'countTokens',
      'CompilationPolicy',
      'CompilationTrace',
      'CompilationResult',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/budget-allocator.d.ts exposes the future or forbidden concept "${forbidden}"`,
        );
      }
    }
  }
}

// The context orderer keeps its documented stage signature: it takes one
// versioned policy at construction, consumes an AllocatedCandidateSet, and
// returns readonly project-owned data (DEC-034).
requireContains('packages/compiler/dist/context-orderer.d.ts', 'declare class ContextOrderer');
requireContains('packages/compiler/dist/context-orderer.d.ts', 'constructor(policy: unknown);');
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'order(input: AllocatedCandidateSet): OrderedCandidateSet;',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'declare class ContextOrderingError extends Error',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'readonly code = "CONTEXT_ORDERING_FAILED"',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'CONTEXT_ORDERING_POLICY_SCHEMA_VERSION = 1',
);
requireContains('packages/compiler/dist/context-orderer.d.ts', 'interface ContextOrderingPolicy');
// The one strategy of schema version 1, spelled exactly.
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  "readonly strategy: 'source-document-then-location';",
);
requireContains('packages/compiler/dist/context-orderer.d.ts', 'interface OrderedCandidateSet');
// The allocation is nested whole, and the ordered sequence is a readonly array
// of the very decision records Phase 10 produced.
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'readonly allocation: AllocatedCandidateSet;',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'readonly orderedIncluded: readonly IncludedCandidateDecision[];',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'readonly orderingPolicyId: string;',
);
requireContains(
  'packages/compiler/dist/context-orderer.d.ts',
  'readonly orderingPolicyVersion: string;',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './context-orderer.js'");

{
  const content = contents.get('packages/compiler/dist/context-orderer.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The ordered set is an ephemeral compiler-stage result, not a persisted
    // record, so only the policy carries a schema version (INV-STORE-004).
    if (/interface OrderedCandidateSet\s*\{[^}]*schemaVersion/.test(declarations)) {
      fail('packages/compiler/dist/context-orderer.d.ts declares a persisted schemaVersion');
    }
    if (/\bDate\b/.test(declarations)) {
      fail('packages/compiler/dist/context-orderer.d.ts exposes a Date');
    }
    // Ordering changes no decision and renders nothing: no allocation,
    // rendering, scoring, or trace vocabulary may reach its surface, and array
    // position stays the whole ordering contract — no index is written onto a
    // block or a decision (DEC-034).
    for (const forbidden of [
      'renderedContext',
      'compiledContext',
      'compiledTokens',
      'renderingOverhead',
      'sourceLabel',
      'separator',
      'renderingPolicy',
      'renderPosition',
      'orderIndex',
      'positionIndex',
      'sortKey',
      'scoreOrder',
      'requiredFirst',
      'CompilationPolicy',
      'CompilationTrace',
      'CompilationResult',
      'Tokenizer',
      'countTokens',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/context-orderer.d.ts exposes the future or forbidden concept "${forbidden}"`,
        );
      }
    }
  }
}

// The validation library, the Node standard library, a provider SDK, an
// application type, and an internal helper all stay implementation details of
// the compiler kernel (INV-ADAPTER-001, INV-DEP-002).
const COMPILER_LEAKED_TYPES = [
  'zod',
  'ZodType',
  'ZodError',
  'node:crypto',
  'Buffer',
  'js-tiktoken',
  'Tiktoken',
  'DomainValidationError',
  'MarkdownChunker',
  'IngestedSource',
  'ingestSource',
  '@ctxalloc/application',
  'Map<',
  'Set<',
  'CountOutcome',
  'IssuePath',
  'canonicalize',
  'canonicalJson',
  'compareCodeUnits',
  'pointerFor',
  'Group',
  // Word-bounded: `OrderedCandidateSet` is a published Phase 11 type, while the
  // bare `Ordered` remains a Phase 8 internal one.
  /\bOrdered\b/,
  'RetrievalEntry',
  'ComponentResult',
  'retrievalContractKey',
  'epochSecondsOf',
  'canonicalNumber',
  'maxNormalized',
  'candidatePath',
  'categoryPath',
  'AllocationCandidate',
  'AllocationState',
  'compareNumbers',
  'compareRequired',
  'compareMinimumCost',
  'compareScoreOrder',
  'compareEviction',
  'reconcile',
  'viewOf',
  'compareBlocks',
  'compareLocation',
  'LOCATION_KIND_RANK',
];

for (const relativePath of [
  'packages/compiler/dist/index.d.ts',
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of COMPILER_LEAKED_TYPES) {
    const leaked = type instanceof RegExp ? type.test(declarations) : declarations.includes(type);
    if (leaked) {
      fail(
        `${relativePath} exposes the implementation type "${type instanceof RegExp ? type.source : type}"`,
      );
    }
  }
  // No later compiler stage may appear before its phase implements it.
  // `Deduplicator` left this list in Phase 8, `Scorer` in Phase 9,
  // `BudgetAllocator` in Phase 10, and `ContextOrderer` in Phase 11, when each
  // became a published stage (DEC-031, DEC-032, DEC-033, DEC-034). Each is
  // therefore checked by name only where it must not appear.
  for (const stage of [
    'CandidateFilter',
    'ContextRenderer',
    'TraceBuilder',
    'ContextCompiler',
    'CandidateProvider',
  ]) {
    if (declarations.includes(stage)) {
      fail(`${relativePath} declares the unimplemented stage "${stage}"`);
    }
  }
}

// No external library type reaches a public declaration.
//
// `@ctxalloc/domain` is the one documented exception: its runtime-validated
// schemas *are* its published contract, so a schema declaration necessarily names
// the validation library's types (MVP_SCOPE 3.1). The allowance is narrow — `zod`
// and nothing else — and it does not extend to any consumer: every other package
// must keep the library behind its own boundary (INV-ADAPTER-001).
const DOMAIN_DECLARATION_PREFIX = 'packages/domain/dist/';

for (const [relativePath, content] of contents) {
  const isDomain = relativePath.startsWith(DOMAIN_DECLARATION_PREFIX);
  const specifiers = [...content.matchAll(/from ["'](?<from>[^"']+)["']/g)]
    .map((match) => match.groups?.from ?? '')
    .filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'));
  for (const specifier of specifiers) {
    if (specifier.startsWith(INTERNAL_SCOPE)) continue;
    if (isDomain && specifier === 'zod') continue;
    fail(`${relativePath} exposes an external type from "${specifier}"`);
  }
}

if (failures.length > 0) {
  console.error('Declaration check failed:\n');
  for (const failure of failures.sort()) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Declaration check passed: ${contents.size} declarations validated.`);

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
  'Ordered',
];

for (const relativePath of [
  'packages/compiler/dist/index.d.ts',
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of COMPILER_LEAKED_TYPES) {
    if (declarations.includes(type)) {
      fail(`${relativePath} exposes the implementation type "${type}"`);
    }
  }
  // No later compiler stage may appear before its phase implements it.
  // `Deduplicator` left this list in Phase 8, when `CandidateDeduplicator`
  // became a published stage (DEC-031).
  for (const stage of [
    'CandidateFilter',
    'CandidateScorer',
    'BudgetAllocator',
    'ContextOrderer',
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

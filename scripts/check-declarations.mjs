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
  'packages/ports/dist/source-reader.d.ts',
  'packages/ports/dist/control-store.d.ts',
  'packages/ports/dist/candidate-provider.d.ts',
  'packages/testing/dist/index.d.ts',
  'packages/testing/dist/fake-tokenizer.d.ts',
  'packages/testing/dist/in-memory-source-reader.d.ts',
  'packages/testing/dist/in-memory-control-store.d.ts',
  'packages/testing/dist/fake-candidate-provider.d.ts',
  'packages/tokenization/dist/index.d.ts',
  'packages/tokenization/dist/o200k-base-tokenizer.d.ts',
  'packages/application/dist/index.d.ts',
  'packages/application/dist/source-ingestion.d.ts',
  'packages/application/dist/markdown-chunker.d.ts',
  'packages/application/dist/text-chunker.d.ts',
  'packages/application/dist/conversation-source.d.ts',
  'packages/application/dist/conversation-chunker.d.ts',
  'packages/application/dist/compile-local-context-service.d.ts',
  'packages/adapters/dist/index.d.ts',
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'packages/domain/dist/index.d.ts',
  'packages/domain/dist/candidate-block.d.ts',
  'packages/domain/dist/block-content-hash.d.ts',
  'packages/compiler/dist/index.d.ts',
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
  'packages/compiler/dist/context-renderer.d.ts',
  'packages/compiler/dist/candidate-filter.d.ts',
  'packages/compiler/dist/compilation-policy.d.ts',
  'packages/compiler/dist/compilation-request.d.ts',
  'packages/compiler/dist/compilation-trace.d.ts',
  'packages/compiler/dist/request-fingerprint.d.ts',
  'packages/compiler/dist/compilation-id.d.ts',
  'packages/compiler/dist/context-compiler.d.ts',
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

// The three ports added by the local vertical slice keep their documented shapes
// (DEC-039). A port is a type-only contract, so the entry point must re-export
// them as types and declare no runtime value of its own.
requireContains('packages/ports/dist/source-reader.d.ts', 'interface SourceReadRequest');
requireContains('packages/ports/dist/source-reader.d.ts', 'readonly locator: string;');
requireContains('packages/ports/dist/source-reader.d.ts', 'interface SourceReadResult');
requireContains('packages/ports/dist/source-reader.d.ts', 'readonly content: string;');
requireContains('packages/ports/dist/source-reader.d.ts', 'interface SourceReader');
requireContains(
  'packages/ports/dist/source-reader.d.ts',
  'read(request: SourceReadRequest): Promise<SourceReadResult>;',
);

requireContains('packages/ports/dist/control-store.d.ts', 'interface SourceRegistration');
requireContains('packages/ports/dist/control-store.d.ts', 'readonly schemaVersion: 1;');
requireContains('packages/ports/dist/control-store.d.ts', 'readonly identity: {');
requireContains('packages/ports/dist/control-store.d.ts', 'readonly namespace: string;');
requireContains('packages/ports/dist/control-store.d.ts', 'readonly key: string;');
requireContains('packages/ports/dist/control-store.d.ts', 'readonly locator: string;');
requireContains('packages/ports/dist/control-store.d.ts', 'interface ControlStore');
requireContains(
  'packages/ports/dist/control-store.d.ts',
  'listSources(scope: Scope): Promise<readonly SourceRegistration[]>;',
);

requireContains(
  'packages/ports/dist/candidate-provider.d.ts',
  'interface CandidateProviderRequest',
);
requireContains(
  'packages/ports/dist/candidate-provider.d.ts',
  'readonly sourceDocuments: readonly SourceDocument[];',
);
requireContains(
  'packages/ports/dist/candidate-provider.d.ts',
  'readonly blocks: readonly ContextBlock[];',
);
requireContains(
  'packages/ports/dist/candidate-provider.d.ts',
  'getCandidates(request: CandidateProviderRequest): Promise<readonly CandidateBlock[]>;',
);

requireContains(
  'packages/ports/dist/index.d.ts',
  "export type { CandidateProvider, CandidateProviderRequest } from './candidate-provider.js'",
);
requireContains(
  'packages/ports/dist/index.d.ts',
  "export type { ControlStore, SourceRegistration } from './control-store.js'",
);
requireContains(
  'packages/ports/dist/index.d.ts',
  "export type { SourceReadRequest, SourceReadResult, SourceReader } from './source-reader.js'",
);

// The control store stays read-only in this phase, and no port may name an
// external system, a Node type, or a compiler policy type (INV-ADAPTER-001).
const PORT_DECLARATIONS = [
  'packages/ports/dist/index.d.ts',
  'packages/ports/dist/tokenizer.d.ts',
  'packages/ports/dist/source-reader.d.ts',
  'packages/ports/dist/control-store.d.ts',
  'packages/ports/dist/candidate-provider.d.ts',
];

const PORT_FORBIDDEN_TYPES = [
  'Buffer',
  'Stats',
  'Dirent',
  'PathLike',
  'node:',
  'Tiktoken',
  'ZodType',
  'CompilationPolicy',
  'CompilationRequest',
  'TokenBudget',
];

for (const relativePath of PORT_DECLARATIONS) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of PORT_FORBIDDEN_TYPES) {
    if (declarations.includes(type)) {
      fail(`${relativePath} exposes the forbidden type "${type}"`);
    }
  }
  // A port carries no behavior, so no runtime declaration may appear.
  if (/declare (const|function|class|enum|let|var) /.test(declarations)) {
    fail(`${relativePath} declares a runtime value`);
  }
}

{
  const content = contents.get('packages/ports/dist/control-store.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const write of ['registerSource', 'updateSource', 'removeSource', 'deleteSource']) {
      if (declarations.includes(write)) {
        fail(`packages/ports/dist/control-store.d.ts declares the write method "${write}"`);
      }
    }
  }
}

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

// The plain-text chunker keeps its documented constructor, its own token policy,
// and its own project-owned error types (DEC-039).
requireContains('packages/application/dist/text-chunker.d.ts', 'interface TextChunkingOptions');
requireContains('packages/application/dist/text-chunker.d.ts', 'readonly targetTokens: number;');
requireContains('packages/application/dist/text-chunker.d.ts', 'readonly maxTokens: number;');
requireContains(
  'packages/application/dist/text-chunker.d.ts',
  'declare class TextChunkingValidationError extends Error',
);
requireContains(
  'packages/application/dist/text-chunker.d.ts',
  'readonly code = "TEXT_CHUNKING_INVALID_INPUT"',
);
requireContains(
  'packages/application/dist/text-chunker.d.ts',
  'declare class TextChunkingError extends Error',
);
requireContains('packages/application/dist/text-chunker.d.ts', 'declare class TextChunker');
requireContains(
  'packages/application/dist/text-chunker.d.ts',
  'constructor(tokenizer: Tokenizer, options: TextChunkingOptions);',
);
requireContains(
  'packages/application/dist/text-chunker.d.ts',
  'chunk(source: IngestedSource): readonly ContextBlock[];',
);
requireContains('packages/application/dist/index.d.ts', "} from './text-chunker.js'");

// The conversation format publishes its schema version, its message and payload
// contracts, its ingestion use case, and its project-owned error (DEC-039).
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'CONVERSATION_SOURCE_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'interface ConversationSourceMessage',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'interface ConversationSourcePayload',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'interface IngestedConversationSource',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'declare class ConversationSourceValidationError extends Error',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'readonly code = "CONVERSATION_SOURCE_INVALID_INPUT"',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'declare function ingestConversationSource(input: unknown): IngestedConversationSource;',
);
requireContains(
  'packages/application/dist/conversation-source.d.ts',
  'declare function parseConversationSourceJson(text: unknown): ConversationSourcePayload;',
);
requireContains('packages/application/dist/index.d.ts', "} from './conversation-source.js'");

// The conversation format of version 1 declares no role, tool call, attachment,
// multimodal part, or thread field: the renderer serializes block content and
// nothing else, so a field the pipeline does not render must not be published.
{
  const content = contents.get('packages/application/dist/conversation-source.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const field of ['role', 'toolCall', 'attachment', 'threadId', 'multimodal']) {
      if (declarations.includes(field)) {
        fail(`packages/application/dist/conversation-source.d.ts declares "${field}"`);
      }
    }
  }
}

// The conversation chunker keeps its documented constructor and error types. It
// takes no token policy: one message is one block, so there is no size decision
// for a policy to configure (DEC-039).
requireContains(
  'packages/application/dist/conversation-chunker.d.ts',
  'declare class ConversationChunker',
);
requireContains(
  'packages/application/dist/conversation-chunker.d.ts',
  'constructor(tokenizer: Tokenizer);',
);
requireContains(
  'packages/application/dist/conversation-chunker.d.ts',
  'chunk(source: IngestedConversationSource): readonly ContextBlock[];',
);
requireContains(
  'packages/application/dist/conversation-chunker.d.ts',
  'declare class ConversationChunkingValidationError extends Error',
);
requireContains(
  'packages/application/dist/conversation-chunker.d.ts',
  'declare class ConversationChunkingError extends Error',
);
requireContains('packages/application/dist/index.d.ts', "} from './conversation-chunker.js'");

// The local application service keeps its documented runtime-boundary
// constructor and its documented asynchronous result (DEC-039).
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'LOCAL_COMPILE_SERVICE_CONFIG_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'LOCAL_COMPILATION_REQUEST_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'interface LocalCompileServiceConfig',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'interface LocalCompilationRequest',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'interface LocalCompilationResult',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'readonly compilation: CompilationResult;',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'declare class LocalSourcePipelineError extends Error',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'readonly code = "LOCAL_SOURCE_PIPELINE_FAILED"',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'declare class CompileLocalContextService',
);
requireContains(
  'packages/application/dist/compile-local-context-service.d.ts',
  'execute(input: unknown): Promise<LocalCompilationResult>;',
);
requireContains(
  'packages/application/dist/index.d.ts',
  "} from './compile-local-context-service.js'",
);

// The service takes one tokenizer and three ports, and constructs the compiler
// itself: it must not accept a pre-built ContextCompiler beside a second
// tokenizer, which is what makes validation-and-rendering coverage provable.
{
  const content = contents.get('packages/application/dist/compile-local-context-service.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    const constructorSignature =
      /constructor\(config: unknown, tokenizer: Tokenizer, sourceReader: SourceReader, controlStore: ControlStore, candidateProvider: CandidateProvider\);/;
    if (!constructorSignature.test(declarations.replace(/\s+/g, ' '))) {
      fail(
        'packages/application/dist/compile-local-context-service.d.ts does not declare the documented constructor',
      );
    }
    if (/constructor\([^)]*compiler: ContextCompiler/.test(declarations.replace(/\s+/g, ' '))) {
      fail(
        'packages/application/dist/compile-local-context-service.d.ts accepts a pre-built ContextCompiler',
      );
    }
  }
}

// Internal chunking primitives stay private to the package (DEC-029, DEC-039).
const CHUNKING_PRIMITIVE_TYPES = [
  'SourceLine',
  'SourceRange',
  'AtomicSourceRange',
  'RangeGroup',
  'CountSlice',
  'ChunkingOptions',
  'TokenizerFailure',
];

for (const relativePath of [
  'packages/application/dist/index.d.ts',
  'packages/application/dist/text-chunker.d.ts',
  'packages/application/dist/conversation-chunker.d.ts',
  'packages/application/dist/compile-local-context-service.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of CHUNKING_PRIMITIVE_TYPES) {
    // Matched on a word boundary: `TextChunkingOptions` legitimately contains
    // `ChunkingOptions`, and a substring match would flag the public name.
    if (new RegExp(`\\b${type}\\b`).test(declarations)) {
      fail(`${relativePath} exposes the internal type "${type}"`);
    }
  }
}

// The local file reader keeps its documented configuration and its
// project-owned error, and leaks no Node type (INV-ADAPTER-001).
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'class NodeFileSourceReader implements SourceReader',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'interface NodeFileSourceReaderConfig',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'readonly rootDirectory: string;',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'readonly maxBytes: number;',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'declare class NodeFileSourceReaderError extends Error',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'read(request: SourceReadRequest): Promise<SourceReadResult>;',
);
requireContains(
  'packages/adapters/dist/node-file-source-reader.d.ts',
  'NODE_FILE_SOURCE_READER_ID = "ctxalloc-node-file"',
);
requireContains('packages/adapters/dist/index.d.ts', "} from './node-file-source-reader.js'");

const ADAPTER_LEAKED_TYPES = [
  'Buffer',
  'Stats',
  'BigIntStats',
  'Dirent',
  'PathLike',
  'FileHandle',
  'ErrnoException',
  'TextDecoder',
  'node:fs',
  'node:path',
];

for (const relativePath of [
  'packages/adapters/dist/index.d.ts',
  'packages/adapters/dist/node-file-source-reader.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of ADAPTER_LEAKED_TYPES) {
    if (declarations.includes(type)) {
      fail(`${relativePath} exposes the implementation type "${type}"`);
    }
  }
  if (declarations.includes('@ctxalloc/compiler')) {
    fail(`${relativePath} depends on the compiler kernel`);
  }
}

// The three new test doubles still implement the ports they stand in for.
requireContains(
  'packages/testing/dist/in-memory-source-reader.d.ts',
  'class InMemorySourceReader implements SourceReader',
);
requireContains(
  'packages/testing/dist/in-memory-control-store.d.ts',
  'class InMemoryControlStore implements ControlStore',
);
requireContains(
  'packages/testing/dist/fake-candidate-provider.d.ts',
  'class FakeCandidateProvider implements CandidateProvider',
);
requireContains('packages/testing/dist/index.d.ts', "} from './in-memory-source-reader.js'");
requireContains('packages/testing/dist/index.d.ts', "} from './in-memory-control-store.js'");
requireContains('packages/testing/dist/index.d.ts', "} from './fake-candidate-provider.js'");

// No test double may declare a model provider or a trace store: neither port
// exists yet, and publishing a fake for one would invite a test to depend on a
// contract nothing implements.
{
  const content = contents.get('packages/testing/dist/index.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const absent of ['FakeModelProvider', 'InMemoryTraceStore', 'ModelProvider']) {
      if (declarations.includes(absent)) {
        fail(`packages/testing/dist/index.d.ts declares "${absent}"`);
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
  'packages/application/dist/text-chunker.d.ts',
  'packages/application/dist/conversation-source.d.ts',
  'packages/application/dist/conversation-chunker.d.ts',
  'packages/application/dist/compile-local-context-service.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  const declarations = stripComments(content);
  for (const type of [...APPLICATION_LEAKED_TYPES, 'node:fs', 'node:path', 'PathLike']) {
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

// The context renderer keeps its documented stage signature: it takes one
// versioned policy and one project-owned Tokenizer at construction, consumes an
// OrderedCandidateSet, and returns one exact measurement of one selection
// (DEC-035).
requireContains('packages/compiler/dist/context-renderer.d.ts', 'declare class ContextRenderer');
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'constructor(policy: unknown, tokenizer: Tokenizer);',
);
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'render(input: OrderedCandidateSet): RenderedContextAttempt;',
);
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'declare class ContextRenderingError extends Error',
);
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'readonly code = "CONTEXT_RENDERING_FAILED"',
);
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'CONTEXT_RENDERING_POLICY_SCHEMA_VERSION = 1',
);
// The renderer publishes a stable project-owned identity for a future trace.
requireContains(
  'packages/compiler/dist/context-renderer.d.ts',
  'CONTEXT_RENDERER_ID = "ctxalloc-jsonl"',
);
requireContains('packages/compiler/dist/context-renderer.d.ts', 'CONTEXT_RENDERER_VERSION = "1"');
requireContains('packages/compiler/dist/context-renderer.d.ts', 'interface ContextRenderingPolicy');
// The one format of schema version 1, spelled exactly.
requireContains('packages/compiler/dist/context-renderer.d.ts', "readonly format: 'jsonl-blocks';");
requireContains('packages/compiler/dist/context-renderer.d.ts', 'interface RenderedContextAttempt');
// The ordered set is nested whole and read-only, and the measurement publishes
// the exact string, its count, the signed delta, and the observation.
for (const member of [
  'readonly ordered: OrderedCandidateSet;',
  'readonly renderingPolicyId: string;',
  'readonly renderingPolicyVersion: string;',
  'readonly rendererId: string;',
  'readonly rendererVersion: string;',
  'readonly tokenizerId: string;',
  'readonly tokenizerVersion: string;',
  'readonly renderedContext: string;',
  'readonly renderedTokens: number;',
  'readonly fitsAvailableInputBudget: boolean;',
]) {
  requireContains('packages/compiler/dist/context-renderer.d.ts', member);
}
requireContains('packages/compiler/dist/index.d.ts', "} from './context-renderer.js'");

{
  const content = contents.get('packages/compiler/dist/context-renderer.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The render attempt is an ephemeral compiler-stage result, not a persisted
    // record, so only the policy carries a schema version (INV-STORE-004).
    if (/interface RenderedContextAttempt\s*\{[^}]*schemaVersion/.test(declarations)) {
      fail('packages/compiler/dist/context-renderer.d.ts declares a persisted schemaVersion');
    }
    if (/\bDate\b/.test(declarations)) {
      fail('packages/compiler/dist/context-renderer.d.ts exposes a Date');
    }
    // A render attempt is not a compilation. Final metrics belong to the future
    // orchestration loop, and the invalid non-negative "overhead" metric is gone
    // for good (DEC-035, METRICS 8.6).
    //
    // `renderedTokenDelta` is forbidden for a different reason: subtracting
    // `selectedBlockContentTokens` from a rendered count is only meaningful when
    // one tokenizer identity produced both, and no stage contract reaching this
    // stage carries a tokenizer identity to prove it. The field may return only
    // once cross-stage identity is available (DEC-035).
    for (const forbidden of [
      'renderedTokenDelta',
      'compiledTokens',
      'unusedTokens',
      'renderingOverheadTokens',
      'renderingTokenDelta',
      'includedContentTokens',
      'tokenReduction',
      'budgetUtilization',
      'REQUIRED_CONTENT_EXCEEDS_BUDGET',
      'CompilationPolicy',
      'CompilationRequest',
      'CompilationTrace',
      'CompilationResult',
      'CandidateFilter',
      'TraceBuilder',
      'ContextCompiler',
      // The renderer depends on the port, never on a tokenizer implementation.
      'O200kBaseTokenizer',
      'FakeTokenizer',
      'Tiktoken',
      'js-tiktoken',
      // Serialization internals stay internal.
      'RenderedBlockRecord',
      'canonicalJson',
      'recordOf',
      'RECORD_SEPARATOR',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/context-renderer.d.ts exposes the future or forbidden concept "${forbidden}"`,
        );
      }
    }
    // The one tokenizer type it may name is the project-owned port.
    if (!/import type \{ Tokenizer \} from ['"]@ctxalloc\/ports['"]/.test(declarations)) {
      fail('packages/compiler/dist/context-renderer.d.ts does not import the Tokenizer port');
    }
  }
}

// The candidate filter keeps its documented stage signature: it takes one narrow
// versioned policy at construction, consumes a ScoredCandidateSet, and returns
// one eligibility decision per scored candidate (DEC-036).
requireContains('packages/compiler/dist/candidate-filter.d.ts', 'declare class CandidateFilter');
requireContains('packages/compiler/dist/candidate-filter.d.ts', 'constructor(policy: unknown);');
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'filter(input: ScoredCandidateSet): FilteredCandidateSet;',
);
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'declare class CandidateFilteringError extends Error',
);
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'readonly code = "CANDIDATE_FILTERING_FAILED"',
);
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'CANDIDATE_FILTERING_POLICY_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'interface CandidateFilteringPolicy',
);
// The complete v1 filtering language: an identity and one optional threshold.
requireContains(
  'packages/compiler/dist/candidate-filter.d.ts',
  'readonly minimumTotalScore?: number | undefined;',
);
requireContains('packages/compiler/dist/candidate-filter.d.ts', 'interface FilteredCandidateSet');
for (const member of [
  'readonly scored: ScoredCandidateSet;',
  'readonly filteringPolicyId: string;',
  'readonly filteringPolicyVersion: string;',
  'readonly eligible: ScoredCandidateSet;',
  'readonly decisions: readonly CandidateFilteringDecision[];',
]) {
  requireContains('packages/compiler/dist/candidate-filter.d.ts', member);
}
requireContains('packages/compiler/dist/index.d.ts', "} from './candidate-filter.js'");

{
  const content = contents.get('packages/compiler/dist/candidate-filter.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The filtered set is an ephemeral compiler-stage result, not a persisted
    // record, so only the policy carries a schema version (INV-STORE-004).
    if (/interface FilteredCandidateSet\s*\{[^}]*schemaVersion/.test(declarations)) {
      fail('packages/compiler/dist/candidate-filter.d.ts declares a persisted schemaVersion');
    }
    // Each decision is discriminated on its own decision and reason pair, so an
    // impossible combination cannot be constructed (INV-TRACE-002).
    for (const decision of [
      "readonly decision: 'eligible';",
      "readonly decision: 'filtered';",
      "readonly reason: 'ELIGIBLE_REQUIRED';",
      "readonly reason: 'ELIGIBLE_POLICY';",
      "readonly reason: 'FILTERED_SCORE_BELOW_MINIMUM';",
      'type CandidateFilteringDecision = RequiredEligibleCandidateDecision | PolicyEligibleCandidateDecision | FilteredCandidateDecision',
    ]) {
      requireContains('packages/compiler/dist/candidate-filter.d.ts', decision);
    }
    // A single reason union would let any reason pair with any decision.
    if (
      /interface \w*CandidateDecision\s*\{[^}]*reason: CandidateFilteringDecisionReason/.test(
        declarations,
      )
    ) {
      fail(
        'packages/compiler/dist/candidate-filter.d.ts widens a decision reason to the whole union',
      );
    }
    // The v1 filtering language is a threshold and nothing else: every deferred
    // hard-exclusion concept stays absent, and so does every signal the filter
    // must not read (DEC-036).
    for (const forbidden of [
      'excludedBlockIds',
      'allowedSourceDocumentIds',
      'deniedSourceDocumentIds',
      'allowedCategories',
      'deniedCategories',
      'sourceType',
      'maxAgeSeconds',
      'minimumRank',
      'providerId',
      'maxTokens',
      'tokenCount',
      'pattern',
      'predicate',
      'TokenBudget',
      'availableInputTokens',
      'referenceTime',
      'Timestamp',
      'query',
      'Tokenizer',
      'Date',
      'CompilationPolicy',
      'CompilationRequest',
      'CompilationTrace',
      'CompilationResult',
      'TraceBuilder',
      'ContextCompiler',
      'ContextRenderer',
      'BudgetAllocator',
      'AllocatedCandidateSet',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/candidate-filter.d.ts exposes the forbidden or future concept "${forbidden}"`,
        );
      }
    }
  }
}

// The broad compilation policy composes exactly the five narrow slices and holds
// no component instance (DEC-036).
requireContains('packages/compiler/dist/compilation-policy.d.ts', 'interface CompilationPolicy');
requireContains(
  'packages/compiler/dist/compilation-policy.d.ts',
  'COMPILATION_POLICY_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/compiler/dist/compilation-policy.d.ts',
  'declare class CompilationPolicyValidator',
);
requireContains(
  'packages/compiler/dist/compilation-policy.d.ts',
  'validate(input: unknown): CompilationPolicy;',
);
requireContains(
  'packages/compiler/dist/compilation-policy.d.ts',
  'declare class CompilationPolicyError extends Error',
);
requireContains(
  'packages/compiler/dist/compilation-policy.d.ts',
  'readonly code = "COMPILATION_POLICY_INVALID"',
);
for (const slice of [
  'readonly scoring: CandidateScoringPolicy;',
  'readonly filtering: CandidateFilteringPolicy;',
  'readonly allocation: BudgetAllocationPolicy;',
  'readonly ordering: ContextOrderingPolicy;',
  'readonly rendering: ContextRenderingPolicy;',
]) {
  requireContains('packages/compiler/dist/compilation-policy.d.ts', slice);
}
requireContains('packages/compiler/dist/index.d.ts', "} from './compilation-policy.js'");

{
  const content = contents.get('packages/compiler/dist/compilation-policy.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // Every slice is required in schema version 1: none may be optional.
    for (const slice of ['scoring', 'filtering', 'allocation', 'ordering', 'rendering']) {
      if (declarations.includes(`readonly ${slice}?:`)) {
        fail(`packages/compiler/dist/compilation-policy.d.ts makes the ${slice} slice optional`);
      }
    }
    // The policy is data, not orchestration: it stores no component instance and
    // owns no tokenizer.
    for (const forbidden of [
      'CandidateScorer',
      'CandidateFilter;',
      'BudgetAllocator',
      'ContextOrderer',
      'ContextRenderer',
      'Tokenizer',
      'ContextCompiler',
      'TraceBuilder',
      'CompilationTrace',
      'CompilationResult',
      'fingerprint',
      'Fingerprint',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/compilation-policy.d.ts exposes the forbidden or future concept "${forbidden}"`,
        );
      }
    }
  }
}

// The compilation request carries every value a deterministic compilation needs,
// with an explicit reference time and no generated identity (DEC-036).
requireContains('packages/compiler/dist/compilation-request.d.ts', 'interface CompilationRequest');
requireContains(
  'packages/compiler/dist/compilation-request.d.ts',
  'COMPILATION_REQUEST_SCHEMA_VERSION = 1',
);
requireContains(
  'packages/compiler/dist/compilation-request.d.ts',
  'declare class CompilationRequestValidator',
);
requireContains(
  'packages/compiler/dist/compilation-request.d.ts',
  'validate(input: unknown): CompilationRequest;',
);
requireContains(
  'packages/compiler/dist/compilation-request.d.ts',
  'declare class CompilationRequestError extends Error',
);
requireContains(
  'packages/compiler/dist/compilation-request.d.ts',
  'readonly code = "COMPILATION_REQUEST_INVALID"',
);
for (const member of [
  'readonly id: string;',
  'readonly scope: Scope;',
  'readonly query: string;',
  'readonly referenceTime: Timestamp;',
  'readonly candidates: readonly CandidateBlock[];',
  'readonly sourceDocuments: readonly SourceDocument[];',
  'readonly budget: TokenBudget;',
  'readonly policy: CompilationPolicy;',
]) {
  requireContains('packages/compiler/dist/compilation-request.d.ts', member);
}
requireContains('packages/compiler/dist/index.d.ts', "} from './compilation-request.js'");

{
  const content = contents.get('packages/compiler/dist/compilation-request.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // The reference time is required: INV-DET-004 forbids a hidden clock, and an
    // optional field would invite one to be defaulted downstream.
    if (declarations.includes('readonly referenceTime?:')) {
      fail('packages/compiler/dist/compilation-request.d.ts makes referenceTime optional');
    }
    if (/\bDate\b/.test(declarations)) {
      fail('packages/compiler/dist/compilation-request.d.ts exposes a Date');
    }
    // Nothing a later phase owns appears on the request.
    for (const forbidden of [
      'fingerprint',
      'Fingerprint',
      'compilationId',
      'CompilationTrace',
      'CompilationResult',
      'TraceBuilder',
      'ContextCompiler',
      'warnings',
      'Tokenizer',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/compilation-request.d.ts exposes the forbidden or future concept "${forbidden}"`,
        );
      }
    }
  }
}

// The compilation trace is a versioned, privacy-minimized, serializable snapshot
// that no stage decision depends on (DEC-037).
requireContains('packages/compiler/dist/compilation-trace.d.ts', 'interface CompilationTrace');
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'COMPILATION_TRACE_SCHEMA_VERSION = 2',
);
requireContains('packages/compiler/dist/compilation-trace.d.ts', 'declare class TraceBuilder');
requireContains('packages/compiler/dist/compilation-trace.d.ts', 'constructor(config: unknown);');
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'build(input: CompilationTraceBuildInput): UnsettledCompilationTrace;',
);
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'declare class CompilationTraceError extends Error',
);
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'readonly code = "COMPILATION_TRACE_BUILD_FAILED"',
);
requireContains('packages/compiler/dist/compilation-trace.d.ts', 'interface TraceBuilderConfig');
requireContains('packages/compiler/dist/compilation-trace.d.ts', 'readonly compilerId: string;');
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'readonly compilerVersion: string;',
);
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'interface CompilationTraceBuildInput',
);
for (const member of [
  'readonly request: CompilationRequest;',
  'readonly validated: ValidatedCandidateSet;',
  'readonly deduplicated: DeduplicatedCandidateSet;',
  'readonly filtered: FilteredCandidateSet;',
  'readonly rendered: RenderedContextAttempt;',
]) {
  requireContains('packages/compiler/dist/compilation-trace.d.ts', member);
}
// The schema version is the exact literal 2, and the two variants are
// discriminated on `settled`: an unsettled trace can carry no settlement and no
// compilation identity, and a settled one requires both (DEC-038).
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'readonly schemaVersion: typeof COMPILATION_TRACE_SCHEMA_VERSION;',
);
for (const member of [
  'interface CompilationTraceBase',
  'interface UnsettledCompilationTrace extends CompilationTraceBase',
  'readonly settled: false;',
  'readonly compilationId?: never;',
  'readonly settlement?: never;',
  'interface SettledCompilationTrace extends CompilationTraceBase',
  'readonly settled: true;',
  'readonly compilationId: CompilationId;',
  'readonly settlement: CompilationTraceSettlement;',
  'type CompilationTrace = UnsettledCompilationTrace | SettledCompilationTrace',
  'interface UnsettledCompilationTraceComposition extends CompilationTraceComposition',
  "readonly tokenizerCoverage: 'rendering-attempt-only';",
  'interface SettledCompilationTraceComposition extends CompilationTraceComposition',
  "readonly tokenizerCoverage: 'validation-and-rendering';",
]) {
  requireContains('packages/compiler/dist/compilation-trace.d.ts', member);
}

// The settlement is the only place a settled token quantity may appear.
for (const member of [
  'interface CompilationTraceSettlement',
  "readonly strategy: 'render-aware-v1';",
  'readonly correctionApplied: boolean;',
  'readonly initialRenderedTokens: number;',
  'readonly evictedBlockIds: readonly ContextBlockId[];',
  'readonly fallbackSearch: CompilationTraceFallbackSearch;',
  'readonly decisions: readonly CompilationTraceFinalDecision[];',
  'interface CompilationTraceFallbackSearch',
  'readonly selectionsVisited: number;',
  'readonly maxSelections: number;',
  'readonly phase?: CompilationTraceFallbackPhase;',
  'readonly chosenBlockIds?: readonly ContextBlockId[];',
  "type CompilationTraceFallbackPhase = 'hard-base' | 'policy-selection-rescue'",
  // The rescue claims its own inclusions rather than attributing them to a rule
  // it did not apply (DEC-038).
  "'INCLUDED_RENDER_AWARE_CORRECTION'",
  'interface CompilationTraceSettlementRendering',
  'readonly renderedContextHash: string;',
  'readonly compiledTokens: number;',
  'interface CompilationTraceSettlementUsage',
  'readonly unusedTokens: number;',
  'readonly renderingTokenDelta: number;',
  'type CompilationTraceFinalDecision',
  "reason: 'FILTERED_POLICY'",
  "reason: 'EXCLUDED_INITIAL_ALLOCATION' | 'EXCLUDED_RENDER_AWARE_CORRECTION'",
  'readonly renderPosition: number;',
]) {
  requireContains('packages/compiler/dist/compilation-trace.d.ts', member);
}

// A settled token quantity never leaks into the attempt or the snapshot totals,
// where it would read as a final metric it is not (METRICS 8.4, 8.6, 8.10).
{
  const content = contents.get('packages/compiler/dist/compilation-trace.d.ts');
  if (content !== undefined) {
    for (const [interfaceName, forbidden] of [
      ['CompilationTraceRendering', ['compiledTokens', 'unusedTokens', 'renderingTokenDelta']],
      ['CompilationTraceTotals', ['compiledTokens', 'unusedTokens', 'renderingTokenDelta']],
    ]) {
      const start = content.indexOf(`interface ${interfaceName} {`);
      if (start === -1) {
        fail(`packages/compiler/dist/compilation-trace.d.ts does not declare ${interfaceName}`);
        continue;
      }
      const body = content.slice(start, content.indexOf('}', start));
      for (const name of forbidden) {
        if (body.includes(name)) {
          fail(
            `packages/compiler/dist/compilation-trace.d.ts declares ${name} on ${interfaceName}`,
          );
        }
      }
    }
  }
}

// The recorded tokenizer identity states the scope of what it explains, so a
// reader cannot take a rendering-only identity to cover the content totals too
// (DEC-037).
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  'readonly tokenizerCoverage: CompilationTraceTokenizerCoverage;',
);
requireContains(
  'packages/compiler/dist/compilation-trace.d.ts',
  "type CompilationTraceTokenizerCoverage = 'rendering-attempt-only' | 'validation-and-rendering'",
);
requireContains('packages/compiler/dist/index.d.ts', "} from './compilation-trace.js'");

// The deterministic compilation identifier binds the request fingerprint plus
// every explicit composition input (DEC-038).
requireContains('packages/compiler/dist/compilation-id.d.ts', 'COMPILATION_ID_VERSION = 1');
requireContains('packages/compiler/dist/compilation-id.d.ts', 'type CompilationId = string');
requireContains('packages/compiler/dist/index.d.ts', "} from './compilation-id.js'");
for (const member of [
  'readonly compilerId: string;',
  'readonly compilerVersion: string;',
  'readonly tokenizerId: string;',
  'readonly tokenizerVersion: string;',
  'readonly rendererId: string;',
  'readonly rendererVersion: string;',
  'readonly correctionStrategy: string;',
  'readonly correctionVersion: number;',
  'readonly maxCorrectionSelections: number;',
]) {
  requireContains('packages/compiler/dist/compilation-id.d.ts', member);
}

// The composition root: one config, one Tokenizer, one CompilationResult
// (DEC-038).
requireContains('packages/compiler/dist/context-compiler.d.ts', 'declare class ContextCompiler');
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'constructor(config: unknown, tokenizer: Tokenizer);',
);
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'compile(input: unknown): CompilationResult;',
);
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION = 1',
);
requireContains('packages/compiler/dist/context-compiler.d.ts', 'interface ContextCompilerConfig');
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'readonly schemaVersion: typeof CONTEXT_COMPILER_CONFIG_SCHEMA_VERSION;',
);
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'readonly maxCorrectionSelections: number;',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './context-compiler.js'");

// The result publishes exactly the measured quantities, and a settled trace.
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'COMPILATION_RESULT_SCHEMA_VERSION = 1',
);
requireContains('packages/compiler/dist/context-compiler.d.ts', 'interface CompilationResult');
for (const member of [
  'readonly schemaVersion: typeof COMPILATION_RESULT_SCHEMA_VERSION;',
  'readonly compilationId: CompilationId;',
  'readonly requestId: string;',
  'readonly compiledContext: string;',
  'readonly includedBlocks: readonly ContextBlock[];',
  'readonly usage: CompilationResultUsage;',
  'readonly trace: SettledCompilationTrace;',
  'interface CompilationResultUsage',
  'readonly candidateTokens: number;',
  'readonly includedContentTokens: number;',
  'readonly compiledTokens: number;',
  'readonly availableTokens: number;',
  'readonly unusedTokens: number;',
  'readonly renderingTokenDelta: number;',
]) {
  requireContains('packages/compiler/dist/context-compiler.d.ts', member);
}

// One structured failure, naming the stage, carrying project-owned issues only.
requireContains(
  'packages/compiler/dist/context-compiler.d.ts',
  'declare class ContextCompilationError extends Error',
);
for (const member of [
  'readonly code = "CONTEXT_COMPILATION_FAILED"',
  'readonly stage: ContextCompilationStage;',
  'readonly issues: readonly ValidationIssue[];',
  'readonly compilationId?: CompilationId;',
  'readonly trace?: UnsettledCompilationTrace;',
  'type ContextCompilationStage',
]) {
  requireContains('packages/compiler/dist/context-compiler.d.ts', member);
}

{
  const content = contents.get('packages/compiler/dist/context-compiler.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const forbidden of [
      // No reduction metric may be invented from a quantity that is not a
      // baseline (METRICS 8.7, 8.8, DEC-038).
      'reductionTokens',
      'reductionRatio',
      'baselineInputTokens',
      'renderingOverheadTokens',
      'budgetUtilization',
      // The result carries no unsettled trace, and no raw excluded list.
      'trace: UnsettledCompilationTrace',
      'excludedBlocks',
      // No tokenizer implementation, retrieval, model, or persistence type.
      'O200kBaseTokenizer',
      'FakeTokenizer',
      'CandidateProvider',
      'SourceReader',
      'ModelProvider',
      'Database',
      'SqliteStore',
      // The correction internals stay package-private.
      'CorrectionCandidate',
      'RenderMeasurement',
      'CompilationRun',
      'verifyResult',
      'combinations(',
      'cartesian',
      'selectionKey',
      'compareRescueOrder',
      'satisfiesCategoryBounds',
      'SearchState',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/context-compiler.d.ts exposes the forbidden concept "${forbidden}"`,
        );
      }
    }
    // The optional error members are declared optional, so an absent identifier
    // or trace is genuinely absent rather than present holding `undefined`.
    if (!declarations.includes('readonly compilationId?: CompilationId;')) {
      fail('packages/compiler/dist/context-compiler.d.ts must declare compilationId as optional');
    }
  }
}

// The request fingerprint accepts a validated CompilationRequest and is not a
// compilation identifier (DEC-037).
requireContains(
  'packages/compiler/dist/request-fingerprint.d.ts',
  'COMPILATION_REQUEST_FINGERPRINT_VERSION = 1',
);
requireContains(
  'packages/compiler/dist/request-fingerprint.d.ts',
  'type CompilationRequestFingerprint = string',
);
requireContains(
  'packages/compiler/dist/request-fingerprint.d.ts',
  'declare function fingerprintCompilationRequest(request: CompilationRequest): CompilationRequestFingerprint;',
);
requireContains('packages/compiler/dist/index.d.ts', "} from './request-fingerprint.js'");

{
  const content = contents.get('packages/compiler/dist/compilation-trace.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    // Schema version 1 can represent no raw content, no rendered string, and no
    // arbitrary metadata (INV-SEC-003).
    for (const forbidden of [
      'readonly content:',
      'readonly query:',
      'readonly renderedContext:',
      'readonly metadata',
      'readonly title',
      'includeContent',
      'CompilationResult',
      'ContextCompiler',
      // The per-group verdict of the stage evidence stays *current*: the final
      // one lives in the settlement, separately (DEC-038).
      'finalDisposition',
      // Coverage is never a caller assertion: the manual caller is exactly the
      // party who may miscompose the stages (DEC-037).
      'validationTokenizerId',
      'validationTokenizerVersion',
      'validationTokenizer',
      'tokenizerInstance',
      'Tiktoken',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/compilation-trace.d.ts exposes the forbidden concept "${forbidden}"`,
        );
      }
    }
  }
}

{
  const content = contents.get('packages/compiler/dist/request-fingerprint.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const forbidden of [
      'compilationId',
      'CompilationId',
      'CompilationFingerprint',
      'Tokenizer',
      'compilerVersion',
      'CompilationTrace',
    ]) {
      if (declarations.includes(forbidden)) {
        fail(
          `packages/compiler/dist/request-fingerprint.d.ts exposes the forbidden concept "${forbidden}"`,
        );
      }
    }
  }
}

// The nested policy parsers exist so one rule has one owner. They are package
// internals: the entry point never re-exports them (INV-ADAPTER-001).
{
  const content = contents.get('packages/compiler/dist/index.d.ts');
  if (content !== undefined) {
    const declarations = stripComments(content);
    for (const internal of [
      'parseCandidateScoringPolicy',
      'parseCandidateFilteringPolicy',
      'parseBudgetAllocationPolicy',
      'parseContextOrderingPolicy',
      'parseContextRenderingPolicy',
      'parseCompilationPolicy',
      'CompilationPolicyWrapperSchema',
      'CompilationRequestShapeSchema',
      'SliceContract',
      'underSlice',
      'underPolicy',
      'policySlice',
      'policySlot',
      'domainSeparatedDigest',
      'TraceBuilderConfigSchema',
      'checkRequestEvidence',
      'checkStageEvidence',
      'calculateTotals',
      'traceGroup',
      'traceMember',
      'traceCanonicalBlock',
      'traceFilteringDecision',
      'safeSum',
      'multisetOf',
      'GroupEvidence',
      'hashRenderedContext',
      'settleCompilationTrace',
      'orderCandidatesForRendering',
      'renderOrderedCandidates',
      'collectTokenizerPortIssues',
      'countTokensSafely',
      'describeThrown',
      'calculateCompilationId',
      'CompilationIdComposition',
      'verifyResult',
      'finalDecisions',
      'selectionKey',
      'sumTokens',
      'CorrectionCandidate',
      'RenderMeasurement',
      'CompilationRun',
      'compareRescueOrder',
      'satisfiesCategoryBounds',
      'SearchState',
    ]) {
      if (declarations.includes(internal)) {
        fail(`packages/compiler/dist/index.d.ts re-exports the internal helper "${internal}"`);
      }
    }
    // The kernel is complete; what lies outside it is not (DEC-038). The
    // fingerprint keeps its own name, and no second spelling of an identity is
    // published beside it.
    for (const future of [
      'CandidateProvider',
      'SourceReader',
      'ModelProvider',
      'CompilationStore',
      'requestFingerprint',
      'compilationFingerprint',
      'CompilationIdentifier',
    ]) {
      if (declarations.includes(future)) {
        fail(`packages/compiler/dist/index.d.ts publishes the future concept "${future}"`);
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
  // Word-bounded: `CompilationTraceGroup` is a published Phase 14 type, while
  // the bare `Group` remains a Phase 8 internal one.
  /\bGroup\b/,
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
  'SliceContract',
  'validateSlice',
  'underSlice',
  'underPolicy',
];

for (const relativePath of [
  'packages/compiler/dist/index.d.ts',
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/candidate-filter.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
  'packages/compiler/dist/context-renderer.d.ts',
  'packages/compiler/dist/compilation-policy.d.ts',
  'packages/compiler/dist/compilation-request.d.ts',
  'packages/compiler/dist/compilation-trace.d.ts',
  'packages/compiler/dist/request-fingerprint.d.ts',
  'packages/compiler/dist/compilation-id.d.ts',
  'packages/compiler/dist/context-compiler.d.ts',
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
  // The retrieval port belongs outside the kernel entirely and must not appear
  // in any compiler declaration (INV-DEP-002).
  for (const stage of ['CandidateProvider']) {
    if (declarations.includes(stage)) {
      fail(`${relativePath} declares the unimplemented stage "${stage}"`);
    }
  }
}

// `ContextCompiler` is the composition root and no other component may name it:
// a stage that reached for its orchestrator would invert the dependency
// direction (DEC-038).
for (const relativePath of [
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/candidate-filter.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
  'packages/compiler/dist/context-renderer.d.ts',
  'packages/compiler/dist/compilation-policy.d.ts',
  'packages/compiler/dist/compilation-request.d.ts',
  'packages/compiler/dist/compilation-trace.d.ts',
  'packages/compiler/dist/request-fingerprint.d.ts',
  'packages/compiler/dist/compilation-id.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  if (stripComments(content).includes('ContextCompiler')) {
    fail(`${relativePath} declares the composition root "ContextCompiler"`);
  }
}

// The renderer is published, but only from Phase 12 onward: no earlier stage may
// name it, because a stage that referenced the renderer would be deciding
// presentation (DEC-034, DEC-035).
for (const relativePath of [
  'packages/compiler/dist/candidate-validator.d.ts',
  'packages/compiler/dist/candidate-deduplicator.d.ts',
  'packages/compiler/dist/candidate-scorer.d.ts',
  'packages/compiler/dist/budget-allocator.d.ts',
  'packages/compiler/dist/context-orderer.d.ts',
]) {
  const content = contents.get(relativePath);
  if (content === undefined) continue;
  if (stripComments(content).includes('ContextRenderer')) {
    fail(`${relativePath} declares the later stage "ContextRenderer"`);
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

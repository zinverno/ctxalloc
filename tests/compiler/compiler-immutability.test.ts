import { readFileSync } from 'node:fs';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextCompiler,
  ContextOrderer,
  ContextRenderer,
  TraceBuilder,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  COUNTEREXAMPLE_AVAILABLE,
  COUNTEREXAMPLE_SPECS,
  COUNTEREXAMPLE_TOKENIZER,
  FACTS_MINIMUM_POLICY,
  compile,
  compilerConfig,
  jsonlOverheadTokenizer,
  requestInput,
  type CandidateSpec,
} from './compiler-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * Immutability and the absence of hidden inputs (INV-ALLOC-004, INV-DET-001).
 *
 * The compiler treats the request and every stage result as data it may read.
 * Correction builds new arrays and new decision records; it never mutates a
 * candidate, a block, an attribute, a score, an allocator decision, or the
 * observational trace snapshot, and it never reorders an existing array in
 * place.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 2, required: true, priority: 0 },
  { id: 'high', tokens: 2, priority: 900 },
  { id: 'mid', tokens: 2, priority: 500 },
  { id: 'low', tokens: 2, priority: 100 },
];

describe('ContextCompiler treats its inputs as immutable', () => {
  it('leaves the raw request record byte-identical', () => {
    const input = requestInput({ specs: SPECS, available: 14 });
    const before = JSON.stringify(input);

    compile({ specs: SPECS, available: 14 }, jsonlOverheadTokenizer(3));
    new ContextCompiler(compilerConfig(), jsonlOverheadTokenizer(3)).compile(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  it('leaves the supplied candidates, blocks, and scores unchanged', () => {
    const input = requestInput({
      specs: COUNTEREXAMPLE_SPECS,
      available: COUNTEREXAMPLE_AVAILABLE,
      policy: FACTS_MINIMUM_POLICY,
    });
    const candidatesBefore = JSON.stringify(input['candidates']);
    const policyBefore = JSON.stringify(input['policy']);
    const documentsBefore = JSON.stringify(input['sourceDocuments']);

    // The fallback path, which rebuilds the selection from the eligible set.
    new ContextCompiler(compilerConfig(), COUNTEREXAMPLE_TOKENIZER).compile(input);

    expect(JSON.stringify(input['candidates'])).toBe(candidatesBefore);
    expect(JSON.stringify(input['policy'])).toBe(policyBefore);
    expect(JSON.stringify(input['sourceDocuments'])).toBe(documentsBefore);
  });

  it('leaves the allocator decisions unchanged after a correction', () => {
    const result = compile({ specs: SPECS, available: 14 }, jsonlOverheadTokenizer(3));

    // The correction evicted two blocks; the allocator's record still shows all
    // four included, with their original reasons.
    expect(result.trace.allocation.includedBlockIds).toHaveLength(4);
    for (const group of result.trace.groups) {
      expect(group.allocation?.decision).toBe('included');
      expect(group.currentDisposition).toBe('included');
    }
    expect(result.includedBlocks).toHaveLength(2);
  });

  it('never mutates the observational snapshot when settling', () => {
    // The same stage evidence, traced by hand and settled by the compiler, must
    // produce a snapshot the settlement did not touch.
    const input = requestInput({ specs: SPECS, available: 14 });
    const tokenizer = jsonlOverheadTokenizer(3);
    const request = new CompilationRequestValidator().validate(input);
    const validated = new CandidateValidator(tokenizer).validate({
      scope: request.scope,
      sourceDocuments: request.sourceDocuments,
      candidates: request.candidates,
    });
    const deduplicated = new CandidateDeduplicator().deduplicate(validated);
    const scored = new CandidateScorer(request.policy.scoring).score(
      deduplicated,
      request.referenceTime,
    );
    const filtered = new CandidateFilter(request.policy.filtering).filter(scored);
    const allocated = new BudgetAllocator(request.policy.allocation).allocate(
      filtered.eligible,
      request.budget,
    );
    const ordered = new ContextOrderer(request.policy.ordering).order(allocated);
    const rendered = new ContextRenderer(request.policy.rendering, tokenizer).render(ordered);
    const snapshot = new TraceBuilder({
      compilerId: 'ctxalloc-compiler',
      compilerVersion: '0.15.0',
    }).build({ request, validated, deduplicated, filtered, rendered });

    const settledTrace = new ContextCompiler(compilerConfig(), tokenizer).compile(input).trace;
    const { settlement, compilationId, composition, ...rest } = settledTrace;
    const { settled: isSettled, ...base } = rest;

    expect(isSettled).toBe(true);
    expect(settlement.correctionApplied).toBe(true);
    expect(compilationId).toMatch(/^sha256:/);
    expect(snapshot.settled).toBe(false);
    expect(Object.keys(snapshot)).not.toContain('settlement');
    // Every base field of the settled trace equals the snapshot's, untouched.
    expect(base).toEqual({
      schemaVersion: snapshot.schemaVersion,
      request: snapshot.request,
      sources: snapshot.sources,
      groups: snapshot.groups,
      allocation: snapshot.allocation,
      ordering: snapshot.ordering,
      rendering: snapshot.rendering,
      totals: snapshot.totals,
    });
    // Only the coverage claim changes, and only because the compiler owns both
    // tokenizer injections.
    expect(composition.tokenizerCoverage).toBe('validation-and-rendering');
    expect(snapshot.composition.tokenizerCoverage).toBe('rendering-attempt-only');
    expect({ ...composition, tokenizerCoverage: 'rendering-attempt-only' }).toEqual(
      snapshot.composition,
    );
  });

  it('reorders no supplied array in place', () => {
    const candidates = COUNTEREXAMPLE_SPECS.map((spec) => spec.id);
    const input = requestInput({
      specs: COUNTEREXAMPLE_SPECS,
      available: COUNTEREXAMPLE_AVAILABLE,
      policy: FACTS_MINIMUM_POLICY,
    });
    new ContextCompiler(compilerConfig(), COUNTEREXAMPLE_TOKENIZER).compile(input);

    const after = (input['candidates'] as readonly { block: { id: string } }[]).map(
      (candidate) => candidate.block.id,
    );
    expect(after).toEqual(candidates);
  });

  it('INV-DET-003, INV-DET-004: reads no clock, randomness, or environment', () => {
    const sources = [
      'packages/compiler/src/context-compiler.ts',
      'packages/compiler/src/compilation-id.ts',
      'packages/compiler/src/tokenizer-port.ts',
    ].map((path) =>
      readFileSync(new URL(path, rootUrl), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    );

    for (const source of sources) {
      for (const forbidden of [
        'Date.now',
        'new Date',
        'Math.random',
        'randomUUID',
        'crypto.random',
        'process.env',
        'process.pid',
        'hostname',
        'node:fs',
        'node:os',
        'node:net',
        'node:http',
        'fetch(',
        'require(',
        'localeCompare',
        'Intl.',
      ]) {
        expect(source, `reads ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('INV-DET-002: orders every decision with the project-owned comparison', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    expect(source).toContain('compareCodeUnits');
    expect(source).not.toContain('.sort()');
  });

  it('INV-DEP-002: imports no retrieval, model, persistence, or application type', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/context-compiler.ts', rootUrl),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from '(?<specifier>[^']+)'/g)].map(
      (match) => match.groups?.specifier ?? '',
    );
    const external = specifiers.filter((specifier) => !specifier.startsWith('./'));
    expect([...new Set(external)].sort()).toEqual(['@ctxalloc/domain', '@ctxalloc/ports', 'zod']);
  });
});

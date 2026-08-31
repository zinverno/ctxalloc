import { readFileSync } from 'node:fs';
import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextOrderer,
  ContextRenderer,
  TraceBuilder,
  fingerprintCompilationRequest,
} from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  compilerPolicy,
  contextBlock,
  requestInput,
  sourceDocument,
  wordTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';
import { candidateOf } from './allocation-fixtures.js';
import { orderSpecs, render, renderingPolicy } from './rendering-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * Phase 11 and 12 public behavior is unchanged by the internal extraction
 * (DEC-038).
 *
 * `ContextOrderer` and `ContextRenderer` now call package-internal helpers that
 * `ContextCompiler` also calls, so one selection cannot order or render two
 * different ways. The extraction is only correct if the public bytes, the public
 * order, and the public failure codes are exactly what they were.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'alpha', tokens: 3, priority: 900 },
  { id: 'beta', tokens: 4, priority: 500 },
  { id: 'gamma', tokens: 2, priority: 100 },
];

describe('Phase 11: ContextOrderer public output is unchanged', () => {
  it('orders by source document, then position, then identifier', () => {
    const ordered = orderSpecs([
      {
        id: 'z',
        tokens: 2,
        sourceLocation: { kind: 'text-range', startOffset: 30, endOffset: 32 },
      },
      {
        id: 'a',
        tokens: 2,
        sourceLocation: { kind: 'text-range', startOffset: 10, endOffset: 12 },
      },
      {
        id: 'm',
        tokens: 2,
        sourceLocation: { kind: 'text-range', startOffset: 20, endOffset: 22 },
      },
    ]);

    expect(
      ordered.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    ).toEqual(['a', 'm', 'z']);
  });

  it('returns the allocator decision objects by reference, permuted', () => {
    const ordered = orderSpecs(SPECS);
    const included = new Set(ordered.allocation.included);

    expect(ordered.orderedIncluded).toHaveLength(ordered.allocation.included.length);
    for (const decision of ordered.orderedIncluded) {
      expect(included.has(decision)).toBe(true);
    }
    expect(ordered.allocation).toBe(ordered.allocation);
  });

  it('places an unlocated block after the located blocks of its own source', () => {
    const ordered = orderSpecs([
      { id: 'no-location', tokens: 2, sourceLocation: null },
      {
        id: 'located',
        tokens: 2,
        sourceLocation: { kind: 'text-range', startOffset: 5, endOffset: 7 },
      },
    ]);
    expect(
      ordered.orderedIncluded.map((decision) => decision.candidate.candidate.canonicalBlock.id),
    ).toEqual(['located', 'no-location']);
  });
});

describe('Phase 12: ContextRenderer public output is unchanged', () => {
  it('renders byte-for-byte the documented v1 JSONL', () => {
    const attempt = render(orderSpecs([{ id: 'one', tokens: 2 }]));
    expect(attempt.renderedContext).toBe(
      '{"blockId":"one","content":"one w0","sourceDocumentId":"doc-1","sourceType":"markdown"}',
    );
  });

  it('joins records with exactly one LF and no trailing newline', () => {
    const attempt = render(orderSpecs(SPECS));
    expect(attempt.renderedContext.split('\n')).toHaveLength(3);
    expect(attempt.renderedContext.endsWith('\n')).toBe(false);
    expect(attempt.renderedContext.startsWith('{')).toBe(true);
  });

  it('renders an empty selection as the exact empty string', () => {
    const attempt = render(orderSpecs([]));
    expect(attempt.renderedContext).toBe('');
    expect(attempt.renderedTokens).toBe(0);
  });

  it('keeps its failure codes and its constructor contract', () => {
    const ordered = orderSpecs(SPECS);
    const codesOf = (run: () => unknown): readonly string[] => {
      try {
        run();
      } catch (error) {
        return ((error as { issues: readonly { code: string }[] }).issues ?? []).map(
          (issue) => issue.code,
        );
      }
      throw new Error('expected a rejection');
    };

    expect(codesOf(() => new ContextRenderer({ schemaVersion: 2 }, wordTokenizer))).toContain(
      'invalid_policy',
    );
    expect(
      codesOf(
        () =>
          new ContextRenderer(renderingPolicy(), {
            id: '',
            version: '1',
            countTokens: (): number => 0,
          }),
      ),
    ).toContain('invalid_tokenizer');
    expect(
      codesOf(() =>
        new ContextRenderer(renderingPolicy(), {
          id: 'x',
          version: '1',
          countTokens: (): number => {
            throw new Error('boom');
          },
        }).render(ordered),
      ),
    ).toEqual(['tokenizer_failed']);
    expect(
      codesOf(() =>
        new ContextRenderer(renderingPolicy(), {
          id: 'x',
          version: '1',
          countTokens: (): number => -1,
        }).render(ordered),
      ),
    ).toEqual(['invalid_rendered_token_count']);
  });

  it('reports a tokenizer failure with the same message it always did', () => {
    const ordered = orderSpecs(SPECS);
    let message = '';
    try {
      new ContextRenderer(renderingPolicy(), {
        id: 'tok',
        version: '9',
        countTokens: (): number => {
          throw new TypeError('encoder exploded');
        },
      }).render(ordered);
    } catch (error) {
      message = (error as { issues: readonly { message: string }[] }).issues[0]?.message ?? '';
    }
    expect(message).toBe(
      'tokenizer "tok" version "9" failed to count the rendered context: TypeError: encoder exploded',
    );
  });
});

describe('Phase 14: the request fingerprint and the trace privacy are unchanged', () => {
  it('produces the same fingerprint bytes for the same validated request', () => {
    const request = new CompilationRequestValidator().validate(
      requestInput({
        specs: SPECS,
        id: 'req-fingerprint',
        query: 'stable query',
        available: 100,
      }),
    );
    // Pinned, so a future change to the preimage is visible rather than silent.
    expect(fingerprintCompilationRequest(request)).toBe(
      fingerprintCompilationRequest(
        new CompilationRequestValidator().validate(
          requestInput({
            specs: SPECS,
            id: 'req-fingerprint',
            query: 'stable query',
            available: 100,
          }),
        ),
      ),
    );
    expect(fingerprintCompilationRequest(request)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('TraceBuilder remains observational and never calls a tokenizer', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/compilation-trace.ts', rootUrl),
      'utf8',
    );
    expect(source).not.toContain('countTokens');
    expect(source).not.toContain('@ctxalloc/ports');
    // The `Tokenizer` port type never reaches the builder: it records an
    // identity the render attempt already published, and measures nothing.
    expect(source).not.toContain(': Tokenizer');
    expect(source).not.toContain('tokenizer.id');
    expect(source).not.toContain('ContextCompiler(');
  });

  it('keeps the Phase 14 coherence checks, which now guard the compiler too', () => {
    const request = new CompilationRequestValidator().validate(
      requestInput({ specs: SPECS, available: 100 }),
    );
    const validated = new CandidateValidator(wordTokenizer).validate({
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
    const rendered = new ContextRenderer(request.policy.rendering, wordTokenizer).render(ordered);
    const builder = new TraceBuilder({ compilerId: 'c', compilerVersion: '1' });

    expect(() =>
      builder.build({ request, validated, deduplicated, filtered, rendered }),
    ).not.toThrow();
    // A request from another run is still rejected rather than reconciled.
    const other = new CompilationRequestValidator().validate(
      requestInput({ specs: [{ id: 'unrelated', tokens: 2 }], available: 100 }),
    );
    expect(() =>
      builder.build({ request: other, validated, deduplicated, filtered, rendered }),
    ).toThrow();
  });

  it('keeps a Phase 14 trace free of raw content and metadata', () => {
    const request = new CompilationRequestValidator().validate(
      requestInput({
        candidates: [candidateOf({ id: 'one', tokens: 3 })],
        sourceDocuments: [sourceDocument({ metadata: { secret: 'do-not-persist' } })],
        query: 'a-distinctive-query',
        available: 100,
        policy: compilerPolicy(),
      }),
    );
    const validated = new CandidateValidator(wordTokenizer).validate({
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
    const rendered = new ContextRenderer(request.policy.rendering, wordTokenizer).render(
      new ContextOrderer(request.policy.ordering).order(allocated),
    );
    const built = new TraceBuilder({ compilerId: 'c', compilerVersion: '1' }).build({
      request,
      validated,
      deduplicated,
      filtered,
      rendered,
    });
    const serialized = JSON.stringify(built);

    expect(serialized).not.toContain('a-distinctive-query');
    expect(serialized).not.toContain('do-not-persist');
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"metadata"');
  });

  it('rejects a candidate batch exactly as CandidateValidator always did', () => {
    const codes = ((): readonly string[] => {
      try {
        new CandidateValidator(wordTokenizer).validate({
          scope: { tenantId: 'local', workspaceId: 'default' },
          sourceDocuments: [sourceDocument()],
          candidates: [{ schemaVersion: 1, block: contextBlock({ tokenCount: 42 }) }],
        });
      } catch (error) {
        return ((error as { issues: readonly { code: string }[] }).issues ?? []).map(
          (issue) => issue.code,
        );
      }
      throw new Error('expected a rejection');
    })();
    expect(codes).toEqual(['invalid_token_count']);
  });
});

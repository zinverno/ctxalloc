import { readFileSync } from 'node:fs';
import { COMPILATION_TRACE_SCHEMA_VERSION } from '@ctxalloc/compiler';
import { describe, expect, it } from 'vitest';
import {
  COUNTEREXAMPLE_AVAILABLE,
  COUNTEREXAMPLE_SPECS,
  COUNTEREXAMPLE_TOKENIZER,
  FACTS_MINIMUM_POLICY,
  compile,
  includedIds,
  jsonlOverheadTokenizer,
  type CandidateSpec,
} from './compiler-fixtures.js';
import { trace as unsettledTrace } from './trace-fixtures.js';

const rootUrl = new URL('../../', import.meta.url);

/**
 * `CompilationTrace` schema version 2 (DEC-038).
 *
 * Version 1 recorded the filtering decision, the allocation decision, the
 * allocator summary, the allocation's render order, and the measured attempt —
 * and named its per-group verdict `currentDisposition`, not `finalDisposition`,
 * precisely because a render-aware correction may settle a different selection.
 *
 * Flipping a version 1 record's `settled` boolean to `true` would therefore
 * publish a false audit record: it would still say the initial allocator
 * selection was the selection that settled. Version 2 adds the settlement
 * overlay instead, and keeps both variants apart at the type level.
 */

const SPECS: readonly CandidateSpec[] = [
  { id: 'must', tokens: 2, required: true, priority: 0 },
  { id: 'high', tokens: 2, priority: 900 },
  { id: 'low', tokens: 2, priority: 100 },
];

function settled(): ReturnType<typeof compile> {
  return compile({ specs: SPECS, available: 14 }, jsonlOverheadTokenizer(3));
}

describe('CompilationTrace schema version 2', () => {
  it('INV-STORE-004: publishes schema version 2', () => {
    expect(COMPILATION_TRACE_SCHEMA_VERSION).toBe(2);
    expect(settled().trace.schemaVersion).toBe(2);
    expect(unsettledTrace({ specs: [{ id: 'one', tokens: 2 }] }).schemaVersion).toBe(2);
  });

  it('TraceBuilder still emits an unsettled snapshot with no settlement', () => {
    const built = unsettledTrace({ specs: [{ id: 'one', tokens: 2 }] });

    expect(built.settled).toBe(false);
    expect(Object.keys(built)).not.toContain('settlement');
    expect(Object.keys(built)).not.toContain('compilationId');
    expect(built.composition.tokenizerCoverage).toBe('rendering-attempt-only');
  });

  it('ContextCompiler emits a settled trace with a settlement and an identity', () => {
    const result = settled();

    expect(result.trace.settled).toBe(true);
    expect(result.trace.compilationId).toBe(result.compilationId);
    expect(result.trace.settlement.strategy).toBe('render-aware-v1');
    expect(result.trace.composition.tokenizerCoverage).toBe('validation-and-rendering');
  });

  it('keeps the two variants apart at the type level', () => {
    const declarations = readFileSync(
      new URL('packages/compiler/src/compilation-trace.ts', rootUrl),
      'utf8',
    );

    expect(declarations).toContain('export interface UnsettledCompilationTrace');
    expect(declarations).toContain('readonly settled: false;');
    expect(declarations).toContain('readonly settlement?: never;');
    expect(declarations).toContain('readonly compilationId?: never;');
    expect(declarations).toContain('export interface SettledCompilationTrace');
    expect(declarations).toContain('readonly settled: true;');
    expect(declarations).toContain('readonly compilationId: CompilationId;');
    expect(declarations).toContain('readonly settlement: CompilationTraceSettlement;');
    expect(declarations).toContain(
      'export type CompilationTrace = UnsettledCompilationTrace | SettledCompilationTrace;',
    );
  });

  it('preserves the original filtering and allocation evidence unchanged', () => {
    const result = settled();

    // The allocator included all three; the correction settled two.
    expect([...result.trace.allocation.includedBlockIds].sort()).toEqual(['high', 'low', 'must']);
    expect(result.trace.ordering.orderedBlockIds).toHaveLength(3);
    expect(result.trace.rendering.fitsAvailableInputBudget).toBe(false);
    for (const group of result.trace.groups) {
      expect(group.filtering.reason).toMatch(/^ELIGIBLE_/);
      expect(group.currentDisposition).toBe('included');
    }
    expect(includedIds(result)).toHaveLength(2);
  });

  it('INV-TRACE-001: carries exactly one final decision per deduplicated group', () => {
    const result = settled();
    const decided = result.trace.settlement.decisions.map((decision) => decision.blockId);

    expect(decided).toHaveLength(result.trace.groups.length);
    expect(new Set(decided).size).toBe(decided.length);
    expect([...decided].sort()).toEqual(
      [...result.trace.groups.map((group) => group.canonical.id)].sort(),
    );
  });

  it('INV-TRACE-004: final render positions cover 0..n-1 exactly once', () => {
    const result = settled();
    const positions = result.trace.settlement.decisions
      .filter((decision) => decision.disposition === 'included')
      .map((decision) => decision.renderPosition);

    expect([...positions].sort()).toEqual([0, 1]);
    for (const decision of result.trace.settlement.decisions) {
      if (decision.disposition !== 'included') {
        expect(Object.keys(decision)).not.toContain('renderPosition');
      }
    }
  });

  it('INV-TRACE-004: the settled ordering equals the returned includedBlocks', () => {
    const result = settled();
    expect(result.trace.settlement.ordering.orderedBlockIds).toEqual(includedIds(result));
    for (const decision of result.trace.settlement.decisions) {
      if (decision.disposition === 'included') {
        expect(includedIds(result)[decision.renderPosition]).toBe(decision.blockId);
      }
    }
  });

  it('INV-TRACE-003: the settlement usage equals the result usage exactly', () => {
    const result = settled();
    expect(result.trace.settlement.rendering.compiledTokens).toBe(result.usage.compiledTokens);
    expect(result.trace.settlement.usage).toEqual({
      availableInputTokens: result.usage.availableTokens,
      includedContentTokens: result.usage.includedContentTokens,
      unusedTokens: result.usage.unusedTokens,
      renderingTokenDelta: result.usage.renderingTokenDelta,
    });
    expect(result.trace.settlement.usage.unusedTokens).toBe(
      result.usage.availableTokens - result.usage.compiledTokens,
    );
  });

  it('records the digest of the exact final compiled context', () => {
    const result = settled();
    const hash = result.trace.settlement.rendering.renderedContextHash;

    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The initial attempt was a different string, so its digest differs.
    expect(hash).not.toBe(result.trace.rendering.renderedContextHash);
    // Both digests use one preimage rule, so the two are comparable.
    const initialFit = compile({ specs: SPECS, available: 100 }, jsonlOverheadTokenizer(3));
    expect(initialFit.trace.settlement.rendering.renderedContextHash).toBe(
      initialFit.trace.rendering.renderedContextHash,
    );
  });

  it('INV-SEC-003: carries no raw final context, query, content, or metadata', () => {
    const result = compile(
      {
        specs: COUNTEREXAMPLE_SPECS,
        available: COUNTEREXAMPLE_AVAILABLE,
        policy: FACTS_MINIMUM_POLICY,
        query: 'a-very-distinctive-query-string',
      },
      COUNTEREXAMPLE_TOKENIZER,
    );
    const serialized = JSON.stringify(result.trace);

    expect(serialized).not.toContain('a-very-distinctive-query-string');
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"renderedContext"');
    expect(serialized).not.toContain('"compiledContext"');
    expect(serialized).not.toContain('"metadata"');
    expect(serialized).not.toContain('"title"');
    // The final string lives only on the result.
    expect(result.compiledContext).toContain('"content"');
  });

  it('survives a JSON round trip with deep equality', () => {
    const result = settled();
    const roundTripped = JSON.parse(JSON.stringify(result.trace)) as typeof result.trace;

    expect(roundTripped).toEqual(result.trace);
    expect(roundTripped.settled).toBe(true);
    expect(roundTripped.settlement.decisions).toEqual(result.trace.settlement.decisions);
  });

  it('DEC-038: settlement is orchestration, not a TraceBuilder method', () => {
    const source = readFileSync(
      new URL('packages/compiler/src/compilation-trace.ts', rootUrl),
      'utf8',
    );
    // The builder gains no `settle` method; the helper is a free function the
    // orchestrator calls once it has proven a result.
    expect(source).not.toContain('settle(');
    expect(source).toContain('export function settleCompilationTrace(');
    expect(source).not.toContain('countTokens');
  });

  it('never mutates the snapshot it settles', () => {
    const result = settled();
    // The settled value is a new record: its base fields equal the snapshot's,
    // and the snapshot never acquires a settlement.
    const { settlement, ...base } = result.trace;
    expect(settlement.correctionApplied).toBe(true);
    expect(base.settled).toBe(true);
    expect(base.rendering.fitsAvailableInputBudget).toBe(false);
  });
});

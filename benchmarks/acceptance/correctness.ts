import {
  CandidateDeduplicator,
  CandidateValidationError,
  CandidateValidator,
  type CompilationRequest,
  type CompilationResult,
} from '@ctxalloc/compiler';
import { availableInputTokens, scopesEqual } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

export interface RatioCount {
  numerator: number;
  denominator: number;
}
export interface CorrectnessCounts {
  provenanceCoverage: RatioCount;
  wrapperAccountingCompleteness: RatioCount;
  groupDecisionCompleteness: RatioCount;
  decisionReasonCoverage: RatioCount;
  traceReconciliationRate: RatioCount;
  crossScopeInclusionCount: number;
}
const ratio = (): RatioCount => ({ numerator: 0, denominator: 0 });
export function emptyCorrectness(): CorrectnessCounts {
  return {
    provenanceCoverage: ratio(),
    wrapperAccountingCompleteness: ratio(),
    groupDecisionCompleteness: ratio(),
    decisionReasonCoverage: ratio(),
    traceReconciliationRate: ratio(),
    crossScopeInclusionCount: 0,
  };
}
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const bag = (values: readonly string[]) => {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
};

/** METRICS 9.5, 13.3–13.5, 15.1; independent observations of actual compiler output. */
export function measureCorrectness(
  request: CompilationRequest,
  result: CompilationResult,
  tokenizer: Tokenizer,
): CorrectnessCounts {
  const counts = emptyCorrectness();
  const validator = new CandidateValidator(tokenizer);
  const validated = validator.validate({
    scope: request.scope,
    sourceDocuments: request.sourceDocuments,
    candidates: request.candidates,
  });
  const dedup = new CandidateDeduplicator().deduplicate(validated);
  const trace = result.trace;
  const memberKey = (groupId: string, blockId: string, sourceId: string, retrieval: unknown) =>
    JSON.stringify([groupId, blockId, sourceId, retrieval]);
  const evidence = (retrieval: (typeof request.candidates)[number]['retrieval']) =>
    retrieval === undefined
      ? null
      : [
          retrieval.providerId,
          retrieval.providerVersion,
          retrieval.rank ?? null,
          retrieval.score === undefined
            ? null
            : [retrieval.score.value, retrieval.score.semantics, retrieval.score.higherIsBetter],
        ];
  const expected = bag(
    dedup.candidates.flatMap((group) =>
      group.members.map((member) =>
        memberKey(
          group.canonicalBlock.id,
          member.candidate.block.id,
          member.candidate.block.sourceDocumentId,
          evidence(member.candidate.retrieval),
        ),
      ),
    ),
  );
  const actual = bag(
    trace.groups.flatMap((group) =>
      group.members.map((member) =>
        memberKey(
          group.canonical.id,
          member.blockId,
          member.sourceDocumentId,
          evidence(member.retrieval),
        ),
      ),
    ),
  );
  counts.wrapperAccountingCompleteness.denominator = validated.candidates.length;
  for (const [key, n] of expected)
    if (actual.get(key) === n) counts.wrapperAccountingCompleteness.numerator += n;
  counts.groupDecisionCompleteness.denominator = dedup.candidates.length;
  for (const group of dedup.candidates) {
    const id = group.canonicalBlock.id;
    if (
      trace.groups.filter((g) => g.canonical.id === id).length === 1 &&
      trace.settlement.decisions.filter(
        (d) => d.blockId === id && ['included', 'excluded', 'filtered'].includes(d.disposition),
      ).length === 1
    )
      counts.groupDecisionCompleteness.numerator += 1;
  }
  const decisions = [
    ...trace.groups.flatMap((group) => [
      group.filtering,
      ...(group.allocation === undefined ? [] : [group.allocation]),
    ]),
    ...trace.settlement.decisions,
  ];
  counts.decisionReasonCoverage = {
    numerator: decisions.filter((d) => typeof d.reason === 'string' && d.reason.length > 0).length,
    denominator: decisions.length,
  };
  for (const block of result.includedBlocks) {
    counts.provenanceCoverage.denominator += 1;
    try {
      validator.validate({
        scope: request.scope,
        sourceDocuments: request.sourceDocuments,
        candidates: [{ schemaVersion: 1, block }],
      });
      counts.provenanceCoverage.numerator += 1;
    } catch {
      /* Invalid provenance remains in the denominator. */
    }
    if (!scopesEqual(block.scope, request.scope)) counts.crossScopeInclusionCount += 1;
  }
  const canonicalTokens = new Map(
    dedup.candidates.map((group) => [group.canonicalBlock.id, group.canonicalBlock.tokenCount]),
  );
  const groupTokens = (disposition: string) =>
    sum(
      trace.groups
        .filter((g) => g.currentDisposition === disposition)
        .map((g) => canonicalTokens.get(g.canonical.id) ?? NaN),
    );
  const t = trace.totals;
  const s = trace.settlement;
  const u = result.usage;
  const rendered =
    result.compiledContext === ''
      ? []
      : result.compiledContext
          .split('\n')
          .map((line) => JSON.parse(line) as { blockId: string; content: string });
  const ids = result.includedBlocks.map((block) => block.id);
  const finalDecisions = s.decisions
    .filter((d) => d.disposition === 'included')
    .sort((a, b) => a.renderPosition - b.renderPosition);
  const expectedTotals = {
    candidateCount: validated.candidates.length,
    deduplicatedGroupCount: dedup.candidates.length,
    duplicateWrapperCount: validated.candidates.length - dedup.candidates.length,
    filteredGroupCount: trace.groups.filter((g) => g.currentDisposition === 'filtered').length,
    eligibleGroupCount: trace.groups.filter((g) => g.currentDisposition !== 'filtered').length,
    includedGroupCount: trace.groups.filter((g) => g.currentDisposition === 'included').length,
    allocationExcludedGroupCount: trace.groups.filter((g) => g.currentDisposition === 'excluded')
      .length,
    candidateTokens: sum(validated.candidates.map((c) => c.block.tokenCount)),
    canonicalContentTokens: sum([...canonicalTokens.values()]),
    duplicateCandidateTokens:
      sum(validated.candidates.map((c) => c.block.tokenCount)) - sum([...canonicalTokens.values()]),
    filteredContentTokens: groupTokens('filtered'),
    includedContentTokens: groupTokens('included'),
    allocationExcludedContentTokens: groupTokens('excluded'),
    excludedCanonicalContentTokens: groupTokens('filtered') + groupTokens('excluded'),
  };
  const reconciles =
    Object.entries(expectedTotals).every(([key, value]) => t[key as keyof typeof t] === value) &&
    t.candidateTokens === t.canonicalContentTokens + t.duplicateCandidateTokens &&
    t.canonicalContentTokens === t.includedContentTokens + t.excludedCanonicalContentTokens &&
    t.eligibleGroupCount === t.includedGroupCount + t.allocationExcludedGroupCount &&
    t.deduplicatedGroupCount === t.filteredGroupCount + t.eligibleGroupCount &&
    t.candidateCount === sum(trace.groups.map((g) => g.members.length)) &&
    same(ids, s.ordering.orderedBlockIds) &&
    same(
      ids,
      finalDecisions.map((d) => d.blockId),
    ) &&
    same(
      ids,
      rendered.map((block) => block.blockId),
    ) &&
    rendered.every((record, index) => record.content === result.includedBlocks[index]?.content) &&
    s.decisions
      .filter((d) => d.disposition !== 'included')
      .every((d) => !ids.includes(d.blockId)) &&
    u.candidateTokens === expectedTotals.candidateTokens &&
    u.availableTokens === availableInputTokens(request.budget) &&
    u.compiledTokens === tokenizer.countTokens(result.compiledContext) &&
    u.compiledTokens === s.rendering.compiledTokens &&
    u.availableTokens === s.usage.availableInputTokens &&
    u.includedContentTokens === sum(result.includedBlocks.map((b) => b.tokenCount)) &&
    u.includedContentTokens === s.usage.includedContentTokens &&
    u.unusedTokens === u.availableTokens - u.compiledTokens &&
    u.unusedTokens === s.usage.unusedTokens &&
    u.renderingTokenDelta === u.compiledTokens - u.includedContentTokens &&
    u.renderingTokenDelta === s.usage.renderingTokenDelta;
  counts.traceReconciliationRate = { numerator: reconciles ? 1 : 0, denominator: 1 };
  return counts;
}
export function addCorrectness(total: CorrectnessCounts, next: CorrectnessCounts): void {
  for (const key of [
    'provenanceCoverage',
    'wrapperAccountingCompleteness',
    'groupDecisionCompleteness',
    'decisionReasonCoverage',
    'traceReconciliationRate',
  ] as const) {
    total[key].numerator += next[key].numerator;
    total[key].denominator += next[key].denominator;
  }
  total.crossScopeInclusionCount += next.crossScopeInclusionCount;
}
/** Each foreign candidate must produce its own candidate-scope mismatch, not only a registry error. */
export function scopeDetections(request: CompilationRequest, tokenizer: Tokenizer): RatioCount {
  const result = ratio();
  for (const candidate of request.candidates.filter(
    (c) => !scopesEqual(c.block.scope, request.scope),
  )) {
    result.denominator += 1;
    try {
      new CandidateValidator(tokenizer).validate({
        scope: request.scope,
        sourceDocuments: request.sourceDocuments,
        candidates: [candidate],
      });
    } catch (cause) {
      if (
        cause instanceof CandidateValidationError &&
        cause.issues.some(
          (issue) => issue.code === 'scope_mismatch' && issue.pointer.startsWith('candidates'),
        )
      )
        result.numerator += 1;
    }
  }
  return result;
}

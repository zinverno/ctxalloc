import {
  BudgetAllocator,
  CandidateDeduplicator,
  CandidateFilter,
  CandidateScorer,
  CandidateValidator,
  CompilationRequestValidator,
  ContextCompiler,
} from '@ctxalloc/compiler';
import { scopesEqual } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';

function assertSame(observed: unknown, traced: unknown): void {
  if (JSON.stringify(observed) !== JSON.stringify(traced))
    throw new Error('Diagnostic stage replay disagrees with the compiler trace.');
}

/**
 * Observe a successful compilation, with no selection rule or metric formula here.
 * The trace omits per-decision budget remainders. Replay the existing stage owners
 * to obtain those values, checking their shared evidence against the real compiler.
 * This is an offline diagnostic, never the serving path or a latency measurement.
 */
export function diagnoseCompilation(input: unknown, config: unknown, tokenizer: Tokenizer) {
  const request = new CompilationRequestValidator().validate(input);
  const { trace, compilationId, usage } = new ContextCompiler(config, tokenizer).compile(request);
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
  assertSame(
    {
      availableInputTokens: allocated.availableInputTokens,
      selectedBlockContentTokens: allocated.selectedBlockContentTokens,
      unallocatedBlockContentTokens: allocated.unallocatedBlockContentTokens,
      includedBlockIds: allocated.included.map((d) => d.candidate.candidate.canonicalBlock.id),
      excludedBlockIds: allocated.excluded.map((d) => d.candidate.candidate.canonicalBlock.id),
      optionalEvictionOrder: allocated.optionalEvictionOrder,
    },
    trace.allocation,
  );
  assertSame(
    deduplicated.candidates.map((g) => g.canonicalBlock.id),
    trace.groups.map((g) => g.canonical.id),
  );
  const allocations = new Map(
    [...allocated.included, ...allocated.excluded].map((d) => [
      d.candidate.candidate.canonicalBlock.id,
      d,
    ]),
  );
  const filters = new Map(
    filtered.decisions.map((d) => [d.candidate.candidate.canonicalBlock.id, d]),
  );
  const finals = new Map(trace.settlement.decisions.map((d) => [d.blockId, d]));
  const groups = trace.groups.map((group, index) => {
    const original = deduplicated.candidates[index]!;
    const filtering = filters.get(group.canonical.id)!;
    const { candidate: scoredCandidate, ...filteringEvidence } = filtering;
    assertSame(scoredCandidate.score, group.score);
    assertSame(filteringEvidence, group.filtering);
    const allocation = allocations.get(group.canonical.id);
    assertSame(
      allocation === undefined
        ? undefined
        : { decision: allocation.decision, reason: allocation.reason },
      group.allocation,
    );
    // Strip the stage's full candidate object; keep the actual budget transition.
    const initialAllocation =
      allocation === undefined
        ? null
        : allocation.decision === 'included'
          ? {
              decision: allocation.decision,
              reason: allocation.reason,
              contentTokens: allocation.contentTokens,
              remainingBefore: allocation.remainingBefore,
              remainingAfter: allocation.remainingAfter,
            }
          : {
              decision: allocation.decision,
              reason: allocation.reason,
              contentTokens: allocation.contentTokens,
              remainingTokens: allocation.remainingTokens,
            };
    return {
      canonical: group.canonical,
      canonicalSelectionReason: group.canonicalSelectionReason,
      // A wrapper has no independent id. Equal wrappers remain equal repeated rows.
      members: original.members.map(({ candidate, matchReason }) => {
        const block = candidate.block;
        const retrieval = candidate.retrieval;
        return {
          blockId: block.id,
          sourceDocumentId: block.sourceDocumentId,
          sourceType: block.sourceType,
          sourceLocation: block.sourceLocation ?? null,
          normalizedContentHash: block.normalizedContentHash,
          contentTokens: block.tokenCount,
          compilerRequired: block.attributes.required === true,
          authoredPriority: block.attributes.priority ?? null,
          category: block.attributes.category ?? null,
          createdAt: block.createdAt ?? null,
          updatedAt: block.updatedAt ?? null,
          scopeMatchesRequest: scopesEqual(block.scope, request.scope),
          isCanonicalBlock: block.id === group.canonical.id,
          matchReason,
          retrieval:
            retrieval === undefined
              ? null
              : {
                  providerId: retrieval.providerId,
                  providerVersion: retrieval.providerVersion,
                  ...(retrieval.rank === undefined ? {} : { rank: retrieval.rank }),
                  ...(retrieval.score === undefined
                    ? {}
                    : {
                        score: {
                          value: retrieval.score.value,
                          semantics: retrieval.score.semantics,
                          higherIsBetter: retrieval.score.higherIsBetter,
                        },
                      }),
                },
        };
      }),
      score: group.score,
      filtering: group.filtering,
      initialAllocation,
      finalDecision: finals.get(group.canonical.id)!,
    };
  });
  return {
    schemaVersion: request.policy.filtering.schemaVersion,
    diagnostic: 'compilation-decisions' as const,
    compilationId,
    request: trace.request,
    composition: trace.composition,
    sources: trace.sources,
    admissionPolicy: {
      minimumTotalScore: request.policy.filtering.minimumTotalScore ?? null,
      optionalSelection: request.policy.allocation.optionalSelection,
      categoryConstraints: request.policy.allocation.categoryConstraints ?? [],
      recencyConfigured: request.policy.scoring.recency !== undefined,
      ...(request.policy.filtering.schemaVersion === 2
        ? { applicability: request.policy.filtering.applicability }
        : {}),
    },
    budgetUnit: 'canonical-block-content-tokens' as const,
    allocation: trace.allocation,
    initialRendering: trace.rendering,
    groups,
    settlement: trace.settlement,
    usage,
  };
}

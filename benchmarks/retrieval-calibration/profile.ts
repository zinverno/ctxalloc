import { MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import { CompilationPolicyValidator, type CompilationPolicy } from '@ctxalloc/compiler';
import type { CandidateBlock, Scope } from '@ctxalloc/domain';
import type { CandidateProviderRequest } from '@ctxalloc/ports';
import { NATIVE } from './observe.js';
import { SCOPE } from './data.js';

export const PROFILE = {
  id: 'minisearch-query-rank-incomplete-admit',
  version: '1',
  calibrationVersion: 'phase22a-development-1',
  provider: NATIVE,
  nativeRange: '(0, +infinity), finite',
  nativeRankBase: 0,
  corpusOrder: 'ascending block ID by UTF-16 code units before calling the unchanged provider',
  mapping: '1 / (nativeRank + 1)',
  mappedRange: '(0, 1]',
  meaning: 'query-local lexical ordering signal, not probability or calibrated usefulness',
  completeness: 'incomplete',
  onIncompleteEvidence: 'admit',
  minimumTotalScore: null,
  admissionPolicyId: 'phase22a:minisearch:admit-all',
  admissionPolicyVersion: '1',
} as const;
export const MAPPED = {
  providerId: 'ctxalloc-minisearch-rank-calibration',
  providerVersion: '1+minisearch@7.2.0',
  semantics: 'reciprocal-one-based-native-rank',
  higherIsBetter: true,
} as const;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Reject unsupported evidence; retain raw evidence beside the mapped batch in the caller. */
export function mapNative(candidates: readonly CandidateBlock[]): readonly CandidateBlock[] {
  const sorted = [...candidates].sort(
    (a, b) => (a.retrieval?.rank ?? -1) - (b.retrieval?.rank ?? -1),
  );
  if (new Set(sorted.map((c) => c.block.id)).size !== sorted.length)
    throw new Error('duplicate_native_candidate');
  for (const [index, candidate] of sorted.entries()) {
    const r = candidate.retrieval;
    if (
      !r ||
      r.providerId !== NATIVE.providerId ||
      r.providerVersion !== NATIVE.providerVersion ||
      r.rank !== index ||
      !r.score ||
      r.score.semantics !== NATIVE.semantics ||
      r.score.higherIsBetter !== true ||
      !Number.isFinite(r.score.value) ||
      r.score.value <= 0 ||
      (index > 0 && r.score.value > sorted[index - 1]!.retrieval!.score!.value)
    )
      throw new Error('unsupported_native_evidence');
  }
  return sorted.map((c) => ({
    schemaVersion: 1,
    block: c.block,
    retrieval: {
      providerId: MAPPED.providerId,
      providerVersion: MAPPED.providerVersion,
      rank: c.retrieval!.rank!,
      score: {
        value: 1 / (c.retrieval!.rank! + 1),
        semantics: MAPPED.semantics,
        higherIsBetter: true,
      },
    },
  }));
}

/** Stable request preparation fixes order-dependent arithmetic without modifying native scores. */
export async function retrieveForProfile(request: CandidateProviderRequest) {
  const provider = new MiniSearchCandidateProvider({
    schemaVersion: 1,
    maxCandidates: Math.max(1, request.blocks.length),
  });
  const native = await provider.getCandidates({
    ...request,
    blocks: [...request.blocks].sort((a, b) => compare(a.id, b.id)),
    sourceDocuments: [...request.sourceDocuments].sort((a, b) => compare(a.id, b.id)),
  });
  return { native, mapped: mapNative(native) };
}

export function profilePolicy(scope: Scope = SCOPE): CompilationPolicy {
  return new CompilationPolicyValidator().validate({
    schemaVersion: 1,
    policyId: `phase22a:${PROFILE.id}`,
    policyVersion: PROFILE.version,
    scoring: {
      schemaVersion: 2,
      policyId: 'phase22a:minisearch:rank',
      policyVersion: '1',
      retrieval: {
        weight: 1,
        aggregation: 'max',
        rules: [{ ruleId: 'reciprocal-rank', ...MAPPED, min: 0, max: 1 }],
      },
      compatibility: { ignoredRetrievalContracts: [] },
      evidence: { scope, completeness: [{ component: 'retrieval', state: 'incomplete' }] },
    },
    filtering: {
      schemaVersion: 3,
      policyId: PROFILE.admissionPolicyId,
      policyVersion: PROFILE.admissionPolicyVersion,
      onIncompleteEvidence: 'admit',
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'phase22a:allocation',
      policyVersion: '1',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'phase22a:ordering',
      policyVersion: '1',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'phase22a:rendering',
      policyVersion: '1',
      format: 'jsonl-blocks',
    },
  });
}

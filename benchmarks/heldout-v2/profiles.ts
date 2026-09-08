import { CompilationPolicyValidator, type CompilationPolicy } from '@ctxalloc/compiler';
import type { Scope } from '@ctxalloc/domain';
import type { Profile } from './protocol.js';

export const SUPPORT = {
  providerId: 'heldout-v2-caller-evidence',
  providerVersion: '1',
  semantics: 'synthetic-support-grade-0-to-4',
  higherIsBetter: true,
} as const;
export const AUXILIARY = {
  providerId: 'heldout-v2-auxiliary-evidence',
  providerVersion: '1',
  semantics: 'synthetic-unrelated-magnitude',
  higherIsBetter: true,
} as const;
/** Evaluation-only identities fixed before authoring; the nine Phase 21D profiles are unchanged. */
export function evaluationProfile(id: Profile, scope: Scope): CompilationPolicy {
  const combined = id === 'combined-mixed';
  return new CompilationPolicyValidator().validate({
    schemaVersion: 1,
    policyId: `heldout-v2:${id}`,
    policyVersion: '1',
    scoring: {
      schemaVersion: 2,
      policyId: `heldout-v2:${id}:score`,
      policyVersion: '1',
      authoredPriority: { weight: 1, min: 0, max: 4 },
      ...(combined
        ? {
            retrieval: {
              weight: 1,
              aggregation: 'max',
              rules: [{ ruleId: 'caller-grade', ...SUPPORT, min: 0, max: 4 }],
            },
          }
        : {}),
      compatibility: { ignoredRetrievalContracts: combined ? [AUXILIARY] : [SUPPORT, AUXILIARY] },
      evidence: {
        scope,
        completeness: [
          {
            component: 'authoredPriority',
            state: id === 'complete' || combined ? 'complete' : 'incomplete',
          },
          ...(combined ? [{ component: 'retrieval', state: 'incomplete' }] : []),
        ],
      },
    },
    filtering: {
      schemaVersion: 3,
      policyId: `heldout-v2:${id}:admission`,
      policyVersion: '1',
      onIncompleteEvidence: id === 'incomplete-reject' ? 'reject' : 'admit',
      ...(id === 'curated' ? {} : { minimumTotalScore: combined ? 1 : 0.5 }),
      applicability: { scope, exclusions: [] },
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'heldout-v2:allocation',
      policyVersion: '1',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'heldout-v2:ordering',
      policyVersion: '1',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'heldout-v2:rendering',
      policyVersion: '1',
      format: 'jsonl-blocks',
    },
  });
}

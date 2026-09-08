import { CompilationPolicyValidator, type CompilationPolicy } from '@ctxalloc/compiler';
import type { Scope } from '@ctxalloc/domain';

export const EVIDENCE_SCOPE = {
  tenantId: 'evidence-development',
  workspaceId: 'observatory',
} as const;
export const GRADE_PROVIDER = {
  providerId: 'evidence-dev-synthetic-support',
  providerVersion: '1',
  semantics: 'caller-support-grade-0-to-4',
  higherIsBetter: true,
} as const;
export const IGNORED_PROVIDER = {
  providerId: 'evidence-dev-auxiliary-measurement',
  providerVersion: '1',
  semantics: 'synthetic-unrelated-magnitude',
  higherIsBetter: true,
} as const;
const definitions = {
  'authored-complete': { authored: 'complete', ignore: false, action: 'admit', minimum: 0.5 },
  'authored-complete-ignore': { authored: 'complete', ignore: true, action: 'admit', minimum: 0.5 },
  'retrieval-complete': { retrieval: 'complete', ignore: false, action: 'admit', minimum: 0.5 },
  'combined-complete-ignore': {
    authored: 'complete',
    retrieval: 'complete',
    ignore: true,
    action: 'admit',
    minimum: 1,
  },
  'authored-incomplete-admit': {
    authored: 'incomplete',
    ignore: false,
    action: 'admit',
    minimum: 0.5,
  },
  'authored-incomplete-reject': {
    authored: 'incomplete',
    ignore: false,
    action: 'reject',
    minimum: 0.5,
  },
  'combined-mixed-admit': {
    authored: 'complete',
    retrieval: 'incomplete',
    ignore: false,
    action: 'admit',
    minimum: 1,
  },
  'authored-incomplete-ignore': {
    authored: 'incomplete',
    ignore: true,
    action: 'admit',
    minimum: 0.5,
  },
  'curated-incomplete-ignore': { authored: 'incomplete', ignore: true, action: 'admit' },
} as const;
export type EvidenceProfileId = keyof typeof definitions;
export const EVIDENCE_PROFILE_IDS = Object.keys(definitions) as EvidenceProfileId[];

/** Caller-selected examples; no registry, automatic fallback, or change to admission-dev:* identities. */
export function evidenceProfile(
  id: EvidenceProfileId,
  scope: Scope = EVIDENCE_SCOPE,
): CompilationPolicy {
  const d = definitions[id];
  return new CompilationPolicyValidator().validate({
    schemaVersion: 1,
    policyId: `evidence-dev:${id}`,
    policyVersion: '1',
    scoring: {
      schemaVersion: 2,
      policyId: `evidence-dev:${id}:score`,
      policyVersion: '1',
      ...('authored' in d ? { authoredPriority: { weight: 1, min: 0, max: 4 } } : {}),
      ...('retrieval' in d
        ? {
            retrieval: {
              weight: 1,
              aggregation: 'max',
              rules: [{ ruleId: 'synthetic-support', ...GRADE_PROVIDER, min: 0, max: 4 }],
            },
          }
        : {}),
      compatibility: { ignoredRetrievalContracts: d.ignore ? [IGNORED_PROVIDER] : [] },
      evidence: {
        scope,
        completeness: [
          ...('authored' in d ? [{ component: 'authoredPriority', state: d.authored }] : []),
          ...('retrieval' in d ? [{ component: 'retrieval', state: d.retrieval }] : []),
        ],
      },
    },
    filtering: {
      schemaVersion: 3,
      policyId: `evidence-dev:${id}:admission`,
      policyVersion: '1',
      onIncompleteEvidence: d.action,
      ...('minimum' in d ? { minimumTotalScore: d.minimum } : {}),
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'evidence-dev:allocation',
      policyVersion: '1',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'evidence-dev:ordering',
      policyVersion: '1',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'evidence-dev:rendering',
      policyVersion: '1',
      format: 'jsonl-blocks',
    },
  });
}

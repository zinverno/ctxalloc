import { CompilationPolicyValidator, type CompilationPolicy } from '@ctxalloc/compiler';

export type AdmissionProfileId =
  'authored-support' | 'retrieval-support' | 'combined-support' | 'curated-history';
export const SUPPORT_PROVIDER = {
  providerId: 'admission-development-evidence-grades',
  providerVersion: '1',
  semantics: 'caller-support-grade-0-to-4',
  higherIsBetter: true,
} as const;

/** Development examples of the existing typed/versioned composition, not a kernel registry. */
export function admissionProfile(id: AdmissionProfileId): {
  readonly id: AdmissionProfileId;
  readonly version: '1';
  readonly scoreOwner: string;
  readonly missingEvidence: string;
  readonly thresholdDerivation: string;
  readonly policy: CompilationPolicy;
} {
  const retrieval = id === 'retrieval-support' || id === 'combined-support';
  const authored = id !== 'retrieval-support';
  const permissive = id === 'curated-history';
  const minimum = id === 'combined-support' ? 1 : 2 / 4;
  const policy = new CompilationPolicyValidator().validate({
    schemaVersion: 1,
    policyId: `admission-dev:${id}`,
    policyVersion: '1',
    scoring: {
      schemaVersion: 1,
      policyId: `admission-dev:${id}:score`,
      policyVersion: '1',
      ...(authored ? { authoredPriority: { weight: 1, min: 0, max: 4 } } : {}),
      ...(retrieval
        ? {
            retrieval: {
              weight: 1,
              aggregation: 'max',
              rules: [{ ruleId: 'support-grade', ...SUPPORT_PROVIDER, min: 0, max: 4 }],
            },
          }
        : {}),
    },
    filtering: {
      schemaVersion: 1,
      policyId: `admission-dev:${id}:admission`,
      policyVersion: '1',
      ...(permissive ? {} : { minimumTotalScore: minimum }),
    },
    allocation: {
      schemaVersion: 1,
      policyId: 'admission-dev:allocation',
      policyVersion: '1',
      optionalSelection: 'score-desc-greedy',
    },
    ordering: {
      schemaVersion: 1,
      policyId: 'admission-dev:ordering',
      policyVersion: '1',
      strategy: 'source-document-then-location',
    },
    rendering: {
      schemaVersion: 1,
      policyId: 'admission-dev:rendering',
      policyVersion: '1',
      format: 'jsonl-blocks',
    },
  });
  return {
    id,
    version: '1',
    policy,
    scoreOwner:
      id === 'retrieval-support'
        ? 'synthetic caller-owned evidence-grade provider'
        : id === 'combined-support'
          ? 'independent authored and synthetic provider support grades'
          : 'caller-authored support grades',
    missingEvidence: permissive
      ? 'caller curated the batch; missing and low numeric evidence stays eligible'
      : 'missing component supplies no positive support; threshold failure does not assert irrelevance; required bypass remains',
    thresholdDerivation: permissive
      ? 'no threshold; intentional caller curation'
      : id === 'combined-support'
        ? 'one support unit: grade 4 in one component or grade 2 in each'
        : 'minimum supporting grade 2 / scale maximum 4',
  };
}

export const ADMISSION_PROFILE_IDS: readonly AdmissionProfileId[] = [
  'authored-support',
  'retrieval-support',
  'combined-support',
  'curated-history',
];

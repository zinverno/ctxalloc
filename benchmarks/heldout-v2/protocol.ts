import type { ContextCompilerConfig } from '@ctxalloc/compiler';

export const BASELINE = '9dceacbd320ddaaa642b2484d876cec21c302d06';
export const DATASET = { id: 'ctxalloc-heldout-v2', version: '1', split: 'held-out' } as const;
export const COMPILER: ContextCompilerConfig = {
  schemaVersion: 1,
  compilerId: 'ctxalloc-heldout-v2',
  compilerVersion: '1',
  maxCorrectionSelections: 64,
};
export const REFERENCE_TIME = '2026-09-01T12:00:00.000Z';
export const PROFILES = [
  'complete',
  'incomplete-admit',
  'incomplete-reject',
  'curated',
  'combined-mixed',
] as const;
export const STRATA = [
  'focused',
  'distributed',
  'density',
  'evidence-gaps',
  'temporal-records',
  'guardrails',
] as const;
export const CONDITIONS = [
  'truthful-complete',
  'truthful-incomplete',
  'misleading-complete',
  'permissive-curated',
  'negative-contract',
] as const;
export type Profile = (typeof PROFILES)[number];
export type Stratum = (typeof STRATA)[number];
export type Condition = (typeof CONDITIONS)[number];
export type BudgetRegime = 'tight' | 'generous';
export interface ExpectedFailure {
  readonly stage: string;
  readonly issueCode: string;
}
export type Mutation =
  | 'unsupported'
  | 'wrong-tuple'
  | 'evidence-scope'
  | 'candidate-scope'
  | 'missing-completeness'
  | 'future-signal'
  | 'required-applicability'
  | 'rule-ignore-overlap'
  | 'missing-applicability-target';
const negatives: Readonly<Record<Profile, readonly [Mutation, Mutation]>> = {
  complete: ['unsupported', 'wrong-tuple'],
  'incomplete-admit': ['evidence-scope', 'candidate-scope'],
  'incomplete-reject': ['missing-completeness', 'future-signal'],
  curated: ['candidate-scope', 'required-applicability'],
  'combined-mixed': ['rule-ignore-overlap', 'missing-applicability-target'],
};
const negativeFailure: Readonly<Record<Mutation, ExpectedFailure>> = {
  unsupported: { stage: 'evidence-validation', issueCode: 'retrieval_score_rule_not_found' },
  'wrong-tuple': { stage: 'evidence-validation', issueCode: 'retrieval_score_rule_not_found' },
  'evidence-scope': { stage: 'evidence-validation', issueCode: 'evidence_scope_mismatch' },
  'candidate-scope': { stage: 'candidate-validation', issueCode: 'scope_mismatch' },
  'missing-completeness': { stage: 'request-validation', issueCode: 'invalid_scoring_policy' },
  'future-signal': { stage: 'request-validation', issueCode: 'invalid_request' },
  'required-applicability': { stage: 'filtering', issueCode: 'required_applicability_conflict' },
  'rule-ignore-overlap': { stage: 'request-validation', issueCode: 'invalid_scoring_policy' },
  'missing-applicability-target': { stage: 'filtering', issueCode: 'missing_applicability_target' },
};
/** Case slots, labels, budgets and failures are fixed before any source content is authored. */
export const MATRIX = PROFILES.flatMap((profile, p) =>
  STRATA.flatMap((stratum, s) =>
    ([0, 1] as const).map((replica) => {
      const mutation = stratum === 'guardrails' ? negatives[profile][replica] : null;
      const rejectsIncomplete =
        profile === 'incomplete-reject' &&
        (stratum === 'focused' ||
          stratum === 'distributed' ||
          stratum === 'evidence-gaps' ||
          (stratum === 'density' && replica === 1));
      const evidenceCondition: Condition =
        mutation !== null
          ? 'negative-contract'
          : profile === 'complete'
            ? stratum === 'evidence-gaps'
              ? 'misleading-complete'
              : 'truthful-complete'
            : profile === 'curated'
              ? 'permissive-curated'
              : 'truthful-incomplete';
      const expectedFailure: ExpectedFailure | null =
        mutation !== null
          ? negativeFailure[mutation]
          : rejectsIncomplete
            ? { stage: 'filtering', issueCode: 'incomplete_admission_evidence' }
            : null;
      // Only truthful complete exclusions or explicit unusability/duplicates promise compression.
      const reductionExpected =
        expectedFailure === null &&
        evidenceCondition !== 'misleading-complete' &&
        ((profile === 'complete' &&
          (stratum === 'focused' ||
            stratum === 'distributed' ||
            (stratum === 'density' && replica === 1))) ||
          stratum === 'temporal-records' ||
          stratum === 'distributed');
      return {
        id: `ev2-${String(p * 12 + s * 2 + replica + 1).padStart(3, '0')}`,
        profile,
        stratum,
        replica,
        budgetRegime: (replica === 0 ? 'tight' : 'generous') as BudgetRegime,
        availableTokens: replica === 0 ? 160 : 1000,
        evidenceCondition,
        expectedFailure,
        mutation,
        reductionExpected,
      };
    }),
  ),
);
export type CasePlan = (typeof MATRIX)[number];
export function planFor(id: string): CasePlan {
  const plan = MATRIX.find((row) => row.id === id);
  if (plan === undefined) throw new Error('Case ID is not preregistered.');
  return plan;
}
export const METRICS = {
  id: 'ctxalloc-heldout-v2-metrics',
  version: '1',
  units: 'explicit exact-content groups; wrapper multiplicity does not multiply truth',
  facts: 'OR across evidence groups, AND within each; critical=3 major=2 minor=1',
  ratios:
    'micro sums numerator/denominator; macro averages defined case ratios; empty denominators null',
  admission: 'runtime-optional groups; useful and applicable labels supply the numerator',
  irrelevantRejection:
    'non-included irrelevant units / all irrelevant units; includes filtering and budget exclusions',
  reduction:
    'existing EvaluationHarness full-wrapper JSONL baseline minus final compiled rendered tokens, unclamped ratio',
  median: 'nearest rank p50',
  repeats: 3,
  failures:
    '17 preregistered failures have no selection-quality denominator; unexpected outcomes fail coverage',
  misleading:
    'included in every overall/segment report; excluded from primary effectiveness gates; separate required risk disclosure gate has no impossible semantic-recovery threshold',
  timing: 'NOT_MEASURED',
  liveAnswerQuality: 'NOT_EVALUATED',
} as const;
export const GATE_LIMITS = {
  id: 'ctxalloc-heldout-v2-gates',
  version: '1',
  cases: 60,
  expectedSuccesses: 43,
  expectedFailures: 17,
  runtimeRequired: 1,
  budgetViolations: 0,
  crossScopeInclusions: 0,
  scopeFailures: 2,
  accounting: 1,
  repeatAgreement: 1,
  comparisons: 120,
  contractMismatches: 0,
  usefulBlockRecall: 0.95,
  usefulFactCoverage: 0.95,
  criticalFactCoverage: 1,
  weightedRequiredFactCoverage: 1,
  optionalAdmissionRecall: 0.95,
  caseUsefulMinimum: 0.8,
  precisionByProfile: {
    complete: 0.8,
    'incomplete-admit': 0.5,
    'incomplete-reject': 0.8,
    curated: 0.5,
    'combined-mixed': 0.5,
  },
  reductionOverallMedian: 0.2,
  reductionProfileMedian: 0.15,
  reductionConditionMedian: 0.15,
  misleadingCases: 2,
} as const;

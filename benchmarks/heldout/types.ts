import type { CompilationRequest, ContextCompilerConfig } from '@ctxalloc/compiler';
import type { EvaluationFactImportance } from '@ctxalloc/evaluation';
import type { AdmissionProfileId } from '../admission-development/profiles.js';

export const PROFILES = [
  'authored-support',
  'retrieval-support',
  'combined-support',
  'curated-history',
] as const;
export const STRATA = [
  'direct-noise',
  'complementary',
  'all-none',
  'missing-conflicting',
  'older-history',
  'applicability-duplicates',
] as const;
export type Stratum = (typeof STRATA)[number];
export type Regime = 'tight' | 'generous';
export type Applicability = 'applicable' | 'inapplicable' | 'superseded';
export interface Unit {
  readonly id: string;
  readonly blockIds: readonly string[];
  readonly useful: boolean;
  readonly applicability: Applicability;
}
export interface Fact {
  readonly id: string;
  readonly description: string;
  readonly useful: boolean;
  readonly required: boolean;
  readonly importance: EvaluationFactImportance;
  readonly evidenceBlockGroups: readonly (readonly string[])[];
}
export interface Annotations {
  readonly requiredBlockIds: readonly string[];
  readonly units: readonly Unit[];
  readonly facts: readonly Fact[];
  readonly runtimeObligations: readonly { readonly blockId: string; readonly rationale: string }[];
  readonly evidenceCondition: 'complete' | 'missing' | 'conflicting' | 'curation-stress';
  readonly ambiguityResolution: string;
  readonly expectedFailure: { readonly stage: string; readonly issueCode: string } | null;
}
export interface HeldoutCase {
  readonly id: string;
  readonly profile: AdmissionProfileId;
  readonly stratum: Stratum;
  readonly replica: 0 | 1;
  readonly budgetRegime: Regime;
  readonly input: CompilationRequest;
  readonly annotations: Annotations;
}
export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
}
export const RATIO_NAMES = [
  'requiredBlockRecall',
  'usefulBlockRecall',
  'usefulFactCoverage',
  'weightedRequiredFactCoverage',
  'criticalFactCoverage',
  'optionalAdmissionPrecision',
  'optionalAdmissionRecall',
  'runtimeRequiredGroupRecall',
] as const;
export type RatioName = (typeof RATIO_NAMES)[number];
export type Ratios = Readonly<Record<RatioName, Ratio>>;
export const DATASET = { id: 'ctxalloc-heldout-v1', version: '1', split: 'held-out' } as const;
export const BASELINE = 'e24a42a71d414ce6de1e8c46de98094100cb7bc1';
export const PROTOCOL_REVISION = '36d468aee5e34d287df43aaf971cd25984b08453';
export const COMPILER: ContextCompilerConfig = {
  schemaVersion: 1,
  compilerId: 'ctxalloc-heldout',
  compilerVersion: '1',
  maxCorrectionSelections: 64,
};
export const REFERENCE_TIME = '2026-08-15T09:00:00.000Z';

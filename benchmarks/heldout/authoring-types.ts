import type { SourceType } from '@ctxalloc/domain';
import type { HeldoutCase } from './types.js';

/** Runtime fields and evaluator judgments are authored separately before freezing. */
export interface AuthoredSeed {
  readonly id: string;
  readonly profile: HeldoutCase['profile'];
  readonly stratum: HeldoutCase['stratum'];
  readonly replica: 0 | 1;
  readonly query: string;
  readonly blocks: readonly {
    readonly key: string;
    readonly content: string;
    readonly sourceType: SourceType;
    readonly priority?: number;
    readonly retrievalGrade?: number;
    readonly runtimeRequired?: boolean;
    readonly createdAt?: string;
    readonly foreign?: boolean;
  }[];
  readonly candidateOrder: readonly string[];
  readonly declarations: readonly {
    readonly key: string;
    readonly reason: 'inapplicable' | 'superseded';
  }[];
  readonly judgments: {
    readonly usefulKeys: readonly string[];
    readonly requiredBlockKeys: readonly string[];
    readonly requiredFactKeys: readonly string[];
    readonly criticalFactKeys: readonly string[];
    readonly duplicateAlternatives: readonly (readonly string[])[];
    readonly callerObligations: readonly { readonly key: string; readonly rationale: string }[];
    readonly evidenceCondition: HeldoutCase['annotations']['evidenceCondition'];
    readonly ambiguityResolution: string;
    readonly combinedFactKeys: readonly string[];
    readonly intendedDispositions: readonly {
      readonly key: string;
      readonly reason: 'inapplicable' | 'superseded';
    }[];
  };
}

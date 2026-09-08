import type { Fact, Unit } from '../heldout/types.js';
import type { CasePlan } from './protocol.js';
export type { Fact, Unit } from '../heldout/types.js';
export interface Annotations {
  readonly units: readonly Unit[];
  readonly facts: readonly Fact[];
  readonly requiredBlockIds: readonly string[];
  readonly runtimeObligations: readonly { readonly blockId: string; readonly rationale: string }[];
  readonly duplicateGroups: readonly (readonly string[])[];
  readonly rationale: string;
}
export interface HeldoutCase extends CasePlan {
  /** Deliberately malformed negative requests still reach the actual compiler boundary. */
  readonly input: unknown;
  readonly annotations: Annotations;
}

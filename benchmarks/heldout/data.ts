import { createHash } from 'node:crypto';
import { CompilationRequestValidator } from '@ctxalloc/compiler';
import { admissionProfile } from '../admission-development/profiles.js';
import {
  PROFILES,
  STRATA,
  type Annotations,
  type Fact,
  type HeldoutCase,
  type Unit,
} from './types.js';

export function fail(message = 'Held-out frozen data is invalid.'): never {
  throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
export function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return fail();
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return fail();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return fail();
  return value;
}
export function enumValue<T extends string>(value: unknown, values: readonly T[]): T {
  const result = values.find((v) => v === value);
  if (result === undefined) return fail();
  return result;
}
function strings(value: unknown): readonly string[] {
  return array(value).map(string);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) fail();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(object(value)[key]))
        .join(',') +
      '}'
    );
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return fail();
  return encoded;
}
export const hashBytes = (value: string | Uint8Array): string =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
export const hashJson = (value: unknown): string => hashBytes(canonical(value));
export function parseAnnotations(value: unknown): Annotations {
  const raw = object(value);
  keys(raw, [
    'requiredBlockIds',
    'units',
    'facts',
    'runtimeObligations',
    'evidenceCondition',
    'ambiguityResolution',
    'expectedFailure',
  ]);
  const units: Unit[] = array(raw.units).map((v) => {
    const u = object(v);
    keys(u, ['id', 'blockIds', 'useful', 'applicability']);
    return {
      id: string(u.id),
      blockIds: strings(u.blockIds),
      useful: boolean(u.useful),
      applicability: enumValue(u.applicability, ['applicable', 'inapplicable', 'superseded']),
    };
  });
  const facts: Fact[] = array(raw.facts).map((v) => {
    const f = object(v);
    keys(f, ['id', 'description', 'useful', 'required', 'importance', 'evidenceBlockGroups']);
    return {
      id: string(f.id),
      description: string(f.description),
      useful: boolean(f.useful),
      required: boolean(f.required),
      importance: enumValue(f.importance, ['critical', 'major', 'minor']),
      evidenceBlockGroups: array(f.evidenceBlockGroups).map(strings),
    };
  });
  const obligations = array(raw.runtimeObligations).map((v) => {
    const r = object(v);
    keys(r, ['blockId', 'rationale']);
    return { blockId: string(r.blockId), rationale: string(r.rationale) };
  });
  const failure = raw.expectedFailure === null ? null : object(raw.expectedFailure);
  if (failure !== null) keys(failure, ['stage', 'issueCode']);
  return {
    requiredBlockIds: strings(raw.requiredBlockIds),
    units,
    facts,
    runtimeObligations: obligations,
    evidenceCondition: enumValue(raw.evidenceCondition, [
      'complete',
      'missing',
      'conflicting',
      'curation-stress',
    ]),
    ambiguityResolution: string(raw.ambiguityResolution),
    expectedFailure:
      failure === null
        ? null
        : { stage: string(failure.stage), issueCode: string(failure.issueCode) },
  };
}
export function parseCase(value: unknown): HeldoutCase {
  const raw = object(value);
  keys(raw, ['id', 'profile', 'stratum', 'replica', 'budgetRegime', 'input', 'annotations']);
  if (raw.replica !== 0 && raw.replica !== 1) return fail();
  const entry: HeldoutCase = {
    id: string(raw.id),
    profile: enumValue(raw.profile, PROFILES),
    stratum: enumValue(raw.stratum, STRATA),
    replica: raw.replica,
    budgetRegime: enumValue(raw.budgetRegime, ['tight', 'generous']),
    input: new CompilationRequestValidator().validate(raw.input),
    annotations: parseAnnotations(raw.annotations),
  };
  validateAnnotations(entry);
  return entry;
}
/** Structural checks only: never deduplicate, score, filter, render or compile. */
export function validateAnnotations(entry: HeldoutCase): void {
  const blocks = new Map(entry.input.candidates.map((c) => [String(c.block.id), c.block]));
  const allIds = new Set<string>();
  const unitIds = new Set<string>();
  const unitFor = new Map<string, Unit>();
  for (const unit of entry.annotations.units) {
    if (
      unitIds.has(unit.id) ||
      unit.blockIds.length === 0 ||
      (unit.useful && unit.applicability !== 'applicable')
    )
      fail();
    unitIds.add(unit.id);
    const hashes = new Set<string>();
    for (const id of unit.blockIds) {
      const b = blocks.get(id);
      if (b === undefined || allIds.has(id)) fail();
      allIds.add(id);
      unitFor.set(id, unit);
      hashes.add(b.normalizedContentHash);
    }
    if (hashes.size !== 1) fail();
  }
  if (allIds.size !== blocks.size) fail();
  // Two units may not split an exact-content group and bias admission denominators.
  const contentGroups = new Set<string>();
  for (const unit of entry.annotations.units) {
    const hash = blocks.get(unit.blockIds[0]!)!.normalizedContentHash;
    if (contentGroups.has(hash)) fail();
    contentGroups.add(hash);
  }
  const factIds = new Set<string>();
  for (const fact of entry.annotations.facts) {
    if (
      factIds.has(fact.id) ||
      fact.evidenceBlockGroups.length === 0 ||
      (fact.required && !fact.useful) ||
      (fact.importance === 'critical' && !fact.required)
    )
      fail();
    factIds.add(fact.id);
    for (const group of fact.evidenceBlockGroups) {
      if (group.length === 0 || new Set(group).size !== group.length) fail();
      for (const id of group) {
        if (!allIds.has(id) || (fact.useful && !unitFor.get(id)!.useful)) fail();
      }
    }
  }
  const required = entry.annotations.requiredBlockIds;
  if (
    new Set(required).size !== required.length ||
    required.some((id) => !allIds.has(id) || !unitFor.get(id)!.useful)
  )
    fail();
  const runtime = [
    ...new Set(
      entry.input.candidates
        .filter((c) => c.block.attributes.required === true)
        .map((c) => String(c.block.id)),
    ),
  ].sort();
  const obligations = entry.annotations.runtimeObligations.map((r) => r.blockId).sort();
  if (JSON.stringify(runtime) !== JSON.stringify(obligations)) fail();
  const profile = admissionProfile(entry.profile).policy;
  const expected =
    entry.input.policy.filtering.schemaVersion === 1
      ? profile
      : {
          ...profile,
          filtering: {
            ...profile.filtering,
            schemaVersion: 2,
            policyVersion: '1-applicability',
            applicability: entry.input.policy.filtering.applicability,
          },
        };
  if (hashJson(entry.input.policy) !== hashJson(expected))
    fail('A held-out request changes a fixed Phase 21B policy.');
}
export function validateMatrix(cases: readonly HeldoutCase[]): void {
  if (cases.length !== 48 || new Set(cases.map((c) => c.id)).size !== 48) fail();
  const blockIds = new Set<string>();
  for (const [p, profile] of PROFILES.entries())
    for (const [s, stratum] of STRATA.entries())
      for (const replica of [0, 1] as const) {
        const matches = cases.filter(
          (c) => c.profile === profile && c.stratum === stratum && c.replica === replica,
        );
        if (matches.length !== 1) fail();
        const c = matches[0]!;
        const regime = (p + s + replica) % 2 === 0 ? 'tight' : 'generous';
        if (
          c.budgetRegime !== regime ||
          c.input.budget.reservedOutputTokens !== 100 ||
          c.input.budget.totalTokens !== (regime === 'tight' ? 280 : 1000)
        )
          fail();
        const expectedFailure = stratum === 'applicability-duplicates' && replica === 1;
        if (
          expectedFailure
            ? c.annotations.expectedFailure?.stage !== 'candidate-validation' ||
              c.annotations.expectedFailure.issueCode !== 'scope_mismatch'
            : c.annotations.expectedFailure !== null
        )
          fail();
        for (const id of new Set(
          c.input.candidates.map((candidate) => String(candidate.block.id)),
        )) {
          if (blockIds.has(id)) fail();
          blockIds.add(id);
        }
      }
}

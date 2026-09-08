import { ScopeSchema, normalizeContextBlockContentForHash } from '@ctxalloc/domain';
import { evaluationProfile, SUPPORT } from './profiles.js';
import {
  CandidateEvidenceError,
  CandidateScorer,
  CandidateValidationError,
  CandidateValidator,
  CompilationRequestError,
  CompilationRequestValidator,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { array, enumValue, hashJson, object, string } from '../heldout/data.js';
import { MATRIX, planFor, type ExpectedFailure } from './protocol.js';
import type { Annotations, HeldoutCase } from './types.js';
export { array, hashBytes, hashJson, object, string } from '../heldout/data.js';
export function fail(message = 'Second held-out data or protocol is invalid.'): never {
  throw new Error(message);
}
export function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  if (
    required.some((k) => !(k in value)) ||
    Object.keys(value).some((k) => !required.includes(k) && !optional.includes(k))
  )
    fail('Unknown or missing authoring field.');
}
const boolean = (value: unknown): boolean => (typeof value === 'boolean' ? value : fail());
const strings = (value: unknown): readonly string[] => array(value).map(string);
function annotations(value: unknown): Annotations {
  const a = object(value);
  keys(a, [
    'units',
    'facts',
    'requiredBlockIds',
    'runtimeObligations',
    'duplicateGroups',
    'rationale',
  ]);
  return {
    units: array(a.units).map((v) => {
      const u = object(v);
      keys(u, ['id', 'blockIds', 'useful', 'applicability']);
      return {
        id: string(u.id),
        blockIds: strings(u.blockIds),
        useful: boolean(u.useful),
        applicability: enumValue(u.applicability, ['applicable', 'inapplicable', 'superseded']),
      };
    }),
    facts: array(a.facts).map((v) => {
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
    }),
    requiredBlockIds: strings(a.requiredBlockIds),
    runtimeObligations: array(a.runtimeObligations).map((v) => {
      const o = object(v);
      keys(o, ['blockId', 'rationale']);
      return { blockId: string(o.blockId), rationale: string(o.rationale) };
    }),
    duplicateGroups: array(a.duplicateGroups).map(strings),
    rationale: string(a.rationale),
  };
}
function finding(error: unknown, stage: string): ExpectedFailure {
  if (
    error instanceof CompilationRequestError ||
    error instanceof CandidateValidationError ||
    error instanceof CandidateEvidenceError
  )
    return { stage, issueCode: error.issues[0]?.code ?? 'unknown_issue' };
  throw error;
}
/** Schema and cross-field validation only. It never calculates scores or executes selection. */
export function authoringFinding(input: unknown, tokenizer: Tokenizer): ExpectedFailure | null {
  let request;
  try {
    request = new CompilationRequestValidator().validate(input);
  } catch (e) {
    return finding(e, 'request-validation');
  }
  let validated;
  try {
    validated = new CandidateValidator(tokenizer).validate({
      scope: request.scope,
      sourceDocuments: request.sourceDocuments,
      candidates: request.candidates,
    });
  } catch (e) {
    return finding(e, 'candidate-validation');
  }
  try {
    new CandidateScorer(request.policy.scoring).validateEvidence(validated);
  } catch (e) {
    return finding(e, 'evidence-validation');
  }
  const filter = request.policy.filtering;
  if ('applicability' in filter && filter.applicability !== undefined) {
    if (hashJson(filter.applicability.scope) !== hashJson(request.scope))
      return { stage: 'filtering', issueCode: 'applicability_scope_mismatch' };
    const reasons = new Map<string, string>();
    for (const exclusion of filter.applicability.exclusions) {
      const target = request.candidates.find((c) => c.block.id === exclusion.blockId);
      if (target === undefined)
        return { stage: 'filtering', issueCode: 'missing_applicability_target' };
      // Structural equality of validated content hashes establishes only the target group, never its score or selection.
      const group = request.candidates.filter(
        (c) =>
          c.block.normalizedContentHash === target.block.normalizedContentHash &&
          normalizeContextBlockContentForHash(c.block.content) ===
            normalizeContextBlockContentForHash(target.block.content),
      );
      if (group.some((c) => c.block.attributes.required === true))
        return { stage: 'filtering', issueCode: 'required_applicability_conflict' };
      const key = target.block.normalizedContentHash;
      if (reasons.has(key) && reasons.get(key) !== exclusion.reason)
        return { stage: 'filtering', issueCode: 'conflicting_applicability_declarations' };
      reasons.set(key, exclusion.reason);
    }
  }
  return null;
}
export function parseCase(value: unknown, tokenizer: Tokenizer): HeldoutCase {
  const raw = object(value);
  const plan = planFor(string(raw.id));
  keys(raw, [...Object.keys(plan), 'input', 'annotations']);
  for (const [key, expected] of Object.entries(plan))
    if (hashJson(raw[key]) !== hashJson(expected)) fail('Preregistered case plan changed.');
  const input = object(raw.input);
  const scope = ScopeSchema.parse(input.scope);
  if (
    hashJson(scope) !==
    hashJson({ tenantId: 'heldout-v2', workspaceId: 'second-freeze', projectId: plan.id })
  )
    fail('Case scope changed.');
  const actualPolicy = object(input.policy);
  const filter = object(actualPolicy.filtering);
  const applicability = object(filter.applicability);
  const expectedPolicy = object(JSON.parse(JSON.stringify(evaluationProfile(plan.profile, scope))));
  object(object(expectedPolicy.filtering).applicability).exclusions = applicability.exclusions;
  const score = object(expectedPolicy.scoring);
  if (plan.mutation === 'evidence-scope')
    object(score.evidence).scope = { ...scope, projectId: plan.id + ':foreign' };
  if (plan.mutation === 'missing-completeness') object(score.evidence).completeness = [];
  if (plan.mutation === 'rule-ignore-overlap')
    object(score.compatibility).ignoredRetrievalContracts = [
      ...array(object(score.compatibility).ignoredRetrievalContracts),
      SUPPORT,
    ];
  if (hashJson(actualPolicy) !== hashJson(expectedPolicy))
    fail('Frozen profile semantics changed.');
  const budget = object(input.budget);
  if (budget.totalTokens !== plan.availableTokens + 100 || budget.reservedOutputTokens !== 100)
    fail('Preregistered budget changed.');
  const a = annotations(raw.annotations);
  const candidates = array(input.candidates).map((c) => object(object(c).block));
  const ids = new Set(candidates.map((c) => string(c.id)));
  const unitIds = a.units.flatMap((u) => u.blockIds);
  if (
    unitIds.length !== ids.size ||
    new Set(unitIds).size !== ids.size ||
    unitIds.some((id) => !ids.has(id))
  )
    fail('Truth units must partition block IDs.');
  if (
    new Set(a.units.map((u) => u.id)).size !== a.units.length ||
    new Set(a.facts.map((f) => f.id)).size !== a.facts.length
  )
    fail('Annotation IDs must be unique.');
  for (const f of a.facts) {
    if (
      f.evidenceBlockGroups.length === 0 ||
      f.evidenceBlockGroups.some((g) => g.length === 0 || g.some((id) => !ids.has(id)))
    )
      fail('Invalid fact evidence groups.');
    if ((f.required || f.importance === 'critical') && !f.useful)
      fail('Required and critical truth must be useful.');
  }
  if (a.requiredBlockIds.some((id) => !ids.has(id))) fail('Unknown evaluator-required block.');
  const runtime = [
    ...new Set(
      candidates.filter((c) => object(c.attributes).required === true).map((c) => string(c.id)),
    ),
  ].sort();
  if (hashJson(runtime) !== hashJson(a.runtimeObligations.map((o) => o.blockId).sort()))
    fail('Runtime obligations need separate caller rationales.');
  for (const u of a.units) {
    const hashes = new Set(
      candidates
        .filter((c) => u.blockIds.includes(string(c.id)))
        .map((c) => string(c.normalizedContentHash)),
    );
    if (hashes.size !== 1) fail('One truth unit must describe exact-content alternatives.');
  }
  const unitHashes = a.units.map((u) =>
    string(candidates.find((c) => c.id === u.blockIds[0])!.normalizedContentHash),
  );
  if (new Set(unitHashes).size !== unitHashes.length)
    fail('Duplicate content must have one truth unit.');
  const duplicates = a.units
    .filter((u) => u.blockIds.length > 1)
    .map((u) => [...u.blockIds].sort())
    .sort((a, b) => (hashJson(a) < hashJson(b) ? -1 : hashJson(a) > hashJson(b) ? 1 : 0));
  const expectedDuplicates = a.duplicateGroups
    .map((g) => [...g].sort())
    .sort((a, b) => (hashJson(a) < hashJson(b) ? -1 : hashJson(a) > hashJson(b) ? 1 : 0));
  if (hashJson(duplicates) !== hashJson(expectedDuplicates))
    fail('Duplicate annotations must match truth units.');
  if (plan.expectedFailure === null) {
    const declared = array(applicability.exclusions).map(object);
    for (const u of a.units) {
      const exclusion = declared.find((d) => u.blockIds.includes(string(d.blockId)));
      if (u.applicability !== (exclusion?.reason ?? 'applicable'))
        fail('Truth applicability differs from the caller declaration.');
    }
    if (plan.reductionExpected && plan.stratum === 'distributed' && duplicates.length === 0)
      fail('Distributed reduction requires authored duplicate alternatives.');
    if (
      plan.reductionExpected &&
      plan.stratum === 'temporal-records' &&
      !a.units.some((u) => !u.useful && u.applicability !== 'applicable')
    )
      fail('Temporal reduction requires explicitly unusable truth.');
    if (
      plan.reductionExpected &&
      plan.profile === 'complete' &&
      !['distributed', 'temporal-records'].includes(plan.stratum) &&
      !a.units.some((u) => !u.useful)
    )
      fail('Complete-evidence reduction requires irrelevant truth.');
  }
  const observed = authoringFinding(raw.input, tokenizer);
  // Incomplete threshold rejection is preregistered, but must not be predicted by executing any admission arithmetic here.
  const expectedStatic =
    plan.expectedFailure?.issueCode === 'incomplete_admission_evidence'
      ? null
      : plan.expectedFailure;
  if (hashJson(observed) !== hashJson(expectedStatic))
    fail(
      `Static compatibility differs for ${plan.id}: ${JSON.stringify(observed)}; expected ${JSON.stringify(expectedStatic)}.`,
    );
  return { ...plan, input: raw.input, annotations: a };
}
export function validateMatrix(cases: readonly HeldoutCase[]) {
  if (
    cases.length !== MATRIX.length ||
    new Set(cases.map((c) => c.id)).size !== MATRIX.length ||
    cases.some((c, i) => c.id !== MATRIX[i]?.id)
  )
    fail('Exact preregistered matrix and order required.');
}

import { isDeepStrictEqual } from 'node:util';
import {
  CompilationRequestValidator,
  ContextCompilationError,
  ContextCompiler,
  SettledCompilationTraceValidator,
} from '@ctxalloc/compiler';
import type { Tokenizer } from '@ctxalloc/ports';
import { measureCorrectness } from '../acceptance/correctness.js';
import { buildEvidenceDevelopment, EVIDENCE_COMPILER, EVIDENCE_DATASET } from './cases.js';
import { EVIDENCE_PROFILE_IDS, evidenceProfile } from './profiles.js';

const sameIds = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  value: denominator === 0 ? null : numerator / denominator,
});
interface Effectiveness {
  usefulPreservation: ReturnType<typeof ratio>;
  irrelevantRejection: ReturnType<typeof ratio>;
  admissionPrecision: ReturnType<typeof ratio>;
  admissionRecall: ReturnType<typeof ratio>;
}
function aggregate(rows: readonly Effectiveness[]) {
  return Object.fromEntries(
    (
      [
        'usefulPreservation',
        'irrelevantRejection',
        'admissionPrecision',
        'admissionRecall',
      ] as const
    ).map((metric) => {
      const values = rows.map((r) => r[metric]);
      const defined = values.flatMap((v) => (v.value === null ? [] : [v.value]));
      return [
        metric,
        {
          micro: ratio(
            values.reduce((n, v) => n + v.numerator, 0),
            values.reduce((n, v) => n + v.denominator, 0),
          ),
          macro: defined.length === 0 ? null : defined.reduce((a, b) => a + b, 0) / defined.length,
          applicableCases: defined.length,
        },
      ];
    }),
  );
}

/** Development correctness assertions and independent useful-unit observations; no product acceptance gates. */
export function evaluateEvidenceDevelopment(tokenizer: Tokenizer) {
  const compiler = new ContextCompiler(EVIDENCE_COMPILER, tokenizer);
  const cases = buildEvidenceDevelopment(tokenizer).map((entry) => {
    const base = {
      caseId: entry.id,
      candidateWrappers: entry.candidateWrappers,
      profile: entry.profile,
      coverage: entry.coverage,
      budgetRegime: entry.budgetRegime,
      evidenceQuality: entry.evidenceQuality,
      truth: entry.truth,
      expected: entry.expected,
    };
    try {
      const result = compiler.compile(entry.input);
      const request = new CompilationRequestValidator().validate(entry.input);
      const admitted: string[] = result.trace.groups
        .filter((g) => g.filtering.decision === 'eligible')
        .map((g) => g.canonical.id);
      const included: string[] = result.includedBlocks.map((b) => b.id);
      const uncertain = result.trace.groups
        .filter((g) => g.filtering.reason === 'ELIGIBLE_INCOMPLETE_EVIDENCE')
        .map((g) => g.canonical.id);
      const correctness = measureCorrectness(request, result, tokenizer);
      const repeat = compiler.compile(entry.input);
      const permuted = compiler.compile({
        ...request,
        candidates: [...request.candidates].reverse(),
      });
      const traceReader = new SettledCompilationTraceValidator().validate(
        JSON.parse(JSON.stringify(result.trace)),
      );
      const checks = {
        expectedSuccess: entry.expected.failure === null,
        admissionMatches: sameIds(admitted, entry.expected.admitted),
        finalSelectionMatches: sameIds(included, entry.expected.included),
        uncertaintyMatches: sameIds(uncertain, entry.expected.uncertain),
        requiredPreserved: result.trace.groups
          .filter((g) => g.canonical.required)
          .every((g) => included.includes(g.canonical.id)),
        withinBudget: result.usage.compiledTokens <= result.usage.availableTokens,
        correctnessReconciles: Object.values(correctness).every((v) =>
          typeof v === 'number' ? v === 0 : v.numerator === v.denominator,
        ),
        repeatedExactly: JSON.stringify(result) === JSON.stringify(repeat),
        permutationStable:
          JSON.stringify(result.trace.groups) === JSON.stringify(permuted.trace.groups) &&
          result.compiledContext === permuted.compiledContext,
        persistedTraceMatches: isDeepStrictEqual(traceReader, result.trace),
        evidenceObservable:
          result.trace.schemaVersion === 4 &&
          result.trace.groups.every((g) => g.score.evidence?.components.length === 5),
      };
      const useful = entry.truth.filter((u) => u.useful);
      const irrelevant = entry.truth.filter((u) => !u.useful);
      const effectiveness: Effectiveness = {
        usefulPreservation: ratio(
          useful.filter((u) => included.includes(u.unitId)).length,
          useful.length,
        ),
        irrelevantRejection: ratio(
          irrelevant.filter((u) => !included.includes(u.unitId)).length,
          irrelevant.length,
        ),
        admissionPrecision: ratio(
          useful.filter((u) => admitted.includes(u.unitId)).length,
          admitted.length,
        ),
        admissionRecall: ratio(
          useful.filter((u) => admitted.includes(u.unitId)).length,
          useful.length,
        ),
      };
      return {
        ...base,
        compilation: 'success',
        checks,
        contractCorrect: Object.values(checks).every(Boolean),
        failure: null,
        effectiveness,
        correctness,
        usage: result.usage,
        trace: result.trace,
      };
    } catch (error) {
      if (!(error instanceof ContextCompilationError)) throw error;
      const failure = { stage: error.stage, issueCodes: error.issues.map((i) => i.code) };
      let repeatedFailure = false;
      try {
        compiler.compile(entry.input);
      } catch (again) {
        repeatedFailure =
          again instanceof ContextCompilationError &&
          again.stage === error.stage &&
          JSON.stringify(again.issues) === JSON.stringify(error.issues);
      }
      const checks = {
        expectedFailure: entry.expected.failure !== null,
        stageMatches: failure.stage === entry.expected.failure?.stage,
        issueMatches: failure.issueCodes.includes(entry.expected.failure?.issueCode ?? ''),
        repeatedFailure,
      };
      return {
        ...base,
        compilation: 'failed',
        checks,
        contractCorrect: Object.values(checks).every(Boolean),
        failure,
        effectiveness: null,
        correctness: null,
        usage: null,
        trace: null,
      };
    }
  });
  const groups = cases.flatMap(
    (c) =>
      c.trace?.groups.map((g) => ({
        ...g,
        finalDecision: c.trace!.settlement.decisions.find((d) => d.blockId === g.canonical.id)!,
      })) ?? [],
  );
  const effectiveness = cases.flatMap((c) => (c.effectiveness === null ? [] : [c.effectiveness]));
  return {
    schemaVersion: 1,
    dataset: EVIDENCE_DATASET,
    purpose:
      'DEVELOPMENT ONLY: declared-contract correctness and selection effectiveness are distinct',
    productValidation: 'NOT_EVALUATED',
    heldOutValidation: 'NOT_EVALUATED',
    liveAnswerQuality: 'NOT_EVALUATED',
    modelExecution: 'disabled',
    timing: 'NOT_MEASURED',
    profiles: EVIDENCE_PROFILE_IDS.map((id) => ({ id, policy: evidenceProfile(id) })),
    metricDefinitions: {
      unit: 'one explicit truth-labelled content unit per distinct block ID; repeated wrappers count once',
      usefulPreservation: 'included useful units / all useful units',
      irrelevantRejection:
        'non-included irrelevant units / all irrelevant units (filtering or budget exclusion)',
      admissionPrecision: 'admitted useful units / all admitted units, before budget allocation',
      admissionRecall: 'admitted useful units / all useful units, before budget allocation',
      aggregation:
        'micro sums numerators and denominators; macro averages defined per-case ratios; empty denominators are null',
      failures:
        'failed compilations have no selection result and are excluded from effectiveness, counted separately',
      gates:
        'only authored contract checks control this command exit status; no effectiveness or product validation gate',
    },
    counts: {
      cases: cases.length,
      inputCandidateWrappers: cases.reduce((n, c) => n + c.candidateWrappers, 0),
      successfulCompilations: cases.filter((c) => c.compilation === 'success').length,
      expectedFailures: cases.filter((c) => c.compilation === 'failed' && c.contractCorrect).length,
      unexpectedOutcomes: cases.filter((c) => !c.contractCorrect).length,
      checks: cases.reduce((n, c) => n + Object.keys(c.checks).length, 0),
      passedChecks: cases.reduce((n, c) => n + Object.values(c.checks).filter(Boolean).length, 0),
      successfulCandidateWrappers: groups.reduce((n, g) => n + g.members.length, 0),
      groups: groups.length,
      admitted: groups.filter((g) => g.filtering.decision === 'eligible').length,
      admittedUnderUncertainty: groups.filter(
        (g) => g.filtering.reason === 'ELIGIBLE_INCOMPLETE_EVIDENCE',
      ).length,
      included: groups.filter((g) => g.finalDecision.disposition === 'included').length,
      budgetExcluded: groups.filter((g) => g.finalDecision.disposition === 'excluded').length,
      filtered: groups.filter((g) => g.finalDecision.disposition === 'filtered').length,
      required: groups.filter((g) => g.canonical.required).length,
      requiredIncluded: groups.filter(
        (g) => g.canonical.required && g.finalDecision.disposition === 'included',
      ).length,
    },
    contractCorrectness: cases.every((c) => c.contractCorrect) ? 'PASS' : 'FAIL',
    selectionEffectiveness: {
      successfulCasesOnly: true,
      overall: aggregate(effectiveness),
      byEvidenceQuality: ['declared-development-evidence', 'misleading'].map((quality) => ({
        quality,
        ...aggregate(
          cases
            .filter((c) => c.evidenceQuality === quality)
            .flatMap((c) => (c.effectiveness === null ? [] : [c.effectiveness])),
        ),
      })),
    },
    cases,
  };
}

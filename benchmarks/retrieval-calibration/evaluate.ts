import {
  ContextCompiler,
  ContextCompilationError,
  type CompilationResult,
} from '@ctxalloc/compiler';
import type { CandidateBlock } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { SCOPE, REFERENCE_TIME, blockId, hash, prepareDocument, type Dataset } from './data.js';
import { distribution, effectiveness, losses, ratio } from './metrics.js';
import { observe, rawReport, type Observation } from './observe.js';
import { PROFILE, profilePolicy, retrieveForProfile } from './profile.js';

function summarize(results: readonly ReturnType<typeof measure>[]) {
  const sum = (fn: (r: ReturnType<typeof measure>) => number) =>
    results.reduce((n, r) => n + fn(r), 0);
  const admitted = sum((r) => r.admittedCount);
  const useful = sum((r) => r.admission.positive);
  const negative = sum((r) => r.admission.negative);
  const unjudged = sum((r) => r.admission.unjudged);
  const full = sum((r) => r.tokens.retrievedFull);
  return {
    compilations: results.length,
    admittedCandidates: admitted,
    admissionRecall: ratio(
      useful,
      sum((r) => r.retrievedUseful),
    ),
    admissionPrecision: {
      lower: ratio(useful, admitted),
      upper: ratio(useful + unjudged, admitted),
    },
    judgedAdmissionPrecision: ratio(useful, useful + negative),
    falseAdmissions: { lower: negative, upper: negative + unjudged },
    falseExclusions: sum((r) => r.admissionMisses),
    usefulBlocks: {
      total: sum((r) => r.blockLosses.total),
      preserved: sum((r) => r.blockLosses.preserved),
      retrievalMisses: sum((r) => r.blockLosses.retrieval),
      admissionMisses: sum((r) => r.blockLosses.admission),
      allocationMisses: sum((r) => r.blockLosses.allocation),
    },
    usefulFacts: {
      total: sum((r) => r.factLosses.total),
      preserved: sum((r) => r.factLosses.preserved),
      retrievalMisses: sum((r) => r.factLosses.retrieval),
      sourceUnavailable: sum((r) => r.factLosses.sourceUnavailable),
      admissionMisses: sum((r) => r.factLosses.admission),
      allocationMisses: sum((r) => r.factLosses.allocation),
    },
    criticalFactPreservation: ratio(
      sum((r) => r.criticalFactLosses.preserved),
      sum((r) => r.criticalFactLosses.total),
    ),
    runtimeRequiredPreservation: ratio(
      sum((r) => Number(r.checks.runtimeRequiredPreserved)),
      results.length,
    ),
    renderedTokenReduction: ratio(full - sum((r) => r.tokens.compiled), full),
    tokenTotals: {
      corpusFull: sum((r) => r.tokens.corpusFull),
      retrievedFull: full,
      compiled: sum((r) => r.tokens.compiled),
    },
    perQueryTokenReduction: distribution(
      results.flatMap((r) => (r.tokens.reduction.value === null ? [] : [r.tokens.reduction.value])),
    ),
    perQueryFactPreservation: distribution(
      results.flatMap((r) => (r.factPreservation.value === null ? [] : [r.factPreservation.value])),
    ),
    budgetViolations: sum((r) => Number(!r.checks.withinBudget)),
    checks: sum((r) => Object.keys(r.checks).length),
    passedChecks: sum((r) => Object.values(r.checks).filter(Boolean).length),
  };
}

function measure(
  row: Observation[number],
  result: CompilationResult,
  runtimeId: string,
  retrieved: ReadonlySet<string>,
  fullTokens: number,
  corpusTokens: number,
  tokenizer: Tokenizer,
) {
  const admitted = new Set(
    result.trace.groups
      .filter((g) => g.filtering.decision === 'eligible')
      .flatMap((g) => g.members.map((m) => String(m.blockId)))
      .filter((id) => id !== runtimeId),
  );
  const includedCanonical = new Set(result.includedBlocks.map((b) => String(b.id)));
  const included = new Set(
    result.trace.groups
      .filter((g) => includedCanonical.has(g.canonical.id))
      .flatMap((g) => g.members.map((m) => String(m.blockId)))
      .filter((id) => id !== runtimeId),
  );
  const useful = row.query.useful.map(blockId),
    irrelevant = row.query.irrelevant.map(blockId);
  const factUnits = row.query.facts.map((f) => ({ ...f, blockIds: f.blockIds.map(blockId) }));
  const factLosses = losses(factUnits, retrieved, admitted, included);
  const admission = effectiveness(admitted, useful, irrelevant);
  const retrievedUseful = useful.filter((id) => retrieved.has(id)).length;
  const blockLosses = losses(
    useful.map((id) => ({ blockIds: [id] })),
    retrieved,
    admitted,
    included,
  );
  const checks = {
    withinBudget: result.usage.compiledTokens <= result.usage.availableTokens,
    runtimeRequiredPreserved: includedCanonical.has(runtimeId),
    actualRenderedMeasurement:
      tokenizer.countTokens(result.compiledContext) === result.usage.compiledTokens,
    allRetrievedAdmitted: [...retrieved].every((id) => admitted.has(id)),
    factOwnershipReconciles:
      factLosses.total ===
      factLosses.preserved + factLosses.retrieval + factLosses.admission + factLosses.allocation,
    blockOwnershipReconciles:
      blockLosses.total ===
      blockLosses.preserved +
        blockLosses.retrieval +
        blockLosses.admission +
        blockLosses.allocation,
    incompleteEvidenceRecorded: result.trace.groups.every((g) =>
      g.score.evidence?.components.some(
        (c) => c.component === 'retrieval' && c.completeness === 'incomplete',
      ),
    ),
  };
  return {
    queryId: row.summary.queryId,
    candidateCount: retrieved.size,
    admittedCount: admitted.size,
    includedCount: included.size,
    retrievedUseful,
    admission: { ...admission, recall: ratio(admission.positive, retrievedUseful) },
    admissionMisses: blockLosses.admission,
    allocationFalseExclusions: blockLosses.allocation,
    blockLosses,
    factLosses,
    criticalFactLosses: losses(
      factUnits.filter((f) => f.critical === true),
      retrieved,
      admitted,
      included,
    ),
    factPreservation: ratio(factLosses.preserved, factLosses.total),
    tokens: {
      corpusFull: corpusTokens,
      retrievedFull: fullTokens,
      compiled: result.usage.compiledTokens,
      available: result.usage.availableTokens,
      admissionReduction: ratio(0, fullTokens),
      reduction: ratio(fullTokens - result.usage.compiledTokens, fullTokens),
      retrievalReduction: ratio(corpusTokens - fullTokens, corpusTokens),
    },
    checks,
  };
}

/** Counterfactual exclusions are development diagnostics, never declarations of complete evidence. */
function cutoffAnalysis(rows: Observation) {
  const native = rows.flatMap((r) => r.summary.native);
  const d = distribution(native.map((c) => c.score));
  const absolute = [0, d.p10, d.p25, d.median, d.p75, d.p90].filter((v): v is number => v !== null);
  const configurations = [
    ...absolute.map((cutoff) => ({ kind: 'native-absolute', cutoff })),
    ...[0.05, 0.1, 0.25, 0.5].map((cutoff) => ({ kind: 'native-over-query-max', cutoff })),
    ...[1, 3, 5, 10, 20].map((cutoff) => ({ kind: 'top-k', cutoff })),
  ];
  return configurations.map(({ kind, cutoff }) => {
    const queries = rows.map((r) => {
      const max = r.summary.native[0]?.score ?? 1;
      const selected = r.summary.native.filter((c) =>
        kind === 'top-k'
          ? c.rank < cutoff
          : (kind === 'native-absolute' ? c.score : c.score / max) >= cutoff,
      );
      const admitted = new Set(selected.map((c) => String(c.blockId)));
      const useful = r.summary.native
        .filter((c) => c.label === 'useful')
        .map((c) => String(c.blockId));
      return {
        queryId: r.summary.queryId,
        retained: selected.length,
        usefulRetrieved: useful.length,
        usefulRetained: useful.filter((id) => admitted.has(id)).length,
        knownAdmissionMisses: useful.filter((id) => !admitted.has(id)).length,
      };
    });
    return {
      kind,
      cutoff,
      queries,
      knownAdmissionMisses: queries.reduce((n, q) => n + q.knownAdmissionMisses, 0),
      retained: queries.reduce((n, q) => n + q.retained, 0),
    };
  });
}

export async function evaluate(dataset: Dataset, tokenizer: Tokenizer) {
  const observations = await observe(dataset, tokenizer);
  const raw = rawReport(dataset, observations);
  const compiler = new ContextCompiler(
    {
      schemaVersion: 1,
      compilerId: 'phase22a-development',
      compilerVersion: '1',
      maxCorrectionSelections: 1024,
    },
    tokenizer,
  );
  const policy = profilePolicy();
  const queries = [];
  const failures: { queryId: string; budget: string; stage: string; issueCodes: string[] }[] = [];
  for (const row of observations) {
    const input = {
      query: row.query.query,
      referenceTime: REFERENCE_TIME,
      scope: SCOPE,
      blocks: row.prepared.blocks,
      sourceDocuments: [row.prepared.sourceDocument],
    };
    const calibrated = await retrieveForProfile(input);
    const permuted = await retrieveForProfile({ ...input, blocks: [...input.blocks].reverse() });
    const runtime = prepareDocument(
      {
        id: `runtime:${row.query.id}`,
        sourceType: 'conversation',
        blocks: [{ id: `runtime-query:${row.query.id}`, content: row.query.query }],
      },
      tokenizer,
    );
    const required: CandidateBlock = {
      schemaVersion: 1,
      block: { ...runtime.blocks[0]!, attributes: { required: true } },
    };
    const candidates = [...calibrated.mapped, required];
    const sources = [...input.sourceDocuments, runtime.sourceDocument];
    // Deliberate ample headroom; final actual tokenization and all-included checks authenticate it.
    const ample =
      input.blocks.reduce((n, b) => n + b.tokenCount + b.content.length * 6 + 2048, 0) +
      required.block.tokenCount +
      4096;
    const base = {
      schemaVersion: 1,
      id: `phase22a:${row.summary.queryId}`,
      scope: SCOPE,
      query: row.query.query,
      referenceTime: REFERENCE_TIME,
      sourceDocuments: sources,
      policy,
    };
    const compile = (cs: readonly CandidateBlock[], available: number) =>
      compiler.compile({
        ...base,
        candidates: cs,
        budget: { totalTokens: available + 128, reservedOutputTokens: 128 },
      });
    const full = compile(candidates, ample);
    const corpusFull = compile(
      [...input.blocks.map((block): CandidateBlock => ({ schemaVersion: 1, block })), required],
      ample,
    );
    if (
      full.includedBlocks.length !== candidates.length ||
      corpusFull.includedBlocks.length !== input.blocks.length + 1
    )
      throw new Error('incomplete_full_baseline');
    const retrieved = new Set(calibrated.native.map((c) => String(c.block.id)));
    const generous = measure(
      row,
      full,
      required.block.id,
      retrieved,
      full.usage.compiledTokens,
      corpusFull.usage.compiledTokens,
      tokenizer,
    );
    const reverse = compile([...candidates].reverse(), ample);
    let constrained = null;
    try {
      const result = compile(candidates, 2048);
      constrained = measure(
        row,
        result,
        required.block.id,
        retrieved,
        full.usage.compiledTokens,
        corpusFull.usage.compiledTokens,
        tokenizer,
      );
      const reverseConstrained = compile([...candidates].reverse(), 2048);
      if (
        result.compiledContext !== reverseConstrained.compiledContext ||
        JSON.stringify(result.trace.groups) !== JSON.stringify(reverseConstrained.trace.groups)
      )
        throw new Error('constrained_nondeterminism');
    } catch (error) {
      if (!(error instanceof ContextCompilationError)) throw error;
      failures.push({
        queryId: row.summary.queryId,
        budget: '2048',
        stage: error.stage,
        issueCodes: error.issues.map((i) => i.code),
      });
    }
    queries.push({
      queryId: row.summary.queryId,
      generous,
      constrained,
      nativePermutation: row.permutationDetails,
      profileEvidence: calibrated.native.map((c, i) => ({
        blockId: c.block.id,
        nativeScore: c.retrieval!.score!.value,
        nativeRank: c.retrieval!.rank!,
        mappedScore: calibrated.mapped[i]!.retrieval!.score!.value,
      })),
      checks: {
        canonicalRetrievalPermutationStable:
          JSON.stringify(calibrated) === JSON.stringify(permuted),
        mappingPreservesBlocks: calibrated.mapped.every(
          (c, i) => c.block === calibrated.native[i]!.block,
        ),
        canonicalPreparationPreservesCandidateSet:
          JSON.stringify([...retrieved].sort()) ===
          JSON.stringify(row.candidates.map((c) => String(c.block.id)).sort()),
        compilerPermutationStable:
          full.compiledContext === reverse.compiledContext &&
          JSON.stringify(full.trace.groups) === JSON.stringify(reverse.trace.groups),
      },
    });
  }
  const generous = summarize(queries.map((q) => q.generous));
  const constrained = summarize(queries.flatMap((q) => (q.constrained ? [q.constrained] : [])));
  const allChecks =
    queries.every((q) => Object.values(q.checks).every(Boolean)) &&
    generous.checks === generous.passedChecks &&
    constrained.checks === constrained.passedChecks &&
    failures.length === 0;
  return {
    schemaVersion: 1,
    phase: '22A',
    purpose: 'DEVELOPMENT ONLY',
    outcome: 'C',
    outcomeScope:
      'Ranking signal only; no restrictive admission claim. Human negative judgments and target-workload coverage are missing.',
    datasetHash: hash(JSON.stringify(dataset)),
    profile: PROFILE,
    policy,
    profileHash: hash(JSON.stringify({ profile: PROFILE, policy })),
    modelExecution: 'disabled',
    productValidation: 'NOT_EVALUATED',
    heldOutValidation: 'NOT_EVALUATED',
    criticalFactStatus: dataset.queries.some((q) => q.facts.some((f) => f.critical === true))
      ? 'ANNOTATED'
      : 'NOT_ANNOTATED',
    factUnit:
      'Original human-selected evidence paragraph; coarse preservation proxy, not independent atomic-fact assessment',
    admissionRecallDenominator:
      'Retrieved positively annotated blocks, excluding runtime-required query',
    evidenceCompleteness:
      'incomplete; no cutoff is configured; ELIGIBLE_POLICY is expected, not ELIGIBLE_INCOMPLETE_EVIDENCE',
    lossAttribution:
      'Retrieval includes unavailable source evidence, disclosed separately; admission and allocation count only downstream losses',
    uncertaintyCost:
      'All retrieved unjudged candidates are admitted; false-admission counts and precision are bounds',
    raw,
    cutoffAnalysis: cutoffAnalysis(observations),
    generous,
    constrained,
    failures,
    contractChecks: allChecks ? 'PASS' : 'FAIL',
    queries,
  };
}

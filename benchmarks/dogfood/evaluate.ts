import { MiniSearchCandidateProvider } from '@ctxalloc/adapters';
import {
  ContextCompiler,
  ContextCompilationError,
  type CompilationResult,
} from '@ctxalloc/compiler';
import {
  ContextBlockSchema,
  SourceDocumentSchema,
  calculateNormalizedContentHash,
  scopesEqual,
  type CandidateBlock,
} from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { hash } from '../retrieval-calibration/data.js';
import {
  PROFILE,
  mapNative,
  profilePolicy,
  retrieveForProfile,
} from '../retrieval-calibration/profile.js';
import { verifyProfileFreeze } from '../retrieval-calibration/freeze.js';
import {
  operating,
  ORIGINS,
  reconcileInputs,
  requireHuman,
  type Settings,
  type Tasks,
  type Annotations,
  type Annotation,
} from './schema.js';
import { mapEvidence, type Preparation, type MappedEvidence } from './prepare.js';
import { evidenceMetrics, summarize, type Outcome, type QueryResult } from './metrics.js';

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ids = (cs: readonly CandidateBlock[]) => new Set(cs.map((c) => String(c.block.id)));
function membership(result: CompilationResult) {
  const canonical = new Set(result.includedBlocks.map((b) => String(b.id)));
  return {
    admitted: new Set(
      result.trace.groups
        .filter((g) => g.filtering.decision === 'eligible')
        .flatMap((g) => g.members.map((m) => String(m.blockId))),
    ),
    final: new Set(
      result.trace.groups
        .filter((g) => canonical.has(g.canonical.id))
        .flatMap((g) => g.members.map((m) => String(m.blockId))),
    ),
  };
}
function runtimeInput(task: Tasks['tasks'][number], p: Preparation, tokenizer: Tokenizer) {
  return task.runtime.map((o) => {
    const source = SourceDocumentSchema.parse({
      schemaVersion: 1,
      id: `runtime-source:${hash(task.id + ':' + o.id)}`,
      scope: p.scope,
      sourceType: 'text',
      contentHash: `sha256:${hash(o.content)}`,
      metadata: {},
    });
    const block = ContextBlockSchema.parse({
      schemaVersion: 1,
      id: `runtime-block:${hash(task.id + ':' + o.id)}`,
      sourceDocumentId: source.id,
      scope: p.scope,
      sourceType: 'text',
      sourceLocation: { kind: 'text-range', startOffset: 0, endOffset: o.content.length },
      content: o.content,
      normalizedContentHash: calculateNormalizedContentHash(o.content),
      tokenCount: tokenizer.countTokens(o.content),
      attributes: { required: true },
      metadata: {},
    });
    return { source, candidate: { schemaVersion: 1 as const, block } };
  });
}
/** Evaluator-only candidate witness. An oversized greedy attempt never proves impossibility. */
export function feasibility(
  a: Annotation,
  mapped: MappedEvidence,
  render: (blockIds: ReadonlySet<string>) => { tokens: number; included: ReadonlySet<string> },
  budget: number,
) {
  if (a.facts.some((f) => f.critical === null))
    return { status: 'NOT_EVALUATED', witnessTokens: null };
  const required = a.facts.filter((f) => f.required || f.critical === true);
  const witness = new Set<string>();
  for (const fact of required) {
    const alternatives = fact.alternatives
      .map((alternative) => alternative.map((id) => mapped.find((e) => e.id === id)!))
      .filter((es) =>
        es.every((e) => e.sourceAvailable && e.preparationComplete !== false && e.blockIds.length),
      );
    const first = alternatives
      .map((es) => [...new Set(es.flatMap((e) => e.blockIds))].sort(compare))
      .sort((a, b) => a.length - b.length || compare(JSON.stringify(a), JSON.stringify(b)))[0];
    if (!first) return { status: 'UNKNOWN', witnessTokens: null };
    for (const id of first) witness.add(id);
  }
  try {
    const result = render(witness);
    const covered = required.every((f) =>
      f.alternatives.some((alternative) =>
        alternative.every((id) => {
          const e = mapped.find((e) => e.id === id)!;
          return e.blockIds.length > 0 && e.blockIds.every((b) => result.included.has(b));
        }),
      ),
    );
    return {
      status: covered && result.tokens <= budget ? 'FEASIBLE' : 'UNKNOWN',
      witnessTokens: result.tokens,
    };
  } catch {
    return { status: 'UNKNOWN', witnessTokens: null };
  }
}
export async function evaluateDogfood(
  settings: Settings,
  tasks: Tasks,
  annotations: Annotations,
  prepared: Preparation,
  tokenizer: Tokenizer,
) {
  if (annotations.process.kind !== 'toy-software-test') requireHuman(tasks, annotations);
  verifyProfileFreeze();
  reconcileInputs(settings, tasks, annotations);
  const op = operating(settings),
    policy = profilePolicy(prepared.scope);
  const compiler = new ContextCompiler(
    {
      schemaVersion: 1,
      compilerId: 'phase22b-dogfood',
      compilerVersion: '1',
      maxCorrectionSelections: 1024,
    },
    tokenizer,
  );
  const rows: (QueryResult & {
    native: { blockHash: string; score: number; rank: number; retainedByCap: boolean }[];
    feasibility: { status: string; witnessTokens: number | null };
    pipelineFailure: boolean;
  })[] = [];
  for (const [index, task] of tasks.tasks.entries()) {
    const annotation = annotations.tasks.find((a) => a.taskId === task.id)!;
    const mapped = mapEvidence(annotation, prepared);
    const base: QueryResult = {
      id: `q${String(index + 1).padStart(3, '0')}`,
      language: task.language,
      strata: task.strata,
      answerability: annotation.answerability,
      scopeReviewed: annotation.scopeReviewed,
      totalEvidence: annotation.useful.length,
      totalFacts: annotation.facts.length,
      totalCritical: annotation.facts.filter((f) => f.critical === true).length,
      runtimeTotal: task.runtime.length,
      primary: null,
      generous: null,
    };
    let native: { blockHash: string; score: number; rank: number; retainedByCap: boolean }[] = [];
    try {
      const input = {
        scope: prepared.scope,
        query: task.query,
        referenceTime: op.referenceTime,
        blocks: [...prepared.corpus.blocks].sort((a, b) => compare(a.id, b.id)),
        sourceDocuments: [...prepared.corpus.sourceDocuments].sort((a, b) => compare(a.id, b.id)),
      };
      const full = await retrieveForProfile(input);
      const permutation = await retrieveForProfile({
        ...input,
        blocks: [...input.blocks].reverse(),
        sourceDocuments: [...input.sourceDocuments].reverse(),
      });
      const provider = new MiniSearchCandidateProvider({
        schemaVersion: 1,
        maxCandidates: op.maxCandidates,
      });
      const cappedNative = await provider.getCandidates(input);
      const repeatNative = await provider.getCandidates(input);
      const capped = mapNative(cappedNative);
      const retrievalDeterministic =
        JSON.stringify(full) === JSON.stringify(permutation) &&
        JSON.stringify(cappedNative) === JSON.stringify(repeatNative) &&
        JSON.stringify(cappedNative) === JSON.stringify(full.native.slice(0, op.maxCandidates));
      const preparedIds = new Set(prepared.corpus.blocks.map((b) => String(b.id))),
        matchingIds = ids(full.native),
        cappedIds = ids(capped);
      if (
        full.native.some(
          (c) => !preparedIds.has(c.block.id) || !scopesEqual(c.block.scope, prepared.scope),
        )
      )
        throw new Error('retrieval_membership');
      native = full.native.map((c) => ({
        blockHash: hash(c.block.id),
        score: c.retrieval!.score!.value,
        rank: c.retrieval!.rank!,
        retainedByCap: cappedIds.has(c.block.id),
      }));
      const runtime = runtimeInput(task, prepared, tokenizer),
        runtimeIds = ids(runtime.map((r) => r.candidate));
      const candidates = [...capped, ...runtime.map((r) => r.candidate)];
      const sources = [...prepared.corpus.sourceDocuments, ...runtime.map((r) => r.source)];
      const ample = [...prepared.corpus.blocks, ...runtime.map((r) => r.candidate.block)].reduce(
        (n, b) => n + b.tokenCount + b.content.length * 6 + 2048,
        4096,
      );
      const compile = (cs: readonly CandidateBlock[], available: number) =>
        compiler.compile({
          schemaVersion: 1,
          id: `phase22b:${base.id}`,
          scope: prepared.scope,
          query: task.query,
          referenceTime: op.referenceTime,
          sourceDocuments: sources,
          candidates: cs,
          policy,
          budget: {
            totalTokens: available + op.reservedOutputTokens,
            reservedOutputTokens: op.reservedOutputTokens,
          },
        });
      const control = compile(candidates, ample);
      const corpus = compile(
        [
          ...prepared.corpus.blocks.map((block): CandidateBlock => ({ schemaVersion: 1, block })),
          ...runtime.map((r) => r.candidate),
        ],
        ample,
      );
      const controlMembers = membership(control),
        corpusMembers = membership(corpus);
      if (
        [...cappedIds, ...runtimeIds].some((id) => !controlMembers.final.has(id)) ||
        [...preparedIds, ...runtimeIds].some((id) => !corpusMembers.final.has(id))
      )
        throw new Error('incomplete_full_baseline');
      const admitted = new Set([...controlMembers.admitted].filter((id) => cappedIds.has(id)));
      const outcome = (available: number, first?: CompilationResult): Outcome => {
        let result: CompilationResult | null = null,
          failureStage: string | null = null,
          deterministic = retrievalDeterministic;
        try {
          result = first ?? compile(candidates, available);
        } catch (error) {
          if (!(error instanceof ContextCompilationError)) throw error;
          failureStage = error.stage;
        }
        const signature = (cs: readonly CandidateBlock[]) => {
          try {
            const r = compile(cs, available);
            return JSON.stringify({
              context: r.compiledContext,
              groups: r.trace.groups,
              usage: r.usage,
            });
          } catch (error) {
            if (!(error instanceof ContextCompilationError)) throw error;
            return JSON.stringify({ stage: error.stage, codes: error.issues.map((i) => i.code) });
          }
        };
        deterministic =
          deterministic && signature(candidates) === signature([...candidates].reverse());
        if (result)
          deterministic =
            deterministic &&
            JSON.stringify(result) === JSON.stringify(compile(candidates, available));
        const included = result === null ? new Set<string>() : membership(result).final;
        const final = new Set([...included].filter((id) => cappedIds.has(id)));
        return {
          status: result ? 'SUCCESS' : 'COMPILATION_FAILED',
          failureStage,
          metrics: evidenceMetrics(annotation, mapped, {
            prepared: preparedIds,
            matching: matchingIds,
            capped: cappedIds,
            admitted,
            final,
          }),
          runtimePreserved: [...runtimeIds].filter((id) => included.has(id)).length,
          runtimeTotal: runtimeIds.size,
          tokens: {
            prepared: corpus.usage.compiledTokens,
            retrieved: control.usage.compiledTokens,
            compiled: result?.usage.compiledTokens ?? null,
          },
          budgetCompliant: result
            ? result.usage.compiledTokens <= available &&
              tokenizer.countTokens(result.compiledContext) === result.usage.compiledTokens
            : null,
          scopeCompliant: result
            ? result.includedBlocks.every((b) => scopesEqual(b.scope, prepared.scope))
            : null,
          deterministic,
        };
      };
      const primary = outcome(op.availableTokens),
        generous = outcome(ample, control);
      const witness = feasibility(
        annotation,
        mapped,
        (blockIds) => {
          const result = compile(
            [
              ...prepared.corpus.blocks
                .filter((b) => blockIds.has(b.id))
                .map((block): CandidateBlock => ({ schemaVersion: 1, block })),
              ...runtime.map((r) => r.candidate),
            ],
            ample,
          );
          const members = membership(result);
          if ([...runtimeIds].some((id) => !members.final.has(id)))
            throw new Error('missing_runtime');
          return { tokens: result.usage.compiledTokens, included: members.final };
        },
        op.availableTokens,
      );
      rows.push({
        ...base,
        primary,
        generous,
        native,
        feasibility: witness,
        pipelineFailure: false,
      });
    } catch {
      // No exception text, raw query, source path or trace leaves this boundary.
      rows.push({
        ...base,
        native,
        feasibility: { status: 'UNKNOWN', witnessTokens: null },
        pipelineFailure: true,
      });
    }
  }
  const primary = summarize(rows),
    generous = summarize(rows, 'generous');
  const requiredOrigins = settings.toolResultsAvailable
    ? ORIGINS
    : ORIGINS.filter((s) => s !== 'tool-result');
  const strata = [
    ...requiredOrigins.map((origin) => ({
      id: origin,
      rows: rows.filter((r) => r.strata.includes(origin)),
    })),
    ...settings.languages.map((language) => ({
      id: `language:${language}`,
      rows: rows.filter((r) => r.language === language),
    })),
  ].map((s) => ({
    id: s.id,
    minimumTasks: 5,
    coverage: s.rows.length >= 5 ? 'PASS' : 'INCOMPLETE',
    metrics: summarize(s.rows),
  }));
  const samplingCoverage =
    rows.length >= 20 &&
    strata.every((s) => s.coverage === 'PASS') &&
    rows.filter((r) => r.answerability !== 'answerable').length >= 2;
  const gates = [
    primary.gates,
    ...strata
      .filter((s) => s.metrics.queryCount > 0)
      .map((s) => ({
        retrieval: s.metrics.gates.retrieval!,
        finalFacts: s.metrics.gates.finalFacts!,
      })),
  ].flatMap((g) => Object.values(g));
  const verdict = gates.includes('FAIL')
    ? 'DOGFOOD BASELINE FAIL'
    : !samplingCoverage || gates.includes('NOT_EVALUATED')
      ? 'INCOMPLETE'
      : 'DOGFOOD BASELINE PASS';
  return {
    schemaVersion: 1,
    phase: '22B',
    purpose:
      annotations.process.kind === 'toy-software-test'
        ? 'TOY_SOFTWARE_TEST_ONLY'
        : 'REAL_DOGFOOD_DIAGNOSTIC_PILOT',
    verdict: annotations.process.kind === 'toy-software-test' ? 'TOY_SOFTWARE_TEST_ONLY' : verdict,
    profile: { id: PROFILE.id, version: PROFILE.version, completeness: PROFILE.completeness },
    modelExecution: 'disabled',
    productValidation: 'NOT_EVALUATED',
    primaryOperatingPoint: {
      availableTokens: op.availableTokens,
      reservedOutputTokens: op.reservedOutputTokens,
      maxCandidates: op.maxCandidates,
    },
    sourceCounts: {
      listed: settings.sources.length,
      available: prepared.sources.filter((s) => s.available).length,
      preparedBlocks: prepared.corpus.blocks.length,
    },
    samplingCoverage: samplingCoverage ? 'PASS' : 'INCOMPLETE',
    primary,
    generous,
    strata,
    preservationQualifiedSavings:
      annotations.process.kind === 'human' && verdict === 'DOGFOOD BASELINE PASS'
        ? primary.tokenComparisons
        : null,
    admissionObservation:
      'The generous control observes the same budget-independent admission policy; primary failures remain final-context failures.',
    queries: rows,
  };
}

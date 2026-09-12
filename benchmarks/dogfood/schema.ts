import {
  ScopeSchema,
  SourceTypeSchema,
  SourceLocationSchema,
  TimestampSchema,
  findLoneSurrogate,
} from '@ctxalloc/domain';

export const ORIGINS = [
  'project-documentation',
  'developer-reference',
  'conversation-history',
  'tool-result',
] as const;
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('invalid_object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !(key in result)))
    throw new Error('invalid_fields');
  return result;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || findLoneSurrogate(value) !== null)
    throw new Error('invalid_text');
  return value;
}
function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('invalid_integer');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid_boolean');
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error('invalid_choice');
  return value as T;
}
export function list<T>(value: unknown, parse: (item: unknown) => T, max = 2000): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid_array');
  return value.map(parse);
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error('duplicate_identity');
}
const nullable = <T>(v: unknown, parse: (v: unknown) => T): T | null =>
  v === null ? null : parse(v);
const language = (v: unknown): string => {
  const s = text(v);
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(s) || s.length > 24)
    throw new Error('invalid_language');
  return s;
};
const chunking = (v: unknown) => {
  const r = object(v, ['targetTokens', 'maxTokens']);
  return { targetTokens: integer(r.targetTokens), maxTokens: integer(r.maxTokens) };
};
export function parseSettings(value: unknown) {
  const r = object(value, [
    'schemaVersion',
    'experimentId',
    'sourceApprovalReference',
    'scope',
    'snapshotRoot',
    'readerMaxBytes',
    'markdownChunking',
    'textChunking',
    'availableTokens',
    'reservedOutputTokens',
    'maxCandidates',
    'referenceTime',
    'collectionRule',
    'languages',
    'toolResultsAvailable',
    'sources',
  ]);
  if (r.schemaVersion !== 1) throw new Error('invalid_version');
  const sources = list(
    r.sources,
    (v) => {
      const s = object(v, ['id', 'locator', 'sourceType', 'origin', 'language', 'available']);
      const sourceType = SourceTypeSchema.parse(s.sourceType),
        origin = choice(s.origin, ORIGINS);
      const available = boolean(s.available),
        locator = nullable(s.locator, text);
      if (available !== (locator !== null)) throw new Error('invalid_availability');
      if (
        (origin === 'conversation-history') !== (sourceType === 'conversation') ||
        (origin === 'project-documentation' && sourceType !== 'markdown')
      )
        throw new Error('inconsistent_source_origin');
      return {
        id: text(s.id),
        locator,
        sourceType,
        origin,
        language: language(s.language),
        available,
      };
    },
    64,
  );
  unique(sources.map((s) => s.id));
  unique(sources.flatMap((s) => (s.locator === null ? [] : [s.locator])));
  const languages = list(r.languages, language, 8);
  unique(languages);
  if (sources.some((s) => !languages.includes(s.language))) throw new Error('undeclared_language');
  return {
    schemaVersion: 1 as const,
    experimentId: nullable(r.experimentId, text),
    sourceApprovalReference: nullable(r.sourceApprovalReference, text),
    scope: nullable(r.scope, (v) => ScopeSchema.parse(v)),
    snapshotRoot: nullable(r.snapshotRoot, text),
    readerMaxBytes: nullable(r.readerMaxBytes, integer),
    markdownChunking: nullable(r.markdownChunking, chunking),
    textChunking: nullable(r.textChunking, chunking),
    availableTokens: nullable(r.availableTokens, integer),
    reservedOutputTokens: nullable(r.reservedOutputTokens, (v) => integer(v, 0)),
    maxCandidates: nullable(r.maxCandidates, integer),
    referenceTime: nullable(r.referenceTime, (v) => TimestampSchema.parse(v)),
    collectionRule: nullable(r.collectionRule, text),
    languages,
    toolResultsAvailable: nullable(r.toolResultsAvailable, boolean),
    sources,
  };
}
export type Settings = ReturnType<typeof parseSettings>;
export function operating(s: Settings) {
  if (
    s.availableTokens === null ||
    s.reservedOutputTokens === null ||
    s.maxCandidates === null ||
    s.referenceTime === null ||
    s.experimentId === null ||
    s.collectionRule === null ||
    s.toolResultsAvailable === null ||
    !s.languages.length
  )
    throw new Error('operating_decisions_required');
  if (
    s.toolResultsAvailable === false &&
    s.sources.some((source) => source.origin === 'tool-result' && source.available)
  )
    throw new Error('inconsistent_tool_availability');
  if (!Number.isSafeInteger(s.availableTokens + s.reservedOutputTokens))
    throw new Error('invalid_budget');
  return {
    availableTokens: s.availableTokens,
    reservedOutputTokens: s.reservedOutputTokens,
    maxCandidates: s.maxCandidates,
    referenceTime: s.referenceTime,
    experimentId: s.experimentId,
  };
}
export function parseTasks(value: unknown) {
  const r = object(value, ['schemaVersion', 'collectionRecord', 'tasks']);
  if (r.schemaVersion !== 1) throw new Error('invalid_version');
  const tasks = list(
    r.tasks,
    (v) => {
      const t = object(v, ['id', 'query', 'language', 'strata', 'runtime']);
      const strata = list(t.strata, (v) => choice(v, ORIGINS), 4);
      unique(strata);
      if (!strata.length) throw new Error('missing_stratum');
      const runtime = list(
        t.runtime,
        (v) => {
          const o = object(v, ['id', 'content', 'basis']);
          return { id: text(o.id), content: text(o.content), basis: text(o.basis) };
        },
        32,
      );
      unique(runtime.map((o) => o.id));
      return {
        id: text(t.id),
        query: text(t.query),
        language: language(t.language),
        strata,
        runtime,
      };
    },
    100,
  );
  unique(tasks.map((t) => t.id));
  return { schemaVersion: 1 as const, collectionRecord: nullable(r.collectionRecord, text), tasks };
}
export type Tasks = ReturnType<typeof parseTasks>;
export function parseAnnotations(value: unknown) {
  const r = object(value, ['schemaVersion', 'process', 'tasks']);
  if (r.schemaVersion !== 1) throw new Error('invalid_version');
  const p = object(r.process, [
    'kind',
    'author',
    'method',
    'independentOfRetrieval',
    'approvedForEvaluation',
    'approvalReference',
  ]);
  const process = {
    kind: nullable(p.kind, (v) => choice(v, ['human', 'toy-software-test'])),
    author: nullable(p.author, text),
    method: nullable(p.method, text),
    independentOfRetrieval: boolean(p.independentOfRetrieval),
    approvedForEvaluation: boolean(p.approvedForEvaluation),
    approvalReference: nullable(p.approvalReference, text),
  };
  const tasks = list(
    r.tasks,
    (v) => {
      const t = object(v, [
        'taskId',
        'answerability',
        'scopeReviewed',
        'useful',
        'irrelevantBlockIds',
        'facts',
      ]);
      const useful = list(t.useful, (v) => {
        const e = object(v, ['id', 'sourceId', 'location', 'quote']);
        const location = nullable(e.location, (v) => SourceLocationSchema.parse(v)),
          quote = nullable(e.quote, text);
        if ((location === null) !== (quote === null)) throw new Error('incomplete_carrier');
        return { id: text(e.id), sourceId: text(e.sourceId), location, quote };
      });
      unique(useful.map((e) => e.id));
      const irrelevantBlockIds = list(t.irrelevantBlockIds, text);
      unique(irrelevantBlockIds);
      const facts = list(t.facts, (v) => {
        const f = object(v, ['id', 'statement', 'required', 'critical', 'alternatives']);
        const alternatives = list(
          f.alternatives,
          (v) => {
            const a = list(v, text);
            unique(a);
            if (!a.length || a.some((id) => !useful.some((e) => e.id === id)))
              throw new Error('orphan_fact_carrier');
            return a;
          },
          32,
        );
        unique(alternatives.map((a) => JSON.stringify([...a].sort())));
        return {
          id: text(f.id),
          statement: text(f.statement),
          required: boolean(f.required),
          critical: nullable(f.critical, boolean),
          alternatives,
        };
      });
      unique(facts.map((f) => f.id));
      const answerability = choice(t.answerability, [
        'answerable',
        'unanswerable',
        'insufficient-source',
      ]);
      if (answerability === 'unanswerable' && (facts.length || useful.length))
        throw new Error('contradictory_unanswerable');
      return {
        taskId: text(t.taskId),
        answerability,
        scopeReviewed: boolean(t.scopeReviewed),
        useful,
        irrelevantBlockIds,
        facts,
      };
    },
    100,
  );
  unique(tasks.map((t) => t.taskId));
  return { schemaVersion: 1 as const, process, tasks };
}
export type Annotations = ReturnType<typeof parseAnnotations>;
export type Annotation = Annotations['tasks'][number];
export function reconcileInputs(settings: Settings, tasks: Tasks, annotations: Annotations): void {
  if (
    !tasks.tasks.length ||
    tasks.tasks.length !== annotations.tasks.length ||
    annotations.tasks.some((a) => !tasks.tasks.some((t) => t.id === a.taskId))
  )
    throw new Error('task_annotation_join');
  if (tasks.tasks.some((t) => !settings.languages.includes(t.language)))
    throw new Error('undeclared_language');
  if (
    annotations.tasks.some((a) =>
      a.useful.some((e) => !settings.sources.some((s) => s.id === e.sourceId)),
    )
  )
    throw new Error('orphan_source');
  if (
    tasks.tasks.some((t) =>
      t.strata.some((s) => !settings.sources.some((source) => source.origin === s)),
    )
  )
    throw new Error('unsupported_stratum');
}
export function requireHuman(tasks: Tasks, a: Annotations): void {
  if (
    !tasks.collectionRecord ||
    a.process.kind !== 'human' ||
    !a.process.author ||
    !a.process.method ||
    !a.process.independentOfRetrieval ||
    !a.process.approvedForEvaluation ||
    !a.process.approvalReference
  )
    throw new Error('human_data_checkpoint');
}

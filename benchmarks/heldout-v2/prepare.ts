import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateNormalizedContentHash } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { array, fail, hashBytes, keys, object, parseCase, string, validateMatrix } from './data.js';
import { requireProtocolCommit, git, MANIFEST_PATH } from './integrity.js';
import { AUXILIARY, evaluationProfile, SUPPORT } from './profiles.js';
import { planFor, REFERENCE_TIME } from './protocol.js';

/** Materializes runtime fields before reading independent annotations. No scoring, filtering, rendering or compiler execution. */
export function prepareCases(raw: unknown, tokenizer: Tokenizer) {
  const cases = array(raw).map((value) => {
    const seed = object(value);
    keys(seed, ['id', 'query', 'blocks', 'candidateOrder', 'exclusions', 'annotations']);
    const id = string(seed.id);
    const plan = planFor(id);
    const scope = { tenantId: 'heldout-v2', workspaceId: 'second-freeze', projectId: id };
    const fullId = (key: unknown) => `${id}:${string(key)}`;
    const specs = array(seed.blocks).map(object);
    const candidates = specs.map((b, index) => {
      keys(b, ['key', 'content', 'sourceType'], ['priority', 'retrieval', 'required', 'createdAt']);
      const content = string(b.content);
      const sourceType = string(b.sourceType);
      const provider = b.retrieval === undefined ? null : object(b.retrieval);
      if (provider !== null) keys(provider, ['contract', 'value'], ['rank']);
      if (provider !== null && !['support', 'auxiliary'].includes(string(provider.contract)))
        fail('Unknown authored provider contract.');
      const contract = provider?.contract === 'auxiliary' ? AUXILIARY : SUPPORT;
      return {
        schemaVersion: 1,
        block: {
          schemaVersion: 1,
          id: fullId(b.key),
          scope,
          sourceDocumentId: `${id}:source:${string(b.key)}`,
          sourceType,
          content,
          normalizedContentHash: calculateNormalizedContentHash(content),
          tokenCount: tokenizer.countTokens(content),
          sourceLocation:
            sourceType === 'conversation'
              ? {
                  kind: 'conversation-message',
                  messageId: `${id}:message:${index}`,
                  messageIndex: index,
                }
              : { kind: 'text-range', startOffset: 0, endOffset: content.length },
          attributes: {
            ...(b.priority === undefined ? {} : { priority: b.priority }),
            ...(b.required === undefined ? {} : { required: b.required }),
          },
          ...(b.createdAt === undefined ? {} : { createdAt: b.createdAt }),
          metadata: {},
        },
        ...(provider === null
          ? {}
          : {
              retrieval: {
                providerId: contract.providerId,
                providerVersion: contract.providerVersion,
                ...(provider.rank === undefined ? {} : { rank: provider.rank }),
                score: {
                  value: provider.value,
                  semantics: contract.semantics,
                  higherIsBetter: contract.higherIsBetter,
                },
              },
            }),
      };
    });
    if (new Set(candidates.map((c) => c.block.id)).size !== candidates.length)
      fail('Authored block keys must be unique.');
    const policy = object(JSON.parse(JSON.stringify(evaluationProfile(plan.profile, scope))));
    object(object(policy.filtering).applicability).exclusions = array(seed.exclusions).map(
      (value) => {
        const d = object(value);
        keys(d, ['blockId', 'reason']);
        return { blockId: fullId(d.blockId), reason: d.reason };
      },
    );
    const input = {
      schemaVersion: 1,
      id: `heldout-v2:${id}`,
      scope,
      query: string(seed.query),
      referenceTime: REFERENCE_TIME,
      policy,
      budget: { totalTokens: plan.availableTokens + 100, reservedOutputTokens: 100 },
      sourceDocuments: candidates.map((c) => ({
        schemaVersion: 1,
        id: c.block.sourceDocumentId,
        scope,
        sourceType: c.block.sourceType,
        contentHash: hashBytes(c.block.content),
        metadata: {},
      })),
      candidates: array(seed.candidateOrder).map((key) => {
        const found = candidates.find((c) => c.block.id === fullId(key));
        if (found === undefined) fail('Unknown authored wrapper.');
        return found;
      }),
    };
    // Deliberate negative mutations are a fixed part of the preregistered plan, never selected from outcomes.
    const mutated = object(JSON.parse(JSON.stringify(input)));
    const score = object(object(mutated.policy).scoring);
    const first = object(array(mutated.candidates)[0]);
    if (plan.mutation === 'unsupported' || plan.mutation === 'wrong-tuple')
      first.retrieval = {
        providerId:
          plan.mutation === 'unsupported' ? 'heldout-v2-unlisted-contract' : SUPPORT.providerId,
        providerVersion: SUPPORT.providerVersion,
        score: {
          value: 2,
          semantics: SUPPORT.semantics,
          higherIsBetter: plan.mutation !== 'wrong-tuple',
        },
      };
    if (plan.mutation === 'evidence-scope')
      object(score.evidence).scope = { ...scope, projectId: id + ':foreign' };
    if (plan.mutation === 'candidate-scope') {
      const foreign = { ...scope, projectId: id + ':foreign' };
      const block = object(first.block);
      block.scope = foreign;
      for (const d of array(mutated.sourceDocuments).map(object))
        if (d.id === block.sourceDocumentId) d.scope = foreign;
    }
    if (plan.mutation === 'missing-completeness') object(score.evidence).completeness = [];
    if (plan.mutation === 'future-signal') first.futureSignal = { value: 1 };
    if (plan.mutation === 'rule-ignore-overlap')
      object(score.compatibility).ignoredRetrievalContracts = [
        ...array(object(score.compatibility).ignoredRetrievalContracts),
        SUPPORT,
      ];
    if (plan.mutation === 'missing-applicability-target')
      object(object(object(mutated.policy).filtering).applicability).exclusions = [
        { blockId: id + ':absent-target', reason: 'inapplicable' },
      ];
    if (plan.mutation === 'required-applicability') {
      const target = array(mutated.candidates)
        .map((c) => object(object(c).block))
        .find((b) => object(b.attributes).required === true);
      if (target === undefined)
        fail('The negative requires an independently authored runtime obligation.');
      object(object(object(mutated.policy).filtering).applicability).exclusions = [
        { blockId: target.id, reason: 'inapplicable' },
      ];
    }
    // Only now materialize truth references. No truth field can change runtime priority, retrieval or required attributes.
    const truth = object(seed.annotations);
    keys(truth, [
      'units',
      'facts',
      'requiredBlockIds',
      'runtimeObligations',
      'duplicateGroups',
      'rationale',
    ]);
    return parseCase(
      {
        ...plan,
        input: mutated,
        annotations: {
          ...truth,
          units: array(truth.units).map((v) => {
            const u = object(v);
            return { ...u, id: fullId(u.id), blockIds: array(u.blockIds).map(fullId) };
          }),
          facts: array(truth.facts).map((v) => {
            const f = object(v);
            return {
              ...f,
              id: fullId(f.id),
              evidenceBlockGroups: array(f.evidenceBlockGroups).map((g) => array(g).map(fullId)),
            };
          }),
          requiredBlockIds: array(truth.requiredBlockIds).map(fullId),
          runtimeObligations: array(truth.runtimeObligations).map((v) => {
            const o = object(v);
            return { ...o, blockId: fullId(o.blockId) };
          }),
          duplicateGroups: array(truth.duplicateGroups).map((g) => array(g).map(fullId)),
        },
      },
      tokenizer,
    );
  });
  validateMatrix(cases);
  return cases;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write')
    fail('Use --write only after the protocol commit.');
  requireProtocolCommit(process.cwd());
  if (git(process.cwd(), ['log', '--diff-filter=A', '--format=%H', '--', MANIFEST_PATH]) !== '')
    fail('Committed held-out data must never be regenerated.');
  const path = resolve(process.cwd(), 'benchmarks/heldout-v2/v2/cases.json');
  const raw: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'benchmarks/heldout-v2/v2/authoring.json'), 'utf8'),
  );
  const cases = prepareCases(raw, new O200kBaseTokenizer());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cases, null, 2) + '\n');
  process.stdout.write(
    'Prepared 60 cases using schema and cross-field validation only. No selection execution.\n',
  );
}

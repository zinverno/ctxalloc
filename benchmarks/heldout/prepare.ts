import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompilationRequestValidator } from '@ctxalloc/compiler';
import { calculateNormalizedContentHash, type Scope, type SourceType } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { admissionProfile, SUPPORT_PROVIDER } from '../admission-development/profiles.js';
import { AUTHORED_SEEDS } from './authored.js';
import { hashBytes, parseCase, validateMatrix } from './data.js';
import { DATA_PATH } from './integrity.js';
import { PROFILES, STRATA, REFERENCE_TIME, type Fact, type HeldoutCase } from './types.js';

/** Materialize authored input fields; judgments never determine a score or runtime required flag. */
export function prepareCases(tokenizer: Tokenizer): readonly HeldoutCase[] {
  const cases = AUTHORED_SEEDS.map((seed): HeldoutCase => {
    const scope: Scope = { tenantId: 'heldout', workspaceId: 'selection', projectId: seed.id };
    const foreignScope: Scope = { ...scope, projectId: seed.id + '-external' };
    const documents = new Map<
      string,
      { id: string; sourceType: SourceType; scope: Scope; text: string }
    >();
    const blocks = new Map(
      seed.blocks.map((spec, index) => {
        const blockScope = spec.foreign === true ? foreignScope : scope;
        const sourceId = `${seed.id}-${spec.sourceType}${spec.foreign === true ? '-x' : ''}`;
        const document = documents.get(sourceId) ?? {
          id: sourceId,
          sourceType: spec.sourceType,
          scope: blockScope,
          text: '',
        };
        const start = document.text.length;
        document.text += spec.content + '\n';
        documents.set(sourceId, document);
        const block = {
          schemaVersion: 1,
          id: `${seed.id}-${spec.key}`,
          scope: blockScope,
          sourceDocumentId: sourceId,
          sourceType: spec.sourceType,
          content: spec.content,
          normalizedContentHash: calculateNormalizedContentHash(spec.content),
          tokenCount: tokenizer.countTokens(spec.content),
          sourceLocation:
            spec.sourceType === 'conversation'
              ? {
                  kind: 'conversation-message',
                  messageId: `${seed.id}-message-${index}`,
                  messageIndex: index,
                }
              : { kind: 'text-range', startOffset: start, endOffset: start + spec.content.length },
          attributes: {
            ...(spec.priority === undefined ? {} : { priority: spec.priority }),
            ...(spec.runtimeRequired === undefined ? {} : { required: spec.runtimeRequired }),
          },
          ...(spec.createdAt === undefined ? {} : { createdAt: spec.createdAt }),
          metadata: {},
        };
        return [
          spec.key,
          {
            schemaVersion: 1,
            block,
            ...(spec.retrievalGrade === undefined
              ? {}
              : {
                  retrieval: {
                    providerId: SUPPORT_PROVIDER.providerId,
                    providerVersion: SUPPORT_PROVIDER.providerVersion,
                    rank: index,
                    score: {
                      value: spec.retrievalGrade,
                      semantics: SUPPORT_PROVIDER.semantics,
                      higherIsBetter: SUPPORT_PROVIDER.higherIsBetter,
                    },
                  },
                }),
          },
        ] as const;
      }),
    );
    const profile = admissionProfile(seed.profile).policy;
    const policy =
      seed.declarations.length === 0
        ? profile
        : {
            ...profile,
            filtering: {
              ...profile.filtering,
              schemaVersion: 2,
              policyVersion: '1-applicability',
              applicability: {
                scope,
                exclusions: seed.declarations.map((d) => ({
                  blockId: `${seed.id}-${d.key}`,
                  reason: d.reason,
                })),
              },
            },
          };
    const p = PROFILES.indexOf(seed.profile);
    const s = STRATA.indexOf(seed.stratum);
    const regime = (p + s + seed.replica) % 2 === 0 ? 'tight' : 'generous';
    const input = new CompilationRequestValidator().validate({
      schemaVersion: 1,
      id: `heldout:${seed.id}`,
      scope,
      query: seed.query,
      referenceTime: REFERENCE_TIME,
      policy,
      budget: { totalTokens: regime === 'tight' ? 280 : 1000, reservedOutputTokens: 100 },
      sourceDocuments: [...documents.values()].map((d) => ({
        schemaVersion: 1,
        id: d.id,
        scope: d.scope,
        sourceType: d.sourceType,
        contentHash: hashBytes(d.text),
        metadata: {},
      })),
      candidates: seed.candidateOrder.map((key) => {
        const candidate = blocks.get(key);
        if (candidate === undefined) throw new Error('Unknown authored wrapper.');
        return candidate;
      }),
    });
    // Annotation construction runs only after the complete runtime request exists.
    const judgments = seed.judgments;
    const consumed = new Set<string>();
    const groups = seed.blocks.flatMap((spec) => {
      if (consumed.has(spec.key)) return [];
      const alternatives = judgments.duplicateAlternatives.find((g) => g.includes(spec.key)) ?? [
        spec.key,
      ];
      for (const key of alternatives) consumed.add(key);
      return [alternatives];
    });
    const units = groups.map((keys) => ({
      id: `${seed.id}-unit-${keys[0]!}`,
      blockIds: keys.map((key) => `${seed.id}-${key}`),
      useful: keys.some((key) => judgments.usefulKeys.includes(key)),
      applicability:
        judgments.intendedDispositions.find((d) => keys.includes(d.key))?.reason ??
        ('applicable' as const),
    }));
    const facts: Fact[] = groups.map((keys) => ({
      id: `${seed.id}-fact-${keys[0]!}`,
      description: seed.blocks.find((b) => b.key === keys[0])!.content,
      useful: keys.some((key) => judgments.usefulKeys.includes(key)),
      required: keys.some((key) => judgments.requiredFactKeys.includes(key)),
      importance: keys.some((key) => judgments.criticalFactKeys.includes(key))
        ? 'critical'
        : keys.some((key) => judgments.requiredFactKeys.includes(key))
          ? 'major'
          : 'minor',
      evidenceBlockGroups: keys.map((key) => [`${seed.id}-${key}`]),
    }));
    if (judgments.combinedFactKeys.length > 0)
      facts.push({
        id: `${seed.id}-fact-joint`,
        description: 'All named task components must be available together.',
        useful: true,
        required: true,
        importance: 'major',
        evidenceBlockGroups: [judgments.combinedFactKeys.map((key) => `${seed.id}-${key}`)],
      });
    return parseCase({
      id: seed.id,
      profile: seed.profile,
      stratum: seed.stratum,
      replica: seed.replica,
      budgetRegime: regime,
      input,
      annotations: {
        requiredBlockIds: judgments.requiredBlockKeys.map((key) => `${seed.id}-${key}`),
        units,
        facts,
        runtimeObligations: judgments.callerObligations.map((o) => ({
          blockId: `${seed.id}-${o.key}`,
          rationale: o.rationale,
        })),
        evidenceCondition: judgments.evidenceCondition,
        ambiguityResolution: judgments.ambiguityResolution,
        expectedFailure:
          seed.stratum === 'applicability-duplicates' && seed.replica === 1
            ? { stage: 'candidate-validation', issueCode: 'scope_mismatch' }
            : null,
      },
    });
  });
  validateMatrix(cases);
  return cases;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--write')
    throw new Error('Use --write before freezing.');
  const root = resolve(import.meta.dirname, '../../..');
  const path = resolve(root, DATA_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(prepareCases(new O200kBaseTokenizer()), null, 2) + '\n');
  process.stdout.write(
    'Prepared 48 inputs using only structural validation and tokenizer counts. No compilation.\n',
  );
}

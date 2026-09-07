import { createHash } from 'node:crypto';
import { CompilationRequestValidator, type CompilationRequest } from '@ctxalloc/compiler';
import { calculateNormalizedContentHash, type SourceType } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { admissionProfile, SUPPORT_PROVIDER, type AdmissionProfileId } from './profiles.js';

export const ADMISSION_DATASET = {
  id: 'ctxalloc-admission-development-v1',
  version: '1',
  split: 'development',
} as const;
export const ADMISSION_SCOPE = { tenantId: 'development', workspaceId: 'workshop' } as const;
export const ADMISSION_COMPILER = {
  schemaVersion: 1,
  compilerId: 'ctxalloc-admission-development',
  compilerVersion: '1',
  maxCorrectionSelections: 64,
} as const;

interface BlockSpec {
  readonly id: string;
  readonly content: string;
  readonly priority?: number;
  readonly grade?: number;
  readonly required?: boolean;
  readonly sourceType?: SourceType;
  readonly createdAt?: string;
  readonly repeat?: number;
}
interface Scenario {
  readonly id: string;
  readonly query: string;
  readonly profile: AdmissionProfileId;
  readonly coverage: readonly string[];
  readonly blocks: readonly BlockSpec[];
  readonly admitted: readonly string[];
  readonly included?: readonly string[];
  readonly available?: number;
  readonly limitation?: string;
  readonly exclusions?: readonly { blockId: string; reason: 'inapplicable' | 'superseded' }[];
}
export interface AdmissionDevelopmentCase {
  readonly id: string;
  readonly profile: AdmissionProfileId;
  readonly coverage: readonly string[];
  readonly limitation: string | null;
  readonly expectedAdmittedIds: readonly string[];
  readonly expectedIncludedIds: readonly string[];
  readonly compilationRequest: CompilationRequest;
}

// Authored independently for the DEC-044 rubric. No frozen evaluation-v1 imports.
const scenarios: readonly Scenario[] = [
  {
    id: 'retrieved-tool-and-noise',
    query: 'Which tool tightens the bench leg?',
    profile: 'retrieval-support',
    coverage: ['retrieval-only', 'obvious-noise', 'generous-budget'],
    blocks: [
      { id: 'tool', content: 'Tighten the bench leg using a hex key.', grade: 4 },
      { id: 'noise', content: 'The monthly newsletter includes photographs of pottery.', grade: 1 },
    ],
    admitted: ['tool'],
  },
  {
    id: 'complementary-medium-facts',
    query: 'What are the three setup requirements for the moisture sensor?',
    profile: 'retrieval-support',
    coverage: ['complementary-medium-facts'],
    blocks: [
      { id: 'cable', content: 'Connect the sensor using the shielded cable.', grade: 2 },
      { id: 'port', content: 'Attach the cable to port B.', grade: 2 },
      { id: 'voltage', content: 'Supply the sensor with twelve volts.', grade: 2 },
      { id: 'catalog', content: 'The equipment catalog has a blue cover.', grade: 1 },
    ],
    admitted: ['cable', 'port', 'voltage'],
  },
  {
    id: 'nearly-all-useful',
    query: 'How do I prepare the workshop before opening?',
    profile: 'authored-support',
    coverage: ['all-useful', 'authored-only'],
    blocks: [
      { id: 'door', content: 'Unlock the workshop side entrance.', priority: 2 },
      { id: 'lights', content: 'Turn on the overhead task lights.', priority: 3 },
      { id: 'floor', content: 'Clear loose materials from the floor.', priority: 4 },
    ],
    admitted: ['door', 'lights', 'floor'],
  },
  {
    id: 'no-useful-optionals',
    query: 'Where is the spare irrigation valve?',
    profile: 'retrieval-support',
    coverage: ['no-useful-optionals'],
    blocks: [
      { id: 'poster', content: 'A flower poster hangs beside the door.', grade: 0 },
      { id: 'leaflet', content: 'The visitor leaflet describes nearby walking trails.', grade: 1 },
    ],
    admitted: [],
  },
  {
    id: 'missing-retrieval-authored-support',
    query: 'Where is the workshop first aid box?',
    profile: 'authored-support',
    coverage: ['missing-retrieval', 'authored-only'],
    blocks: [
      { id: 'first-aid', content: 'The first aid box is beside the main door.', priority: 3 },
      { id: 'paint', content: 'The door was painted green during renovation.', priority: 1 },
    ],
    admitted: ['first-aid'],
  },
  {
    id: 'missing-evidence-restrictive',
    query: 'Which shelf holds the seed packets?',
    profile: 'retrieval-support',
    coverage: ['missing-all-evidence', 'explicit-restrictive-missing'],
    blocks: [{ id: 'unrated', content: 'The seed packets are on shelf C.' }],
    admitted: [],
    limitation:
      'Useful but unrated context is filtered: this profile requires positive evidence. Use an appropriate authored, required or curated policy when this loss is unacceptable.',
  },
  {
    id: 'missing-evidence-curated',
    query: 'Which shelf holds the seed packets?',
    profile: 'curated-history',
    coverage: ['missing-all-evidence', 'permissive-admission'],
    blocks: [{ id: 'unrated', content: 'The seed packets are on shelf C.' }],
    admitted: ['unrated'],
  },
  {
    id: 'combined-support-units',
    query: 'What preparation does the kiln need?',
    profile: 'combined-support',
    coverage: ['combined-evidence', 'corroboration', 'missing-component'],
    blocks: [
      { id: 'vent', content: 'Open the kiln ventilation damper.', priority: 2, grade: 2 },
      { id: 'inspect', content: 'Inspect the kiln lining before firing.', priority: 4 },
      { id: 'color', content: 'The kiln exterior is painted dark red.', priority: 1, grade: 1 },
    ],
    admitted: ['vent', 'inspect'],
  },
  {
    id: 'useful-old-conversation',
    query: 'Which finish did we choose and how should it be applied?',
    profile: 'curated-history',
    coverage: ['history', 'older-low-ranked-useful', 'conversation'],
    blocks: [
      {
        id: 'choice',
        content: 'We chose a water based finish for the shelves.',
        priority: 0,
        sourceType: 'conversation',
        createdAt: '2023-02-01T12:00:00.000Z',
      },
      {
        id: 'method',
        content: 'Apply the chosen finish with a foam brush.',
        priority: 4,
        sourceType: 'conversation',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
    ],
    admitted: ['choice', 'method'],
  },
  {
    id: 'duplicates-aggregate-support',
    query: 'Which brush applies the primer?',
    profile: 'retrieval-support',
    coverage: ['duplicates', 'wrapper-multiplicity'],
    blocks: [
      { id: 'copy-a', content: 'Apply primer with a natural bristle brush.', grade: 1 },
      { id: 'copy-z', content: 'Apply primer with a natural bristle brush.', grade: 2, repeat: 2 },
      { id: 'other', content: 'Brush handles are stored in assorted colors.', grade: 1 },
    ],
    admitted: ['copy-a'],
  },
  {
    id: 'tight-budget',
    query: 'How should the workshop be secured?',
    profile: 'authored-support',
    coverage: ['tight-budget'],
    available: 40,
    blocks: [
      { id: 'lock', content: 'Lock the workshop door.', priority: 4 },
      { id: 'close', content: 'Close the workshop windows.', priority: 2 },
    ],
    admitted: ['lock', 'close'],
    included: ['lock'],
  },
  {
    id: 'generous-budget',
    query: 'How should the workshop be secured?',
    profile: 'authored-support',
    coverage: ['generous-budget', 'complementary-facts'],
    blocks: [
      { id: 'lock', content: 'Lock the workshop door.', priority: 4 },
      { id: 'close', content: 'Close the workshop windows.', priority: 2 },
    ],
    admitted: ['lock', 'close'],
  },
  {
    id: 'conflict-ranking-insufficient',
    query: 'Which shelf reservation applies now?',
    profile: 'authored-support',
    coverage: ['conflict-without-applicability'],
    blocks: [
      {
        id: 'retired',
        content: 'The old shelf reservation was assigned to team Birch.',
        priority: 4,
      },
      {
        id: 'active',
        content: 'The current shelf reservation is assigned to team Cedar.',
        priority: 2,
      },
    ],
    admitted: ['retired', 'active'],
    limitation:
      'Ranking does not interpret old/current words or establish supersession; both meet the numerical threshold.',
  },
  {
    id: 'explicit-superseded-disposition',
    query: 'Which shelf reservation applies now?',
    profile: 'authored-support',
    coverage: ['explicit-superseded'],
    blocks: [
      { id: 'retired', content: 'The shelf reservation is assigned to team Birch.', priority: 4 },
      { id: 'active', content: 'The shelf reservation is assigned to team Cedar.', priority: 2 },
    ],
    exclusions: [{ blockId: 'retired', reason: 'superseded' }],
    admitted: ['active'],
  },
  {
    id: 'explicit-room-inapplicability',
    query: 'Where should equipment for room A be stored?',
    profile: 'authored-support',
    coverage: ['explicit-inapplicable'],
    blocks: [
      { id: 'room-a', content: 'Store room A equipment in the east cupboard.', priority: 2 },
      { id: 'room-b', content: 'Store room B equipment in the west cupboard.', priority: 4 },
    ],
    exclusions: [{ blockId: 'room-b', reason: 'inapplicable' }],
    admitted: ['room-a'],
  },
  {
    id: 'required-below-admission',
    query: 'How should the sanding bench be prepared?',
    profile: 'authored-support',
    coverage: ['required-below-threshold'],
    blocks: [
      {
        id: 'safety',
        content: 'Wear eye protection when using the sanding bench.',
        priority: 0,
        required: true,
      },
      { id: 'paper', content: 'Fit fine grit paper to the sanding block.', priority: 2 },
      { id: 'paint', content: 'The bench legs were recently painted.', priority: 1 },
    ],
    admitted: ['safety', 'paper'],
  },
  {
    id: 'mixed-source-support',
    query: 'Summarize the planter construction steps.',
    profile: 'authored-support',
    coverage: ['mixed-sources'],
    blocks: [
      {
        id: 'cut',
        content: 'Cut the planter side boards to equal length.',
        priority: 2,
        sourceType: 'markdown',
      },
      {
        id: 'join',
        content: 'Join the boards using exterior screws.',
        priority: 2,
        sourceType: 'text',
      },
      {
        id: 'line',
        content: 'Line the planter with breathable fabric.',
        priority: 2,
        sourceType: 'conversation',
      },
    ],
    admitted: ['cut', 'join', 'line'],
  },
  {
    id: 'equal-score-tight-budget',
    query: 'Which workshop closing checks can fit?',
    profile: 'authored-support',
    coverage: ['ranking-tie', 'tight-budget'],
    available: 40,
    blocks: [
      { id: 'alpha', content: 'Switch off the lights.', priority: 3 },
      { id: 'zulu', content: 'Close the side door.', priority: 3 },
    ],
    admitted: ['alpha', 'zulu'],
    included: ['alpha'],
  },
  {
    id: 'duplicate-group-inapplicability',
    query: 'Which planter liner should be used?',
    profile: 'authored-support',
    coverage: ['duplicate-applicability'],
    blocks: [
      { id: 'copy-a', content: 'Use the plastic planter liner.', priority: 4 },
      { id: 'copy-z', content: 'Use the plastic planter liner.', priority: 4 },
      {
        id: 'replacement',
        content: 'Use the breathable planter liner.',
        priority: 2,
        required: true,
      },
    ],
    exclusions: [{ blockId: 'copy-z', reason: 'superseded' }],
    admitted: ['replacement'],
  },
  {
    id: 'superseded-without-replacement',
    query: 'Which cabinet key assignment can be used?',
    profile: 'authored-support',
    coverage: ['no-replacement-promise'],
    blocks: [{ id: 'retired', content: 'The cabinet key is assigned to Morgan.', priority: 4 }],
    exclusions: [{ blockId: 'retired', reason: 'superseded' }],
    admitted: [],
    limitation:
      'The caller declares this assignment unusable; a superseded disposition promises no replacement.',
  },
];

export function buildAdmissionDevelopment(
  tokenizer: Tokenizer,
): readonly AdmissionDevelopmentCase[] {
  return scenarios.map((scenario) => {
    const profile = admissionProfile(scenario.profile);
    const texts = new Map<SourceType, string>();
    const candidates = scenario.blocks.flatMap((spec, index) => {
      const sourceType = spec.sourceType ?? 'text';
      const prefix = texts.get(sourceType) ?? '';
      texts.set(sourceType, prefix + spec.content + '\n');
      const block = {
        schemaVersion: 1,
        id: spec.id,
        scope: ADMISSION_SCOPE,
        sourceDocumentId: `dev:doc:${sourceType}`,
        sourceType,
        content: spec.content,
        normalizedContentHash: calculateNormalizedContentHash(spec.content),
        tokenCount: tokenizer.countTokens(spec.content),
        sourceLocation:
          sourceType === 'conversation'
            ? { kind: 'conversation-message', messageId: `message-${index}`, messageIndex: index }
            : {
                kind: 'text-range',
                startOffset: prefix.length,
                endOffset: prefix.length + spec.content.length,
              },
        attributes: {
          ...(spec.priority === undefined ? {} : { priority: spec.priority }),
          ...(spec.required === undefined ? {} : { required: spec.required }),
        },
        ...(spec.createdAt === undefined ? {} : { createdAt: spec.createdAt }),
        metadata: {},
      };
      const candidate = {
        schemaVersion: 1,
        block,
        ...(spec.grade === undefined
          ? {}
          : {
              retrieval: {
                providerId: SUPPORT_PROVIDER.providerId,
                providerVersion: SUPPORT_PROVIDER.providerVersion,
                rank: index,
                score: {
                  value: spec.grade,
                  semantics: SUPPORT_PROVIDER.semantics,
                  higherIsBetter: SUPPORT_PROVIDER.higherIsBetter,
                },
              },
            }),
      };
      return Array.from({ length: spec.repeat ?? 1 }, () => candidate);
    });
    const sourceDocuments = [...texts].map(([sourceType, text]) => ({
      schemaVersion: 1,
      id: `dev:doc:${sourceType}`,
      scope: ADMISSION_SCOPE,
      sourceType,
      contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      metadata: {},
    }));
    const policy =
      scenario.exclusions === undefined
        ? profile.policy
        : {
            ...profile.policy,
            filtering: {
              ...profile.policy.filtering,
              schemaVersion: 2,
              policyVersion: '1-applicability',
              applicability: { scope: ADMISSION_SCOPE, exclusions: scenario.exclusions },
            },
          };
    return {
      id: scenario.id,
      profile: scenario.profile,
      coverage: scenario.coverage,
      limitation: scenario.limitation ?? null,
      expectedAdmittedIds: scenario.admitted,
      expectedIncludedIds: scenario.included ?? scenario.admitted,
      compilationRequest: new CompilationRequestValidator().validate({
        schemaVersion: 1,
        id: `admission-dev:${scenario.id}`,
        scope: ADMISSION_SCOPE,
        query: scenario.query,
        referenceTime: '2026-06-01T12:00:00.000Z',
        candidates,
        sourceDocuments,
        budget: { totalTokens: (scenario.available ?? 500) + 100, reservedOutputTokens: 100 },
        policy,
      }),
    };
  });
}

import { createHash } from 'node:crypto';
import { CompilationRequestValidator } from '@ctxalloc/compiler';
import { calculateNormalizedContentHash, type SourceType } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import {
  EVIDENCE_SCOPE,
  GRADE_PROVIDER,
  IGNORED_PROVIDER,
  evidenceProfile,
  type EvidenceProfileId,
} from './profiles.js';

export const EVIDENCE_DATASET = {
  id: 'ctxalloc-evidence-development-v1',
  version: '1',
  split: 'development',
} as const;
export const EVIDENCE_COMPILER = {
  schemaVersion: 1,
  compilerId: 'ctxalloc-evidence-development',
  compilerVersion: '1',
  maxCorrectionSelections: 64,
} as const;
interface Spec {
  readonly id: string;
  readonly content: string;
  readonly useful: boolean;
  readonly priority?: number;
  readonly grade?: number;
  readonly ignored?: boolean;
  readonly required?: boolean;
  readonly repeat?: number;
  readonly sourceType?: SourceType;
}
interface Scenario {
  readonly id: string;
  readonly coverage: string;
  readonly profile: EvidenceProfileId;
  readonly blocks: readonly Spec[];
  readonly admitted: readonly string[];
  readonly included?: readonly string[];
  readonly uncertain?: readonly string[];
  readonly tight?: boolean;
  readonly exclude?: string;
  readonly misleading?: boolean;
  readonly invalid?: 'future-signal' | 'foreign-candidate' | 'foreign-declaration';
  readonly failure?: { readonly stage: string; readonly issueCode: string };
}
const bearing = {
  id: 'bearing',
  content: 'Set the telescope bearing to north.',
  useful: true,
} as const;
const poster = {
  id: 'poster',
  content: 'The corridor poster depicts a spiral galaxy.',
  useful: false,
} as const;
// New authored DEVELOPMENT fixtures. Labels are explicit human-authored truth, never derived from grades or required flags.
const scenarios: readonly Scenario[] = [
  {
    id: 'ed01',
    coverage: 'supported-authored-only',
    profile: 'authored-complete',
    blocks: [
      { ...bearing, priority: 3 },
      { ...poster, priority: 1 },
    ],
    admitted: ['bearing'],
  },
  {
    id: 'ed02',
    coverage: 'supported-retrieval-only',
    profile: 'retrieval-complete',
    blocks: [
      { ...bearing, grade: 3 },
      { ...poster, grade: 1 },
    ],
    admitted: ['bearing'],
  },
  {
    id: 'ed03',
    coverage: 'authored-policy-uncovered-retrieval',
    profile: 'authored-complete',
    blocks: [{ ...bearing, priority: 3, grade: 900, ignored: true }],
    admitted: [],
    failure: { stage: 'evidence-validation', issueCode: 'retrieval_score_rule_not_found' },
  },
  {
    id: 'ed04',
    coverage: 'same-evidence-explicitly-ignored',
    profile: 'authored-complete-ignore',
    blocks: [{ ...bearing, priority: 3, grade: 900, ignored: true }],
    admitted: ['bearing'],
  },
  {
    id: 'ed05',
    coverage: 'future-signal-schema-rejected',
    profile: 'authored-complete-ignore',
    blocks: [{ ...bearing, priority: 3 }],
    admitted: [],
    invalid: 'future-signal',
    failure: { stage: 'request-validation', issueCode: 'invalid_request' },
  },
  {
    id: 'ed06',
    coverage: 'supported-and-ignored-evidence',
    profile: 'combined-complete-ignore',
    blocks: [
      { ...bearing, priority: 2, grade: 2 },
      { ...poster, priority: 1, grade: 10000, ignored: true },
    ],
    admitted: ['bearing'],
  },
  {
    id: 'ed07',
    coverage: 'required-with-ignored-evidence',
    profile: 'authored-complete-ignore',
    blocks: [{ ...bearing, required: true, grade: -1000, ignored: true }],
    admitted: ['bearing'],
  },
  {
    id: 'ed08',
    coverage: 'complete-absent-signal',
    profile: 'authored-complete',
    blocks: [poster],
    admitted: [],
  },
  {
    id: 'ed09',
    coverage: 'incomplete-absent-useful',
    profile: 'authored-incomplete-admit',
    blocks: [bearing],
    admitted: ['bearing'],
    uncertain: ['bearing'],
  },
  {
    id: 'ed10',
    coverage: 'incomplete-absent-irrelevant',
    profile: 'authored-incomplete-admit',
    blocks: [poster],
    admitted: ['poster'],
    uncertain: ['poster'],
  },
  {
    id: 'ed11',
    coverage: 'complete-explicit-low',
    profile: 'authored-complete',
    blocks: [{ ...poster, priority: 0 }],
    admitted: [],
  },
  {
    id: 'ed12',
    coverage: 'incomplete-explicit-low',
    profile: 'authored-incomplete-admit',
    blocks: [{ ...bearing, priority: 0 }],
    admitted: ['bearing'],
    uncertain: ['bearing'],
  },
  {
    id: 'ed13',
    coverage: 'mixed-component-completeness',
    profile: 'combined-mixed-admit',
    blocks: [
      { ...bearing, priority: 2 },
      { ...poster, priority: 0, grade: 0 },
    ],
    admitted: ['bearing', 'poster'],
    uncertain: ['bearing', 'poster'],
  },
  {
    id: 'ed14',
    coverage: 'generous-uncertainty',
    profile: 'authored-incomplete-admit',
    blocks: [{ ...bearing, required: true }, poster],
    admitted: ['bearing', 'poster'],
    uncertain: ['poster'],
  },
  {
    id: 'ed15',
    coverage: 'tight-uncertainty',
    profile: 'authored-incomplete-admit',
    blocks: [{ ...bearing, required: true }, poster],
    admitted: ['bearing', 'poster'],
    included: ['bearing'],
    uncertain: ['poster'],
    tight: true,
  },
  {
    id: 'ed16',
    coverage: 'runtime-required-incomplete-reject',
    profile: 'authored-incomplete-reject',
    blocks: [{ ...bearing, required: true }],
    admitted: ['bearing'],
  },
  {
    id: 'ed17',
    coverage: 'applicability-before-uncertainty',
    profile: 'authored-incomplete-reject',
    blocks: [poster],
    admitted: [],
    exclude: 'poster',
  },
  {
    id: 'ed18',
    coverage: 'duplicate-wrappers-incomplete',
    profile: 'authored-incomplete-admit',
    blocks: [{ ...bearing, repeat: 4, sourceType: 'conversation' }],
    admitted: ['bearing'],
    uncertain: ['bearing'],
  },
  {
    id: 'ed19',
    coverage: 'misleading-low-useful',
    profile: 'authored-complete',
    blocks: [{ ...bearing, priority: 0 }],
    admitted: [],
    misleading: true,
  },
  {
    id: 'ed20',
    coverage: 'misleading-high-irrelevant',
    profile: 'authored-complete',
    blocks: [{ ...poster, priority: 4 }],
    admitted: ['poster'],
    misleading: true,
  },
  {
    id: 'ed21',
    coverage: 'misleading-both',
    profile: 'authored-complete',
    blocks: [
      { ...bearing, priority: 0 },
      { ...poster, priority: 4 },
    ],
    admitted: ['poster'],
    misleading: true,
  },
  {
    id: 'ed22',
    coverage: 'reject-incomplete-exclusion',
    profile: 'authored-incomplete-reject',
    blocks: [bearing],
    admitted: [],
    failure: { stage: 'filtering', issueCode: 'incomplete_admission_evidence' },
  },
  {
    id: 'ed23',
    coverage: 'permissive-incomplete-ignored',
    profile: 'curated-incomplete-ignore',
    blocks: [{ ...bearing, grade: -10000, ignored: true }, poster],
    admitted: ['bearing', 'poster'],
  },
  {
    id: 'ed24',
    coverage: 'foreign-candidate-rejected-first',
    profile: 'authored-incomplete-admit',
    blocks: [bearing],
    admitted: [],
    invalid: 'foreign-candidate',
    failure: { stage: 'candidate-validation', issueCode: 'scope_mismatch' },
  },
  {
    id: 'ed25',
    coverage: 'foreign-completeness-rejected',
    profile: 'authored-incomplete-admit',
    blocks: [bearing],
    admitted: [],
    invalid: 'foreign-declaration',
    failure: { stage: 'evidence-validation', issueCode: 'evidence_scope_mismatch' },
  },
  {
    id: 'ed26',
    coverage: 'required-applicability-conflict',
    profile: 'authored-incomplete-admit',
    blocks: [{ ...bearing, required: true }],
    admitted: [],
    exclude: 'bearing',
    failure: { stage: 'filtering', issueCode: 'required_applicability_conflict' },
  },
  {
    id: 'ed27',
    coverage: 'ignored-is-not-positive-support',
    profile: 'authored-incomplete-ignore',
    blocks: [
      { ...bearing, grade: 10000, ignored: true },
      { ...poster, priority: 0, sourceType: 'conversation' },
    ],
    admitted: ['bearing', 'poster'],
    uncertain: ['bearing', 'poster'],
  },
];

export function buildEvidenceDevelopment(tokenizer: Tokenizer) {
  return scenarios.map((s) => {
    const sourceDocuments = s.blocks.map((b) => ({
      schemaVersion: 1,
      id: `evidence-doc:${b.id}`,
      scope: EVIDENCE_SCOPE,
      sourceType: b.sourceType ?? 'text',
      contentHash: `sha256:${createHash('sha256').update(b.content).digest('hex')}`,
      metadata: {},
    }));
    const candidates = s.blocks.flatMap((b) => {
      const provider = b.ignored ? IGNORED_PROVIDER : GRADE_PROVIDER;
      const c = {
        schemaVersion: 1,
        block: {
          schemaVersion: 1,
          id: b.id,
          scope:
            s.invalid === 'foreign-candidate'
              ? { ...EVIDENCE_SCOPE, tenantId: 'elsewhere' }
              : EVIDENCE_SCOPE,
          sourceDocumentId: `evidence-doc:${b.id}`,
          sourceType: b.sourceType ?? 'text',
          content: b.content,
          normalizedContentHash: calculateNormalizedContentHash(b.content),
          tokenCount: tokenizer.countTokens(b.content),
          sourceLocation:
            b.sourceType === 'conversation'
              ? { kind: 'conversation-message', messageId: b.id, messageIndex: 0 }
              : { kind: 'text-range', startOffset: 0, endOffset: b.content.length },
          attributes: {
            ...(b.priority === undefined ? {} : { priority: b.priority }),
            ...(b.required ? { required: true } : {}),
          },
          metadata: {},
        },
        ...(b.grade === undefined
          ? {}
          : {
              retrieval: {
                providerId: provider.providerId,
                providerVersion: provider.providerVersion,
                score: {
                  value: b.grade,
                  semantics: provider.semantics,
                  higherIsBetter: provider.higherIsBetter,
                },
              },
            }),
      };
      return Array.from({ length: b.repeat ?? 1 }, () => c);
    });
    const base = evidenceProfile(
      s.profile,
      s.invalid === 'foreign-declaration'
        ? { ...EVIDENCE_SCOPE, workspaceId: 'elsewhere' }
        : EVIDENCE_SCOPE,
    );
    const policy =
      s.exclude === undefined
        ? base
        : {
            ...base,
            filtering: {
              ...base.filtering,
              applicability: {
                scope: EVIDENCE_SCOPE,
                exclusions: [{ blockId: s.exclude, reason: 'inapplicable' }],
              },
            },
          };
    // Tight budget is exactly the serialized required record. Use real tokenizer, no character/token estimate.
    const available = s.tight
      ? tokenizer.countTokens(
          JSON.stringify({
            blockId: bearing.id,
            content: bearing.content,
            sourceDocumentId: `evidence-doc:${bearing.id}`,
            sourceType: 'text',
          }),
        )
      : 1000;
    const valid = new CompilationRequestValidator().validate({
      schemaVersion: 1,
      id: `evidence-dev:${s.id}`,
      scope: EVIDENCE_SCOPE,
      query: 'Which direction should the telescope bearing face?',
      referenceTime: '2026-07-01T00:00:00.000Z',
      candidates,
      sourceDocuments,
      budget: { totalTokens: available + 100, reservedOutputTokens: 100 },
      policy,
    });
    const input: unknown =
      s.invalid === 'future-signal'
        ? {
            ...valid,
            candidates: valid.candidates.map((c) => ({ ...c, futureSignal: { score: 1 } })),
          }
        : valid;
    return {
      id: s.id,
      candidateWrappers: candidates.length,
      profile: s.profile,
      coverage: s.coverage,
      budgetRegime: s.tight ? 'tight' : 'generous',
      evidenceQuality: s.misleading ? 'misleading' : 'declared-development-evidence',
      truth: s.blocks.map((b) => ({ unitId: b.id, useful: b.useful })),
      expected: {
        admitted: s.admitted,
        included: s.included ?? s.admitted,
        uncertain: s.uncertain ?? [],
        failure: s.failure ?? null,
      },
      input,
    };
  });
}

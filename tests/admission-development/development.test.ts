import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import {
  ADMISSION_COMPILER,
  buildAdmissionDevelopment,
} from '../../benchmarks/admission-development/cases.js';
import {
  ADMISSION_PROFILE_IDS,
  admissionProfile,
} from '../../benchmarks/admission-development/profiles.js';
import { evaluateAdmissionDevelopment } from '../../benchmarks/admission-development/evaluate.js';

const tokenizer = new O200kBaseTokenizer();
const cases = buildAdmissionDevelopment(tokenizer);
const report = evaluateAdmissionDevelopment(tokenizer);

describe('independent DEVELOPMENT-ONLY admission evidence', () => {
  it.each(cases)(
    '$id satisfies its independently authored admission and final-selection expectations',
    (entry) => {
      const observation = report.cases.find((c) => c.caseId === entry.id)!;
      expect(observation.checks).toEqual({
        admissionMatches: true,
        finalSelectionMatches: true,
        wrappersAccounted: true,
        requiredGroupsPreserved: true,
        withinBudget: true,
      });
      const actual = new ContextCompiler(ADMISSION_COMPILER, tokenizer).compile(
        entry.compilationRequest,
      );
      expect(observation.diagnostic.usage).toEqual(actual.usage);
      expect(observation.includedIds).toEqual(actual.includedBlocks.map((b) => b.id));
      expect(actual.trace.settlement.rendering.compiledTokens).toBe(
        tokenizer.countTokens(actual.compiledContext),
      );
    },
  );

  it('keeps complete versioned caller policies and their missing-evidence semantics explicit', () => {
    expect(
      ADMISSION_PROFILE_IDS.map((id) => admissionProfile(id).policy.filtering.minimumTotalScore),
    ).toEqual([0.5, 0.5, 1, undefined]);
    for (const id of ADMISSION_PROFILE_IDS) {
      const profile = admissionProfile(id);
      expect(profile.policy.policyVersion).toBe('1');
      expect(profile.scoreOwner.length).toBeGreaterThan(0);
      expect(profile.missingEvidence.length).toBeGreaterThan(0);
      expect(profile.thresholdDerivation.length).toBeGreaterThan(0);
    }
  });

  it('makes the restrictive missing-evidence loss visible beside the permissive alternative', () => {
    const restrictive = report.cases.find((c) => c.caseId === 'missing-evidence-restrictive')!;
    const permissive = report.cases.find((c) => c.caseId === 'missing-evidence-curated')!;
    expect(restrictive.includedIds).toEqual([]);
    expect(restrictive.limitation).toContain('Useful but unrated');
    expect(permissive.includedIds).toEqual(['unrated']);
  });

  it('preserves complementary medium-grade facts and nearly all-useful content', () => {
    expect(
      report.cases.find((c) => c.caseId === 'complementary-medium-facts')!.includedIds,
    ).toHaveLength(3);
    const allUseful = report.cases.find((c) => c.caseId === 'nearly-all-useful')!;
    expect(allUseful.includedIds).toHaveLength(allUseful.diagnostic.groups.length);
  });

  it('is deterministic and publishes no raw content or held-out product claim', () => {
    expect(JSON.stringify(evaluateAdmissionDevelopment(tokenizer))).toBe(JSON.stringify(report));
    expect(report.dataset.split).toBe('development');
    expect(report.productValidation).toBe('NOT_EVALUATED');
    const serialized = JSON.stringify(report);
    for (const entry of cases) {
      expect(serialized).not.toContain(entry.compilationRequest.query);
      for (const candidate of entry.compilationRequest.candidates)
        expect(serialized).not.toContain(candidate.block.content);
    }
  });

  it('covers the requested development scenarios without importing frozen-v1 data', () => {
    const coverage = new Set(cases.flatMap((c) => c.coverage));
    for (const item of [
      'obvious-noise',
      'complementary-medium-facts',
      'all-useful',
      'no-useful-optionals',
      'missing-retrieval',
      'authored-only',
      'retrieval-only',
      'combined-evidence',
      'history',
      'duplicates',
      'tight-budget',
      'generous-budget',
      'conflict-without-applicability',
      'required-below-threshold',
      'mixed-sources',
    ])
      expect(coverage.has(item)).toBe(true);
    for (const file of ['cases.ts', 'profiles.ts', 'evaluate.ts']) {
      const source = readFileSync(
        new URL(`../../benchmarks/admission-development/${file}`, import.meta.url),
        'utf8',
      );
      expect(source).not.toMatch(/from\s+['"][^'"]*evaluation\/v1/);
    }
  });
});

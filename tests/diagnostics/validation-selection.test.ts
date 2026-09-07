import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ContextCompiler } from '@ctxalloc/compiler';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { diagnoseValidationSelection } from '../../benchmarks/diagnostics/validation-selection.js';
import { buildEvaluationSuiteV1 } from '../../benchmarks/evaluation/v1/index.js';
import { benchmarkCompilerConfig } from '../../benchmarks/evaluation/v1/fixtures.js';

describe('frozen validation selection diagnostic', () => {
  it('derives every validation case from actual inputs and reconciles all wrappers and final decisions', () => {
    const tokenizer = new O200kBaseTokenizer();
    const cases = buildEvaluationSuiteV1(tokenizer).filter(
      (entry) => entry.datasetSplit === 'validation',
    );
    const report = diagnoseValidationSelection(tokenizer);
    expect(report.cases.map((entry) => entry.caseId)).toEqual(cases.map((entry) => entry.id));
    expect(report.cases).toHaveLength(3);
    for (const [index, entry] of cases.entries()) {
      const diagnostic = report.cases[index]!;
      const result = new ContextCompiler(benchmarkCompilerConfig(), tokenizer).compile(
        entry.compilationRequest,
      );
      expect(diagnostic.compilationId).toBe(result.compilationId);
      expect(diagnostic.groups.flatMap((group) => group.members)).toHaveLength(
        entry.compilationRequest.candidates.length,
      );
      expect(diagnostic.groups.map((group) => group.finalDecision)).toEqual(
        result.trace.settlement.decisions,
      );
      expect(diagnostic.usage).toEqual(result.usage);
      expect(JSON.stringify(diagnostic)).not.toContain(entry.compilationRequest.query);
      for (const wrapper of entry.compilationRequest.candidates) {
        expect(JSON.stringify(diagnostic)).not.toContain(wrapper.block.content);
      }
    }
    expect(JSON.stringify(diagnoseValidationSelection(tokenizer))).toBe(JSON.stringify(report));
  });

  it('has no selection branch using benchmark identities or evaluation annotations', () => {
    for (const name of ['compilation-decisions.ts', 'validation-selection.ts']) {
      const source = readFileSync(
        new URL(`../../benchmarks/diagnostics/${name}`, import.meta.url),
        'utf8',
      );
      expect(source).not.toMatch(
        /case-\d|irrelevantBlockIds|requiredBlockIds|answerCriteria|expectedResult/,
      );
    }
  });
});

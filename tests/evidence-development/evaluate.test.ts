import { describe, expect, it } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { evaluateEvidenceDevelopment } from '../../benchmarks/evidence-development/evaluate.js';

const report = evaluateEvidenceDevelopment(new O200kBaseTokenizer());
describe('Phase 21D DEVELOPMENT corpus, not held-out validation', () => {
  it('covers all 21 requested scenarios plus explicit rejection and boundary cases', () => {
    expect(report.cases).toHaveLength(27);
    expect(new Set(report.cases.map((c) => c.coverage)).size).toBe(27);
    expect(
      report.cases
        .filter((c) => !c.contractCorrect)
        .map((c) => ({ id: c.caseId, checks: c.checks, failure: c.failure })),
    ).toEqual([]);
    expect(report.contractCorrectness).toBe('PASS');
    expect(report.productValidation).toBe('NOT_EVALUATED');
    expect(report.heldOutValidation).toBe('NOT_EVALUATED');
  });
  it('reports misleading complete evidence as contract-correct and ineffective', () => {
    const misleading = report.cases.filter((c) => c.evidenceQuality === 'misleading');
    expect(misleading.map((c) => c.caseId)).toEqual(['ed19', 'ed20', 'ed21']);
    expect(misleading.every((c) => c.contractCorrect)).toBe(true);
    expect(misleading.map((c) => c.effectiveness?.usefulPreservation.value)).toEqual([0, null, 0]);
    expect(misleading.map((c) => c.effectiveness?.irrelevantRejection.value)).toEqual([null, 0, 0]);
  });
  it('reports the precision cost of admitting missing evidence and the independent budget limit', () => {
    const noise = report.cases.find((c) => c.caseId === 'ed10')!;
    expect(noise.effectiveness?.irrelevantRejection.value).toBe(0);
    const tight = report.cases.find((c) => c.caseId === 'ed15')!;
    expect(tight.trace?.groups.find((g) => g.canonical.id === 'poster')).toMatchObject({
      filtering: { reason: 'ELIGIBLE_INCOMPLETE_EVIDENCE' },
    });
    expect(tight.trace?.settlement.decisions.find((d) => d.blockId === 'poster')?.disposition).toBe(
      'excluded',
    );
  });
  it('is byte deterministic and contains diagnostics without raw source bodies', () => {
    expect(evaluateEvidenceDevelopment(new O200kBaseTokenizer())).toEqual(report);
    const bytes = JSON.stringify(report);
    expect(bytes).not.toContain('Set the telescope bearing to north.');
    expect(bytes).not.toContain('The corridor poster depicts a spiral galaxy.');
  });
});

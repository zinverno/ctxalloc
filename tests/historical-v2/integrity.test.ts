import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateScorer, ContextCompiler, ContextRenderer } from '@ctxalloc/compiler';
import { verifyPhase21EHistory } from '../../benchmarks/historical-v2/phase21e.js';
afterEach(() => vi.restoreAllMocks());
describe('Phase 21E historical verification preserves the first experiment', () => {
  it('verifies a committed report larger than 1 MiB without executing selection', () => {
    const spies = [
      vi.spyOn(ContextCompiler.prototype, 'compile'),
      vi.spyOn(CandidateScorer.prototype, 'score'),
      vi.spyOn(ContextRenderer.prototype, 'render'),
    ];
    for (const spy of spies)
      spy.mockImplementation(() => {
        throw new Error('Historical verification must never execute selection.');
      });
    expect(readFileSync('docs/evidence/phase21e-first-run.json').length).toBeGreaterThan(
      1024 * 1024,
    );
    expect(verifyPhase21EHistory(process.cwd())).toMatchObject({
      status: 'PASS',
      compilerExecuted: false,
      originalExecutableReproduced: false,
      originalSemanticsFilesVerifiedAgainstFreezeTree: 220,
      originalBuiltArtifactHashesPreserved: 142,
      caseCount: 60,
      successfulCompilations: 43,
      expectedFailures: 17,
      unexpectedOutcomes: 0,
      heldOutEvidenceAwareContextSelection: 'PASS',
    });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it.each([
    'benchmarks/heldout-v2/v2/cases.json',
    'benchmarks/heldout-v2/v2/freeze.json',
    'benchmarks/heldout-v2/profiles.ts',
    'benchmarks/heldout-v2/gates.ts',
    'docs/PHASE21E_HELD_OUT_PROTOCOL.md',
    'docs/evidence/phase21e-first-run.json',
  ])('rejects tampering in %s', (target) => {
    expect(() =>
      verifyPhase21EHistory(process.cwd(), (p) => {
        const bytes = readFileSync(p);
        return p === target ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
      }),
    ).toThrow('Frozen artifact changed');
  });
});

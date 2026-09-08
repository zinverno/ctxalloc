import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyPhase21CHistory } from '../../benchmarks/historical/phase21c.js';

describe('Phase 21C historical artifact integrity after DEC-045', () => {
  it('verifies the immutable FAIL without executing a changed compiler', () => {
    expect(verifyPhase21CHistory(process.cwd())).toMatchObject({
      status: 'PASS',
      changedCompilerExecuted: false,
      originalExecutableReproduced: false,
      originalSemanticsFilesVerifiedAgainstMergedTree: 155,
      originalBuiltArtifactHashesPreserved: 123,
      caseCount: 48,
      successfulCompilations: 22,
      expectedFailures: 4,
      unexpectedFailures: 22,
      heldOutContextSelectionValidation: 'FAIL',
    });
  });
  it.each([
    'benchmarks/heldout/v1/cases.json',
    'benchmarks/heldout/v1/freeze.json',
    'docs/PHASE21C_HELD_OUT_PROTOCOL.md',
    'docs/evidence/phase21c-first-run.json',
    'benchmarks/heldout/gates.ts',
  ])('rejects byte tampering in %s', (target) => {
    expect(() =>
      verifyPhase21CHistory(process.cwd(), (path) => {
        const bytes = readFileSync(path);
        return path === target ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes;
      }),
    ).toThrow('Frozen artifact changed');
  });
});

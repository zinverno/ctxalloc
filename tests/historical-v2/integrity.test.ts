import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { verifyPhase21EHistory } from '../../benchmarks/historical-v2/phase21e.js';

describe('original Phase 21E historical verifier after squash integration', () => {
  it('retains the original implementation and CLI bytes', () => {
    for (const path of ['benchmarks/historical-v2/phase21e.ts', 'benchmarks/historical-v2/run.ts'])
      expect(readFileSync(path)).toEqual(
        execFileSync('git', ['show', `f4c3c999ee6afc3fe52ea606fcd6fdca1053d06c:${path}`]),
      );
  });
  it('still rejects lost ancestry before reading evidence', () => {
    // The original command is intentionally inapplicable on the squash lineage.
    // This also rejects when its orphaned results object is absent entirely.
    const read = vi.fn(() => Buffer.alloc(0));
    expect(() => verifyPhase21EHistory(process.cwd(), read)).toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

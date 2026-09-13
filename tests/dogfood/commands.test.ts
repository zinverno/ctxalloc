import { readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import * as evaluator from '../../benchmarks/dogfood/evaluate.js';
import * as freeze from '../../benchmarks/dogfood/freeze.js';
import { runDogfood } from '../../benchmarks/dogfood/commands.js';
import { toy } from './fixtures.js';

const tokenizer = new O200kBaseTokenizer();
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function setup() {
  const f = await toy(tokenizer);
  roots.push(f.root);
  // Engine output is explicitly toy-only. Human-shaped flags below test CLI plumbing
  // with the evaluator stubbed, never establish independent human ground truth.
  const toyReport = await evaluator.evaluateDogfood(
    f.settings,
    f.tasks,
    f.annotations,
    f.prepared,
    tokenizer,
  );
  f.annotations.process = {
    kind: 'human',
    author: 'MOCK CHECKPOINT ONLY',
    method: 'MOCK; evaluator is stubbed',
    independentOfRetrieval: true,
    approvedForEvaluation: true,
    approvalReference: 'MOCK AUTHORIZATION FOR SOFTWARE TEST',
  };
  writeFileSync(f.paths.annotations, JSON.stringify(f.annotations));
  vi.spyOn(freeze, 'implementationIdentity').mockReturnValue('mock-build-identity');
  const frozen = join(f.base, 'freeze.json'),
    out = join(f.base, 'result.json');
  const common = [
    '--local',
    f.paths.settings,
    '--tasks',
    f.paths.tasks,
    '--annotations',
    f.paths.annotations,
  ];
  expect((await runDogfood(['freeze', ...common, '--out', frozen], f.root)).report.status).toBe(
    'FROZEN_AWAITING_EVALUATION',
  );
  return { ...f, toyReport, frozen, out, common };
}

describe('Dogfood CLI freeze and first-result plumbing; stubbed toy engine only', () => {
  it('reserves the first result before selection and refuses reuse before another engine call', async () => {
    const f = await setup();
    const engine = vi.spyOn(evaluator, 'evaluateDogfood').mockImplementation(async () => {
      expect(JSON.parse(readFileSync(f.out, 'utf8')).status).toBe('STARTED_NOT_COMPLETED');
      return f.toyReport;
    });
    const args = ['evaluate', ...f.common, '--freeze', f.frozen, '--out', f.out];
    const result = await runDogfood(args, f.root);
    expect(result.report.status).toBe('TOY_SOFTWARE_TEST_ONLY');
    const first = readFileSync(f.out, 'utf8');
    expect((await runDogfood(args, f.root)).exitCode).toBe(2);
    expect(engine).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.out, 'utf8')).toBe(first);
  });
  it('retains a STARTED marker and bounded failure when the engine is interrupted', async () => {
    const f = await setup();
    vi.spyOn(evaluator, 'evaluateDogfood').mockRejectedValue(
      new Error('PRIVATE INTERRUPTION CANARY'),
    );
    const result = await runDogfood(
      ['evaluate', ...f.common, '--freeze', f.frozen, '--out', f.out],
      f.root,
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain('CANARY');
    expect(JSON.parse(readFileSync(f.out, 'utf8')).status).toBe('STARTED_NOT_COMPLETED');
  });
  it.each(['settings', 'annotations', 'source', 'implementation'] as const)(
    'refuses frozen %s drift before selection',
    async (kind) => {
      const f = await setup();
      const engine = vi.spyOn(evaluator, 'evaluateDogfood').mockResolvedValue(f.toyReport);
      if (kind === 'settings')
        writeFileSync(f.paths.settings, JSON.stringify({ ...f.settings, availableTokens: 3000 }));
      if (kind === 'annotations')
        writeFileSync(
          f.paths.annotations,
          JSON.stringify({
            ...f.annotations,
            process: { ...f.annotations.process, method: 'changed process' },
          }),
        );
      if (kind === 'source') appendFileSync(join(f.snapshot, 'doc.md'), '\n');
      if (kind === 'implementation')
        vi.mocked(freeze.implementationIdentity).mockReturnValue('changed-build');
      expect(
        (await runDogfood(['evaluate', ...f.common, '--freeze', f.frozen, '--out', f.out], f.root))
          .exitCode,
      ).toBe(2);
      expect(engine).not.toHaveBeenCalled();
    },
  );
});

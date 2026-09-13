import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { ContextCompiler } from '@ctxalloc/compiler';
import { evaluateDogfood } from '../../benchmarks/dogfood/evaluate.js';
import { freezeRecord, verifyFrozen } from '../../benchmarks/dogfood/freeze.js';
import { toy } from './fixtures.js';

const tokenizer = new O200kBaseTokenizer();
const roots: string[] = [];
async function fixture() {
  const f = await toy(tokenizer);
  roots.push(f.root);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Dogfood workflow software tests; no human evidence or real evaluation', () => {
  it('uses the actual configured cap, preserves native evidence and canonical downstream determinism', async () => {
    const f = await fixture();
    const report = await evaluateDogfood(
      { ...f.settings, maxCandidates: 1 },
      f.tasks,
      f.annotations,
      f.prepared,
      tokenizer,
    );
    expect(report.purpose).toBe('TOY_SOFTWARE_TEST_ONLY');
    expect(report.verdict).toBe('TOY_SOFTWARE_TEST_ONLY');
    expect(report.queries[0]!.pipelineFailure).toBe(false);
    expect(report.queries[0]!.native.filter((c) => c.retainedByCap)).toHaveLength(1);
    expect(report.primary.evidenceLosses.retrievalCap).toBeGreaterThan(0);
    expect(report.primary.admissionRecall?.value).toBe(1);
    expect(report.primary.gates.determinism).toBe('PASS');
    expect(report.preservationQualifiedSavings).toBeNull();
  });
  it('INV-BUDGET-001: retains required-content compilation failure and its losses without fake savings', async () => {
    const f = await fixture();
    f.tasks.tasks[0]!.runtime.push({
      id: 'obligation',
      content: 'Caller must preserve this obligatory instruction exactly.',
      basis: 'Toy caller contract, unrelated to evaluator labels',
    });
    const report = await evaluateDogfood(
      { ...f.settings, availableTokens: 1 },
      f.tasks,
      f.annotations,
      f.prepared,
      tokenizer,
    );
    expect(report.queries[0]!.pipelineFailure).toBe(false);
    expect(report.primary.failures).toBe(1);
    expect(report.primary.finalFactPreservation.denominator).toBe(
      f.annotations.tasks[0]!.facts.length,
    );
    expect(report.primary.finalFactPreservation.numerator).toBe(0);
    expect(report.primary.runtimePreservation.value).toBe(0);
    expect(report.primary.tokenComparisons.retrievedToCompiled).toBeNull();
    expect(report.primary.tokenComparisons.preparedToRetrieved).not.toBeNull();
    expect(report.generous.failures).toBe(0);
    expect(report.primary.gates.compilation).toBe('FAIL');
    expect(report.queries[0]!.feasibility.status).toBe('UNKNOWN');
  });
  it('keeps evaluator critical/required labels out of runtime flags and policy', async () => {
    const f = await fixture(),
      spy = vi.spyOn(ContextCompiler.prototype, 'compile');
    const report = await evaluateDogfood(f.settings, f.tasks, f.annotations, f.prepared, tokenizer);
    expect(report.queries[0]!.pipelineFailure).toBe(false);
    for (const call of spy.mock.calls) {
      const request = call[0] as {
        candidates: { block: { attributes: Record<string, unknown> } }[];
        policy: { filtering: Record<string, unknown> };
      };
      expect(request.candidates.every((c) => c.block.attributes.required !== true)).toBe(true);
      expect(request.policy.filtering).not.toHaveProperty('minimumTotalScore');
    }
    expect(report.primary.runtimePreservation.value).toBeNull();
    expect(JSON.stringify(report)).not.toContain(f.content.text);
    expect(JSON.stringify(report)).not.toContain(f.tasks.tasks[0]!.query + ' proof.');
  });
  it('reports missing criticality as NOT_EVALUATED and cannot rescue the primary point with the control', async () => {
    const f = await fixture();
    f.annotations.tasks[0]!.facts[0]!.critical = null;
    const report = await evaluateDogfood(f.settings, f.tasks, f.annotations, f.prepared, tokenizer);
    expect(report.primary.criticalityStatus).toBe('NOT_EVALUATED');
    expect(report.primary.gates.critical).toBe('NOT_EVALUATED');
    expect(report.samplingCoverage).toBe('INCOMPLETE');
    expect(report.preservationQualifiedSavings).toBeNull();
  });
  it('binds inputs, operating point, source preparation, policy and implementation before selection', async () => {
    const f = await fixture(),
      providerSpy = vi.spyOn(ContextCompiler.prototype, 'compile');
    const original = freezeRecord(
      f.settings,
      f.tasks,
      f.annotations,
      f.prepared,
      'toy-code-identity',
    );
    expect(() => verifyFrozen(original, original)).not.toThrow();
    expect(providerSpy).not.toHaveBeenCalled();
    const mutations = [
      freezeRecord(
        { ...f.settings, maxCandidates: 1 },
        f.tasks,
        f.annotations,
        f.prepared,
        'toy-code-identity',
      ),
      freezeRecord(
        f.settings,
        { ...f.tasks, collectionRecord: 'different collection' },
        f.annotations,
        f.prepared,
        'toy-code-identity',
      ),
      freezeRecord(
        f.settings,
        f.tasks,
        {
          ...f.annotations,
          process: { ...f.annotations.process, method: 'changed annotations process' },
        },
        f.prepared,
        'toy-code-identity',
      ),
      freezeRecord(
        f.settings,
        f.tasks,
        f.annotations,
        { ...f.prepared, fingerprint: 'changed snapshot' },
        'toy-code-identity',
      ),
      freezeRecord(f.settings, f.tasks, f.annotations, f.prepared, 'changed-code'),
    ];
    for (const changed of mutations)
      expect(() => verifyFrozen(original, changed)).toThrow('frozen_input_changed');
  });
});

it('keeps an empty native result and unanswerable task without inventing a required query block', async () => {
  const f = await fixture();
  f.tasks.tasks[0]!.query = 'zzzzunmatchedtoyterm';
  f.annotations.tasks[0] = {
    taskId: 'toy-task',
    answerability: 'unanswerable',
    scopeReviewed: true,
    useful: [],
    facts: [],
    irrelevantBlockIds: f.prepared.corpus.blocks.map((b) => b.id),
  };
  const report = await evaluateDogfood(f.settings, f.tasks, f.annotations, f.prepared, tokenizer);
  expect(report.queries[0]!.pipelineFailure).toBe(false);
  expect(report.queries[0]!.native).toHaveLength(0);
  expect(report.primary.queryCount).toBe(1);
  expect(report.primary.runtimePreservation.denominator).toBe(0);
  expect(report.primary.retrievalRecall?.value).toBeNull();
  expect(report.primary.finalFactPreservation.value).toBeNull();
});

it('rejects a direct non-toy evaluator call without the declared human checkpoint', async () => {
  const f = await fixture();
  f.annotations.process.kind = null;
  await expect(
    evaluateDogfood(f.settings, f.tasks, f.annotations, f.prepared, tokenizer),
  ).rejects.toThrow('human_data_checkpoint');
});

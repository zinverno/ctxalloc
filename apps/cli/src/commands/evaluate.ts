import { SystemMonotonicClock } from '@ctxalloc/adapters';
import { EvaluationHarness, type EvaluationReport } from '@ctxalloc/evaluation';
import { O200kBaseTokenizer } from '@ctxalloc/tokenization';
import { CliError, cliIssue } from '../errors.js';
import { toCliError } from '../failures.js';
import type { CliConfig } from '../config.js';

/**
 * `ctxalloc eval` (DEC-042).
 *
 * It makes the existing `EvaluationHarness` runnable from a shell. It redesigns
 * nothing about evaluation: the baselines, the metrics, the determinism repeats,
 * and the report shape are all the harness's, and a CLI that recomputed any of
 * them would be a second measurement of one thing (INV-DEP-003).
 *
 * ## No model, structurally
 *
 * The harness takes an optional `ModelProvider`, and this command **never
 * constructs one**. That is not a flag an operator can flip and not a default
 * that could drift: there is no code path here that reaches a model SDK, reads
 * an API key, or opens a socket, so no invocation of this command — in CI or
 * anywhere else — can call a model (INV-DEP-002).
 *
 * A run configuration that enables model execution is therefore rejected by the
 * harness itself, before anything is compiled. Adding secret handling merely to
 * be able to claim live model execution would be adding an untested capability
 * to a command whose value is that it runs offline.
 *
 * ## Report only
 *
 * The output is an `EvaluationReport` and nothing else. `runSuite` never collects
 * the raw strings — `EvaluationCaseDetails` exists only inside
 * `runCaseDetailed`, which this command does not call — so the compiled context,
 * the query, and any model answer are structurally absent from what is printed
 * rather than filtered out of it (INV-SEC-001).
 *
 * Nothing is persisted. Evaluation reports are not control-plane data and not
 * audit records of a compilation, and giving them a table would be storing a
 * benchmark result in the operational database (DEC-042).
 */

/**
 * Runs one evaluation case and returns the report.
 *
 * The compiler configuration comes from the CLI config's `localCompile.compiler`,
 * so an evaluation measures the same compiler an operator's `compile` command
 * runs. A separate compiler configuration for evaluation would let the benchmark
 * measure something the product does not do (INV-EVAL-001).
 *
 * @throws {CliError} for every failure, with the stage the caller can act on.
 */
export async function runEvalCommand(
  config: CliConfig,
  runConfig: unknown,
  evaluationCase: unknown,
): Promise<EvaluationReport> {
  const localCompile = config.localCompile;
  if (typeof localCompile !== 'object' || localCompile === null) {
    throw new CliError('config', [cliIssue('invalid_config', 'localCompile', 'must be an object')]);
  }
  const compilerConfig = (localCompile as { compiler?: unknown }).compiler;

  try {
    const harness = new EvaluationHarness(
      compilerConfig,
      new O200kBaseTokenizer(),
      new SystemMonotonicClock(),
    );
    return await harness.runSuite(runConfig, [evaluationCase]);
  } catch (cause) {
    throw toCliError(cause, 'evaluation');
  }
}

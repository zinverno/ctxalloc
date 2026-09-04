import {
  CompilationTracePersistenceError,
  LocalSourcePipelineError,
  LocalSourceRegistryError,
  type LocalSourcePipelineStage,
} from '@ctxalloc/application';
import { ContextCompilationError } from '@ctxalloc/compiler';
import { SQLiteControlStoreError, SQLiteTraceStoreError } from '@ctxalloc/adapters';
import {
  EvaluationCaseValidationError,
  EvaluationHarnessError,
  EvaluationRunConfigValidationError,
} from '@ctxalloc/evaluation';
import { CliError, cliIssue, issuesOf, type CliStage } from './errors.js';

/**
 * Translating a component failure into the CLI's own contract (DEC-042).
 *
 * Every error the CLI can meet is already project-owned, structured, and
 * privacy-minimized: the packages beneath it translated their dependencies'
 * failures on the way out, which is the whole reason this function has so little
 * to do. What is left is choosing the **stage** — the CLI's answer to *which
 * part of my invocation was wrong?* — and projecting the issues onto one
 * envelope.
 *
 * The thrown value's `message` is never copied into an issue. Each error type's
 * `issues` array is already written by this project; a `message` may summarize
 * them, but for a value this function does not recognize it may be anything at
 * all, including a driver's wording (INV-SEC-001).
 */

/**
 * Which CLI stage one pre-compiler pipeline failure belongs to.
 *
 * The pipeline's own stages are finer than the CLI's on purpose: they name the
 * step inside a service, and an operator needs to know which of *their* inputs
 * was at fault. A registration this build cannot read and a chunker that
 * rejected a file are both `preparation` from the outside, while an unreachable
 * control store is `source-store` and an unreadable file is `source-read`.
 */
const PIPELINE_STAGES: Readonly<Record<LocalSourcePipelineStage, CliStage>> = {
  configuration: 'config',
  'request-validation': 'input',
  'control-store': 'source-store',
  'source-registration': 'preparation',
  'source-read': 'source-read',
  'source-ingestion': 'preparation',
  'source-chunking': 'preparation',
  'candidate-provider': 'retrieval',
};

/**
 * Turns any thrown value into a `CliError`.
 *
 * A `CliError` travels unchanged: it was raised by the CLI itself and already
 * names the stage the caller needs.
 *
 * A value this function does not recognize becomes one fixed issue at
 * `fallback`. That is deliberately uninformative: an unrecognized value is, by
 * definition, one whose contents this project has not vouched for, and copying
 * its message would publish whatever it happened to say.
 */
export function toCliError(cause: unknown, fallback: CliStage): CliError {
  if (cause instanceof CliError) return cause;

  if (cause instanceof LocalSourcePipelineError) {
    return new CliError(
      PIPELINE_STAGES[cause.stage],
      issuesOf(cause, 'local_pipeline_failed', 'the local source pipeline failed'),
    );
  }

  if (cause instanceof LocalSourceRegistryError) {
    return new CliError(
      'source-store',
      issuesOf(cause, 'source_store_failed', 'the local control store operation failed'),
    );
  }

  if (cause instanceof CompilationTracePersistenceError) {
    return new CliError(
      'trace-store',
      issuesOf(cause, 'trace_store_failed', 'the local trace store operation failed'),
    );
  }

  if (cause instanceof ContextCompilationError) {
    return new CliError(
      'compilation',
      issuesOf(cause, 'compilation_failed', 'the compilation failed'),
    );
  }

  // An adapter constructed directly by the CLI — a store whose database could
  // not be opened or migrated — fails before any service is reached, so its
  // stable code is the whole of what there is to report. The message is this
  // project's own and names no path, no SQL, and no driver wording.
  if (cause instanceof SQLiteControlStoreError) {
    return new CliError('source-store', [
      cliIssue(cause.code, 'config.databasePath', cause.message),
    ]);
  }
  if (cause instanceof SQLiteTraceStoreError) {
    return new CliError('trace-store', [
      cliIssue(cause.code, 'config.databasePath', cause.message),
    ]);
  }

  if (cause instanceof EvaluationCaseValidationError) {
    return new CliError(
      'evaluation',
      issuesOf(cause, 'invalid_case', 'the evaluation case is invalid'),
    );
  }
  if (cause instanceof EvaluationRunConfigValidationError) {
    return new CliError(
      'evaluation',
      issuesOf(cause, 'invalid_run_config', 'the evaluation run configuration is invalid'),
    );
  }
  if (cause instanceof EvaluationHarnessError) {
    // The harness reports one machine-readable `issueCode` and no issues array.
    // Its message is project-owned and quotes no case content, so it is the one
    // component message the envelope carries.
    return new CliError('evaluation', [cliIssue(cause.issueCode, '', cause.message)]);
  }

  return new CliError(fallback, [
    cliIssue('unexpected_failure', '', `the command failed at ${fallback}`),
  ]);
}

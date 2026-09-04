/**
 * The CLI failure contract (DEC-042).
 *
 * The CLI is a public runtime boundary. Everything it prints is something a
 * person reads or a script parses, and everything it is handed — a config file,
 * a request file, a database an operator edited — is external.
 *
 * So exactly one shape is ever written to stderr, and it is machine-readable. A
 * raw `SyntaxError`, a validation-library error, a SQLite error, a filesystem
 * error, and a stack trace are all failures of this contract: the first three
 * quote data the caller did not ask to see (a fragment of the malformed file, a
 * SQL statement, an absolute path), and the last is a fact about this program's
 * source rather than about the operator's problem (INV-SEC-001,
 * INV-ADAPTER-001).
 */

/** The schema version of the CLI error envelope (INV-STORE-004). */
export const CLI_ERROR_SCHEMA_VERSION = 1;

/** The single code every CLI failure carries. */
export const CLI_ERROR_CODE = 'CTXALLOC_CLI_FAILED';

/**
 * Where a command failed.
 *
 * The stage is the CLI's own vocabulary, not a component's. It answers *which
 * part of my invocation was wrong?* — my arguments, my config file, an input
 * file, the control store, a source file, preparation, retrieval, the compiler,
 * the trace store, or evaluation — which is a different question from which
 * class threw.
 */
export type CliStage =
  | 'arguments'
  | 'config'
  | 'input'
  | 'source-store'
  | 'source-read'
  | 'preparation'
  | 'retrieval'
  | 'compilation'
  | 'trace-store'
  | 'evaluation';

/** One machine-readable problem, addressed inside the input that carried it. */
export interface CliIssue {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}

/** The one envelope every failure is written as. */
export interface CliErrorEnvelope {
  readonly schemaVersion: typeof CLI_ERROR_SCHEMA_VERSION;
  readonly code: typeof CLI_ERROR_CODE;
  readonly stage: CliStage;
  readonly issues: readonly CliIssue[];
}

/**
 * The single error every command raises.
 *
 * `usage` separates the two exit codes. A wrong invocation is the caller's
 * mistake about *how to run the program* and exits `2`; everything else is a
 * validated operational failure and exits `1`. A script can therefore retry an
 * operational failure and must not retry a usage one.
 */
export class CliError extends Error {
  readonly code = CLI_ERROR_CODE;
  readonly stage: CliStage;
  readonly issues: readonly CliIssue[];
  readonly usage: boolean;

  constructor(stage: CliStage, issues: readonly CliIssue[], usage = false) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`ctxalloc failed at ${stage}: ${summary}`);
    this.name = 'CliError';
    this.stage = stage;
    this.issues = issues;
    this.usage = usage;
  }

  /** The envelope written to stderr. */
  envelope(): CliErrorEnvelope {
    return {
      schemaVersion: CLI_ERROR_SCHEMA_VERSION,
      code: CLI_ERROR_CODE,
      stage: this.stage,
      issues: this.issues,
    };
  }
}

/** One issue, addressed by a dotted pointer. */
export function cliIssue(code: string, pointer: string, message: string): CliIssue {
  return { code, pointer, message };
}

/** A usage failure: the invocation itself was wrong. */
export function usageError(code: string, pointer: string, message: string): CliError {
  return new CliError('arguments', [cliIssue(code, pointer, message)], true);
}

/**
 * Projects the structured issues of a project-owned error onto the envelope.
 *
 * Only a project-owned `issues` array is read. The thrown value's `message` is
 * never copied: a component's own wording may quote a path, a query, a SQL
 * statement, or a fragment of source content, and this envelope is the one place
 * that must not republish them (INV-SEC-001).
 *
 * An error with no issues falls back to one fixed issue. A component that fails
 * with a message and no issues would otherwise produce an envelope that names a
 * stage and says nothing at all.
 */
export function issuesOf(
  cause: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): readonly CliIssue[] {
  if (typeof cause === 'object' && cause !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cause, 'issues');
    const nested: unknown =
      descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    if (Array.isArray(nested) && nested.length > 0) {
      const projected = nested.flatMap((entry): CliIssue[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const issue = entry as { code?: unknown; pointer?: unknown; message?: unknown };
        return [
          {
            code: typeof issue.code === 'string' ? issue.code : fallbackCode,
            pointer: typeof issue.pointer === 'string' ? issue.pointer : '',
            message: typeof issue.message === 'string' ? issue.message : fallbackMessage,
          },
        ];
      });
      if (projected.length > 0) return projected;
    }
  }
  return [cliIssue(fallbackCode, '', fallbackMessage)];
}

/**
 * The stable machine code of a project-owned adapter error, if it has one.
 *
 * Read through an own data property so an accessor is neither invoked nor
 * trusted. Only a `string` is accepted; anything else is treated as absent.
 */
export function errorCode(cause: unknown): string | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(cause, 'code');
  if (descriptor === undefined || !('value' in descriptor)) return null;
  return typeof descriptor.value === 'string' ? descriptor.value : null;
}

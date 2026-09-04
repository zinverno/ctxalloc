import type { ValidationIssue } from '@ctxalloc/domain';
import { issue } from './chunking-primitives.js';

/**
 * The failure vocabulary shared by every local application service (DEC-039,
 * DEC-042).
 *
 * `PrepareLocalCorpusService` and `CompileLocalContextService` are two use cases
 * over one pipeline, and preparation is literally the first half of compilation.
 * One error type owned here is what keeps them reporting a missing source, a
 * contradictory control plane, or an unreadable locator identically; two error
 * types would let the same failure acquire two spellings depending on which
 * entry point a caller happened to use (INV-DEP-003).
 */

/** Where one local pipeline run failed, before the compiler was reached. */
export type LocalSourcePipelineStage =
  | 'configuration'
  | 'request-validation'
  | 'control-store'
  | 'source-registration'
  | 'source-read'
  | 'source-ingestion'
  | 'source-chunking'
  | 'candidate-provider';

/**
 * The single error the local services raise for a pre-compiler failure.
 *
 * The issues are project-owned, serializable, and deterministically ordered.
 * They carry no raw file content, no conversation content, no filesystem error
 * object, no `SyntaxError`, and no validation-library error: an adapter failure
 * is translated at this boundary rather than re-thrown (INV-ADAPTER-001,
 * INV-ADAPTER-003).
 *
 * A failure *inside* the compiler is not wrapped. `ContextCompilationError`
 * already names its stage, its issues, and its compilation identifier, and
 * replacing it with a weaker application error would discard exactly the detail
 * a caller needs (INV-DEP-003).
 */
export class LocalSourcePipelineError extends Error {
  readonly code = 'LOCAL_SOURCE_PIPELINE_FAILED';
  readonly stage: LocalSourcePipelineStage;
  readonly issues: readonly ValidationIssue[];

  constructor(stage: LocalSourcePipelineStage, issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((detail) => `${detail.pointer || '<root>'}: ${detail.message}`)
      .join('; ');
    super(`Local source pipeline failed at ${stage}: ${summary}`);
    this.name = 'LocalSourcePipelineError';
    this.stage = stage;
    this.issues = issues;
  }
}

/** Re-addresses one component's issues under the configuration field that carries it. */
export function underField(
  field: string,
  issues: readonly ValidationIssue[],
): readonly ValidationIssue[] {
  return issues.map((detail) => {
    const path = [field, ...detail.path];
    return { code: detail.code, path, pointer: path.join('.'), message: detail.message };
  });
}

/**
 * The structured issues of a project-owned error, or one fixed generic issue.
 *
 * Only a project-owned `issues` array is carried through: those are already
 * serializable, deterministic, and written by this project. The thrown value's
 * `message` is never read, because an error raised inside an injected component
 * may quote source content or a machine path (INV-SEC-001).
 *
 * An empty `issues` array falls back too. A chunker reports a tokenizer failure
 * with a message and no issues, and passing that empty array through would
 * produce a pipeline failure that names its stage but says nothing at all.
 */
export function issuesOf(
  cause: unknown,
  path: readonly string[],
  fallback: string,
): readonly ValidationIssue[] {
  if (typeof cause === 'object' && cause !== null) {
    const nested: unknown = (cause as { issues?: unknown }).issues;
    if (Array.isArray(nested) && nested.length > 0) {
      return nested as readonly ValidationIssue[];
    }
  }
  return [issue(path, fallback)];
}

/**
 * Builds one component, re-addressing its construction issues under the
 * configuration field that carried them.
 */
export function build<T>(construct: () => T, field: string): T {
  try {
    return construct();
  } catch (cause) {
    const issues = issuesOf(cause, [], `is not a valid ${field}`);
    throw new LocalSourcePipelineError(
      'configuration',
      issues.map((detail) => {
        const path = [...field.split('.'), ...detail.path];
        return { code: detail.code, path, pointer: path.join('.'), message: detail.message };
      }),
    );
  }
}

/**
 * Checks one injected port implementation for the shape it must have.
 *
 * The dependencies arrive as objects, and their identities may travel into a
 * report, so the port shape is checked once at construction rather than trusted
 * from the compile-time type alone.
 */
export function validatePort(
  name: string,
  candidate: unknown,
  method: string,
): readonly ValidationIssue[] {
  if (typeof candidate !== 'object' || candidate === null) {
    return [issue([name], `must be a ${name}`, 'invalid_type')];
  }
  const port = candidate as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  if (typeof port.id !== 'string' || port.id.trim().length === 0) {
    issues.push(issue([name, 'id'], 'must not be empty or whitespace-only'));
  }
  if (typeof port.version !== 'string' || port.version.trim().length === 0) {
    issues.push(issue([name, 'version'], 'must not be empty or whitespace-only'));
  }
  if (typeof port[method] !== 'function') {
    issues.push(issue([name, method], 'must be a function', 'invalid_type'));
  }
  return issues;
}

/**
 * Compares two strings by UTF-16 code unit.
 *
 * `localeCompare` is deliberately not used anywhere in the local pipeline: its
 * result depends on the machine's locale data, which would make one corpus order
 * on a developer's laptop and another in a container (INV-DET-001).
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

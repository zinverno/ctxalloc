import type { z } from 'zod';

/**
 * Project-owned validation results.
 *
 * Domain failures must be structured and serializable so that a future CLI,
 * HTTP API, and trace can report them without re-deriving meaning from a
 * free-text `Error` message. Zod is an implementation detail: its error objects
 * are converted here and never escape the domain boundary.
 */

/** A single problem found while validating one input. */
export interface ValidationIssue {
  /** Stable machine-readable category, for example `invalid_type`. */
  readonly code: string;
  /** Serializable location of the problem inside the input. */
  readonly path: readonly (string | number)[];
  /** Dotted rendering of `path`, for logs and human-facing output. */
  readonly pointer: string;
  /** Human-readable explanation. */
  readonly message: string;
}

/** Discriminated result for callers that handle failure explicitly. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Error thrown by {@link parseOrThrow}, carrying the structured issues. */
export class DomainValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.pointer || '<root>'}: ${issue.message}`)
      .join('; ');
    super(`Domain validation failed: ${summary}`);
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}

function formatPointer(path: readonly (string | number)[]): string {
  return path.reduce<string>((pointer, segment) => {
    if (typeof segment === 'number') return `${pointer}[${segment}]`;
    return pointer.length === 0 ? segment : `${pointer}.${segment}`;
  }, '');
}

/**
 * Issue order follows the validator's traversal order, which is stable for a
 * given schema and input, so identical invalid input yields identical issues
 * (INV-DET-001).
 */
function toValidationIssues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number',
    );
    return {
      code: issue.code,
      path,
      pointer: formatPointer(path),
      message: issue.message,
    };
  });
}

/** Validate `input`, returning the parsed value or throwing {@link DomainValidationError}. */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainValidationError(toValidationIssues(result.error));
  }
  return result.data;
}

/** Validate `input`, returning a discriminated success or failure result. */
export function safeParse<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    return { ok: false, issues: toValidationIssues(result.error) };
  }
  return { ok: true, value: result.data };
}

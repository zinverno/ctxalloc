import type { ValidationIssue } from '@ctxalloc/domain';
import type { Tokenizer } from '@ctxalloc/ports';
import { pointerFor, quote, type IssuePath } from './validation-issues.js';

/**
 * Shared runtime checking of the injected `Tokenizer` port (DEC-038).
 *
 * The tokenizer is an injected dependency whose count is correctness data, so
 * its port shape is checked at construction rather than trusted from the
 * compile-time type alone: every component that takes one is reachable from a
 * runtime boundary where the compile-time type proves nothing.
 *
 * Two components now own that check — `ContextRenderer`, which measures one
 * rendered attempt, and `ContextCompiler`, which owns the one configured
 * tokenizer for candidate validation and for every rendered measurement — and
 * two implementations of one rule would be free to drift, so the rule is owned
 * once, here (INV-DEP-003).
 *
 * Identity values are checked for blankness and never rewritten: a trace records
 * them verbatim, and trimming here would publish a value the caller never
 * configured (INV-TRACE-005).
 *
 * The module is internal to the compiler kernel. It is never re-exported from
 * the package entry point, and no public declaration names it
 * (INV-ADAPTER-001). `CandidateValidator` keeps its own copy of the shape check
 * deliberately: its issues carry that stage's own `invalid_input` code and its
 * own paths, and rewiring them would change a published failure contract this
 * phase must leave untouched.
 */

/**
 * Collects every problem with one injected tokenizer, under the caller's own
 * issue code and path prefix.
 *
 * The code is a parameter because the categories belong to the component that
 * raises them: a renderer reports `invalid_tokenizer`, and so does the compiler,
 * but neither may borrow the other's vocabulary by accident.
 */
export function collectTokenizerPortIssues(
  tokenizer: Tokenizer,
  code: string,
  path: IssuePath,
): readonly ValidationIssue[] {
  const issue = (rest: IssuePath, message: string): ValidationIssue => {
    const full: IssuePath = [...path, ...rest];
    return { code, path: full, pointer: pointerFor(full), message };
  };

  if (typeof tokenizer !== 'object' || tokenizer === null) {
    return [issue([], 'must be a Tokenizer')];
  }
  const issues: ValidationIssue[] = [];
  if (typeof tokenizer.id !== 'string' || tokenizer.id.trim().length === 0) {
    issues.push(issue(['id'], 'must not be empty or whitespace-only'));
  }
  if (typeof tokenizer.version !== 'string' || tokenizer.version.trim().length === 0) {
    issues.push(issue(['version'], 'must not be empty or whitespace-only'));
  }
  if (typeof tokenizer.countTokens !== 'function') {
    issues.push(issue(['countTokens'], 'must be a function'));
  }
  return issues;
}

/** Describes a thrown value without letting the object itself escape (INV-ADAPTER-003). */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `a non-Error value (${typeof error})`;
}

/**
 * The outcome of counting one exact complete string.
 *
 * A returned value that is not a usable count is a failure, never a value to
 * repair, and no character or word estimate substitutes for it (DEC-027). The
 * discriminated result lets each caller raise its own error type with its own
 * issue code, over one shared measurement rule.
 */
export type TokenizerCountResult =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly kind: 'threw'; readonly message: string }
  | { readonly ok: false; readonly kind: 'invalid'; readonly message: string };

/**
 * Counts one complete string exactly once, wrapping a tokenizer failure.
 *
 * `subject` names what was counted, so the message reads the same way whichever
 * component asked. Summing per-block or per-record counts is not equivalent and
 * is never done here: tokenization is not additive, so boundaries shift when
 * content is embedded in a larger string, and separators and JSON escaping are
 * part of what the model receives (INV-BUDGET-002, INV-RENDER-004).
 */
export function countTokensSafely(
  tokenizer: Tokenizer,
  text: string,
  subject: string,
): TokenizerCountResult {
  const identity = `tokenizer ${quote(tokenizer.id)} version ${quote(tokenizer.version)}`;
  let tokens: number;
  try {
    tokens = tokenizer.countTokens(text);
  } catch (error: unknown) {
    return {
      ok: false,
      kind: 'threw',
      message: `${identity} failed to count ${subject}: ${describeThrown(error)}`,
    };
  }
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) {
    return {
      ok: false,
      kind: 'invalid',
      message: `${identity} returned ${String(tokens)} for ${subject}: expected a non-negative safe integer`,
    };
  }
  return { ok: true, tokens };
}

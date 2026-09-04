import { readFileSync } from 'node:fs';
import { CliError, cliIssue, type CliStage } from './errors.js';

/**
 * Reading one explicit JSON input file (DEC-042).
 *
 * Every structured input the CLI takes — a config, a compilation request, a
 * registration, a key, a scope, an evaluation case — arrives as a named file.
 * There is no stdin auto-detection, no comment extension, no trailing-comma
 * extension, and no format guessing: a command that behaved differently
 * depending on whether a terminal was attached would produce results an operator
 * cannot reproduce (INV-DET-001).
 *
 * The file is decoded as strict UTF-8 and parsed as strict JSON. Nothing here
 * validates *what* the value means: that belongs to the component that owns the
 * shape, and a second opinion in this module would be a second place for one
 * rule to drift (INV-DEP-003).
 */

/**
 * Reads and parses one JSON file.
 *
 * A missing file, an unreadable file, invalid UTF-8, and malformed JSON all
 * become one `CliError` addressed to the option that named the file. The
 * `SyntaxError` is deliberately dropped: its message quotes the offending text,
 * which for a request file is the operator's raw query and for a registration is
 * their filesystem layout (INV-SEC-001).
 *
 * The parsed value is an ordinary passive object. `JSON.parse` produces plain
 * objects and arrays with no accessors, no `Proxy`, and no class instances, and
 * it defines a `"__proto__"` key as an own data property rather than assigning
 * through the setter — so no key in an input file can reach a prototype.
 */
export function readJsonFile(path: string, option: string, stage: CliStage): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // The filesystem error names the absolute path it tried, which is more than
    // the caller asked to be told. The option they typed is what they can act on.
    throw new CliError(stage, [
      cliIssue('input_unreadable', option, `the file named by --${option} could not be read`),
    ]);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(stage, [
      cliIssue('input_not_json', option, `the file named by --${option} is not valid JSON`),
    ]);
  }
}

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
 * The file is decoded as **fatal** UTF-8 and parsed as strict JSON. Nothing here
 * validates *what* the value means: that belongs to the component that owns the
 * shape, and a second opinion in this module would be a second place for one
 * rule to drift (INV-DEP-003).
 */

/**
 * Decodes one file's bytes as UTF-8, refusing to repair a malformed sequence.
 *
 * `readFileSync(path, 'utf8')` is **replacement** decoding, not fatal decoding:
 * every byte that is not part of a well-formed sequence silently becomes
 * `U+FFFD`. The bytes `7b 22 78 22 3a 22 80 22 7d` are `{"x":"<0x80>"}`, and
 * that path turns them into the perfectly valid document `{"x":"�"}` — so
 * the CLI would hand a component a string the operator never wrote, and would
 * report success while doing it. A tool that silently alters its input is worse
 * than one that refuses it, because nothing downstream can tell that it
 * happened (INV-DET-001, INV-BLOCK-005).
 *
 * `TextDecoder` with `fatal: true` throws on the first ill-formed sequence
 * instead, and a project-owned issue replaces it. The decoder's own message is
 * dropped along with everything else about the bytes: the offending sequence is
 * a fragment of the operator's file, and the option they typed is what they can
 * act on (INV-SEC-001).
 *
 * `ignoreBOM: true` is deliberate and is **not** the default. The default
 * strips a leading `U+FEFF`, which is one more silent edit to the caller's
 * input; retaining it means a byte-order mark reaches `JSON.parse`, which
 * rejects it, so a BOM-prefixed file is a reported `input_not_json` rather than
 * a quietly accepted extension to the JSON grammar. A decoder is constructed per
 * call because a shared one would be module-level mutable state.
 */
function decodeUtf8(bytes: Uint8Array, option: string, stage: CliStage): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError(stage, [
      cliIssue('input_not_utf8', option, `the file named by --${option} is not valid UTF-8`),
    ]);
  }
}

/**
 * Reads and parses one JSON file.
 *
 * A missing file, an unreadable file, invalid UTF-8, and malformed JSON all
 * become one `CliError` addressed to the option that named the file, each with
 * its own code. Malformed bytes and malformed grammar are separated because they
 * are different mistakes with different fixes: `input_not_utf8` says the file's
 * encoding is wrong, and `input_not_json` says its syntax is.
 *
 * The `SyntaxError` is deliberately dropped: its message quotes the offending
 * text, which for a request file is the operator's raw query and for a
 * registration is their filesystem layout (INV-SEC-001).
 *
 * The parsed value is an ordinary passive object. `JSON.parse` produces plain
 * objects and arrays with no accessors, no `Proxy`, and no class instances, and
 * it defines a `"__proto__"` key as an own data property rather than assigning
 * through the setter — so no key in an input file can reach a prototype.
 */
export function readJsonFile(path: string, option: string, stage: CliStage): unknown {
  let bytes: Uint8Array;
  try {
    // Read as bytes, never as a decoded string: the `'utf8'` encoding argument
    // is the whole bug this function exists to avoid.
    bytes = readFileSync(path);
  } catch {
    // The filesystem error names the absolute path it tried, which is more than
    // the caller asked to be told. The option they typed is what they can act on.
    throw new CliError(stage, [
      cliIssue('input_unreadable', option, `the file named by --${option} could not be read`),
    ]);
  }

  const text = decodeUtf8(bytes, option, stage);

  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(stage, [
      cliIssue('input_not_json', option, `the file named by --${option} is not valid JSON`),
    ]);
  }
}

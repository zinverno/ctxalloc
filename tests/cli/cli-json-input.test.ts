import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE,
  cli,
  cliConfig,
  createWorkspace,
  failureOf,
  registration,
  successOf,
  type Workspace,
} from './fixtures.js';

/**
 * Every JSON file the CLI reads is decoded as **fatal** UTF-8 (DEC-042).
 *
 * `readFileSync(path, 'utf8')` is replacement decoding: an ill-formed byte
 * becomes `U+FFFD` and the read succeeds. A CLI on that path would hand a
 * component a string the operator never wrote and report success while doing
 * it, which is worse than refusing the file because nothing downstream can tell
 * that it happened (INV-DET-001, INV-BLOCK-005).
 *
 * Every fixture here is written as **raw bytes**. A fixture written as a
 * JavaScript string is already well-formed UTF-16, so it cannot express the
 * sequences under test.
 */

/** The replacement character a lossy decode would have produced. */
const REPLACEMENT = '�';

let workspace: Workspace | undefined;

function open(config?: Record<string, unknown>): Workspace {
  workspace = config === undefined ? createWorkspace() : createWorkspace(config);
  return workspace;
}

afterEach(() => {
  workspace?.dispose();
  workspace = undefined;
});

/** `{"x":"<bytes>"}` with arbitrary bytes inside the string. */
function documentWith(...bytes: readonly number[]): Uint8Array {
  return Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, ...bytes, 0x22, 0x7d]);
}

describe('INV-BLOCK-005: malformed UTF-8 is refused, never repaired', () => {
  it.each([
    // The reviewer's counterexample: `{"x":"<0x80>"}`. Replacement decoding
    // turns this into the perfectly valid document `{"x":"<U+FFFD>"}`.
    ['a continuation byte with no lead byte', [0x80]],
    ['a truncated two-byte sequence', [0xc3]],
    ['a truncated three-byte sequence', [0xe2, 0x82]],
    ['a truncated four-byte sequence', [0xf0, 0x9f, 0x8e]],
    // Overlong: `0xC0 0xAF` is `/` encoded in two bytes, which UTF-8 forbids.
    ['an overlong encoding of "/"', [0xc0, 0xaf]],
    // A surrogate half encoded as UTF-8, which UTF-8 also forbids.
    ['a CESU-8 encoded surrogate half', [0xed, 0xa0, 0x80]],
    ['a byte no UTF-8 sequence may contain', [0xff]],
  ])('rejects %s with input_not_utf8', async (_label, bytes) => {
    const ws = open();
    const path = ws.writeBytes('registration.json', documentWith(...bytes));

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(1);
    expect(envelope.stage).toBe('input');
    expect(envelope.issues).toHaveLength(1);
    expect(envelope.issues[0]?.code).toBe('input_not_utf8');
    expect(envelope.issues[0]?.pointer).toBe('registration');
  });

  it('a malformed byte never becomes U+FFFD and never reaches the owning validator', async () => {
    const ws = open();
    // Valid JSON *shape*, but the source type is one the registration validator
    // would reject. If the bytes were repaired the file would parse and the
    // failure would carry the validator's own code, so the code reported here
    // proves the bytes were refused before any component saw them.
    const bytes = Uint8Array.from([
      ...Buffer.from('{"schemaVersion":1,"sourceType":"'),
      0x80,
      ...Buffer.from('"}'),
    ]);
    const path = ws.writeBytes('registration.json', bytes);

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const envelope = failureOf(run);

    expect(envelope.issues[0]?.code).toBe('input_not_utf8');
    expect(envelope.issues.map((entry) => entry.code)).not.toContain('invalid_registration');
    expect(run.stderr).not.toContain(REPLACEMENT);
    expect(run.stdout).toBe('');
  });

  it('the envelope carries neither the offending bytes nor the file path', async () => {
    const ws = open();
    const path = ws.writeBytes('registration.json', documentWith(0x80, 0xff));

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);

    expect(run.stderr).not.toContain(path);
    expect(run.stderr).not.toContain(ws.root);
    expect(run.stderr).not.toContain(REPLACEMENT);
    // No decoder or engine wording, and no stack trace.
    expect(run.stderr).not.toContain('TypeError');
    expect(run.stderr).not.toContain('decode');
    expect(run.stderr).not.toContain('at ');
  });

  it('applies to the config file on the same terms', async () => {
    const ws = open();
    const path = ws.writeBytes('broken.json', documentWith(0x80));

    const run = await cli('source', 'list', '--config', path, '--scope', ws.write('s.json', SCOPE));
    const envelope = failureOf(run);

    expect(envelope.stage).toBe('config');
    expect(envelope.issues[0]?.code).toBe('input_not_utf8');
    expect(envelope.issues[0]?.pointer).toBe('config');
  });
});

describe('valid UTF-8 decodes exactly', () => {
  it('a supplementary-plane character survives the round trip', async () => {
    const ws = open();
    // U+1F389 PARTY POPPER: a four-byte sequence and a surrogate pair.
    const title = '\u{1F389} 予算';
    const path = ws.writeBytes(
      'registration.json',
      Buffer.from(JSON.stringify(registration({ title })), 'utf8'),
    );

    await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const listed = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE)),
    ) as { registrations: readonly { title?: string }[] };

    expect(listed.registrations[0]?.title).toBe(title);
    expect(listed.registrations[0]?.title).not.toContain(REPLACEMENT);
  });

  it('an empty file is a JSON failure, not an encoding one', async () => {
    const ws = open();
    const path = ws.writeBytes('registration.json', Uint8Array.from([]));

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    expect(failureOf(run).issues[0]?.code).toBe('input_not_json');
  });
});

/**
 * A leading UTF-8 byte-order mark is **retained** by the decoder and then
 * rejected by strict JSON.
 *
 * `TextDecoder`'s default strips it, which is one more silent edit to the
 * caller's file; `ignoreBOM: true` keeps it, so `U+FEFF` reaches `JSON.parse`,
 * which has no production for it. The alternative — stripping it — would be a
 * quiet extension to the JSON grammar this CLI does not implement.
 */
describe('a byte-order mark is reported, not silently stripped', () => {
  const BOM = [0xef, 0xbb, 0xbf] as const;

  it('rejects a BOM-prefixed file as input_not_json', async () => {
    const ws = open();
    const path = ws.writeBytes(
      'registration.json',
      Uint8Array.from([...BOM, ...Buffer.from(JSON.stringify(registration()), 'utf8')]),
    );

    const run = await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const envelope = failureOf(run);

    expect(run.exitCode).toBe(1);
    // Not an encoding failure: the bytes are well-formed UTF-8. The document is
    // simply not JSON.
    expect(envelope.issues[0]?.code).toBe('input_not_json');
  });

  it('a U+FEFF inside a string is ordinary data and is preserved', async () => {
    const ws = open();
    // Written as an escape: a literal U+FEFF in source is an irregular
    // whitespace character, and the point is what the byte stream carries.
    const title = 'a\uFEFFb';
    const path = ws.writeBytes(
      'registration.json',
      Buffer.from(JSON.stringify(registration({ title })), 'utf8'),
    );

    await cli('source', 'add', '--config', ws.configPath, '--registration', path);
    const listed = successOf(
      await cli('source', 'list', '--config', ws.configPath, '--scope', ws.write('s.json', SCOPE)),
    ) as { registrations: readonly { title?: string }[] };

    expect(listed.registrations[0]?.title).toBe(title);
  });
});

describe('an ordinary config still loads', () => {
  it('a valid UTF-8 config with a relative database path still works', async () => {
    const ws = open(cliConfig());
    const run = await cli(
      'source',
      'add',
      '--config',
      ws.configPath,
      '--registration',
      ws.write('registration.json', registration()),
    );

    expect(successOf(run)).toEqual({ schemaVersion: 1, operation: 'register', registered: true });
  });
});

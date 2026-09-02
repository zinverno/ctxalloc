import {
  CompileLocalContextService,
  ConversationSourceValidationError,
  LocalSourcePipelineError,
  parseConversationSourceJson,
} from '@ctxalloc/application';
import type { CandidateProvider, ControlStore, SourceReader } from '@ctxalloc/ports';
import {
  FakeCandidateProvider,
  InMemoryControlStore,
  InMemorySourceReader,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SOURCE,
  MARKDOWN_SOURCE,
  TEXT_SOURCE,
  localRequest,
  registration,
  serviceConfig,
} from './local-service-fixtures.js';
import { wordTokenizer } from './text-fixtures.js';

/**
 * A dependency's own error message is untrusted output (DEC-039).
 *
 * A port implementation chooses its own wording, and nothing constrains it: a
 * filesystem error names an absolute path, a database error can carry a
 * connection string or a query, and a retrieval provider's can echo the raw
 * query or a stored document. Copying any of it into a project-owned issue would
 * republish whatever the dependency happened to say (INV-SEC-001).
 *
 * These tests make each dependency throw a deliberately hostile message and
 * assert that none of it reaches the serialized failure, while the stage and the
 * machine-readable code stay exactly right.
 */

const CONTROL_SECRET = 'TOP-SECRET-CONTROL postgres://user:hunter2@db.internal/ctxalloc';
const READ_SECRET = '/absolute/private/path TOP-SECRET-SOURCE the vault passphrase is swordfish';
const PROVIDER_SECRET = 'TOP-SECRET-PROVIDER index dump: What is the token budget?';
const JSON_SECRET = 'TOP-SECRET-CONVERSATION';

const REGISTRATIONS = [
  registration({
    sourceType: 'markdown',
    identity: { namespace: 'vault:notes', key: 'budgets.md' },
    locator: 'notes/budgets.md',
  }),
  registration({
    sourceType: 'text',
    identity: { namespace: 'vault:notes', key: 'scratch.txt' },
    locator: 'notes/scratch.txt',
  }),
  registration({
    sourceType: 'conversation',
    identity: { namespace: 'chat:local', key: 'thread-1' },
    locator: 'chats/thread-1.json',
  }),
];

const SOURCES = [
  { locator: 'notes/budgets.md', content: MARKDOWN_SOURCE },
  { locator: 'notes/scratch.txt', content: TEXT_SOURCE },
  { locator: 'chats/thread-1.json', content: CONVERSATION_SOURCE },
];

function build(overrides: {
  readonly reader?: SourceReader;
  readonly store?: ControlStore;
  readonly provider?: CandidateProvider;
  readonly sources?: readonly { locator: string; content: string }[];
}): CompileLocalContextService {
  return new CompileLocalContextService(
    serviceConfig(),
    wordTokenizer,
    overrides.reader ?? new InMemorySourceReader([...(overrides.sources ?? SOURCES)]),
    overrides.store ?? new InMemoryControlStore(REGISTRATIONS as never),
    overrides.provider ?? new FakeCandidateProvider(),
  );
}

/** Everything a caller could read off the failure, as one string. */
function serialized(error: LocalSourcePipelineError): string {
  return [
    error.message,
    error.name,
    error.code,
    error.stage,
    JSON.stringify(error.issues),
    JSON.stringify(error),
  ].join('\n');
}

async function capture(service: CompileLocalContextService): Promise<LocalSourcePipelineError> {
  try {
    await service.execute(localRequest());
  } catch (cause) {
    expect(cause).toBeInstanceOf(LocalSourcePipelineError);
    return cause as LocalSourcePipelineError;
  }
  throw new Error('expected a rejection');
}

describe('INV-SEC-001: dependency error messages are never republished', () => {
  it('does not copy a control-store message', async () => {
    const store: ControlStore = {
      id: 'hostile',
      version: '1',
      listSources: () => Promise.reject(new Error(CONTROL_SECRET)),
    };
    const error = await capture(build({ store }));

    expect(error.stage).toBe('control-store');
    expect(error.issues[0]?.code).toBe('control_store_unavailable');
    expect(error.issues[0]?.message).toBe('ControlStore listSources failed.');
    for (const secret of ['TOP-SECRET-CONTROL', 'postgres://', 'hunter2', 'db.internal']) {
      expect(serialized(error), `leaks ${secret}`).not.toContain(secret);
    }
  });

  it('does not copy a source-reader message or its absolute path', async () => {
    const reader: SourceReader = {
      id: 'hostile',
      version: '1',
      read: () => Promise.reject(new Error(READ_SECRET)),
    };
    const error = await capture(build({ reader }));

    expect(error.stage).toBe('source-read');
    expect(error.issues[0]?.code).toBe('source_unreadable');
    for (const secret of ['TOP-SECRET-SOURCE', '/absolute/private/path', 'swordfish']) {
      expect(serialized(error), `leaks ${secret}`).not.toContain(secret);
    }
    // The logical identity is registration data the caller already supplied, so
    // it stays: it says which source failed without disclosing where it lives.
    // Registrations are read in canonical order, so the conversation source is
    // the first one attempted.
    expect(error.issues[0]?.message).toBe(
      'SourceReader failed for logical source chat:local/thread-1.',
    );
    expect(serialized(error), 'leaks the locator').not.toContain('chats/thread-1.json');
  });

  it('does not copy a candidate-provider message or the query it echoes', async () => {
    const provider: CandidateProvider = {
      id: 'hostile',
      version: '1',
      getCandidates: () => Promise.reject(new Error(PROVIDER_SECRET)),
    };
    const error = await capture(build({ provider }));

    expect(error.stage).toBe('candidate-provider');
    expect(error.issues[0]?.code).toBe('provider_unavailable');
    expect(error.issues[0]?.message).toBe('CandidateProvider getCandidates failed.');
    for (const secret of ['TOP-SECRET-PROVIDER', 'What is the token budget?', 'index dump']) {
      expect(serialized(error), `leaks ${secret}`).not.toContain(secret);
    }
  });

  it('copies nothing from a thrown value that is not an Error either', async () => {
    const store: ControlStore = {
      id: 'hostile',
      version: '1',
      // A thrown object with a hostile `toString` is still not a message source.
      listSources: () => Promise.reject({ toString: () => CONTROL_SECRET }),
    };
    const error = await capture(build({ store }));
    expect(serialized(error)).not.toContain('TOP-SECRET-CONTROL');
  });

  it('INV-DET-001: reports the same issues for the same failure every time', async () => {
    const failing = (): ControlStore => ({
      id: 'hostile',
      version: '1',
      listSources: () => Promise.reject(new Error(`${CONTROL_SECRET} ${String(Math.random())}`)),
    });
    const first = await capture(build({ store: failing() }));
    const second = await capture(build({ store: failing() }));
    expect(second.issues).toEqual(first.issues);
    expect(second.message).toBe(first.message);
  });

  it('every issue stays JSON-safe with no attached cause', async () => {
    const reader: SourceReader = {
      id: 'hostile',
      version: '1',
      read: () => Promise.reject(new Error(READ_SECRET)),
    };
    const error = await capture(build({ reader }));

    expect(JSON.parse(JSON.stringify(error.issues))).toEqual(error.issues);
    for (const detail of error.issues) {
      expect(Object.keys(detail).sort()).toEqual(['code', 'message', 'path', 'pointer']);
    }
    expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('INV-SEC-001: parser diagnostics are not part of the public contract', () => {
  const MALFORMED = `{"schemaVersion":1,"messages":[{"id":"m1","content":"${JSON_SECRET}" %%}]}`;

  it('does not copy the JSON parser message or the input fragment around the fault', () => {
    try {
      parseConversationSourceJson(MALFORMED);
      throw new Error('expected a rejection');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ConversationSourceValidationError);
      const error = cause as ConversationSourceValidationError;
      expect(error.issues[0]?.code).toBe('invalid_json');
      expect(error.issues[0]?.message).toBe('must be valid JSON');

      const rendered = [error.message, JSON.stringify(error.issues)].join('\n');
      expect(rendered).not.toContain(JSON_SECRET);
      // Parser wording is engine- and version-dependent, so none of it appears.
      for (const fragment of ['position', 'JSON.parse', 'Unexpected token', '%%']) {
        expect(rendered, `leaks ${fragment}`).not.toContain(fragment);
      }
    }
  });

  it('INV-DET-001: reports the same message for every malformed input', () => {
    const messages = ['{', 'nope', '[1,2', '{"a":}', MALFORMED].map((text) => {
      try {
        parseConversationSourceJson(text);
        return 'no error';
      } catch (cause) {
        return (cause as ConversationSourceValidationError).issues[0]?.message;
      }
    });
    expect(new Set(messages)).toEqual(new Set(['must be valid JSON']));
  });

  it('does not leak the conversation through the service either', async () => {
    const error = await capture(
      build({
        sources: [SOURCES[0]!, SOURCES[1]!, { locator: 'chats/thread-1.json', content: MALFORMED }],
      }),
    );

    expect(error.stage).toBe('source-ingestion');
    expect(serialized(error)).not.toContain(JSON_SECRET);
    expect(serialized(error)).not.toContain('%%');
  });
});

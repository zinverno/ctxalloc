import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ANTHROPIC_MODEL_PROVIDER_ID,
  ANTHROPIC_MODEL_PROVIDER_VERSION,
  AnthropicModelProvider,
  AnthropicModelProviderError,
} from '@ctxalloc/adapters';
import type { ModelProviderRequest } from '@ctxalloc/ports';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The one real model adapter, exercised against a local stub server (DEC-040).
 *
 * No test here reaches the internet, needs an API key, or makes a paid call. The
 * stub runs on loopback, which is exactly why the adapter accepts plain HTTP
 * there and nowhere else.
 *
 * Two things are checked throughout: the request the provider actually receives
 * is the one the caller asked for, byte for byte; and nothing the provider says
 * — its body, its error text, the prompts, the API key — ever appears in a
 * failure this adapter publishes (INV-SEC-001).
 */

const API_KEY = 'sk-test-DO-NOT-LEAK-0123456789';
const SYSTEM_PROMPT = 'You answer only from context.';
const USER_PROMPT = '{"context":"CONTEXT-SECRET","query":"QUERY-SECRET"}';

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

type Responder = (request: IncomingMessage, response: ServerResponse) => void;

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];
let respond: Responder;

function jsonResponse(status: number, payload: unknown): Responder {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
}

function successPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_stub_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-stub-2026-01-01',
    content: [{ type: 'text', text: 'stub answer' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 41, output_tokens: 7 },
    ...overrides,
  };
}

beforeEach(async () => {
  captured = [];
  respond = jsonResponse(200, successPayload());
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      captured.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      respond(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
});

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiKey: API_KEY,
    modelId: 'claude-stub',
    apiVersion: '2023-06-01',
    baseUrl,
    timeoutMs: 2000,
    ...overrides,
  };
}

function request(overrides: Partial<ModelProviderRequest> = {}): ModelProviderRequest {
  return {
    schemaVersion: 1,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT,
    maxOutputTokens: 256,
    temperature: 0,
    ...overrides,
  };
}

async function failureOf(promise: Promise<unknown>): Promise<AnthropicModelProviderError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(AnthropicModelProviderError);
    return cause as AnthropicModelProviderError;
  }
  throw new Error('expected a rejection');
}

describe('AnthropicModelProvider: request mapping', () => {
  it('publishes its own identity and the configured model', () => {
    const provider = new AnthropicModelProvider(config());
    expect(provider.id).toBe(ANTHROPIC_MODEL_PROVIDER_ID);
    expect(provider.version).toBe(ANTHROPIC_MODEL_PROVIDER_VERSION);
    expect(provider.modelId).toBe('claude-stub');
  });

  it('POSTs to /v1/messages with the exact configured headers and body', async () => {
    await new AnthropicModelProvider(config()).generate(request());

    const call = captured[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/v1/messages');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.headers['x-api-key']).toBe(API_KEY);
    expect(call?.headers['anthropic-version']).toBe('2023-06-01');

    // The prompt is forwarded unchanged: no template, no wrapper, no trimming.
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      model: 'claude-stub',
      max_tokens: 256,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: USER_PROMPT }],
    });
  });

  it('sends nothing this adapter does not support', async () => {
    await new AnthropicModelProvider(config()).generate(request());
    const body = captured[0]?.body ?? '';
    for (const field of ['tools', 'tool_choice', 'thinking', 'stream', 'metadata', 'citations']) {
      expect(body, `sends ${field}`).not.toContain(`"${field}"`);
    }
  });

  it('appends the endpoint under a configured base path, without a double slash', async () => {
    await new AnthropicModelProvider(config({ baseUrl: `${baseUrl}/gateway/` })).generate(
      request(),
    );
    expect(captured[0]?.url).toBe('/gateway/v1/messages');
  });
});

describe('AnthropicModelProvider: response parsing', () => {
  it('maps a successful response onto the project-owned result', async () => {
    const result = await new AnthropicModelProvider(config()).generate(request());
    expect(result).toEqual({
      schemaVersion: 1,
      outputText: 'stub answer',
      usage: { inputTokens: 41, outputTokens: 7 },
      providerRequestId: 'msg_stub_1',
      stopReason: 'end_turn',
      actualModelId: 'claude-stub-2026-01-01',
    });
  });

  it('concatenates several text blocks in provider order, with no separator', async () => {
    respond = jsonResponse(
      200,
      successPayload({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: ' and second' },
        ],
      }),
    );
    // An invented newline would put a character in the answer the model did not
    // produce, and every criterion is evaluated against exact text.
    const result = await new AnthropicModelProvider(config()).generate(request());
    expect(result.outputText).toBe('first and second');
  });

  it('returns an empty answer when a structurally valid response has no text block', async () => {
    respond = jsonResponse(200, successPayload({ content: [] }));
    const result = await new AnthropicModelProvider(config()).generate(request());
    expect(result.outputText).toBe('');
  });

  it('omits absent usage, request id, stop reason, and model rather than guessing', async () => {
    respond = jsonResponse(200, { type: 'message', content: [{ type: 'text', text: 'bare' }] });
    const result = await new AnthropicModelProvider(config()).generate(request());
    expect(result).toEqual({ schemaVersion: 1, outputText: 'bare' });
  });

  it('records the resolved model without requiring it to equal the configured one', async () => {
    respond = jsonResponse(200, successPayload({ model: 'claude-stub-20260101' }));
    const result = await new AnthropicModelProvider(config()).generate(request());
    // A provider may resolve an alias to a concrete version; rejecting that
    // would reject a correct answer.
    expect(result.actualModelId).toBe('claude-stub-20260101');
  });

  it('fails on a non-text content block rather than silently dropping it', async () => {
    respond = jsonResponse(
      200,
      successPayload({
        content: [
          { type: 'text', text: 'partial' },
          { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
        ],
      }),
    );
    const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_UNSUPPORTED_RESPONSE_CONTENT');
  });

  it('fails on a malformed JSON body', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not json');
    };
    const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE_BODY');
  });

  it('fails on a structurally invalid success payload', async () => {
    respond = jsonResponse(200, { id: 'msg_1', content: 'not-an-array' });
    expect((await failureOf(new AnthropicModelProvider(config()).generate(request()))).code).toBe(
      'ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE',
    );

    respond = jsonResponse(200, successPayload({ usage: { input_tokens: -1 } }));
    expect((await failureOf(new AnthropicModelProvider(config()).generate(request()))).code).toBe(
      'ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE',
    );
  });
});

describe('AnthropicModelProvider: failures and privacy', () => {
  it('reports a non-2xx status with one fixed message and no provider body', async () => {
    respond = jsonResponse(429, {
      type: 'error',
      error: { type: 'rate_limit_error', message: `slow down, key ${API_KEY}` },
    });

    const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_HTTP_ERROR');
    expect(error.status).toBe(429);
    expect(error.message).toBe('AnthropicModelProvider received an unsuccessful response.');
    expect(error.message).not.toContain('rate_limit_error');
  });

  it('never exposes the API key, the prompts, the body, or the answer', async () => {
    const cases: Responder[] = [
      jsonResponse(401, { error: { message: `bad key ${API_KEY}` } }),
      jsonResponse(200, successPayload({ content: [{ type: 'image', source: {} }] })),
      jsonResponse(200, { content: 5 }),
    ];

    for (const responder of cases) {
      respond = responder;
      const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
      const serialized = `${error.name} ${error.message} ${String(error.code)} ${JSON.stringify(error)} ${String(error.stack)}`;
      for (const secret of [API_KEY, 'CONTEXT-SECRET', 'QUERY-SECRET', SYSTEM_PROMPT, 'bad key']) {
        expect(serialized, `leaks ${secret}`).not.toContain(secret);
      }
      expect(error.cause).toBeUndefined();
    }
  });

  it('reports a timeout as a project-owned timeout and does not retry', async () => {
    let hits = 0;
    respond = (_request, response) => {
      hits += 1;
      // Never answers: the abort has to end the call.
      void response;
    };

    const error = await failureOf(
      new AnthropicModelProvider(config({ timeoutMs: 60 })).generate(request()),
    );
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_TIMEOUT');
    expect(hits).toBe(1);
  });

  it('reports an unreachable host as a transport failure, with no host detail', async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });

    const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_TRANSPORT_FAILED');
    expect(error.message).toBe(
      'AnthropicModelProvider request failed before a response was received.',
    );

    // Reopened so the shared teardown has a server to close.
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
});

describe('AnthropicModelProvider: redirects are refused before transmission', () => {
  /**
   * The configured endpoint is an authorization boundary.
   *
   * `fetch` follows redirects by default, and a 307 or 308 preserves the method
   * and the body — so an endpoint replying `Location: <other origin>` would have
   * the runtime re-send `x-api-key`, the system prompt, and the whole user prompt
   * to a destination the caller never authorized. Validating a redirect after the
   * fact does not help: by then the request has already gone.
   */
  let target: Server;
  let targetUrl: string;
  let targetHits: Captured[] = [];

  beforeEach(async () => {
    targetHits = [];
    target = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        targetHits.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(successPayload()));
      });
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address() as AddressInfo;
    targetUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      target.closeAllConnections();
      target.close(() => {
        resolve();
      });
    });
  });

  it.each([307, 308])(
    'rejects a %s redirect, and the target receives nothing at all',
    async (status) => {
      respond = (_request, response) => {
        response.writeHead(status, { location: `${targetUrl}/v1/messages` });
        response.end();
      };

      const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
      expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_TRANSPORT_FAILED');

      // The configured endpoint saw exactly one request, and nothing was retried.
      expect(captured).toHaveLength(1);
      // The redirect target saw none: no key, no prompts, no body.
      expect(targetHits).toHaveLength(0);

      const serialized = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
      for (const secret of [API_KEY, 'CONTEXT-SECRET', 'QUERY-SECRET', targetUrl]) {
        expect(serialized, `leaks ${secret}`).not.toContain(secret);
      }
    },
  );

  it('refuses a same-origin redirect too, because discovery is not its job', async () => {
    respond = (_request, response) => {
      response.writeHead(307, { location: `${baseUrl}/v1/messages` });
      response.end();
    };
    const error = await failureOf(new AnthropicModelProvider(config()).generate(request()));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_TRANSPORT_FAILED');
    expect(captured).toHaveLength(1);
  });

  it('asks the runtime for redirect: "error" rather than relying on a default', () => {
    const source = readFileSync(
      new URL('../../packages/adapters/src/anthropic-model-provider.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain("redirect: 'error'");
    expect(source).not.toContain("redirect: 'follow'");
    expect(source).not.toContain("redirect: 'manual'");
  });
});

describe('AnthropicModelProvider: strict configuration', () => {
  it('rejects a missing, blank, or unknown configuration field', () => {
    for (const bad of [
      undefined,
      null,
      [],
      'text',
      config({ apiKey: '   ' }),
      config({ modelId: '' }),
      config({ apiVersion: '' }),
      config({ timeoutMs: 0 }),
      config({ timeoutMs: 1.5 }),
      { ...config(), retries: 3 },
    ]) {
      expect(() => new AnthropicModelProvider(bad), JSON.stringify(bad)).toThrow(
        AnthropicModelProviderError,
      );
    }
  });

  it("bounds timeoutMs by the largest delay Node's timer actually honors", () => {
    // `setTimeout` stores its delay as a signed 32-bit value and silently
    // replaces anything larger with 1 ms. A configuration that validated
    // `2_147_483_648` would therefore abort after about a millisecond while
    // claiming to wait for twenty-four days, which is exactly the silent
    // substitution this adapter refuses everywhere else.
    expect(() => new AnthropicModelProvider(config({ timeoutMs: 1 }))).not.toThrow();
    expect(() => new AnthropicModelProvider(config({ timeoutMs: 2_147_483_647 }))).not.toThrow();

    for (const rejected of [2_147_483_648, Number.MAX_SAFE_INTEGER]) {
      expect(
        () => new AnthropicModelProvider(config({ timeoutMs: rejected })),
        String(rejected),
      ).toThrow(AnthropicModelProviderError);
    }
  });

  it('requires https for a non-loopback host and allows http on loopback', () => {
    expect(() => new AnthropicModelProvider(config({ baseUrl: 'http://api.example.com' }))).toThrow(
      AnthropicModelProviderError,
    );
    expect(
      () => new AnthropicModelProvider(config({ baseUrl: 'https://api.example.com' })),
    ).not.toThrow();
    for (const loopback of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
    ]) {
      expect(
        () => new AnthropicModelProvider(config({ baseUrl: loopback })),
        loopback,
      ).not.toThrow();
    }
  });

  it('rejects a base URL carrying credentials, a query, a fragment, or a foreign scheme', () => {
    for (const bad of [
      'https://user:pass@api.example.com',
      'https://api.example.com?key=abc',
      'https://api.example.com#frag',
      'ftp://api.example.com',
      'not-a-url',
      '   ',
    ]) {
      expect(() => new AnthropicModelProvider(config({ baseUrl: bad })), bad).toThrow(
        AnthropicModelProviderError,
      );
    }
  });

  it('never puts the API key into a configuration failure', () => {
    try {
      new AnthropicModelProvider(config({ baseUrl: 'http://api.example.com' }));
      throw new Error('expected a rejection');
    } catch (cause) {
      const error = cause as AnthropicModelProviderError;
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(API_KEY);
    }
  });
});

describe('AnthropicModelProvider: strict requests', () => {
  it('rejects a malformed request before anything is sent', async () => {
    const provider = new AnthropicModelProvider(config());
    for (const bad of [
      request({ schemaVersion: 2 as never }),
      request({ userPrompt: '   ' }),
      request({ maxOutputTokens: 0 }),
      request({ maxOutputTokens: 2.5 }),
      request({ temperature: 1.5 }),
      request({ temperature: Number.NaN }),
      { ...request(), topP: 0.9 } as never,
    ]) {
      const error = await failureOf(provider.generate(bad));
      expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST');
    }
    // Nothing reached the wire.
    expect(captured).toHaveLength(0);
  });

  it('accepts an empty system prompt but not an empty user prompt', async () => {
    const provider = new AnthropicModelProvider(config());
    await provider.generate(request({ systemPrompt: '' }));
    expect(JSON.parse(captured[0]?.body ?? '{}')).toMatchObject({ system: '' });

    const error = await failureOf(provider.generate(request({ userPrompt: '' })));
    expect(error.code).toBe('ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST');
  });

  it('rejects a prompt that is not well-formed UTF-16', async () => {
    const provider = new AnthropicModelProvider(config());
    const lone = 'text \ud800 more';
    expect((await failureOf(provider.generate(request({ userPrompt: lone })))).code).toBe(
      'ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST',
    );
    expect((await failureOf(provider.generate(request({ systemPrompt: lone })))).code).toBe(
      'ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST',
    );
  });
});

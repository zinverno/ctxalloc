import type { ModelProvider, ModelProviderRequest, ModelProviderResult } from '@ctxalloc/ports';

/**
 * `ModelProvider` over the Anthropic Messages HTTP API (DEC-040).
 *
 * This adapter exists so the evaluation harness can ask one real model the same
 * question twice, changing only the context. It is **not** a model gateway and
 * must not grow into one: there is no streaming, no tool use, no routing, no
 * retry, no fallback model, no caching orchestration, and no pricing. The
 * provider SDK is deliberately absent — the request is four fields and the
 * response is a small JSON document, so Node's built-in `fetch` is enough, and a
 * dependency would put an SDK type one careless export away from the port
 * (INV-ADAPTER-001).
 *
 * **The prompt is the caller's.** `systemPrompt` and `userPrompt` are forwarded
 * byte for byte. Nothing is templated, prefixed, trimmed, or appended. An
 * adapter that shaped the prompt would make a measured difference between two
 * answers partly its own doing, and the whole point of the comparison is that
 * only the context differs.
 *
 * **Nothing is discovered.** The adapter reads no environment variable — not
 * `ANTHROPIC_API_KEY` — no configuration file, and no working directory. Every
 * value arrives as explicit configuration (INV-DET-003). A future CLI is the
 * right place to turn an environment into explicit config, because that is where
 * a human is present to be told what was picked up.
 *
 * **Nothing leaks.** The API key, the request headers, the prompts, the context,
 * the response body, the provider's own error text, and the generated output all
 * stay inside. A failure carries a stable project-owned code, one fixed message,
 * and — for an HTTP error — the status code, which names the class of problem
 * without quoting anything the caller did not ask to disclose (INV-SEC-001,
 * INV-ADAPTER-003).
 */

/** Stable identity of this adapter, recorded wherever a provider identity is reported. */
export const ANTHROPIC_MODEL_PROVIDER_ID = 'ctxalloc-anthropic-messages';

/** Stable version of this adapter's request mapping and response parsing. */
export const ANTHROPIC_MODEL_PROVIDER_VERSION = '1';

/**
 * Explicit adapter configuration.
 *
 * Every field is required and nothing is defaulted. An API version silently
 * chosen by this adapter would change what the provider returns without any
 * record of it, and a base URL taken from the environment would let a benchmark
 * be pointed somewhere else without the report saying so.
 *
 * The constructor takes `unknown` and validates this shape at runtime, because
 * configuration routinely arrives from a file, an environment, or another
 * language, where a compile-time type proves nothing (INV-BLOCK-005). The
 * interface stays exported for callers that do build it in TypeScript.
 */
export interface AnthropicModelProviderConfig {
  /** Credential sent as the `x-api-key` header, never logged or reported. */
  readonly apiKey: string;
  /** Model identity this instance is configured to call. */
  readonly modelId: string;
  /** Exact value of the `anthropic-version` header. */
  readonly apiVersion: string;
  /** Absolute origin (and optional base path) the Messages endpoint hangs off. */
  readonly baseUrl: string;
  /** Hard upper bound, in milliseconds, on one request. */
  readonly timeoutMs: number;
}

/** Machine-readable categories of a model call failure (INV-TRACE-002). */
export type AnthropicModelProviderErrorCode =
  | 'ANTHROPIC_MODEL_PROVIDER_INVALID_CONFIG'
  | 'ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST'
  | 'ANTHROPIC_MODEL_PROVIDER_TIMEOUT'
  | 'ANTHROPIC_MODEL_PROVIDER_TRANSPORT_FAILED'
  | 'ANTHROPIC_MODEL_PROVIDER_HTTP_ERROR'
  | 'ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE_BODY'
  | 'ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE'
  | 'ANTHROPIC_MODEL_PROVIDER_UNSUPPORTED_RESPONSE_CONTENT';

/**
 * The single error this adapter raises.
 *
 * It carries a stable code, one fixed project-owned message, and — only for an
 * HTTP error — the status code. It deliberately carries no `cause`, no response
 * body, no provider error text, no header, no prompt, and no output: a rejected
 * call is not a licence to republish whatever the other side said, and a
 * serialized error is exactly the place a credential or a fragment of source
 * content would escape unnoticed.
 */
export class AnthropicModelProviderError extends Error {
  readonly code: AnthropicModelProviderErrorCode;

  // `declare` so no property exists when there is no status: a field
  // declaration would put `status: undefined` on every transport failure, which
  // reads as "there is one, and it is nothing".
  declare readonly status?: number;

  constructor(code: AnthropicModelProviderErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AnthropicModelProviderError';
    this.code = code;
    if (status !== undefined) {
      Object.defineProperty(this, 'status', { value: status, enumerable: true });
    }
  }
}

/** The complete set of configuration fields. Anything else is rejected. */
const CONFIG_KEYS: readonly string[] = ['apiKey', 'apiVersion', 'baseUrl', 'modelId', 'timeoutMs'];

/** The complete set of request fields. Anything else is rejected. */
const REQUEST_KEYS: readonly string[] = [
  'maxOutputTokens',
  'schemaVersion',
  'systemPrompt',
  'temperature',
  'userPrompt',
];

/** The one schema version this adapter accepts. */
const REQUEST_SCHEMA_VERSION = 1;

/** The one result schema version this adapter produces. */
const RESULT_SCHEMA_VERSION = 1;

/** Path appended to the configured base URL. */
const MESSAGES_PATH = '/v1/messages';

/**
 * Hosts for which plain HTTP is accepted.
 *
 * Everything else must be HTTPS. The exception exists so the adapter can be
 * tested against a local stub server without a certificate, and it is scoped to
 * addresses that never leave the machine — which is exactly the property that
 * makes plain text acceptable there and nowhere else.
 *
 * The IPv6 loopback appears twice because `URL.hostname` keeps the brackets it
 * was written with, and a host that is loopback in one spelling is loopback in
 * the other.
 */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * True when a string contains a lone surrogate.
 *
 * The domain owns the canonical version of this check, but this package depends
 * on `@ctxalloc/ports` alone, and widening an adapter's dependencies to reach one
 * predicate would trade a real boundary for a small convenience (INV-DEP-001).
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function invalidConfig(message: string): AnthropicModelProviderError {
  return new AnthropicModelProviderError('ANTHROPIC_MODEL_PROVIDER_INVALID_CONFIG', message);
}

function invalidRequest(message: string): AnthropicModelProviderError {
  return new AnthropicModelProviderError('ANTHROPIC_MODEL_PROVIDER_INVALID_REQUEST', message);
}

function invalidResponse(message: string): AnthropicModelProviderError {
  return new AnthropicModelProviderError('ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE', message);
}

/** The value of one own data property, without following the prototype chain. */
function fieldOf(host: unknown, key: string): unknown {
  if (typeof host !== 'object' || host === null) return undefined;
  return (host as Record<string, unknown>)[key];
}

/** A provider-supplied token count: a non-negative safe integer, or nothing. */
function usageCount(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidResponse(
      `AnthropicModelProvider response usage.${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

/** A provider-supplied identity string: non-empty, or nothing. */
function optionalIdentity(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw invalidResponse(`AnthropicModelProvider response ${field} must be a string.`);
  }
  return value.length === 0 ? null : value;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly id = ANTHROPIC_MODEL_PROVIDER_ID;
  readonly version = ANTHROPIC_MODEL_PROVIDER_VERSION;
  readonly modelId: string;

  readonly #apiKey: string;
  readonly #apiVersion: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;

  /**
   * Validates the configuration strictly: exactly the five documented fields, no
   * unknown field, no default, and no coercion.
   *
   * An unknown field is rejected rather than ignored, for the reason every
   * strict boundary in this repository gives: a misspelled `timeoutMS` would
   * leave the adapter with a timeout the caller believes they configured and
   * does not have.
   *
   * @throws {AnthropicModelProviderError} when the configuration is not usable.
   */
  constructor(config: unknown) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw invalidConfig('AnthropicModelProvider configuration must be an object.');
    }

    const unknownKeys = Object.keys(config)
      .filter((key) => !CONFIG_KEYS.includes(key))
      .sort();
    if (unknownKeys.length > 0) {
      throw invalidConfig(
        `AnthropicModelProvider configuration has unknown field(s): ${unknownKeys.join(', ')}.`,
      );
    }

    const { apiKey, apiVersion, baseUrl, modelId, timeoutMs } =
      config as Partial<AnthropicModelProviderConfig>;

    for (const [field, value] of [
      ['apiKey', apiKey],
      ['apiVersion', apiVersion],
      ['modelId', modelId],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw invalidConfig(
          `AnthropicModelProvider ${field} must not be empty or whitespace-only.`,
        );
      }
      if (hasLoneSurrogate(value)) {
        throw invalidConfig(`AnthropicModelProvider ${field} must be well-formed UTF-16.`);
      }
    }

    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw invalidConfig('AnthropicModelProvider timeoutMs must be a positive safe integer.');
    }

    // `apiKey` is read into a private field and never stored anywhere a
    // stringified instance could reach.
    this.#apiKey = apiKey as string;
    this.#apiVersion = apiVersion as string;
    this.modelId = modelId as string;
    this.#timeoutMs = timeoutMs;
    this.#endpoint = buildEndpoint(baseUrl);
  }

  /**
   * Sends one request and returns the provider's text result.
   *
   * The call is made once. A timeout, a transport failure, and a non-2xx status
   * are all reported rather than retried: a benchmark that silently retried
   * would measure a latency nobody experienced, and deciding whether a retry is
   * appropriate belongs to whoever is running the benchmark.
   *
   * @throws {AnthropicModelProviderError} for every rejection and every failure.
   */
  async generate(request: ModelProviderRequest): Promise<ModelProviderResult> {
    const validated = validateRequest(request);
    const body = JSON.stringify({
      model: this.modelId,
      max_tokens: validated.maxOutputTokens,
      temperature: validated.temperature,
      system: validated.systemPrompt,
      messages: [{ role: 'user', content: validated.userPrompt }],
    });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.#apiKey,
          'anthropic-version': this.#apiVersion,
        },
        body,
        signal: controller.signal,
      });
    } catch {
      // The rejection reason is discarded deliberately. A `fetch` failure names
      // the host it could not reach and, for some causes, echoes request detail;
      // neither belongs in an error this adapter publishes.
      throw timedOut
        ? new AnthropicModelProviderError(
            'ANTHROPIC_MODEL_PROVIDER_TIMEOUT',
            'AnthropicModelProvider request exceeded the configured timeout.',
          )
        : new AnthropicModelProviderError(
            'ANTHROPIC_MODEL_PROVIDER_TRANSPORT_FAILED',
            'AnthropicModelProvider request failed before a response was received.',
          );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The status is the one detail worth publishing: it separates a bad
      // credential from a rate limit from an outage without quoting the
      // provider's message, which can restate the prompt back at the caller.
      throw new AnthropicModelProviderError(
        'ANTHROPIC_MODEL_PROVIDER_HTTP_ERROR',
        'AnthropicModelProvider received an unsuccessful response.',
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AnthropicModelProviderError(
        'ANTHROPIC_MODEL_PROVIDER_INVALID_RESPONSE_BODY',
        'AnthropicModelProvider response body must be valid JSON.',
      );
    }

    return parseResult(payload);
  }
}

/**
 * Resolves the Messages endpoint from the configured base URL.
 *
 * The URL is validated rather than trusted. Credentials in the authority would
 * be a second, unrecorded way to authenticate; a query or fragment would be
 * silently carried onto every request; and plain HTTP outside the loopback
 * addresses would send the API key and the whole prompt in clear text.
 *
 * A base path is preserved so a stub server can be mounted under one, and any
 * trailing slash is dropped so the endpoint never contains an empty segment.
 */
function buildEndpoint(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    throw invalidConfig('AnthropicModelProvider baseUrl must not be empty or whitespace-only.');
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw invalidConfig('AnthropicModelProvider baseUrl must be a valid absolute URL.');
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw invalidConfig('AnthropicModelProvider baseUrl must not carry credentials.');
  }
  if (url.search.length > 0) {
    throw invalidConfig('AnthropicModelProvider baseUrl must not carry a query string.');
  }
  if (url.hash.length > 0) {
    throw invalidConfig('AnthropicModelProvider baseUrl must not carry a fragment.');
  }

  const isLoopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol === 'https:') {
    // Accepted everywhere.
  } else if (url.protocol === 'http:' && isLoopback) {
    // Accepted only because the request never leaves the machine.
  } else if (url.protocol === 'http:') {
    throw invalidConfig('AnthropicModelProvider baseUrl must use https for a non-loopback host.');
  } else {
    throw invalidConfig('AnthropicModelProvider baseUrl must use http or https.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}${MESSAGES_PATH}`;
}

/**
 * Validates one request strictly, before anything is sent.
 *
 * `temperature` has no default. Choosing one here would silently change what is
 * being measured, and a benchmark whose sampling temperature is an adapter
 * detail is not reproducible by anyone reading its report.
 */
function validateRequest(request: ModelProviderRequest): ModelProviderRequest {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw invalidRequest('AnthropicModelProvider request must be an object.');
  }

  const unknownKeys = Object.keys(request)
    .filter((key) => !REQUEST_KEYS.includes(key))
    .sort();
  if (unknownKeys.length > 0) {
    throw invalidRequest(
      `AnthropicModelProvider request has unknown field(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const { schemaVersion, systemPrompt, userPrompt, maxOutputTokens, temperature } = request;

  if (schemaVersion !== REQUEST_SCHEMA_VERSION) {
    throw invalidRequest(
      `AnthropicModelProvider request schemaVersion must be ${String(REQUEST_SCHEMA_VERSION)}.`,
    );
  }
  if (typeof systemPrompt !== 'string' || hasLoneSurrogate(systemPrompt)) {
    throw invalidRequest(
      'AnthropicModelProvider systemPrompt must be a well-formed UTF-16 string.',
    );
  }
  // An empty system prompt is a deliberate configuration; an empty user prompt
  // is a request with no question in it.
  if (
    typeof userPrompt !== 'string' ||
    userPrompt.trim().length === 0 ||
    hasLoneSurrogate(userPrompt)
  ) {
    throw invalidRequest(
      'AnthropicModelProvider userPrompt must be a non-blank well-formed UTF-16 string.',
    );
  }
  if (
    typeof maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  ) {
    throw invalidRequest('AnthropicModelProvider maxOutputTokens must be a positive safe integer.');
  }
  if (
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 1
  ) {
    throw invalidRequest('AnthropicModelProvider temperature must be a finite number in [0, 1].');
  }

  return request;
}

/**
 * Projects one successful provider response onto the project-owned result.
 *
 * Text blocks are concatenated in the order the provider returned them, with
 * **no** separator: inventing a newline between two parts would put a character
 * in the answer that the model did not produce, and every downstream criterion
 * is evaluated against exact text.
 *
 * A non-text block fails explicitly. Dropping it would silently discard part of
 * the answer and then score what remains as if it were the whole of it, which is
 * a measurement error rather than a graceful degradation (INV-ADAPTER-003).
 *
 * `model` is recorded, never checked against the configured identifier: a
 * provider may resolve an alias to a concrete version, and rejecting that would
 * reject a correct answer.
 */
function parseResult(payload: unknown): ModelProviderResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw invalidResponse('AnthropicModelProvider response must be a JSON object.');
  }

  const content = fieldOf(payload, 'content');
  if (!Array.isArray(content)) {
    throw invalidResponse('AnthropicModelProvider response content must be an array.');
  }

  const parts: string[] = [];
  for (const [index, block] of content.entries()) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw invalidResponse(
        `AnthropicModelProvider response content[${String(index)}] must be an object.`,
      );
    }
    const type = fieldOf(block, 'type');
    if (type !== 'text') {
      throw new AnthropicModelProviderError(
        'ANTHROPIC_MODEL_PROVIDER_UNSUPPORTED_RESPONSE_CONTENT',
        `AnthropicModelProvider response content[${String(index)}] is not a text block.`,
      );
    }
    const text = fieldOf(block, 'text');
    if (typeof text !== 'string') {
      throw invalidResponse(
        `AnthropicModelProvider response content[${String(index)}].text must be a string.`,
      );
    }
    parts.push(text);
  }

  const providerRequestId = optionalIdentity(fieldOf(payload, 'id'), 'id');
  const actualModelId = optionalIdentity(fieldOf(payload, 'model'), 'model');
  const stopReason = optionalIdentity(fieldOf(payload, 'stop_reason'), 'stop_reason');

  const usageField = fieldOf(payload, 'usage');
  if (usageField !== undefined && usageField !== null) {
    if (typeof usageField !== 'object' || Array.isArray(usageField)) {
      throw invalidResponse('AnthropicModelProvider response usage must be an object.');
    }
  }
  const inputTokens = usageCount(fieldOf(usageField, 'input_tokens'), 'input_tokens');
  const outputTokens = usageCount(fieldOf(usageField, 'output_tokens'), 'output_tokens');
  const usage =
    inputTokens === null && outputTokens === null
      ? undefined
      : {
          ...(inputTokens === null ? {} : { inputTokens }),
          ...(outputTokens === null ? {} : { outputTokens }),
        };

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    // Zero text blocks is a valid, structurally complete response with no text
    // in it; an empty answer is reported as such rather than as a failure.
    outputText: parts.join(''),
    ...(usage === undefined ? {} : { usage }),
    ...(providerRequestId === null ? {} : { providerRequestId }),
    ...(stopReason === null ? {} : { stopReason }),
    ...(actualModelId === null ? {} : { actualModelId }),
  };
}

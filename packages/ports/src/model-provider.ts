/**
 * Model provider port (DEC-040).
 *
 * One configured model, one text request, one text result. The capability exists
 * because the evaluation harness has to ask a real model the same question twice
 * — once with a baseline context and once with the compiled one — and compare
 * the answers. Nothing in the compiler kernel consumes it: `ContextCompiler`,
 * every stage it composes, and `CompileLocalContextService` remain model-free,
 * and a model call inside any of them would make compilation non-deterministic
 * (INV-DET-001, INV-DEP-002).
 *
 * The contract is deliberately narrow. There is no streaming, no tool or
 * function calling, no routing between models, no retry, no fallback model, no
 * prompt-caching orchestration, and no pricing. Each of those is a product
 * decision with its own failure semantics, and adding one here would start
 * turning CtxAlloc into a model gateway, which the product contract says it is
 * not.
 *
 * **The prompt belongs to the caller.** `systemPrompt` and `userPrompt` are the
 * exact strings the evaluation layer prepared, and an adapter must send them
 * unchanged: no template, no wrapper, no instruction of its own, no trimming.
 * An adapter that enriched the prompt would make the two answers in a comparison
 * differ by something other than the context under test, which is the one thing
 * the measurement depends on.
 *
 * **Model identity belongs to the provider instance, not to the request.** A
 * request that named its own model would let one evaluation run silently mix two
 * models and still call the difference a context effect.
 *
 * No latency field appears anywhere here. Duration is measured by the caller
 * around the call, through `MonotonicClock`, because a provider-reported
 * duration would describe the provider's view of its own work rather than what
 * the caller waited for.
 *
 * No external SDK type appears in this contract (INV-ADAPTER-001).
 */

/**
 * One text generation request.
 *
 * `schemaVersion` is the literal `1`, spelled inline rather than imported from a
 * constant so this package keeps its no-runtime-export property: a port is a
 * type, and a type cannot pull infrastructure into a layer.
 *
 * `temperature` and `maxOutputTokens` are required and have no default. A
 * default temperature chosen by an adapter would be an unrecorded experiment
 * variable, and two runs of one benchmark could then differ for a reason the
 * report never mentions.
 */
export interface ModelProviderRequest {
  readonly schemaVersion: 1;

  /** Exact system prompt prepared by the caller, sent unchanged. */
  readonly systemPrompt: string;

  /** Exact user prompt prepared by the caller, sent unchanged. */
  readonly userPrompt: string;

  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/**
 * Provider-native token usage for one call.
 *
 * These counts come from the provider's own tokenizer and vocabulary. They are
 * **not** comparable with CtxAlloc `Tokenizer` counts, and no consumer may
 * subtract one from the other: the difference would mix two vocabularies and
 * silently include the provider's own prompt and message framing (METRICS 8.6).
 *
 * Both fields are optional because a provider may not report them. An absent
 * count stays absent — estimating one from a string length or from a CtxAlloc
 * token count would publish a guess under a measurement's name.
 */
export interface ModelProviderUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * One text generation result.
 *
 * `outputText` is the exact text the provider produced, concatenated in provider
 * order when the response carried several text parts, with nothing inserted
 * between them.
 *
 * The remaining fields are provider-native observations, present only when the
 * provider supplied them. `actualModelId` is recorded rather than checked: a
 * provider may resolve a configured alias to a concrete version, and requiring
 * it to byte-equal the configured identifier would reject a correct answer.
 */
export interface ModelProviderResult {
  readonly schemaVersion: 1;
  readonly outputText: string;
  readonly usage?: ModelProviderUsage;

  /** Provider-native request or message identifier, when supplied. */
  readonly providerRequestId?: string;

  /** Provider-native stop reason, normalized to a string, when supplied. */
  readonly stopReason?: string;

  /** Model identifier the provider says it actually ran, when supplied. */
  readonly actualModelId?: string;
}

/**
 * One configured model, callable once per request.
 *
 * `id` and `version` identify the adapter implementation; `modelId` identifies
 * the model it is configured to call. All three are recorded in an evaluation
 * report so a measurement can say what produced it (INV-TRACE-005).
 *
 * An implementation must fail explicitly rather than return an approximation,
 * substitute another model, or retry silently (INV-ADAPTER-003).
 */
export interface ModelProvider {
  /** Stable identifier of the adapter implementation. */
  readonly id: string;

  /** Stable version of the adapter implementation. */
  readonly version: string;

  /** Configured model identity of this provider instance. */
  readonly modelId: string;

  generate(request: ModelProviderRequest): Promise<ModelProviderResult>;
}

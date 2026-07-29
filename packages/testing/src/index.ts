/**
 * Test doubles for CtxAlloc ports.
 *
 * Implementations here exist so the core suite runs without a network, a model
 * API, a retrieval service, or a real tokenizer. They are deterministic by
 * construction and must never contain product logic.
 */

export {
  FakeTokenizer,
  FakeTokenizerConfigurationError,
  FakeTokenizerUnknownTextError,
  type FakeTokenizerEntry,
  type FakeTokenizerOptions,
} from './fake-tokenizer.js';

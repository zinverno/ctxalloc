/**
 * Test doubles for CtxAlloc ports.
 *
 * Implementations here exist so the core suite runs without a network, a model
 * API, a retrieval service, a filesystem, a control-plane database, or a real
 * tokenizer. They are deterministic by construction and must never contain
 * product logic: a fake that scored candidates or resolved paths would be an
 * implementation nothing ships, and every test built on it would be measuring
 * that instead of the product (INV-DEP-003).
 *
 * Each double fails explicitly on unconfigured input, so a missing fixture is
 * visible rather than silently producing an empty successful result
 * (INV-ADAPTER-003).
 *
 * `FakeModelProvider` is deliberately absent: no `ModelProvider` port exists yet.
 */

export {
  FakeCandidateProvider,
  FakeCandidateProviderError,
  type FakeCandidateProviderOptions,
} from './fake-candidate-provider.js';
export {
  FakeTokenizer,
  FakeTokenizerConfigurationError,
  FakeTokenizerUnknownTextError,
  type FakeTokenizerEntry,
  type FakeTokenizerOptions,
} from './fake-tokenizer.js';
export {
  InMemoryControlStore,
  InMemoryControlStoreConfigurationError,
  type InMemoryControlStoreOptions,
} from './in-memory-control-store.js';
export {
  InMemorySourceReader,
  InMemorySourceReaderConfigurationError,
  InMemorySourceReaderUnknownLocatorError,
  type InMemorySourceEntry,
  type InMemorySourceReaderOptions,
} from './in-memory-source-reader.js';

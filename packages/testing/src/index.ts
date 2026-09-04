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
 * `FakeModelProvider` and `FakeMonotonicClock` serve the evaluation harness
 * (DEC-040). Neither derives anything from its input: the model double answers
 * only from its script, and the clock double reads only the sequence it was
 * given.
 *
 * `InMemoryControlStore` and `InMemoryTraceStore` are the in-memory halves of
 * the persistence contracts (DEC-042). Each publishes the **exact** machine
 * codes its SQLite counterpart does and is run against the same shared contract
 * suite, so a store test written on a double is a test of shipped behavior
 * rather than of the double (INV-ADAPTER-005).
 */

export {
  FakeCandidateProvider,
  FakeCandidateProviderError,
  type FakeCandidateProviderOptions,
} from './fake-candidate-provider.js';
export {
  FakeModelProvider,
  FakeModelProviderConfigurationError,
  FakeModelProviderScriptedFailureError,
  FakeModelProviderUnscriptedCallError,
  type FakeModelProviderOptions,
  type FakeModelProviderOutcome,
  type FakeModelProviderPromptOutcome,
} from './fake-model-provider.js';
export {
  FakeMonotonicClock,
  FakeMonotonicClockConfigurationError,
  FakeMonotonicClockExhaustedError,
  type FakeMonotonicClockOptions,
} from './fake-monotonic-clock.js';
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
  InMemoryControlStoreWriteError,
  type InMemoryControlStoreOptions,
  type InMemoryControlStoreWriteErrorCode,
} from './in-memory-control-store.js';
export {
  InMemoryTraceStore,
  InMemoryTraceStoreConfigurationError,
  InMemoryTraceStoreError,
  type InMemoryTraceStoreErrorCode,
  type InMemoryTraceStoreOptions,
} from './in-memory-trace-store.js';
export {
  InMemorySourceReader,
  InMemorySourceReaderConfigurationError,
  InMemorySourceReaderUnknownLocatorError,
  type InMemorySourceEntry,
  type InMemorySourceReaderOptions,
} from './in-memory-source-reader.js';

import type { MonotonicClock } from '@ctxalloc/ports';

/**
 * Deterministic test double for the {@link MonotonicClock} port (DEC-040).
 *
 * The clock is a script. It is constructed from an explicit sequence of
 * millisecond readings and returns them in order, one per call. It advances
 * nothing on its own, interpolates nothing, and falls back to nothing: a test
 * that measures three durations supplies six readings, and the durations it
 * asserts are the ones it wrote.
 *
 * Running out of readings is an explicit failure. A fake that looped, repeated
 * its last value, or started reading the real timer would silently turn an
 * under-specified test into a passing one, and the missing fixture — usually a
 * measurement the test did not know the code takes — would never be seen
 * (INV-ADAPTER-003).
 *
 * A test may deliberately supply a **backwards** step. A clock that moves
 * backwards is a real failure mode the harness has to reject rather than publish
 * as a negative duration, so the double must be able to produce one. Only the
 * individual readings are checked for being finite and non-negative; their order
 * is the test's to choose.
 *
 * It reads no real timer, no `Date`, no random value, and no environment
 * (INV-DET-001, INV-DET-003, INV-DET-004).
 */

const DEFAULT_ID = 'fake-monotonic-clock';
const DEFAULT_VERSION = '1';

/** Explicit clock behavior for one test. */
export interface FakeMonotonicClockOptions {
  readonly id?: string;
  readonly version?: string;
}

/** Rejected {@link FakeMonotonicClock} configuration. */
export class FakeMonotonicClockConfigurationError extends Error {
  readonly code = 'FAKE_MONOTONIC_CLOCK_INVALID_CONFIGURATION';

  constructor(message: string) {
    super(message);
    this.name = 'FakeMonotonicClockConfigurationError';
  }
}

/** A {@link FakeMonotonicClock} asked for a reading it was never given. */
export class FakeMonotonicClockExhaustedError extends Error {
  readonly code = 'FAKE_MONOTONIC_CLOCK_EXHAUSTED';
  /** How many readings the clock was configured with. */
  readonly configuredReadings: number;

  constructor(message: string, configuredReadings: number) {
    super(message);
    this.name = 'FakeMonotonicClockExhaustedError';
    this.configuredReadings = configuredReadings;
  }
}

export class FakeMonotonicClock implements MonotonicClock {
  readonly id: string;
  readonly version: string;

  readonly #readings: readonly number[];
  #next = 0;

  /**
   * @param readings Exact values `nowMilliseconds` returns, in call order.
   * @throws {FakeMonotonicClockConfigurationError} when a reading is not a
   * finite non-negative number, or the sequence is empty.
   */
  constructor(readings: readonly number[], options: FakeMonotonicClockOptions = {}) {
    if (readings.length === 0) {
      throw new FakeMonotonicClockConfigurationError(
        'FakeMonotonicClock requires at least one reading.',
      );
    }
    readings.forEach((reading, index) => {
      if (typeof reading !== 'number' || !Number.isFinite(reading) || reading < 0) {
        throw new FakeMonotonicClockConfigurationError(
          `FakeMonotonicClock reading at index ${String(index)} must be a finite non-negative number.`,
        );
      }
    });

    this.#readings = [...readings];
    this.id = options.id ?? DEFAULT_ID;
    this.version = options.version ?? DEFAULT_VERSION;
  }

  /** How many readings have not been returned yet. */
  get remaining(): number {
    return this.#readings.length - this.#next;
  }

  /**
   * The next configured reading.
   *
   * @throws {FakeMonotonicClockExhaustedError} when every reading has been used.
   */
  nowMilliseconds(): number {
    const reading = this.#readings[this.#next];
    if (reading === undefined) {
      throw new FakeMonotonicClockExhaustedError(
        `FakeMonotonicClock was configured with ${String(this.#readings.length)} reading(s) and has no more to return.`,
        this.#readings.length,
      );
    }
    this.#next += 1;
    return reading;
  }
}

/**
 * Monotonic clock port (DEC-040).
 *
 * This measures **elapsed durations only**. It is not a wall clock, it has no
 * date or timezone semantics, and it must never be used to stamp a record: the
 * evaluation run's execution date stays explicit caller data, exactly as
 * `CompilationRequest.referenceTime` does (INV-DET-004).
 *
 * The port exists now because Phase 17 has a real consumer for it — the
 * evaluation harness measures compilation latency and each model call — and
 * every port in this package is added by the phase that consumes it. A general
 * `Clock` abstraction over `Date.now` is deliberately **not** added: nothing
 * needs one, and a wall clock reachable from a component is exactly what makes a
 * deterministic pipeline stop being deterministic.
 *
 * An implementation must return values that are finite, non-negative, and
 * monotonically non-decreasing within one instance. Two instances share no
 * origin, so a reading from one may never be subtracted from a reading of
 * another. The absolute value means nothing on its own; only differences do.
 */
export interface MonotonicClock {
  /** Stable identifier of the clock implementation. */
  readonly id: string;

  /** Stable version of the clock implementation. */
  readonly version: string;

  /**
   * Milliseconds since this instance's own unspecified origin.
   *
   * The value may be fractional. Successive calls on one instance never
   * decrease; a caller that observes a decrease must treat it as a failure of
   * the clock rather than publish a negative duration.
   */
  nowMilliseconds(): number;
}

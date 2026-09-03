/**
 * `MonotonicClock` over the Node monotonic timer (DEC-040).
 *
 * `performance.now()` is the platform's monotonic source: it counts from an
 * unspecified origin fixed when the process started and is unaffected by system
 * clock adjustments, NTP steps, or timezone changes. `Date.now()` is none of
 * those things — it can move backwards mid-measurement and would then produce a
 * negative duration — so it is deliberately not used here, and neither is any
 * filesystem or wall-clock time source.
 *
 * The class has no configuration. There is nothing to configure: an origin would
 * only make readings from one instance comparable with another's, and they are
 * not comparable by contract.
 *
 * No Node type reaches the public declaration (INV-ADAPTER-001).
 */

/** Stable identifier of this clock implementation. */
export const SYSTEM_MONOTONIC_CLOCK_ID = 'node-performance-now';

/** Stable version of the behavior published under {@link SYSTEM_MONOTONIC_CLOCK_ID}. */
export const SYSTEM_MONOTONIC_CLOCK_VERSION = '1';

export class SystemMonotonicClock {
  readonly id = SYSTEM_MONOTONIC_CLOCK_ID;
  readonly version = SYSTEM_MONOTONIC_CLOCK_VERSION;

  /**
   * Milliseconds since this process's monotonic origin, possibly fractional.
   *
   * The value is returned exactly as the platform reports it: not rounded, not
   * truncated, and not offset. Rounding here would make two readings taken
   * inside one millisecond compare equal and hide a real ordering.
   */
  nowMilliseconds(): number {
    return performance.now();
  }
}

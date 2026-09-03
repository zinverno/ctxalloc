import {
  FakeMonotonicClock,
  FakeMonotonicClockConfigurationError,
  FakeMonotonicClockExhaustedError,
} from '@ctxalloc/testing';
import { describe, expect, it } from 'vitest';

/**
 * The scripted monotonic clock (DEC-040).
 *
 * Every reading a test asserts is one the test wrote. The double advances
 * nothing on its own, so a measurement the code takes and the test did not
 * anticipate surfaces as an exhaustion failure rather than as a plausible
 * number.
 */
describe('FakeMonotonicClock', () => {
  it('returns the configured readings in order', () => {
    const clock = new FakeMonotonicClock([0, 5, 5, 12.5]);
    expect(clock.nowMilliseconds()).toBe(0);
    expect(clock.nowMilliseconds()).toBe(5);
    // Equal readings are legal: two operations can land inside one tick.
    expect(clock.nowMilliseconds()).toBe(5);
    expect(clock.nowMilliseconds()).toBe(12.5);
  });

  it('publishes its own identity', () => {
    const clock = new FakeMonotonicClock([1], { id: 'clock-a', version: '9' });
    expect(clock.id).toBe('clock-a');
    expect(clock.version).toBe('9');
  });

  it('reports how many readings remain', () => {
    const clock = new FakeMonotonicClock([1, 2, 3]);
    expect(clock.remaining).toBe(3);
    clock.nowMilliseconds();
    expect(clock.remaining).toBe(2);
  });

  it('fails explicitly rather than repeating or looping when exhausted', () => {
    // A fallback would turn an under-specified test into a passing one, and the
    // missing fixture is usually a measurement the test did not know about.
    const clock = new FakeMonotonicClock([7]);
    expect(clock.nowMilliseconds()).toBe(7);
    expect(() => clock.nowMilliseconds()).toThrow(FakeMonotonicClockExhaustedError);
    try {
      clock.nowMilliseconds();
    } catch (cause) {
      expect((cause as FakeMonotonicClockExhaustedError).configuredReadings).toBe(1);
    }
  });

  it('rejects an empty sequence and a non-finite or negative reading', () => {
    expect(() => new FakeMonotonicClock([])).toThrow(FakeMonotonicClockConfigurationError);
    expect(() => new FakeMonotonicClock([Number.NaN])).toThrow(
      FakeMonotonicClockConfigurationError,
    );
    expect(() => new FakeMonotonicClock([Number.POSITIVE_INFINITY])).toThrow(
      FakeMonotonicClockConfigurationError,
    );
    expect(() => new FakeMonotonicClock([-1])).toThrow(FakeMonotonicClockConfigurationError);
  });

  it('permits a deliberately backwards step, which the harness must reject', () => {
    // The double has to be able to produce a real failure mode. Rejecting a
    // backwards clock is the harness's job, not the fake's.
    const clock = new FakeMonotonicClock([100, 40]);
    expect(clock.nowMilliseconds()).toBe(100);
    expect(clock.nowMilliseconds()).toBe(40);
  });

  it('copies its readings, so a later mutation of the array changes nothing', () => {
    const readings = [1, 2];
    const clock = new FakeMonotonicClock(readings);
    readings[1] = 999;
    expect(clock.nowMilliseconds()).toBe(1);
    expect(clock.nowMilliseconds()).toBe(2);
  });
});

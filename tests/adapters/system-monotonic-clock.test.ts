import { readFileSync } from 'node:fs';
import {
  SYSTEM_MONOTONIC_CLOCK_ID,
  SYSTEM_MONOTONIC_CLOCK_VERSION,
  SystemMonotonicClock,
} from '@ctxalloc/adapters';
import { describe, expect, it } from 'vitest';

/**
 * The real monotonic clock (DEC-040).
 *
 * It measures elapsed time and nothing else. `Date.now` is deliberately not used:
 * it can move backwards mid-measurement under an NTP step and would then publish
 * a negative duration.
 */
describe('SystemMonotonicClock', () => {
  it('publishes a stable identity', () => {
    const clock = new SystemMonotonicClock();
    expect(clock.id).toBe(SYSTEM_MONOTONIC_CLOCK_ID);
    expect(clock.version).toBe(SYSTEM_MONOTONIC_CLOCK_VERSION);
  });

  it('returns finite non-negative readings that never decrease', () => {
    const clock = new SystemMonotonicClock();
    let previous = clock.nowMilliseconds();
    expect(Number.isFinite(previous)).toBe(true);
    expect(previous).toBeGreaterThanOrEqual(0);

    for (let index = 0; index < 200; index += 1) {
      const reading = clock.nowMilliseconds();
      expect(Number.isFinite(reading)).toBe(true);
      expect(reading).toBeGreaterThanOrEqual(previous);
      previous = reading;
    }
  });

  it('measures a real elapsed interval as a non-negative duration', async () => {
    const clock = new SystemMonotonicClock();
    const start = clock.nowMilliseconds();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(clock.nowMilliseconds() - start).toBeGreaterThanOrEqual(0);
  });

  it('reads no wall clock and no filesystem time', () => {
    const source = readFileSync(
      new URL('../../packages/adapters/src/system-monotonic-clock.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['Date.now', 'new Date', 'hrtime', 'statSync', 'mtime']) {
      expect(code, `uses ${forbidden}`).not.toContain(forbidden);
    }
    expect(code).toContain('performance.now()');
  });
});

import { z } from 'zod';

/**
 * Serialized UTC instant, for example `2026-01-31T09:15:00.000Z`.
 *
 * Persisted records carry timestamps as strings, never as `Date` instances: a
 * `Date` does not survive a JSON round trip unchanged and would reintroduce
 * locale- and environment-dependent behavior.
 *
 * Validation is purely structural. The domain never reads the current clock;
 * time-dependent behavior must use a supplied reference timestamp or an injected
 * clock (INV-DET-004).
 */
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

/**
 * Checks that the components describe a real UTC instant.
 *
 * `Date.parse` alone is not sufficient: it silently rolls impossible values over
 * (`2026-02-31` becomes 3 March), which would let a malformed timestamp through
 * and change its meaning. Comparing the parsed components against the supplied
 * ones rejects any value that was normalized.
 *
 * The `Date` here is transient arithmetic over the supplied string. It never
 * reads the current clock and never enters the record.
 */
function isRealUtcInstant(value: string): boolean {
  const match = ISO_UTC_PATTERN.exec(value);
  if (match === null) return false;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }

  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day &&
    instant.getUTCHours() === hour &&
    instant.getUTCMinutes() === minute &&
    instant.getUTCSeconds() === second
  );
}

export const TimestampSchema = z
  .string()
  .regex(ISO_UTC_PATTERN, { message: 'must be an ISO 8601 UTC timestamp ending in "Z"' })
  .refine(isRealUtcInstant, { message: 'must be a valid calendar date and time' })
  .brand<'Timestamp'>();

export type Timestamp = z.infer<typeof TimestampSchema>;

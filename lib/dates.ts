/**
 * Date handling.
 *
 * WHOOP's collection endpoints take absolute UTC instants (`start` / `end`),
 * but the useful questions are local-calendar ones: "how did I sleep last
 * night", "what was my strain on Tuesday". These helpers translate a local
 * calendar day in a configured IANA timezone into the UTC window WHOOP wants,
 * correctly across DST boundaries.
 */

function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

/** Converts a wall-clock time in `timeZone` into the matching UTC instant. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  // Two passes settle the DST edge cases: the first offset is computed from an
  // approximate instant, the second from one already close to the real answer.
  let instant = new Date(naive - timezoneOffsetMs(new Date(naive), timeZone));
  instant = new Date(naive - timezoneOffsetMs(instant, timeZone));
  return instant;
}

export interface TimeRange {
  start: string;
  end: string;
}

function parseIsoDate(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid date "${value}". Expected YYYY-MM-DD.`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** UTC window covering one local calendar day. */
export function dayRange(date: string, timeZone: string): TimeRange {
  const [year, month, day] = parseIsoDate(date);
  const start = zonedTimeToUtc(year, month, day, timeZone);
  const end = zonedTimeToUtc(year, month, day + 1, timeZone);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Today's date in `timeZone`, as YYYY-MM-DD. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Shifts a local calendar date by whole days. Pure calendar arithmetic in UTC:
 * a 23- or 25-hour DST day must not shorten or lengthen a window.
 */
export function addDays(date: string, delta: number): string {
  const [year, month, day] = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day + delta))
    .toISOString()
    .slice(0, 10);
}

export interface RangeArgs {
  date?: string;
  start?: string;
  end?: string;
  days?: number;
}

/**
 * Resolves the three ways a tool can be asked for a time window, in priority
 * order: explicit start/end, a single `date`, or the last `days` days
 * (defaulting to 7). Always returns absolute UTC instants.
 */
export function resolveRange(args: RangeArgs, timeZone: string): TimeRange {
  if (args.start || args.end) {
    const end = args.end ? new Date(args.end) : new Date();
    const start = args.start
      ? new Date(args.start)
      : new Date(end.getTime() - 7 * 86_400_000);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Invalid start/end. Use ISO-8601, e.g. 2026-09-01T00:00:00Z.');
    }
    return { start: start.toISOString(), end: end.toISOString() };
  }

  if (args.date) {
    return dayRange(args.date, timeZone);
  }

  const days = Math.max(1, Math.min(args.days ?? 7, 60));
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

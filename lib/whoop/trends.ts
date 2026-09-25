/**
 * Aggregation for the trend tool.
 *
 * Pure functions over already-normalized numbers: no WHOOP calls, no clock,
 * no database. The tool in lib/mcp/server.ts fetches the records and hands
 * them here.
 */

export interface Summary {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}

const round = (value: number, digits = 1): number =>
  Number(value.toFixed(digits));

/** Null when the window holds no scored records — never NaN. */
export function summarize(values: number[]): Summary | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return {
    n: sorted.length,
    mean: round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
    median: round(
      sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle],
    ),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

export interface Comparison {
  current: Summary | null;
  previous: Summary | null;
  /** Change in mean against the preceding window of equal length. */
  change: number | null;
  change_pct: number | null;
}

/**
 * "Is this better or worse than usual?" — the question a rolling average is
 * actually asked. Null rather than zero whenever a window has no data, so the
 * model can say "no baseline yet" instead of inventing a flat trend.
 */
export function compare(
  currentValues: number[],
  previousValues: number[],
): Comparison {
  const current = summarize(currentValues);
  const previous = summarize(previousValues);

  const change =
    current && previous ? round(current.mean - previous.mean) : null;
  const change_pct =
    change !== null && previous && previous.mean !== 0
      ? round((change / Math.abs(previous.mean)) * 100)
      : null;

  return { current, previous, change, change_pct };
}

export interface Windows<T> {
  current: T[];
  previous: T[];
}

/**
 * Splits one fetch of 2N days into the current N days and the N before it.
 * Comparing against the preceding window is what turns an average into a
 * trend, and one fetch is cheaper than two.
 *
 * Dates are the record's own local calendar day (see normalize.ts), compared
 * as YYYY-MM-DD strings — lexicographic order is chronological order.
 */
export function splitByDate<T extends { date?: string }>(
  records: T[],
  cutoff: string,
): Windows<T> {
  const current: T[] = [];
  const previous: T[] = [];

  for (const record of records) {
    if (!record.date) continue;
    if (record.date >= cutoff) current.push(record);
    else previous.push(record);
  }

  return { current, previous };
}

/**
 * Recent training load over the longer-term baseline — the acute:chronic
 * workload ratio. Around 1 means the current week matches what the body is
 * used to; well above it is the classic "ramping up too fast" signal, well
 * below it means detraining. Null whenever there is no baseline to divide by,
 * so a first week of data doesn't produce a meaningless number.
 */
export function acuteChronicRatio(
  acuteMean: number | null,
  chronicMean: number | null,
): number | null {
  if (acuteMean === null || chronicMean === null || chronicMean === 0) {
    return null;
  }
  return round(acuteMean / chronicMean, 2);
}

/** WHOOP scores a record asynchronously; only SCORED carries real numbers. */
const SCORED = 'SCORED';

/**
 * Pulls one metric out of normalized records, keeping only the records that
 * can legitimately be averaged.
 */
export function scoredValues<T extends { score_state?: string }>(
  records: T[],
  pick: (record: T) => number | undefined,
  include: (record: T) => boolean = () => true,
): number[] {
  const values: number[] = [];

  for (const record of records) {
    if (record.score_state !== SCORED) continue;
    if (!include(record)) continue;
    const value = pick(record);
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }

  return values;
}

/* -------------------------------------------------------------------------- */
/* Assembling the tool payload                                                */
/* -------------------------------------------------------------------------- */

/** The fields of `normalize.ts` output that trends read. */
export interface RecoveryPoint {
  date?: string;
  score_state?: string;
  calibrating?: boolean;
  recovery_score_pct?: number;
  hrv_rmssd_ms?: number;
  resting_heart_rate_bpm?: number;
}

export interface SleepPoint {
  date?: string;
  score_state?: string;
  is_nap?: boolean;
  sleep_performance_pct?: number;
  asleep_min?: number;
  sleep_efficiency_pct?: number;
  sleep_debt_min?: number;
}

export interface CyclePoint {
  date?: string;
  score_state?: string;
  day_strain?: number;
  calories_kcal?: number;
}

export interface TrendsInput {
  windowDays: number;
  /** First local day of the current window, YYYY-MM-DD. */
  cutoff: string;
  /** First local day of the acute (recent-load) window, YYYY-MM-DD. */
  acuteCutoff: string;
  recoveries: RecoveryPoint[];
  sleeps: SleepPoint[];
  cycles: CyclePoint[];
}

function comparison<T extends { score_state?: string }>(
  windows: Windows<T>,
  pick: (record: T) => number | undefined,
  include?: (record: T) => boolean,
): Comparison {
  return compare(
    scoredValues(windows.current, pick, include),
    scoredValues(windows.previous, pick, include),
  );
}

/**
 * Turns a fetch spanning two windows into the comparison the model is really
 * being asked for: this week against the one before it, plus how the recent
 * training load sits against the longer baseline.
 */
export function buildTrends(input: TrendsInput) {
  const recoveries = splitByDate(input.recoveries, input.cutoff);
  const sleeps = splitByDate(input.sleeps, input.cutoff);
  const cycles = splitByDate(input.cycles, input.cutoff);

  // Naps are real sleep but not comparable with a night, and WHOOP flags them.
  const isNight = (sleep: SleepPoint) => sleep.is_nap !== true;
  const isCalibrated = (recovery: RecoveryPoint) => recovery.calibrating !== true;

  const acuteStrain = scoredValues(
    splitByDate(input.cycles, input.acuteCutoff).current,
    (cycle) => cycle.day_strain,
  );
  const chronicStrain = scoredValues(input.cycles, (cycle) => cycle.day_strain);

  const acute = summarize(acuteStrain);
  const chronic = summarize(chronicStrain);

  return {
    window_days: input.windowDays,
    window_start: input.cutoff,
    recovery: {
      recovery_score_pct: comparison(
        recoveries,
        (r) => r.recovery_score_pct,
        isCalibrated,
      ),
      hrv_rmssd_ms: comparison(recoveries, (r) => r.hrv_rmssd_ms, isCalibrated),
      resting_heart_rate_bpm: comparison(
        recoveries,
        (r) => r.resting_heart_rate_bpm,
        isCalibrated,
      ),
    },
    sleep: {
      sleep_performance_pct: comparison(sleeps, (s) => s.sleep_performance_pct, isNight),
      asleep_min: comparison(sleeps, (s) => s.asleep_min, isNight),
      sleep_efficiency_pct: comparison(sleeps, (s) => s.sleep_efficiency_pct, isNight),
      sleep_debt_min: comparison(sleeps, (s) => s.sleep_debt_min, isNight),
    },
    strain: {
      day_strain: comparison(cycles, (c) => c.day_strain),
      calories_kcal: comparison(cycles, (c) => c.calories_kcal),
    },
    training_load: {
      acute_days: input.windowDays,
      acute_mean: acute?.mean ?? null,
      chronic_days: input.windowDays * 2,
      chronic_mean: chronic?.mean ?? null,
      ratio: acuteChronicRatio(acute?.mean ?? null, chronic?.mean ?? null),
    },
  };
}

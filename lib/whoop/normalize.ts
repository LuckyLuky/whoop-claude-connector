import { localDateIn } from '../dates.ts';

/**
 * WHOOP's raw payloads nest every metric under a `score` object, express
 * durations in milliseconds and energy in kilojoules, and carry a lot of
 * fields no one will ask about. These helpers flatten them into compact,
 * self-describing objects — fewer tokens per tool result, and less room for
 * the model to misread a unit.
 */

export interface WhoopCycle {
  id: number | string;
  start: string;
  end: string | null;
  timezone_offset: string;
  score_state: string;
  score?: {
    strain?: number;
    kilojoule?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
  };
}

export interface WhoopRecovery {
  cycle_id: number | string;
  sleep_id: string;
  created_at: string;
  score_state: string;
  score?: {
    user_calibrating?: boolean;
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
}

export interface WhoopSleep {
  id: string;
  cycle_id?: number | string;
  start: string;
  end: string;
  timezone_offset: string;
  nap: boolean;
  score_state: string;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      sleep_cycle_count?: number;
      disturbance_count?: number;
    };
    sleep_needed?: {
      baseline_milli?: number;
      need_from_sleep_debt_milli?: number;
      need_from_recent_strain_milli?: number;
      need_from_recent_nap_milli?: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
}

export interface WhoopWorkout {
  id: string;
  start: string;
  end: string;
  timezone_offset: string;
  sport_name?: string;
  score_state: string;
  score?: {
    strain?: number;
    average_heart_rate?: number;
    max_heart_rate?: number;
    kilojoule?: number;
    distance_meter?: number;
    altitude_gain_meter?: number;
    zone_durations?: Record<string, number>;
  };
}

export interface WhoopProfile {
  user_id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
}

export interface WhoopBodyMeasurement {
  height_meter?: number;
  weight_kilogram?: number;
  max_heart_rate?: number;
}

const round = (value: number | undefined, digits = 1): number | undefined =>
  value === undefined ? undefined : Number(value.toFixed(digits));

const minutes = (milli: number | undefined): number | undefined =>
  milli === undefined ? undefined : Math.round(milli / 60_000);

const kcal = (kilojoule: number | undefined): number | undefined =>
  kilojoule === undefined ? undefined : Math.round(kilojoule * 0.239006);

/** Drops undefined and null keys so tool output stays terse. */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = compact(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) output[key] = nested;
      continue;
    }
    output[key] = value;
  }
  return output as Partial<T>;
}

/** Local calendar date the record belongs to, derived from its own offset. */
function localDate(start: string, timezoneOffset: string): string | undefined {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(timezoneOffset ?? '');
  if (!match) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const offsetMs =
    sign * (Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000);
  return new Date(new Date(start).getTime() + offsetMs)
    .toISOString()
    .slice(0, 10);
}

export function normalizeCycle(cycle: WhoopCycle) {
  return compact({
    cycle_id: cycle.id,
    date: localDate(cycle.start, cycle.timezone_offset),
    start: cycle.start,
    end: cycle.end,
    in_progress: cycle.end === null,
    score_state: cycle.score_state,
    day_strain: round(cycle.score?.strain, 2),
    calories_kcal: kcal(cycle.score?.kilojoule),
    average_heart_rate_bpm: cycle.score?.average_heart_rate,
    max_heart_rate_bpm: cycle.score?.max_heart_rate,
  });
}

/**
 * Recovery is the one record with no `timezone_offset` of its own, so its
 * local day comes from `created_at` resolved in `timeZone`. Without one the
 * UTC date is used, which is a day out either side of midnight.
 */
export function normalizeRecovery(recovery: WhoopRecovery, timeZone?: string) {
  return compact({
    cycle_id: recovery.cycle_id,
    sleep_id: recovery.sleep_id,
    date: timeZone
      ? localDateIn(recovery.created_at, timeZone)
      : recovery.created_at?.slice(0, 10),
    score_state: recovery.score_state,
    calibrating: recovery.score?.user_calibrating,
    recovery_score_pct: recovery.score?.recovery_score,
    resting_heart_rate_bpm: recovery.score?.resting_heart_rate,
    hrv_rmssd_ms: round(recovery.score?.hrv_rmssd_milli),
    spo2_pct: round(recovery.score?.spo2_percentage),
    skin_temp_celsius: round(recovery.score?.skin_temp_celsius),
  });
}

export function normalizeSleep(sleep: WhoopSleep) {
  const stages = sleep.score?.stage_summary;
  const needed = sleep.score?.sleep_needed;

  const totalNeededMilli =
    needed === undefined
      ? undefined
      : (needed.baseline_milli ?? 0) +
        (needed.need_from_sleep_debt_milli ?? 0) +
        (needed.need_from_recent_strain_milli ?? 0) +
        (needed.need_from_recent_nap_milli ?? 0);

  const asleepMilli =
    stages === undefined
      ? undefined
      : (stages.total_light_sleep_time_milli ?? 0) +
        (stages.total_slow_wave_sleep_time_milli ?? 0) +
        (stages.total_rem_sleep_time_milli ?? 0);

  return compact({
    sleep_id: sleep.id,
    cycle_id: sleep.cycle_id,
    date: localDate(sleep.end, sleep.timezone_offset),
    start: sleep.start,
    end: sleep.end,
    is_nap: sleep.nap,
    score_state: sleep.score_state,
    time_in_bed_min: minutes(stages?.total_in_bed_time_milli),
    asleep_min: minutes(asleepMilli),
    awake_min: minutes(stages?.total_awake_time_milli),
    light_sleep_min: minutes(stages?.total_light_sleep_time_milli),
    deep_sleep_min: minutes(stages?.total_slow_wave_sleep_time_milli),
    rem_sleep_min: minutes(stages?.total_rem_sleep_time_milli),
    sleep_needed_min: minutes(totalNeededMilli),
    sleep_debt_min: minutes(needed?.need_from_sleep_debt_milli),
    sleep_cycles: stages?.sleep_cycle_count,
    disturbances: stages?.disturbance_count,
    respiratory_rate: round(sleep.score?.respiratory_rate),
    sleep_performance_pct: round(sleep.score?.sleep_performance_percentage),
    sleep_consistency_pct: round(sleep.score?.sleep_consistency_percentage),
    sleep_efficiency_pct: round(sleep.score?.sleep_efficiency_percentage),
  });
}

export function normalizeWorkout(workout: WhoopWorkout) {
  const zones = workout.score?.zone_durations ?? {};
  const zoneMinutes = compact({
    zone_0_min: minutes(zones.zone_zero_milli),
    zone_1_min: minutes(zones.zone_one_milli),
    zone_2_min: minutes(zones.zone_two_milli),
    zone_3_min: minutes(zones.zone_three_milli),
    zone_4_min: minutes(zones.zone_four_milli),
    zone_5_min: minutes(zones.zone_five_milli),
  });

  return compact({
    workout_id: workout.id,
    date: localDate(workout.start, workout.timezone_offset),
    sport: workout.sport_name,
    start: workout.start,
    end: workout.end,
    duration_min: Math.round(
      (new Date(workout.end).getTime() - new Date(workout.start).getTime()) /
        60_000,
    ),
    score_state: workout.score_state,
    strain: round(workout.score?.strain, 2),
    average_heart_rate_bpm: workout.score?.average_heart_rate,
    max_heart_rate_bpm: workout.score?.max_heart_rate,
    calories_kcal: kcal(workout.score?.kilojoule),
    distance_m: round(workout.score?.distance_meter, 0),
    altitude_gain_m: round(workout.score?.altitude_gain_meter, 0),
    heart_rate_zones:
      Object.keys(zoneMinutes).length > 0 ? zoneMinutes : undefined,
  });
}

export function normalizeProfile(
  profile: WhoopProfile,
  body?: WhoopBodyMeasurement,
) {
  return compact({
    whoop_user_id: profile.user_id,
    first_name: profile.first_name,
    last_name: profile.last_name,
    email: profile.email,
    height_cm: body?.height_meter ? Math.round(body.height_meter * 100) : undefined,
    weight_kg: round(body?.weight_kilogram),
    max_heart_rate_bpm: body?.max_heart_rate,
  });
}

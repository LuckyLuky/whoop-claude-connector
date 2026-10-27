import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRecovery,
  normalizeWorkout,
  type WhoopRecovery,
  type WhoopWorkout,
} from './normalize.ts';

/**
 * Recovery is the one record WHOOP gives no timezone offset for — only a UTC
 * `created_at`. Its local date therefore has to be derived in the configured
 * timezone, or a recovery recorded late in the evening reads as the next day
 * and lands in the wrong trend window.
 */

function recovery(createdAt: string): WhoopRecovery {
  return {
    cycle_id: 1,
    sleep_id: 'sleep-1',
    created_at: createdAt,
    score_state: 'SCORED',
    score: { recovery_score_pct: 70 } as WhoopRecovery['score'],
  };
}

describe('normalizeRecovery', () => {
  it('dates a recovery by the local calendar day', () => {
    // 23:30 UTC is already the next day in Prague.
    assert.equal(
      normalizeRecovery(recovery('2026-01-14T23:30:00Z'), 'Europe/Prague').date,
      '2026-01-15',
    );
  });

  it('dates a recovery by the local day west of UTC too', () => {
    assert.equal(
      normalizeRecovery(recovery('2026-01-02T00:30:00Z'), 'America/Los_Angeles').date,
      '2026-01-01',
    );
  });

  it('falls back to the UTC date when no timezone is given', () => {
    assert.equal(
      normalizeRecovery(recovery('2026-01-14T23:30:00Z')).date,
      '2026-01-14',
    );
  });
});

/**
 * WHOOP sends `null` rather than omitting the key for metrics a workout
 * doesn't have — `distance_meter` on wrestling, BJJ or strength sessions.
 * One such record used to throw inside `round()` and fail the whole
 * `get_workouts` response.
 */
describe('normalizeWorkout', () => {
  it('tolerates null metrics on non-distance sports', () => {
    const workout = {
      id: 'w1',
      start: '2026-10-26T17:00:00.000Z',
      end: '2026-10-26T18:30:00.000Z',
      timezone_offset: '+01:00',
      sport_name: 'wrestling',
      score_state: 'SCORED',
      score: {
        strain: 10.4,
        average_heart_rate: 142,
        max_heart_rate: 168,
        kilojoule: 3500,
        distance_meter: null,
        altitude_gain_meter: null,
        zone_durations: { zone_zero_milli: 60_000, zone_four_milli: null },
      },
    } as unknown as WhoopWorkout;

    const result = normalizeWorkout(workout);
    assert.equal(result.sport, 'wrestling');
    assert.equal(result.strain, 10.4);
    assert.equal(result.distance_m, undefined);
    assert.equal(result.altitude_gain_m, undefined);
    assert.deepEqual(result.heart_rate_zones, { zone_0_min: 1 });
  });
});

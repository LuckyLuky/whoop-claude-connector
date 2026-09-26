import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  acuteChronicRatio,
  buildTrends,
  compare,
  scoredValues,
  splitByDate,
  summarize,
} from './trends.ts';

describe('summarize', () => {
  it('reports no data rather than NaN for an empty window', () => {
    // A strap not worn for a week must read as "no data", not as zero.
    assert.equal(summarize([]), null);
  });

  it('averages the middle pair when the count is even', () => {
    assert.equal(summarize([10, 20, 30, 40])?.median, 25);
  });

  it('rounds to one decimal so tool output stays terse', () => {
    assert.equal(summarize([1, 2, 2])?.mean, 1.7);
  });

  it('describes a set of values', () => {
    assert.deepEqual(summarize([60, 40, 80]), {
      n: 3,
      mean: 60,
      median: 60,
      min: 40,
      max: 80,
    });
  });
});

describe('compare', () => {
  it('reports the change between this window and the one before it', () => {
    const result = compare([70, 80], [60, 60]);

    assert.deepEqual(result.current, { n: 2, mean: 75, median: 75, min: 70, max: 80 });
    assert.deepEqual(result.previous, { n: 2, mean: 60, median: 60, min: 60, max: 60 });
    assert.equal(result.change, 15);
    assert.equal(result.change_pct, 25);
  });

  it('reports a decline as a negative change', () => {
    assert.equal(compare([50], [60]).change, -10);
  });

  it('has no change to report without a previous window', () => {
    const result = compare([70], []);

    assert.equal(result.previous, null);
    assert.equal(result.change, null);
    assert.equal(result.change_pct, null);
  });

  it('has no change to report when the current window is empty', () => {
    const result = compare([], [60]);

    assert.equal(result.current, null);
    assert.equal(result.change, null);
  });

  it('omits the percentage when the previous mean is zero', () => {
    const result = compare([5], [0]);

    assert.equal(result.change, 5);
    assert.equal(result.change_pct, null);
  });
});

describe('splitByDate', () => {
  const records = [
    { date: '2026-09-10', v: 1 },
    { date: '2026-09-01', v: 2 },
    { date: '2026-08-31', v: 3 },
    { date: '2026-08-15', v: 4 },
  ];

  it('puts records on or after the cutoff in the current window', () => {
    const { current } = splitByDate(records, '2026-09-01');
    assert.deepEqual(current.map((r) => r.v), [1, 2]);
  });

  it('puts earlier records in the previous window', () => {
    const { previous } = splitByDate(records, '2026-09-01');
    assert.deepEqual(previous.map((r) => r.v), [3, 4]);
  });

  it('drops records older than the previous window starts', () => {
    // The chronic baseline needs 28 days of cycles, but the comparison window
    // is only as long as it was asked to be — without a lower bound the
    // "previous week" would quietly become the previous three weeks.
    const { previous } = splitByDate(records, '2026-09-01', '2026-08-20');
    assert.deepEqual(previous.map((r) => r.v), [3]);
  });

  it('drops records WHOOP could not date', () => {
    // A record with no local date can't be placed in either window, and
    // guessing would silently skew the baseline.
    const { current, previous } = splitByDate(
      [...records, { v: 5 } as { date?: string; v: number }],
      '2026-09-01',
    );
    assert.equal(current.length + previous.length, 4);
  });
});

describe('scoredValues', () => {
  it('keeps only records WHOOP has finished scoring', () => {
    // A PENDING_SCORE record carries no score yet, and an UNSCORABLE one
    // never will; averaging them in would drag the baseline around.
    const records = [
      { score_state: 'SCORED', recovery_score_pct: 60 },
      { score_state: 'PENDING_SCORE', recovery_score_pct: 0 },
      { score_state: 'UNSCORABLE', recovery_score_pct: 0 },
    ];

    assert.deepEqual(
      scoredValues(records, (r) => r.recovery_score_pct),
      [60],
    );
  });

  it('drops records missing the metric asked for', () => {
    const records = [
      { score_state: 'SCORED', spo2_pct: 97 },
      { score_state: 'SCORED' } as { score_state: string; spo2_pct?: number },
    ];

    assert.deepEqual(scoredValues(records, (r) => r.spo2_pct), [97]);
  });

  it('honours an extra exclusion, such as a calibrating recovery', () => {
    // WHOOP reports a recovery score while still calibrating a new strap,
    // but it is not comparable with the rest.
    const records = [
      { score_state: 'SCORED', calibrating: true, recovery_score_pct: 33 },
      { score_state: 'SCORED', calibrating: false, recovery_score_pct: 66 },
    ];

    assert.deepEqual(
      scoredValues(records, (r) => r.recovery_score_pct, (r) => !r.calibrating),
      [66],
    );
  });
});

describe('acuteChronicRatio', () => {
  it('divides recent load by the longer-term baseline', () => {
    // 12 of strain this week against a baseline of 10 = ramping up 20%.
    assert.equal(acuteChronicRatio(12, 10), 1.2);
  });

  it('reads below 1 when training has eased off', () => {
    assert.equal(acuteChronicRatio(8, 10), 0.8);
  });

  it('has no ratio without a baseline', () => {
    assert.equal(acuteChronicRatio(12, null), null);
    assert.equal(acuteChronicRatio(null, 10), null);
  });

  it('has no ratio when the baseline is zero', () => {
    assert.equal(acuteChronicRatio(12, 0), null);
  });
});

describe('buildTrends', () => {
  const scored = (date: string, extra: Record<string, unknown>) => ({
    date,
    score_state: 'SCORED',
    ...extra,
  });

  const input = {
    windowDays: 7,
    cutoff: '2026-09-08',
    previousStart: '2026-09-01',
    acuteStart: '2026-09-04',
    chronicStart: '2026-08-14',
    recoveries: [
      scored('2026-09-10', { recovery_score_pct: 70, hrv_rmssd_ms: 90, resting_heart_rate_bpm: 50 }),
      scored('2026-09-09', { recovery_score_pct: 80, hrv_rmssd_ms: 100, resting_heart_rate_bpm: 48 }),
      scored('2026-09-02', { recovery_score_pct: 50, hrv_rmssd_ms: 70, resting_heart_rate_bpm: 55 }),
    ],
    sleeps: [
      scored('2026-09-10', { sleep_performance_pct: 90, asleep_min: 420, is_nap: false }),
      scored('2026-09-10', { sleep_performance_pct: 10, asleep_min: 25, is_nap: true }),
      scored('2026-09-02', { sleep_performance_pct: 70, asleep_min: 360, is_nap: false }),
    ],
    cycles: [
      scored('2026-09-10', { day_strain: 14, calories_kcal: 2600 }),
      scored('2026-09-09', { day_strain: 10, calories_kcal: 2400 }),
      scored('2026-09-02', { day_strain: 8, calories_kcal: 2200 }),
      // Older than both the comparison window and the 28-day baseline.
      scored('2026-07-01', { day_strain: 2, calories_kcal: 1500 }),
    ],
  };

  it('compares recovery against the preceding window', () => {
    const trends = buildTrends(input);

    assert.equal(trends.recovery.recovery_score_pct.current?.mean, 75);
    assert.equal(trends.recovery.recovery_score_pct.previous?.mean, 50);
    assert.equal(trends.recovery.recovery_score_pct.change, 25);
  });

  it('reports HRV and resting heart rate alongside it', () => {
    const trends = buildTrends(input);

    assert.equal(trends.recovery.hrv_rmssd_ms.current?.mean, 95);
    assert.equal(trends.recovery.resting_heart_rate_bpm.current?.mean, 49);
  });

  it('leaves naps out of the sleep averages', () => {
    // A 25-minute nap is not a night's sleep; averaging it in would halve
    // the apparent sleep performance.
    const trends = buildTrends(input);

    assert.equal(trends.sleep.sleep_performance_pct.current?.n, 1);
    assert.equal(trends.sleep.sleep_performance_pct.current?.mean, 90);
    assert.equal(trends.sleep.asleep_min.current?.mean, 420);
  });

  it('leaves a day still in progress out of the strain averages', () => {
    // WHOOP scores the current cycle as it goes, so at midday it holds a
    // partial strain. Counting it as a full day drags the mean down and
    // makes the load ratio read low every morning.
    const trends = buildTrends({
      ...input,
      cycles: [
        { ...scored('2026-09-10', { day_strain: 1.7, calories_kcal: 400 }), in_progress: true },
        scored('2026-09-09', { day_strain: 10, calories_kcal: 2400 }),
      ],
    });

    assert.equal(trends.strain.day_strain.current?.n, 1);
    assert.equal(trends.strain.day_strain.current?.mean, 10);
    assert.equal(trends.strain.calories_kcal.current?.mean, 2400);
  });

  it('leaves a day still in progress out of the training load too', () => {
    const trends = buildTrends({
      ...input,
      cycles: [
        { ...scored('2026-09-10', { day_strain: 1.7, calories_kcal: 400 }), in_progress: true },
        scored('2026-09-09', { day_strain: 10, calories_kcal: 2400 }),
        scored('2026-09-02', { day_strain: 8, calories_kcal: 2200 }),
      ],
    });

    assert.equal(trends.training_load.acute_mean, 10);
    assert.equal(trends.training_load.chronic_mean, 9);
    assert.equal(trends.training_load.ratio, 1.11);
  });

  it('reports day strain for the window', () => {
    const trends = buildTrends(input);

    assert.equal(trends.strain.day_strain.current?.mean, 12);
    assert.equal(trends.strain.day_strain.previous?.mean, 8);
  });

  it('measures training load as 7 days against 28, whatever the window', () => {
    // The textbook acute:chronic workload ratio. Acute = 14 and 10 (mean 12),
    // chronic = those plus the 09-02 cycle (mean 10.7); the July cycle is
    // outside the 28-day baseline and must not drag it down.
    const trends = buildTrends(input);

    assert.equal(trends.training_load.acute_days, 7);
    assert.equal(trends.training_load.chronic_days, 28);
    assert.equal(trends.training_load.acute_mean, 12);
    assert.equal(trends.training_load.chronic_mean, 10.7);
    assert.equal(trends.training_load.ratio, 1.12);
  });

  it('keeps the comparison window from swallowing the baseline fetch', () => {
    // Cycles are fetched over 28 days so the ratio has a baseline; the
    // "previous week" must still be one week.
    const trends = buildTrends(input);

    assert.equal(trends.strain.day_strain.previous?.n, 1);
  });

  it('echoes the window it was asked for', () => {
    const trends = buildTrends(input);

    assert.equal(trends.window_days, 7);
    assert.equal(trends.window_start, '2026-09-08');
  });

  it('reports nulls rather than zeros when nothing was recorded', () => {
    const trends = buildTrends({
      windowDays: 7,
      cutoff: '2026-09-08',
      previousStart: '2026-09-01',
      acuteStart: '2026-09-04',
      chronicStart: '2026-08-14',
      recoveries: [],
      sleeps: [],
      cycles: [],
    });

    assert.equal(trends.recovery.recovery_score_pct.current, null);
    assert.equal(trends.recovery.recovery_score_pct.change, null);
    assert.equal(trends.training_load.ratio, null);
  });
});

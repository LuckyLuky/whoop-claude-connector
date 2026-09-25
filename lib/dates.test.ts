import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, resolveRange, todayIn } from './dates.ts';

/**
 * These are the windows WHOOP is actually asked for. Getting them wrong is
 * quiet: the tool still answers, just with the wrong day's sleep or a strain
 * score shifted by an hour of DST. Every expectation below is a literal UTC
 * instant rather than something recomputed with the code under test.
 */

const PRAGUE = 'Europe/Prague';

function hoursBetween(range: { start: string; end: string }): number {
  return (
    (new Date(range.end).getTime() - new Date(range.start).getTime()) / 3_600_000
  );
}

describe('dayRange', () => {
  it('covers a winter day in Prague (UTC+1)', () => {
    assert.deepEqual(dayRange('2026-01-15', PRAGUE), {
      start: '2026-01-14T23:00:00.000Z',
      end: '2026-01-15T23:00:00.000Z',
    });
  });

  it('covers a summer day in Prague (UTC+2)', () => {
    assert.deepEqual(dayRange('2026-07-15', PRAGUE), {
      start: '2026-07-14T22:00:00.000Z',
      end: '2026-07-15T22:00:00.000Z',
    });
  });

  it('is 23 hours long on the spring-forward day', () => {
    // 2026-03-29: Prague clocks jump 02:00 CET -> 03:00 CEST.
    const range = dayRange('2026-03-29', PRAGUE);
    assert.deepEqual(range, {
      start: '2026-03-28T23:00:00.000Z',
      end: '2026-03-29T22:00:00.000Z',
    });
    assert.equal(hoursBetween(range), 23);
  });

  it('is 25 hours long on the fall-back day', () => {
    // 2026-10-25: Prague clocks fall 03:00 CEST -> 02:00 CET.
    const range = dayRange('2026-10-25', PRAGUE);
    assert.deepEqual(range, {
      start: '2026-10-24T22:00:00.000Z',
      end: '2026-10-25T23:00:00.000Z',
    });
    assert.equal(hoursBetween(range), 25);
  });

  /**
   * Far-east zones are where a naive single-pass offset lookup breaks: UTC
   * midnight and local midnight sit on opposite sides of the transition, so
   * the offset has to be sampled at an instant already near the answer.
   * A one-pass implementation returns 12:00Z here — 01:00 local, not midnight.
   */
  it('is 25 hours long when DST ends in Auckland (UTC+13 -> +12)', () => {
    const range = dayRange('2026-04-05', 'Pacific/Auckland');
    assert.deepEqual(range, {
      start: '2026-04-04T11:00:00.000Z',
      end: '2026-04-05T12:00:00.000Z',
    });
    assert.equal(hoursBetween(range), 25);
  });

  it('is 23 hours long when DST starts in Auckland (UTC+12 -> +13)', () => {
    const range = dayRange('2026-09-27', 'Pacific/Auckland');
    assert.deepEqual(range, {
      start: '2026-09-26T12:00:00.000Z',
      end: '2026-09-27T11:00:00.000Z',
    });
    assert.equal(hoursBetween(range), 23);
  });

  it('handles a half-hour offset (Asia/Kolkata, UTC+5:30)', () => {
    assert.deepEqual(dayRange('2026-06-15', 'Asia/Kolkata'), {
      start: '2026-06-14T18:30:00.000Z',
      end: '2026-06-15T18:30:00.000Z',
    });
  });

  it('handles a quarter-hour offset (Pacific/Chatham, UTC+12:45)', () => {
    assert.deepEqual(dayRange('2026-06-15', 'Pacific/Chatham'), {
      start: '2026-06-14T11:15:00.000Z',
      end: '2026-06-15T11:15:00.000Z',
    });
  });

  it('handles a negative offset (America/Los_Angeles)', () => {
    assert.deepEqual(dayRange('2026-01-15', 'America/Los_Angeles'), {
      start: '2026-01-15T08:00:00.000Z',
      end: '2026-01-16T08:00:00.000Z',
    });
  });

  it('rolls over a month boundary', () => {
    assert.deepEqual(dayRange('2026-01-31', PRAGUE), {
      start: '2026-01-30T23:00:00.000Z',
      end: '2026-01-31T23:00:00.000Z',
    });
  });

  it('rolls over a year boundary', () => {
    assert.deepEqual(dayRange('2026-12-31', PRAGUE), {
      start: '2026-12-30T23:00:00.000Z',
      end: '2026-12-31T23:00:00.000Z',
    });
  });

  it('handles a leap day', () => {
    assert.deepEqual(dayRange('2028-02-29', PRAGUE), {
      start: '2028-02-28T23:00:00.000Z',
      end: '2028-02-29T23:00:00.000Z',
    });
  });

  it('is exact in UTC', () => {
    assert.deepEqual(dayRange('2026-05-04', 'UTC'), {
      start: '2026-05-04T00:00:00.000Z',
      end: '2026-05-05T00:00:00.000Z',
    });
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    for (const bad of ['15-01-2026', '2026-1-5', 'yesterday', '', '2026-01-15T00:00:00Z']) {
      assert.throws(() => dayRange(bad, PRAGUE), /Expected YYYY-MM-DD/);
    }
  });

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(dayRange(' 2026-01-15 ', PRAGUE), dayRange('2026-01-15', PRAGUE));
  });
});

describe('todayIn', () => {
  it('reads the local date, not the UTC one', () => {
    // 23:30 UTC is already the next day in Prague, and still the previous
    // afternoon in Los Angeles.
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-14T23:30:00Z') });
    try {
      assert.equal(todayIn(PRAGUE), '2026-01-15');
      assert.equal(todayIn('UTC'), '2026-01-14');
      assert.equal(todayIn('America/Los_Angeles'), '2026-01-14');
    } finally {
      mock.timers.reset();
    }
  });
});

describe('resolveRange', () => {
  const NOW = new Date('2026-09-14T12:00:00Z');

  function withFrozenClock(run: () => void): void {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    try {
      run();
    } finally {
      mock.timers.reset();
    }
  }

  it('prefers explicit start/end over everything else', () => {
    const range = resolveRange(
      { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z', date: '2026-01-01', days: 30 },
      PRAGUE,
    );
    assert.deepEqual(range, {
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
    });
  });

  it('defaults a missing end to now', () => {
    withFrozenClock(() => {
      const range = resolveRange({ start: '2026-09-01T00:00:00Z' }, PRAGUE);
      assert.equal(range.end, NOW.toISOString());
    });
  });

  it('defaults a missing start to seven days before the end', () => {
    const range = resolveRange({ end: '2026-09-08T00:00:00Z' }, PRAGUE);
    assert.equal(range.start, '2026-09-01T00:00:00.000Z');
  });

  it('prefers date over days', () => {
    assert.deepEqual(
      resolveRange({ date: '2026-07-15', days: 30 }, PRAGUE),
      dayRange('2026-07-15', PRAGUE),
    );
  });

  it('looks back seven days when given nothing', () => {
    withFrozenClock(() => {
      const range = resolveRange({}, PRAGUE);
      assert.equal(range.end, NOW.toISOString());
      assert.equal(range.start, '2026-09-07T12:00:00.000Z');
    });
  });

  it('clamps days to the 1-60 range', () => {
    withFrozenClock(() => {
      assert.equal(resolveRange({ days: 1000 }, PRAGUE).start, '2026-07-16T12:00:00.000Z');
      assert.equal(resolveRange({ days: 0 }, PRAGUE).start, '2026-09-13T12:00:00.000Z');
      assert.equal(resolveRange({ days: -5 }, PRAGUE).start, '2026-09-13T12:00:00.000Z');
    });
  });

  it('rejects unparseable start/end', () => {
    assert.throws(
      () => resolveRange({ start: 'last tuesday' }, PRAGUE),
      /Invalid start\/end/,
    );
    assert.throws(
      () => resolveRange({ end: 'not-a-date' }, PRAGUE),
      /Invalid start\/end/,
    );
  });

  it('rejects a malformed date the same way dayRange does', () => {
    assert.throws(() => resolveRange({ date: '2026-9-1' }, PRAGUE), /Expected YYYY-MM-DD/);
  });
});

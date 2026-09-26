import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecovery, type WhoopRecovery } from './normalize.ts';

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

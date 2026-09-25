import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenService, WhoopGrantInvalidError } from './tokens.ts';
import { WhoopOAuthError, type WhoopTokenResponse } from './oauth.ts';
import type { GrantRecord, GrantStore, RefreshedTokens } from './grant-store.ts';

/**
 * WHOOP rotates the refresh token on every refresh, so the failure modes here
 * are the expensive kind: a grant that dies silently and only surfaces hours
 * later as "reconnect the connector".
 *
 * The store is faked, but faithfully: acquireLease is the one operation whose
 * contract the policy depends on, and the fake enforces it the way the
 * conditional UPDATE in grant-store.ts does — one winner, and a lapsed lease
 * is free to take.
 */

const GRANT_ID = 'grant-1';
const HOUR_MS = 3_600_000;

interface StoredRow extends GrantRecord {
  leaseUntil: string | null;
}

interface MemoryStore extends GrantStore {
  row(): StoredRow | undefined;
  setLease(until: string | null): void;
  calls: { acquire: number; release: number; storeRefreshed: number; delete: number };
}

function createMemoryStore(overrides: Partial<GrantRecord> = {}): MemoryStore {
  const rows = new Map<string, StoredRow>();
  rows.set(GRANT_ID, {
    id: GRANT_ID,
    whoopUserId: '12345678',
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    scope: 'offline read:recovery',
    leaseUntil: null,
    ...overrides,
  });

  const calls = { acquire: 0, release: 0, storeRefreshed: 0, delete: 0 };

  return {
    calls,
    row: () => rows.get(GRANT_ID),
    setLease(until) {
      const row = rows.get(GRANT_ID);
      if (row) row.leaseUntil = until;
    },
    async load(id) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async save(grant) {
      rows.set(GRANT_ID, { ...grant, id: GRANT_ID, leaseUntil: null });
      return GRANT_ID;
    },
    async acquireLease(id, until, now) {
      calls.acquire += 1;
      const row = rows.get(id);
      if (!row) return false;
      // Mirrors `refresh_lease_until is null or refresh_lease_until < now`.
      const free =
        row.leaseUntil === null ||
        new Date(row.leaseUntil).getTime() < new Date(now).getTime();
      if (!free) return false;
      row.leaseUntil = until;
      return true;
    },
    async releaseLease(id) {
      calls.release += 1;
      const row = rows.get(id);
      if (row) row.leaseUntil = null;
    },
    async storeRefreshed(id, tokens: RefreshedTokens) {
      calls.storeRefreshed += 1;
      const row = rows.get(id);
      if (!row) throw new Error('no such grant');
      row.accessToken = tokens.accessToken;
      row.refreshToken = tokens.refreshToken;
      row.expiresAt = tokens.expiresAt;
      row.scope = tokens.scope;
      row.leaseUntil = null;
    },
    async delete(id) {
      calls.delete += 1;
      rows.delete(id);
    },
  };
}

function whoopResponse(over: Partial<WhoopTokenResponse> = {}): WhoopTokenResponse {
  return {
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    expires_in: 3600,
    token_type: 'bearer',
    scope: 'offline read:recovery',
    ...over,
  };
}

/** Records every refresh call so double-refresh regressions are visible. */
function recordingRefresh(
  impl: (refreshToken: string) => Promise<WhoopTokenResponse>,
) {
  const seen: string[] = [];
  const fn = async (refreshToken: string) => {
    seen.push(refreshToken);
    return impl(refreshToken);
  };
  return Object.assign(fn, { seen });
}

const expired = { expiresAt: new Date(Date.now() - 60_000).toISOString() };

function serviceWith(store: MemoryStore, refresh: (rt: string) => Promise<WhoopTokenResponse>) {
  // Short waits keep the concurrency tests quick.
  return createTokenService({ store, refresh, leasePollMs: 2, leaseWaitMs: 200 });
}

describe('getValidAccessToken', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  it('returns the stored token without calling WHOOP when it is fresh', async () => {
    const refresh = recordingRefresh(async () => whoopResponse());
    const token = await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(token, 'access-old');
    assert.deepEqual(refresh.seen, []);
    assert.equal(store.calls.acquire, 0);
  });

  it('refreshes an expired token and hands back the new one', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => whoopResponse());

    const token = await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(token, 'access-new');
    assert.deepEqual(refresh.seen, ['refresh-old']);
    assert.equal(store.row()?.accessToken, 'access-new');
  });

  it('refreshes inside the 120s skew window, before WHOOP would reject', async () => {
    store = createMemoryStore({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const refresh = recordingRefresh(async () => whoopResponse());

    await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.deepEqual(refresh.seen, ['refresh-old']);
  });

  it('persists the rotated refresh token', async () => {
    // The regression that kills a grant: keeping the refresh token WHOOP just
    // invalidated means the next refresh fails and the user must reconnect.
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => whoopResponse());

    await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(store.row()?.refreshToken, 'refresh-new');
  });

  it('keeps the previous refresh token when WHOOP omits one', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () =>
      whoopResponse({ refresh_token: undefined }),
    );

    await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(store.row()?.refreshToken, 'refresh-old');
  });

  it('frees the lease after a successful refresh', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => whoopResponse());

    await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(store.row()?.leaseUntil, null);
  });

  it('refreshes a token WHOOP just rejected, even though it looks fresh', async () => {
    const refresh = recordingRefresh(async () => whoopResponse());

    const token = await serviceWith(store, refresh).getValidAccessToken(GRANT_ID, {
      rejectedToken: 'access-old',
    });

    assert.equal(token, 'access-new');
    assert.deepEqual(refresh.seen, ['refresh-old']);
  });

  it('uses another request\'s replacement instead of refreshing again', async () => {
    // Parallel tool calls both get a 401 on the same stale token; the second
    // must not burn a second refresh.
    store = createMemoryStore({ accessToken: 'access-newer' });
    const refresh = recordingRefresh(async () => whoopResponse());

    const token = await serviceWith(store, refresh).getValidAccessToken(GRANT_ID, {
      rejectedToken: 'access-old',
    });

    assert.equal(token, 'access-newer');
    assert.deepEqual(refresh.seen, []);
  });

  it('refreshes exactly once when several callers race', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return whoopResponse();
    });
    const service = serviceWith(store, refresh);

    const tokens = await Promise.all([
      service.getValidAccessToken(GRANT_ID),
      service.getValidAccessToken(GRANT_ID),
      service.getValidAccessToken(GRANT_ID),
    ]);

    assert.deepEqual(tokens, ['access-new', 'access-new', 'access-new']);
    assert.deepEqual(refresh.seen, ['refresh-old'], 'only the lease holder refreshes');
    assert.equal(store.calls.storeRefreshed, 1);
  });

  it('takes over a lease whose holder died', async () => {
    store = createMemoryStore(expired);
    store.setLease(new Date(Date.now() - 1000).toISOString());
    const refresh = recordingRefresh(async () => whoopResponse());

    const token = await serviceWith(store, refresh).getValidAccessToken(GRANT_ID);

    assert.equal(token, 'access-new');
  });

  it('gives up rather than hanging when a lease is held too long', async () => {
    store = createMemoryStore(expired);
    store.setLease(new Date(Date.now() + HOUR_MS).toISOString());
    const refresh = recordingRefresh(async () => whoopResponse());

    await assert.rejects(
      serviceWith(store, refresh).getValidAccessToken(GRANT_ID),
      /Timed out waiting for a concurrent WHOOP token refresh/,
    );
    assert.deepEqual(refresh.seen, []);
  });

  it('deletes the grant when WHOOP refuses the refresh token', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => {
      throw new WhoopOAuthError('refused', 400, 'invalid_grant');
    });

    await assert.rejects(
      serviceWith(store, refresh).getValidAccessToken(GRANT_ID),
      WhoopGrantInvalidError,
    );
    assert.equal(store.calls.delete, 1);
    assert.equal(store.row(), undefined);
  });

  it('keeps the grant when WHOOP is merely broken', async () => {
    // A 500 is not a verdict on the token. Deleting here would force a
    // needless reconnect for an outage that fixes itself.
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => {
      throw new WhoopOAuthError('upstream boom', 503, undefined);
    });

    await assert.rejects(
      serviceWith(store, refresh).getValidAccessToken(GRANT_ID),
      /upstream boom/,
    );
    assert.equal(store.calls.delete, 0);
    assert.equal(store.row()?.refreshToken, 'refresh-old');
  });

  it('keeps the grant when the refresh call never completes', async () => {
    store = createMemoryStore(expired);
    const refresh = recordingRefresh(async () => {
      throw new Error('The operation was aborted due to timeout');
    });

    await assert.rejects(
      serviceWith(store, refresh).getValidAccessToken(GRANT_ID),
      /aborted due to timeout/,
    );
    assert.equal(store.calls.delete, 0);
  });

  it('frees the lease after a failure, so the next attempt can refresh', async () => {
    store = createMemoryStore(expired);
    let attempt = 0;
    const refresh = recordingRefresh(async () => {
      attempt += 1;
      if (attempt === 1) throw new WhoopOAuthError('flaky', 503, undefined);
      return whoopResponse();
    });
    const service = serviceWith(store, refresh);

    await assert.rejects(service.getValidAccessToken(GRANT_ID), /flaky/);
    assert.equal(store.row()?.leaseUntil, null, 'lease released on failure');

    assert.equal(await service.getValidAccessToken(GRANT_ID), 'access-new');
  });

  it('reports a missing grant as invalid, not as a transient error', async () => {
    store = createMemoryStore();
    await store.delete(GRANT_ID);
    const refresh = recordingRefresh(async () => whoopResponse());

    await assert.rejects(
      serviceWith(store, refresh).getValidAccessToken(GRANT_ID),
      WhoopGrantInvalidError,
    );
  });
});

describe('saveWhoopGrant', () => {
  it('rejects a grant with no refresh token', async () => {
    const store = createMemoryStore();
    const service = serviceWith(store, async () => whoopResponse());

    // WHOOP only returns one when the `offline` scope was granted; without it
    // the connector would stop working an hour after each sign-in.
    await assert.rejects(
      service.saveWhoopGrant('12345678', whoopResponse({ refresh_token: undefined })),
      /offline/,
    );
  });

  it('stores the tokens with an absolute expiry', async () => {
    const store = createMemoryStore();
    const service = serviceWith(store, async () => whoopResponse());

    const before = Date.now();
    await service.saveWhoopGrant('87654321', whoopResponse({ expires_in: 3600 }));
    const row = store.row();

    assert.equal(row?.whoopUserId, '87654321');
    assert.equal(row?.accessToken, 'access-new');
    assert.equal(row?.refreshToken, 'refresh-new');
    const expiry = new Date(row!.expiresAt).getTime();
    assert.ok(
      expiry >= before + HOUR_MS && expiry <= Date.now() + HOUR_MS,
      'expiry is now + expires_in',
    );
  });
});

import {
  supabaseGrantStore,
  type GrantRecord,
  type GrantStore,
} from './grant-store.ts';
import {
  refreshWhoopTokens,
  WhoopOAuthError,
  type WhoopTokenResponse,
} from './oauth.ts';

/** Refresh this far ahead of expiry rather than waiting for a 401. */
const REFRESH_SKEW_SECONDS = 120;

/**
 * How long one request may hold the refresh lease. Longer than the WHOOP
 * token call's timeout, so a lease only lapses if its holder died mid-refresh.
 */
const REFRESH_LEASE_SECONDS = 30;
const LEASE_POLL_MS = 250;
const LEASE_WAIT_MS = 15_000;

/**
 * The WHOOP grant is gone for good: missing, or its refresh token was refused.
 * Only a fresh sign-in fixes this, so the MCP route answers it with a 401.
 * Anything else thrown from here (network, WHOOP 5xx, database) is transient.
 */
export class WhoopGrantInvalidError extends Error {
  constructor(message = 'WHOOP access expired or was revoked. Reconnect the WHOOP connector.') {
    super(message);
    this.name = 'WhoopGrantInvalidError';
  }
}

export type WhoopGrant = GrantRecord;

export interface TokenServiceOptions {
  store?: GrantStore;
  refresh?: (refreshToken: string) => Promise<WhoopTokenResponse>;
  leasePollMs?: number;
  leaseWaitMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function expiresAt(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Refresh policy for the WHOOP grant.
 *
 * Injectable so the lease and rotation behaviour can be tested without a
 * database or a WHOOP account; production uses the defaults below.
 */
export function createTokenService(options: TokenServiceOptions = {}) {
  const store = options.store ?? supabaseGrantStore;
  const refresh = options.refresh ?? refreshWhoopTokens;
  const leasePollMs = options.leasePollMs ?? LEASE_POLL_MS;
  const leaseWaitMs = options.leaseWaitMs ?? LEASE_WAIT_MS;

  /** Fresh, and not the token WHOOP just refused. */
  function isUsable(grant: GrantRecord, rejectedToken: string | undefined): boolean {
    if (grant.accessToken === rejectedToken) return false;
    return (
      new Date(grant.expiresAt).getTime() - REFRESH_SKEW_SECONDS * 1000 > Date.now()
    );
  }

  /**
   * Stores a freshly granted WHOOP token set. Keyed on the WHOOP user id, so
   * re-authorizing the same account replaces the existing grant rather than
   * accumulating dead rows.
   */
  async function saveWhoopGrant(
    whoopUserId: string,
    tokens: WhoopTokenResponse,
  ): Promise<string> {
    if (!tokens.refresh_token) {
      throw new Error(
        'WHOOP did not return a refresh token. Confirm the `offline` scope is requested and enabled on the app.',
      );
    }

    return store.save({
      whoopUserId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: expiresAt(tokens.expires_in),
      scope: tokens.scope ?? null,
    });
  }

  async function refreshUnderLease(
    whoopTokenId: string,
    rejectedToken: string | undefined,
  ): Promise<string> {
    try {
      // Re-read: another request may have finished refreshing between our
      // first read and taking the lease.
      const grant = await store.load(whoopTokenId);
      if (!grant) throw new WhoopGrantInvalidError();
      if (isUsable(grant, rejectedToken)) {
        await store.releaseLease(whoopTokenId);
        return grant.accessToken;
      }

      let refreshed: WhoopTokenResponse;
      try {
        refreshed = await refresh(grant.refreshToken);
      } catch (error) {
        // Only WHOOP's explicit verdict on the token counts. A timeout or 5xx
        // must not destroy a grant that may still be perfectly good.
        if (error instanceof WhoopOAuthError && error.code === 'invalid_grant') {
          // Cascades to the bearer tokens Claude holds, so its next request
          // gets a 401, its refresh gets invalid_grant, and it reconnects.
          await store.delete(whoopTokenId);
          throw new WhoopGrantInvalidError();
        }
        throw error;
      }

      await store.storeRefreshed(whoopTokenId, {
        accessToken: refreshed.access_token,
        // WHOOP rotates the refresh token on every use; keep the newest one.
        refreshToken: refreshed.refresh_token ?? grant.refreshToken,
        expiresAt: expiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? grant.scope,
      });

      return refreshed.access_token;
    } catch (error) {
      await store.releaseLease(whoopTokenId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Returns a WHOOP access token that is valid right now, refreshing it first
   * if it is expired or about to be, or if WHOOP just refused `rejectedToken`.
   *
   * Only the holder of the refresh lease calls WHOOP; concurrent callers wait
   * and reuse the token it stores. WHOOP rotates refresh tokens, so two
   * parallel refreshes would leave one request (or the stored grant) holding a
   * dead token.
   */
  async function getValidAccessToken(
    whoopTokenId: string,
    callOptions: { rejectedToken?: string } = {},
  ): Promise<string> {
    const deadline = Date.now() + leaseWaitMs;

    for (;;) {
      const grant = await store.load(whoopTokenId);
      if (!grant) throw new WhoopGrantInvalidError();
      if (isUsable(grant, callOptions.rejectedToken)) return grant.accessToken;

      const now = new Date();
      const taken = await store.acquireLease(
        whoopTokenId,
        new Date(now.getTime() + REFRESH_LEASE_SECONDS * 1000).toISOString(),
        now.toISOString(),
      );
      if (taken) {
        return refreshUnderLease(whoopTokenId, callOptions.rejectedToken);
      }

      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for a concurrent WHOOP token refresh.');
      }
      await sleep(leasePollMs);
    }
  }

  async function deleteWhoopGrant(whoopTokenId: string): Promise<void> {
    await store.delete(whoopTokenId);
  }

  return { getValidAccessToken, saveWhoopGrant, deleteWhoopGrant };
}

const defaultService = createTokenService();

export const getValidAccessToken = defaultService.getValidAccessToken;
export const saveWhoopGrant = defaultService.saveWhoopGrant;
export const deleteWhoopGrant = defaultService.deleteWhoopGrant;

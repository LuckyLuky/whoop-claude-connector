import { decrypt, encrypt } from '../crypto';
import { db } from '../supabase';
import {
  refreshWhoopTokens,
  WhoopOAuthError,
  type WhoopTokenResponse,
} from './oauth';

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

export interface WhoopGrant {
  id: string;
  whoop_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
}

interface WhoopGrantRow {
  id: string;
  whoop_user_id: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scope: string | null;
}

function decode(row: WhoopGrantRow): WhoopGrant {
  return {
    id: row.id,
    whoop_user_id: row.whoop_user_id,
    access_token: decrypt(row.access_token_enc),
    refresh_token: decrypt(row.refresh_token_enc),
    expires_at: row.expires_at,
    scope: row.scope,
  };
}

function expiresAt(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Stores a freshly granted WHOOP token set. Keyed on the WHOOP user id, so
 * re-authorizing the same account replaces the existing grant rather than
 * accumulating dead rows.
 */
export async function saveWhoopGrant(
  whoopUserId: string,
  tokens: WhoopTokenResponse,
): Promise<string> {
  if (!tokens.refresh_token) {
    throw new Error(
      'WHOOP did not return a refresh token. Confirm the `offline` scope is requested and enabled on the app.',
    );
  }

  const { data, error } = await db()
    .from('whoop_tokens')
    .upsert(
      {
        whoop_user_id: whoopUserId,
        access_token_enc: encrypt(tokens.access_token),
        refresh_token_enc: encrypt(tokens.refresh_token),
        expires_at: expiresAt(tokens.expires_in),
        scope: tokens.scope ?? null,
        refresh_lease_until: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'whoop_user_id' },
    )
    .select('id')
    .single();

  if (error) throw new Error(`Failed to persist WHOOP grant: ${error.message}`);
  return data.id as string;
}

async function loadGrant(id: string): Promise<WhoopGrant | null> {
  const { data, error } = await db()
    .from('whoop_tokens')
    .select('id, whoop_user_id, access_token_enc, refresh_token_enc, expires_at, scope')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(`Failed to load WHOOP grant: ${error.message}`);
  return data ? decode(data as WhoopGrantRow) : null;
}

/** Fresh, and not the token WHOOP just refused. */
function isUsable(grant: WhoopGrant, rejectedToken: string | undefined): boolean {
  if (grant.access_token === rejectedToken) return false;
  return (
    new Date(grant.expires_at).getTime() - REFRESH_SKEW_SECONDS * 1000 >
    Date.now()
  );
}

/**
 * Takes the refresh lease if nobody holds it or the holder's lease lapsed.
 * A single conditional UPDATE, so at most one concurrent caller gets a row back.
 */
async function acquireLease(id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await db()
    .from('whoop_tokens')
    .update({ refresh_lease_until: expiresAt(REFRESH_LEASE_SECONDS) })
    .eq('id', id)
    .or(`refresh_lease_until.is.null,refresh_lease_until.lt."${now}"`)
    .select('id');

  if (error) throw new Error(`Failed to take WHOOP refresh lease: ${error.message}`);
  return data.length > 0;
}

async function releaseLease(id: string): Promise<void> {
  await db()
    .from('whoop_tokens')
    .update({ refresh_lease_until: null })
    .eq('id', id);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns a WHOOP access token that is valid right now, refreshing it first if
 * it is expired or about to be, or if WHOOP just refused `rejectedToken`.
 *
 * Only the holder of the refresh lease calls WHOOP; concurrent callers wait
 * and reuse the token it stores. WHOOP rotates refresh tokens, so two parallel
 * refreshes would leave one request (or the stored grant) with a dead token.
 */
export async function getValidAccessToken(
  whoopTokenId: string,
  options: { rejectedToken?: string } = {},
): Promise<string> {
  const deadline = Date.now() + LEASE_WAIT_MS;

  for (;;) {
    const grant = await loadGrant(whoopTokenId);
    if (!grant) throw new WhoopGrantInvalidError();
    if (isUsable(grant, options.rejectedToken)) return grant.access_token;

    if (await acquireLease(whoopTokenId)) {
      return refreshUnderLease(whoopTokenId, options.rejectedToken);
    }

    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a concurrent WHOOP token refresh.');
    }
    await sleep(LEASE_POLL_MS);
  }
}

async function refreshUnderLease(
  whoopTokenId: string,
  rejectedToken: string | undefined,
): Promise<string> {
  try {
    // Re-read: another request may have finished refreshing between our first
    // read and taking the lease.
    const grant = await loadGrant(whoopTokenId);
    if (!grant) throw new WhoopGrantInvalidError();
    if (isUsable(grant, rejectedToken)) {
      await releaseLease(whoopTokenId);
      return grant.access_token;
    }

    let refreshed: WhoopTokenResponse;
    try {
      refreshed = await refreshWhoopTokens(grant.refresh_token);
    } catch (error) {
      // Only WHOOP's explicit verdict on the token counts. A timeout or 5xx
      // must not destroy a grant that may still be perfectly good.
      if (error instanceof WhoopOAuthError && error.code === 'invalid_grant') {
        // Cascades to the bearer tokens Claude holds, so its next request gets
        // a 401, its refresh gets invalid_grant, and it asks to reconnect.
        await deleteWhoopGrant(whoopTokenId);
        throw new WhoopGrantInvalidError();
      }
      throw error;
    }

    const { error } = await db()
      .from('whoop_tokens')
      .update({
        access_token_enc: encrypt(refreshed.access_token),
        // WHOOP rotates the refresh token on every use; keep the newest one.
        refresh_token_enc: encrypt(refreshed.refresh_token ?? grant.refresh_token),
        expires_at: expiresAt(refreshed.expires_in),
        scope: refreshed.scope ?? grant.scope,
        refresh_lease_until: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', whoopTokenId);

    if (error) {
      throw new Error(`Failed to persist refreshed WHOOP token: ${error.message}`);
    }
    return refreshed.access_token;
  } catch (error) {
    await releaseLease(whoopTokenId).catch(() => undefined);
    throw error;
  }
}

export async function deleteWhoopGrant(whoopTokenId: string): Promise<void> {
  const { error } = await db().from('whoop_tokens').delete().eq('id', whoopTokenId);
  if (error) throw new Error(`Failed to delete WHOOP grant: ${error.message}`);
}

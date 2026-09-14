import { decrypt, encrypt } from '../crypto';
import { db } from '../supabase';
import { refreshWhoopTokens, type WhoopTokenResponse } from './oauth';

/** Refresh this far ahead of expiry rather than waiting for a 401. */
const REFRESH_SKEW_SECONDS = 120;

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
  const { data } = await db()
    .from('whoop_tokens')
    .select('id, whoop_user_id, access_token_enc, refresh_token_enc, expires_at, scope')
    .eq('id', id)
    .maybeSingle();

  return data ? decode(data as WhoopGrantRow) : null;
}

/**
 * Returns a WHOOP access token that is valid right now, refreshing it first if
 * it is expired or about to be. The rotated refresh token is persisted before
 * the new access token is handed out.
 */
export async function getValidAccessToken(
  whoopTokenId: string,
  options: { force?: boolean } = {},
): Promise<string> {
  const grant = await loadGrant(whoopTokenId);
  if (!grant) {
    throw new Error('WHOOP grant not found. The connector needs to be reconnected.');
  }

  const stillFresh =
    new Date(grant.expires_at).getTime() - REFRESH_SKEW_SECONDS * 1000 >
    Date.now();
  if (stillFresh && !options.force) return grant.access_token;

  const refreshed = await refreshWhoopTokens(grant.refresh_token);

  const { error } = await db()
    .from('whoop_tokens')
    .update({
      access_token_enc: encrypt(refreshed.access_token),
      // WHOOP rotates the refresh token on every use; keep the newest one.
      refresh_token_enc: encrypt(refreshed.refresh_token ?? grant.refresh_token),
      expires_at: expiresAt(refreshed.expires_in),
      scope: refreshed.scope ?? grant.scope,
      updated_at: new Date().toISOString(),
    })
    .eq('id', whoopTokenId);

  if (error) {
    throw new Error(`Failed to persist refreshed WHOOP token: ${error.message}`);
  }
  return refreshed.access_token;
}

export async function deleteWhoopGrant(whoopTokenId: string): Promise<void> {
  await db().from('whoop_tokens').delete().eq('id', whoopTokenId);
}

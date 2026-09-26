import type { SupabaseClient } from '@supabase/supabase-js';
import { hashToken, randomToken } from '../crypto.ts';
import { db } from '../supabase.ts';

/**
 * Persistence for the bridge authorization server.
 *
 * Three short-lived artefacts live here:
 *   1. pending authorizations — the leg between Claude's /authorize call and
 *      WHOOP's redirect back to /callback, keyed by the `state` we send WHOOP;
 *   2. authorization codes — issued by us, redeemed by Claude at /token;
 *   3. access + refresh tokens — issued by us, presented as bearers on /mcp.
 *
 * Bearer and refresh tokens are stored as SHA-256 digests only.
 */

export const AUTHORIZATION_CODE_TTL_SECONDS = 600; // 10 minutes
export const ACCESS_TOKEN_TTL_SECONDS = 3600; // 1 hour, matching WHOOP
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days

function expiry(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isExpired(timestamp: string): boolean {
  return new Date(timestamp).getTime() <= Date.now();
}

/**
 * Unwraps a single-row result, distinguishing "no such row" from "the query
 * did not run".
 *
 * Every caller here turns `null` into a refusal: an unknown bearer becomes a
 * 401, an unknown refresh token becomes `invalid_grant`. Letting a failed
 * query collapse into `null` would make a Supabase blip look like a revoked
 * grant, and Claude answers `invalid_grant` by discarding a refresh token that
 * was working. So a query error is thrown, and `/token` reports `server_error`.
 */
export function takeOne<T>(
  result: { data: unknown; error: { message: string } | null },
  what: string,
): T | null {
  if (result.error) {
    throw new Error(`Failed to read ${what}: ${result.error.message}`);
  }
  return (result.data ?? null) as T | null;
}

/* -------------------------------------------------------------------------- */
/* Pending authorizations                                                     */
/* -------------------------------------------------------------------------- */

export interface PendingAuthorization {
  state: string;
  client_id: string;
  client_redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
}

export async function createPendingAuthorization(input: {
  clientId: string;
  clientRedirectUri: string;
  clientState: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
  resource: string | null;
}): Promise<string> {
  // WHOOP requires the `state` it echoes back to be at least 8 characters.
  const state = randomToken(24);

  const { error } = await db().from('mcp_pending_authorizations').insert({
    state,
    client_id: input.clientId,
    client_redirect_uri: input.clientRedirectUri,
    client_state: input.clientState,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    expires_at: expiry(AUTHORIZATION_CODE_TTL_SECONDS),
  });
  if (error) throw new Error(`Failed to store pending authorization: ${error.message}`);

  return state;
}

export async function consumePendingAuthorization(
  state: string,
  client: SupabaseClient = db(),
): Promise<PendingAuthorization | null> {
  // Deleted and returned in one statement, so only the caller that actually
  // removed the row sees it. A replayed /callback finds nothing.
  const data = takeOne<PendingAuthorization>(
    await client
      .from('mcp_pending_authorizations')
      .delete()
      .eq('state', state)
      .select()
      .maybeSingle(),
    'pending authorization',
  );

  if (!data) return null;
  if (isExpired(data.expires_at)) return null;
  return data;
}

/* -------------------------------------------------------------------------- */
/* Authorization codes                                                        */
/* -------------------------------------------------------------------------- */

export interface AuthorizationCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  whoop_token_id: string;
  scope: string | null;
  expires_at: string;
}

export async function issueAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  whoopTokenId: string;
  scope: string | null;
}): Promise<string> {
  const code = randomToken(32);
  const { error } = await db().from('mcp_authorization_codes').insert({
    code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    whoop_token_id: input.whoopTokenId,
    scope: input.scope,
    expires_at: expiry(AUTHORIZATION_CODE_TTL_SECONDS),
  });
  if (error) throw new Error(`Failed to issue authorization code: ${error.message}`);
  return code;
}

/**
 * Single-use: the row is deleted on first read, expired or not.
 *
 * The delete is what returns the row, so of two requests redeeming the same
 * code exactly one is served. Reading first and deleting second left a window
 * in which both saw it.
 */
export async function consumeAuthorizationCode(
  code: string,
  client: SupabaseClient = db(),
): Promise<AuthorizationCode | null> {
  const data = takeOne<AuthorizationCode>(
    await client
      .from('mcp_authorization_codes')
      .delete()
      .eq('code', code)
      .select()
      .maybeSingle(),
    'authorization code',
  );

  if (!data) return null;
  if (isExpired(data.expires_at)) return null;
  return data;
}

/* -------------------------------------------------------------------------- */
/* Access + refresh tokens                                                    */
/* -------------------------------------------------------------------------- */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function issueTokens(
  input: {
    clientId: string;
    whoopTokenId: string;
    scope: string | null;
  },
  client: SupabaseClient = db(),
): Promise<IssuedTokens> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  const { error } = await client.from('mcp_access_tokens').insert({
    token_hash: hashToken(accessToken),
    refresh_token_hash: hashToken(refreshToken),
    client_id: input.clientId,
    whoop_token_id: input.whoopTokenId,
    scope: input.scope,
    expires_at: expiry(ACCESS_TOKEN_TTL_SECONDS),
    refresh_expires_at: expiry(REFRESH_TOKEN_TTL_SECONDS),
  });
  if (error) throw new Error(`Failed to issue tokens: ${error.message}`);

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export interface AccessTokenRecord {
  token_hash: string;
  client_id: string;
  whoop_token_id: string;
  scope: string | null;
  expires_at: string;
}

/** Returns null for unknown or expired bearer tokens. */
export async function lookupAccessToken(
  token: string,
  client: SupabaseClient = db(),
): Promise<AccessTokenRecord | null> {
  const data = takeOne<AccessTokenRecord>(
    await client
      .from('mcp_access_tokens')
      .select('token_hash, client_id, whoop_token_id, scope, expires_at')
      .eq('token_hash', hashToken(token))
      .maybeSingle(),
    'access token',
  );

  if (!data) return null;
  if (isExpired(data.expires_at)) return null;
  return data;
}

/** The columns rotation needs from the row it is replacing. */
interface RotationSource {
  token_hash: string;
  client_id: string;
  whoop_token_id: string;
  scope: string | null;
  refresh_expires_at: string;
}

/**
 * Rotates a refresh token, as OAuth 2.1 requires for public clients. The old
 * row is consumed by the statement that returns it, so of two requests
 * presenting the same refresh token exactly one is served.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  client: SupabaseClient = db(),
): Promise<{ tokens: IssuedTokens; clientId: string } | null> {
  const refreshHash = hashToken(refreshToken);
  const existing = takeOne<RotationSource>(
    await client
      .from('mcp_access_tokens')
      .select('token_hash, client_id, whoop_token_id, scope, refresh_expires_at')
      .eq('refresh_token_hash', refreshHash)
      .maybeSingle(),
    'refresh token',
  );

  if (!existing) return null;

  if (isExpired(existing.refresh_expires_at)) {
    await client
      .from('mcp_access_tokens')
      .delete()
      .eq('token_hash', existing.token_hash);
    return null;
  }

  // Issue first, then consume. The other order — delete, then issue — leaves
  // the grant with no tokens at all if issuing fails, and a reconnect is the
  // only way back from that. This way a failure costs nothing and a lost race
  // costs one discarded pair.
  const tokens = await issueTokens(
    {
      clientId: existing.client_id,
      whoopTokenId: existing.whoop_token_id,
      scope: existing.scope,
    },
    client,
  );

  const consumed = takeOne<{ token_hash: string }>(
    await client
      .from('mcp_access_tokens')
      .delete()
      .eq('refresh_token_hash', refreshHash)
      .select('token_hash')
      .maybeSingle(),
    'refresh token',
  );

  if (!consumed) {
    // Someone else rotated this token first. Their pair is the live one, so
    // drop ours rather than leaving two valid bearers behind.
    await client
      .from('mcp_access_tokens')
      .delete()
      .eq('token_hash', hashToken(tokens.accessToken));
    return null;
  }

  return { tokens, clientId: existing.client_id };
}

/** Drops every token bound to a WHOOP grant. Used when access is revoked. */
export async function revokeTokensForWhoopToken(
  whoopTokenId: string,
): Promise<void> {
  await db()
    .from('mcp_access_tokens')
    .delete()
    .eq('whoop_token_id', whoopTokenId);
}

import { hashToken, randomToken } from '../crypto';
import { db } from '../supabase';

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
): Promise<PendingAuthorization | null> {
  const { data } = await db()
    .from('mcp_pending_authorizations')
    .select('*')
    .eq('state', state)
    .maybeSingle();

  if (!data) return null;

  await db().from('mcp_pending_authorizations').delete().eq('state', state);

  if (isExpired(data.expires_at)) return null;
  return data as PendingAuthorization;
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

/** Single-use: the row is deleted on first read, expired or not. */
export async function consumeAuthorizationCode(
  code: string,
): Promise<AuthorizationCode | null> {
  const { data } = await db()
    .from('mcp_authorization_codes')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (!data) return null;
  await db().from('mcp_authorization_codes').delete().eq('code', code);

  if (isExpired(data.expires_at)) return null;
  return data as AuthorizationCode;
}

/* -------------------------------------------------------------------------- */
/* Access + refresh tokens                                                    */
/* -------------------------------------------------------------------------- */

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function issueTokens(input: {
  clientId: string;
  whoopTokenId: string;
  scope: string | null;
}): Promise<IssuedTokens> {
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  const { error } = await db().from('mcp_access_tokens').insert({
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
): Promise<AccessTokenRecord | null> {
  const { data } = await db()
    .from('mcp_access_tokens')
    .select('token_hash, client_id, whoop_token_id, scope, expires_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();

  if (!data) return null;
  if (isExpired(data.expires_at)) return null;
  return data as AccessTokenRecord;
}

/**
 * Rotates a refresh token, as OAuth 2.1 requires for public clients. The old
 * row is deleted in the same operation that issues the replacement.
 */
export async function rotateRefreshToken(
  refreshToken: string,
): Promise<{ tokens: IssuedTokens; clientId: string } | null> {
  const { data } = await db()
    .from('mcp_access_tokens')
    .select('token_hash, client_id, whoop_token_id, scope, refresh_expires_at')
    .eq('refresh_token_hash', hashToken(refreshToken))
    .maybeSingle();

  if (!data) return null;
  await db()
    .from('mcp_access_tokens')
    .delete()
    .eq('token_hash', data.token_hash);

  if (isExpired(data.refresh_expires_at)) return null;

  const tokens = await issueTokens({
    clientId: data.client_id,
    whoopTokenId: data.whoop_token_id,
    scope: data.scope,
  });
  return { tokens, clientId: data.client_id };
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

import { env, endpoints } from '../env';
import {
  WHOOP_AUTHORIZE_URL,
  WHOOP_SCOPE_STRING,
  WHOOP_TOKEN_URL,
} from './constants';

export interface WhoopTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

/** A non-2xx from WHOOP's token endpoint, with its RFC 6749 error code if any. */
export class WhoopOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'WhoopOAuthError';
  }
}

/** URL the user's browser is sent to in order to grant access to their WHOOP data. */
export function whoopAuthorizeUrl(state: string): string {
  const url = new URL(WHOOP_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.whoopClientId());
  url.searchParams.set('redirect_uri', endpoints().callback);
  url.searchParams.set('scope', WHOOP_SCOPE_STRING);
  url.searchParams.set('state', state);
  return url.toString();
}

async function postToken(body: URLSearchParams): Promise<WhoopTokenResponse> {
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // Must stay well under REFRESH_LEASE_SECONDS in tokens.ts.
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    let code: string | undefined;
    try {
      code = (JSON.parse(detail) as { error?: string }).error;
    } catch {
      // Not JSON; leave the code unknown.
    }
    throw new WhoopOAuthError(
      `WHOOP token request failed (${response.status}): ${detail.slice(0, 500)}`,
      response.status,
      code,
    );
  }
  return (await response.json()) as WhoopTokenResponse;
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<WhoopTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.whoopClientId(),
      client_secret: env.whoopClientSecret(),
      redirect_uri: endpoints().callback,
    }),
  );
}

/**
 * WHOOP rotates refresh tokens: the response carries a NEW refresh_token and
 * the one just used stops working. Callers must persist the replacement.
 */
export async function refreshWhoopTokens(
  refreshToken: string,
): Promise<WhoopTokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.whoopClientId(),
      client_secret: env.whoopClientSecret(),
      scope: 'offline',
    }),
  );
}

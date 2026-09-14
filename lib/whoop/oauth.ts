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
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `WHOOP token request failed (${response.status}): ${detail.slice(0, 500)}`,
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

import { verifyPkce } from '@/lib/oauth/pkce';
import {
  consumeAuthorizationCode,
  issueTokens,
  rotateRefreshToken,
} from '@/lib/oauth/store';
import { MCP_SCOPE } from '@/lib/oauth/metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 6749 error codes matter here: Claude looks for `invalid_grant`
 * specifically to decide that a refresh token is dead and a fresh sign-in is
 * needed. A custom code or a bare `invalid_request` leaves the connector stuck.
 */
function oauthError(
  error: string,
  description: string,
  status = 400,
): Response {
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

function tokenResponse(tokens: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}): Response {
  return Response.json(
    {
      access_token: tokens.accessToken,
      token_type: 'Bearer',
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: MCP_SCOPE,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleToken(request);
  } catch (error) {
    // Infrastructure failure, not a credential problem. This must NOT be
    // reported as `invalid_grant`: Claude reads that as "the refresh token is
    // dead" and throws away a perfectly good one, forcing a re-consent.
    return oauthError(
      'server_error',
      error instanceof Error ? error.message : 'Unexpected error.',
      500,
    );
  }
}

async function handleToken(request: Request): Promise<Response> {
  // Claude sends both the initial exchange and refreshes as form-urlencoded,
  // per RFC 6749 §4.1.3. JSON is accepted too, for hand-testing with curl.
  let form: URLSearchParams;
  const contentType = request.headers.get('content-type') ?? '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, string>;
      form = new URLSearchParams(body);
    } else {
      form = new URLSearchParams(await request.text());
    }
  } catch {
    return oauthError('invalid_request', 'Could not parse the request body.');
  }

  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = form.get('code');
    const codeVerifier = form.get('code_verifier');
    const redirectUri = form.get('redirect_uri');
    const clientId = form.get('client_id');

    if (!code || !codeVerifier) {
      return oauthError(
        'invalid_request',
        'code and code_verifier are required.',
      );
    }

    const record = await consumeAuthorizationCode(code);
    if (!record) {
      return oauthError(
        'invalid_grant',
        'Authorization code is unknown, expired, or already used.',
      );
    }

    if (clientId && clientId !== record.client_id) {
      return oauthError(
        'invalid_grant',
        'Authorization code was issued to a different client.',
      );
    }

    if (redirectUri && redirectUri !== record.redirect_uri) {
      return oauthError(
        'invalid_grant',
        'redirect_uri does not match the authorization request.',
      );
    }

    if (
      !verifyPkce(
        codeVerifier,
        record.code_challenge,
        record.code_challenge_method,
      )
    ) {
      return oauthError('invalid_grant', 'PKCE verification failed.');
    }

    const tokens = await issueTokens({
      clientId: record.client_id,
      whoopTokenId: record.whoop_token_id,
      scope: record.scope,
    });
    return tokenResponse(tokens);
  }

  if (grantType === 'refresh_token') {
    const refreshToken = form.get('refresh_token');
    if (!refreshToken) {
      return oauthError('invalid_request', 'refresh_token is required.');
    }

    // Rotation, as OAuth 2.1 requires for public clients: the replacement is
    // returned in the same response that invalidates the old token.
    const rotated = await rotateRefreshToken(refreshToken);
    if (!rotated) {
      return oauthError(
        'invalid_grant',
        'Refresh token is unknown, expired, or already rotated.',
      );
    }

    return tokenResponse(rotated.tokens);
  }

  return oauthError(
    'unsupported_grant_type',
    'Only authorization_code and refresh_token are supported.',
  );
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

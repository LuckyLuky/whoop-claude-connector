import {
  redirectUriAllowed,
  redirectUriTrusted,
  resolveClient,
} from '@/lib/oauth/clients';
import { errorPage } from '@/lib/html';
import { createPendingAuthorization } from '@/lib/oauth/store';
import { whoopAuthorizeUrl } from '@/lib/whoop/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return Response.redirect(url.toString(), 302);
}

/**
 * Front channel of the bridge.
 *
 * Claude sends the user here with its own PKCE challenge. We park that request,
 * then hand the browser to WHOOP's real consent screen using our confidential
 * client credentials. Claude never sees the WHOOP client secret, and WHOOP
 * never sees Claude's redirect URI.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    return await authorize(request);
  } catch (error) {
    // Misconfiguration or a Supabase outage. Render it rather than letting it
    // surface as an opaque framework 500.
    return errorPage(
      'Authorization failed',
      error instanceof Error ? error.message : 'Unexpected error.',
      500,
    );
  }
}

async function authorize(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const state = params.get('state');
  const responseType = params.get('response_type');
  const codeChallenge = params.get('code_challenge');
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'plain';

  if (!clientId || !redirectUri) {
    return errorPage(
      'Invalid authorization request',
      'Both client_id and redirect_uri are required.',
    );
  }

  const client = await resolveClient(clientId);
  if (!client) {
    return errorPage(
      'Unknown client',
      'This client_id is not registered and does not resolve to a valid client ID metadata document.',
    );
  }

  // Only redirect back to a URI the client itself declared — otherwise this
  // endpoint would be an open redirector.
  if (!redirectUriAllowed(redirectUri, client.redirectUris)) {
    return errorPage(
      'Invalid redirect URI',
      'The supplied redirect_uri is not registered for this client.',
    );
  }

  // A client may declare any redirect URI it likes; this personal connector
  // only hands codes to Claude. See redirectUriTrusted.
  if (!redirectUriTrusted(redirectUri)) {
    return errorPage(
      'Untrusted redirect URI',
      'This connector only completes sign-in for Claude.',
    );
  }

  if (responseType !== 'code') {
    return redirectWithError(
      redirectUri,
      'unsupported_response_type',
      'Only the authorization code flow is supported.',
      state,
    );
  }

  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return redirectWithError(
      redirectUri,
      'invalid_request',
      'PKCE with code_challenge_method=S256 is required.',
      state,
    );
  }

  const bridgeState = await createPendingAuthorization({
    clientId,
    clientRedirectUri: redirectUri,
    clientState: state,
    codeChallenge,
    codeChallengeMethod,
    scope: params.get('scope'),
    resource: params.get('resource'),
  });

  return Response.redirect(whoopAuthorizeUrl(bridgeState), 302);
}

import { env } from '@/lib/env';
import { errorPage as htmlErrorPage } from '@/lib/html';
import {
  consumePendingAuthorization,
  issueAuthorizationCode,
} from '@/lib/oauth/store';
import { exchangeCodeForTokens } from '@/lib/whoop/oauth';
import { saveWhoopGrant } from '@/lib/whoop/tokens';
import type { WhoopProfile } from '@/lib/whoop/normalize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The shared page, plus the line that tells the user what to do next. */
function errorPage(title: string, detail: string, status = 400): Response {
  return htmlErrorPage(
    title,
    detail,
    status,
    'You can close this window and try connecting again.',
  );
}

/**
 * Back channel of the bridge.
 *
 * WHOOP redirects here with its authorization code. We exchange it server-side
 * for WHOOP tokens, persist them encrypted, then mint our OWN authorization
 * code and hand that back to Claude — completing the flow Claude started.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const whoopError = params.get('error');
  const code = params.get('code');
  const state = params.get('state');

  if (!state) {
    return errorPage('Missing state', 'WHOOP did not return a state parameter.');
  }

  const pending = await consumePendingAuthorization(state);
  if (!pending) {
    return errorPage(
      'Authorization expired',
      'This authorization request is unknown or older than 10 minutes.',
    );
  }

  const clientRedirect = new URL(pending.client_redirect_uri);
  if (pending.client_state) {
    clientRedirect.searchParams.set('state', pending.client_state);
  }

  if (whoopError || !code) {
    clientRedirect.searchParams.set('error', whoopError ?? 'access_denied');
    clientRedirect.searchParams.set(
      'error_description',
      params.get('error_description') ?? 'WHOOP did not return an authorization code.',
    );
    return Response.redirect(clientRedirect.toString(), 302);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    // Identify the account so re-authorizing replaces the existing grant
    // instead of piling up rows.
    const profileResponse = await fetch(
      'https://api.prod.whoop.com/developer/v2/user/profile/basic',
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    if (!profileResponse.ok) {
      throw new Error(
        `Could not read WHOOP profile (${profileResponse.status}). Check the read:profile scope.`,
      );
    }
    const profile = (await profileResponse.json()) as WhoopProfile;
    const whoopUserId = String(profile.user_id);

    // Single-user connector: the WHOOP tokens of any other account are
    // discarded here, before anything is stored or a code is issued.
    const allowedUserId = env.allowedWhoopUserId();
    if (whoopUserId !== allowedUserId) {
      return errorPage(
        'WHOOP account not allowed',
        allowedUserId
          ? 'This connector is locked to a different WHOOP account.'
          : `ALLOWED_WHOOP_USER_ID is not set. If this is your account, set ALLOWED_WHOOP_USER_ID=${whoopUserId} in the deployment environment, redeploy, and connect again.`,
        403,
      );
    }

    const whoopTokenId = await saveWhoopGrant(whoopUserId, tokens);

    const authorizationCode = await issueAuthorizationCode({
      clientId: pending.client_id,
      redirectUri: pending.client_redirect_uri,
      codeChallenge: pending.code_challenge,
      codeChallengeMethod: pending.code_challenge_method,
      whoopTokenId,
      scope: pending.scope,
    });

    clientRedirect.searchParams.set('code', authorizationCode);
    return Response.redirect(clientRedirect.toString(), 302);
  } catch (error) {
    return errorPage(
      'Could not complete WHOOP sign-in',
      error instanceof Error ? error.message : 'Unexpected error.',
      500,
    );
  }
}

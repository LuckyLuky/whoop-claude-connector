import { randomToken } from '@/lib/crypto';
import { redirectUriTrusted } from '@/lib/oauth/clients';
import { db } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Claude prefers the Client ID Metadata Document path (see lib/oauth/clients.ts),
 * which needs no registration at all. This endpoint is the fallback for clients
 * that don't support CIMD — including older Claude surfaces and the MCP
 * Inspector.
 *
 * Registration is open, which is the norm for MCP servers: holding a client_id
 * grants nothing on its own. What makes that safe is the redirect URI
 * allowlist — codes only ever go back to Claude, never to a URI a stranger
 * registered.
 */
export async function POST(request: Request): Promise<Response> {
  let metadata: {
    redirect_uris?: string[];
    client_name?: string;
    token_endpoint_auth_method?: string;
  };

  try {
    // RFC 7591 §3.1 specifies application/json here — note this differs from
    // the token endpoint, which is form-urlencoded.
    metadata = await request.json();
  } catch {
    return Response.json(
      {
        error: 'invalid_client_metadata',
        error_description: 'Body must be JSON.',
      },
      { status: 400 },
    );
  }

  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return Response.json(
      {
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array.',
      },
      { status: 400 },
    );
  }

  const untrusted = redirectUris.filter(
    (uri) => typeof uri !== 'string' || !redirectUriTrusted(uri),
  );
  if (untrusted.length > 0) {
    return Response.json(
      {
        error: 'invalid_redirect_uri',
        error_description: `This connector only accepts Claude's redirect URIs. Rejected: ${untrusted.join(', ')}`,
      },
      { status: 400 },
    );
  }

  const clientId = randomToken(16);

  let error: { message: string } | null = null;
  try {
    ({ error } = await db().from('mcp_oauth_clients').insert({
      client_id: clientId,
      client_name: metadata.client_name ?? null,
      redirect_uris: redirectUris,
    }));
  } catch (thrown) {
    error = {
      message: thrown instanceof Error ? thrown.message : 'Unexpected error.',
    };
  }

  if (error) {
    return Response.json(
      {
        error: 'invalid_client_metadata',
        error_description: `Could not store client: ${error.message}`,
      },
      { status: 500 },
    );
  }

  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      client_name: metadata.client_name ?? undefined,
      // Public client: PKCE stands in for a client secret.
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    {
      status: 201,
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    },
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

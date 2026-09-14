import { authorizationServerMetadata } from '@/lib/oauth/metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Served at /.well-known/oauth-authorization-server (and the /mcp and
 * openid-configuration variants) via rewrites in next.config.ts.
 */
export async function GET(): Promise<Response> {
  return Response.json(authorizationServerMetadata(), {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

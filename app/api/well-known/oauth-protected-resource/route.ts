import { protectedResourceMetadata } from '@/lib/oauth/metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Served at /.well-known/oauth-protected-resource and
 * /.well-known/oauth-protected-resource/mcp via rewrites in next.config.ts.
 *
 * `resource` must match the MCP server URL exactly as the user types it into
 * Claude, path component included.
 */
export async function GET(): Promise<Response> {
  return Response.json(protectedResourceMetadata(), {
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

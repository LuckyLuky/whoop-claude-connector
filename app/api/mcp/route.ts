import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { endpoints } from '@/lib/env';
import { buildMcpServer } from '@/lib/mcp/server';
import { lookupAccessToken } from '@/lib/oauth/store';
import { MCP_SCOPE } from '@/lib/oauth/metadata';
import {
  getValidAccessToken,
  WhoopGrantInvalidError,
} from '@/lib/whoop/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every tool on this server touches the user's WHOOP account, so all of them
 * are protected. `initialize` and `tools/list` deliberately are not: Claude can
 * connect and inspect the server before anyone signs in, and the sign-in
 * prompt appears at the moment a tool is actually called.
 */
function callsProtectedTool(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'tools/call',
  );
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * The 401 handshake. This has to be a transport-level HTTP 401 with a
 * WWW-Authenticate header — a 200 wrapping a tool error would just be read by
 * the model as a failed tool call, and the user would never see a Connect
 * prompt. The `resource_metadata` pointer is what lets Claude discover the
 * authorization server without anything being hard-coded on its side.
 */
function unauthorized(): Response {
  const challenge = [
    'Bearer error="invalid_token"',
    'error_description="Sign in to WHOOP to use this tool"',
    `resource_metadata="${endpoints().protectedResourceMetadata}"`,
    `scope="${MCP_SCOPE}"`,
  ].join(', ');

  return withCors(
    new Response(
      JSON.stringify({
        error: 'invalid_token',
        error_description: 'Sign in to WHOOP to use this tool',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': challenge,
        },
      },
    ),
  );
}

/**
 * Infrastructure failure. Deliberately NOT a 401: a database outage is not an
 * expired token, and reporting it as one would push the user through a
 * pointless reconnect that cannot fix anything.
 */
function serverError(error: unknown): Response {
  console.error('[mcp]', error);
  return withCors(
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

async function handle(
  request: Request,
  parsedBody?: unknown,
): Promise<Response> {
  const token = extractBearer(request);

  let grant: Awaited<ReturnType<typeof lookupAccessToken>> = null;
  if (token) {
    try {
      grant = await lookupAccessToken(token);
    } catch (error) {
      return serverError(error);
    }
  }

  const protectedCall =
    parsedBody !== undefined && callsProtectedTool(parsedBody);

  if (protectedCall && !grant) {
    return unauthorized();
  }

  // A valid bearer is not enough: the WHOOP grant behind it may be dead. Find
  // out here, while a 401 is still possible — inside a tool handler it could
  // only become an error result, and Claude would never offer to reconnect.
  // This also refreshes a stale token once, before handlers run in parallel.
  if (protectedCall && grant) {
    try {
      await getValidAccessToken(grant.whoop_token_id);
    } catch (error) {
      if (error instanceof WhoopGrantInvalidError) return unauthorized();
      // Transient (WHOOP or database hiccup): not a reason to re-consent. The
      // tool handler retries and reports it as a tool error.
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session affinity, so this works on serverless functions
    // where consecutive requests land on different instances.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = buildMcpServer(grant?.whoop_token_id ?? '');

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(
      request,
      parsedBody === undefined ? undefined : { parsedBody },
    );
    return withCors(response);
  } catch (error) {
    return serverError(error);
  } finally {
    // enableJsonResponse buffers the whole reply before handleRequest resolves,
    // so tearing the server down here cannot truncate it.
    void server.close().catch(() => undefined);
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withCors(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );
  }

  return handle(request, body);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

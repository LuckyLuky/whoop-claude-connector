import { db } from '../supabase';

/**
 * Client identification for the bridge authorization server.
 *
 * Two mechanisms are supported, both of which Claude can use out of the box:
 *
 *  - Client ID Metadata Document (CIMD): `client_id` is an HTTPS URL that
 *    dereferences to the client's own OAuth metadata. No registration call,
 *    no rows in our database. This is what Claude prefers when we advertise
 *    `client_id_metadata_document_supported` alongside `"none"` auth.
 *  - Dynamic Client Registration (RFC 7591): the client POSTs to /register
 *    first and gets an opaque `client_id` back.
 */

export interface ResolvedClient {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  source: 'cimd' | 'dcr';
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function resolveCimd(clientId: string): Promise<ResolvedClient | null> {
  let response: Response;
  try {
    response = await fetch(clientId, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const doc = (await response.json()) as {
    client_id?: string;
    client_name?: string;
    redirect_uris?: string[];
  };

  // The document must be self-referential: it asserts its own identity, so the
  // only thing anchoring it is that it is served from the client_id URL itself.
  if (doc.client_id !== clientId) return null;
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) {
    return null;
  }

  return {
    clientId,
    redirectUris: doc.redirect_uris,
    clientName: doc.client_name,
    source: 'cimd',
  };
}

async function resolveRegistered(
  clientId: string,
): Promise<ResolvedClient | null> {
  const { data } = await db()
    .from('mcp_oauth_clients')
    .select('client_id, client_name, redirect_uris')
    .eq('client_id', clientId)
    .maybeSingle();

  if (!data) return null;
  return {
    clientId: data.client_id,
    redirectUris: (data.redirect_uris ?? []) as string[],
    clientName: data.client_name ?? undefined,
    source: 'dcr',
  };
}

export async function resolveClient(
  clientId: string,
): Promise<ResolvedClient | null> {
  if (isHttpsUrl(clientId)) {
    return resolveCimd(clientId);
  }
  return resolveRegistered(clientId);
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname === '::1'
  );
}

/**
 * Redirect URI comparison.
 *
 * Exact match, except for loopback addresses: native clients (Claude Code)
 * bind an ephemeral port at runtime, so the port is ignored per RFC 8252 §7.3.
 * The spec only requires this for the IP-literal form, but Claude Code declares
 * `http://localhost/callback` in its metadata, so the same relaxation is
 * applied to `localhost`.
 */
export function redirectUriAllowed(
  candidate: string,
  allowed: string[],
): boolean {
  let candidateUrl: URL;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    return false;
  }

  return allowed.some((entry) => {
    if (entry === candidate) return true;

    let entryUrl: URL;
    try {
      entryUrl = new URL(entry);
    } catch {
      return false;
    }

    if (!isLoopback(entryUrl) || !isLoopback(candidateUrl)) return false;

    return (
      entryUrl.protocol === candidateUrl.protocol &&
      entryUrl.hostname === candidateUrl.hostname &&
      entryUrl.pathname === candidateUrl.pathname
    );
  });
}

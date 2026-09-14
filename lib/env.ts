/**
 * Environment access.
 *
 * Everything is read lazily: `next build` imports route modules to collect
 * metadata, and throwing at module scope would break builds on machines that
 * don't have production secrets.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

/** Public origin of this deployment, without a trailing slash. */
export function baseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');

  const vercel =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`.replace(/\/+$/, '');

  return 'http://localhost:3000';
}

export const env = {
  baseUrl,
  whoopClientId: () => required('WHOOP_CLIENT_ID'),
  whoopClientSecret: () => required('WHOOP_CLIENT_SECRET'),
  whoopWebhookSecret: () => process.env.WHOOP_WEBHOOK_SECRET ?? '',
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
  tokenEncryptionKey: () => required('TOKEN_ENCRYPTION_KEY'),
  timezone: () => process.env.WHOOP_TIMEZONE ?? 'Europe/Prague',
};

/** Endpoints on this server, derived from the public origin. */
export function endpoints() {
  const base = baseUrl();
  return {
    issuer: base,
    resource: `${base}/mcp`,
    authorization: `${base}/authorize`,
    token: `${base}/token`,
    registration: `${base}/register`,
    callback: `${base}/callback`,
    protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
  };
}

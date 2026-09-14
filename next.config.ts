import type { NextConfig } from 'next';

/**
 * Public URL surface of the connector.
 *
 * Claude (and the OAuth specs) expect discovery documents at the ORIGIN root
 * under `/.well-known/...`. Next.js treats dot-prefixed directories in `app/`
 * inconsistently, so the routes live under `app/api/**` and are exposed at the
 * canonical paths via rewrites.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // MCP endpoint — this is the URL you paste into Claude.
      { source: '/mcp', destination: '/api/mcp' },

      // RFC 9728 protected resource metadata (bare + path-suffixed variant).
      {
        source: '/.well-known/oauth-protected-resource',
        destination: '/api/well-known/oauth-protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/mcp',
        destination: '/api/well-known/oauth-protected-resource',
      },

      // RFC 8414 authorization server metadata (bare + path-suffixed variant).
      {
        source: '/.well-known/oauth-authorization-server',
        destination: '/api/well-known/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/mcp',
        destination: '/api/well-known/oauth-authorization-server',
      },
      // Some clients probe the OIDC discovery path.
      {
        source: '/.well-known/openid-configuration',
        destination: '/api/well-known/oauth-authorization-server',
      },

      // OAuth endpoints, advertised at clean paths.
      { source: '/authorize', destination: '/api/oauth/authorize' },
      { source: '/token', destination: '/api/oauth/token' },
      { source: '/register', destination: '/api/oauth/register' },
      { source: '/callback', destination: '/api/oauth/callback' },
    ];
  },
};

export default nextConfig;

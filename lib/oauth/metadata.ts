import { endpoints } from '../env';

/**
 * Scope namespace of this bridge. It is deliberately coarse: the connector
 * either reads the user's WHOOP data or it doesn't. The granular WHOOP scopes
 * (`read:sleep`, `read:recovery`, …) are requested from WHOOP on the back
 * channel and never surface to Claude.
 */
export const MCP_SCOPE = 'whoop:read';

/** RFC 9728 protected resource metadata. */
export function protectedResourceMetadata() {
  const { resource, issuer } = endpoints();
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_documentation: `${issuer}/`,
  };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata() {
  const {
    issuer,
    authorization,
    token,
    registration,
  } = endpoints();

  return {
    issuer,
    authorization_endpoint: authorization,
    token_endpoint: token,
    registration_endpoint: registration,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // Claude registers as a public client via DCR or CIMD, so the token
    // endpoint must accept PKCE-only requests with no client secret.
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
  };
}

export const WHOOP_AUTHORIZE_URL =
  'https://api.prod.whoop.com/oauth/oauth2/auth';
export const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
export const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';

/**
 * Scopes requested from WHOOP. `offline` is what makes WHOOP return a refresh
 * token — without it the grant dies after an hour and the user has to
 * reconnect the connector every time.
 */
export const WHOOP_SCOPES = [
  'offline',
  'read:cycles',
  'read:sleep',
  'read:recovery',
  'read:workout',
  'read:profile',
  'read:body_measurement',
] as const;

export const WHOOP_SCOPE_STRING = WHOOP_SCOPES.join(' ');

/** WHOOP caps `limit` at 25 on every collection endpoint. */
export const WHOOP_MAX_PAGE_SIZE = 25;

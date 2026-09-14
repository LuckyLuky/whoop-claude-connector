import { createHash } from 'node:crypto';
import { safeEqual } from '../crypto';

/**
 * PKCE (RFC 7636). Claude always sends `code_challenge_method=S256`, and the
 * MCP authorization spec requires S256 support, so `plain` is not accepted.
 */
export function verifyPkce(
  codeVerifier: string,
  storedChallenge: string,
  method: string,
): boolean {
  if (method !== 'S256') return false;
  if (!codeVerifier || codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return safeEqual(computed, storedChallenge);
}

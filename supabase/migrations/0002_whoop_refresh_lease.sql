-- Refresh lease for the WHOOP grant.
--
-- WHOOP rotates the refresh token on every use. Claude calls tools in
-- parallel, so two requests can find the access token stale at the same time
-- and both refresh with the same refresh token: one of them fails, and
-- whichever write lands last may store a token WHOOP has already invalidated.
--
-- A request takes this lease with a conditional UPDATE before calling WHOOP;
-- the others wait and pick up the token it stores. See lib/whoop/tokens.ts.
alter table whoop_tokens
  add column if not exists refresh_lease_until timestamptz;

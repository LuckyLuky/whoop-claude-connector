-- prune_expired_oauth_rows() is SECURITY DEFINER, and Postgres grants EXECUTE
-- to PUBLIC by default — so anon and authenticated could call it through
-- /rest/v1/rpc. Only the service role (or pg_cron) should run housekeeping.
revoke execute on function prune_expired_oauth_rows() from public, anon, authenticated;
grant execute on function prune_expired_oauth_rows() to service_role;

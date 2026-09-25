-- Nightly housekeeping.
--
-- prune_expired_oauth_rows() clears expired authorization codes, abandoned
-- pending authorizations and expired bearer/refresh tokens. Nothing called it
-- before, so those rows accumulated forever — and the privacy policy says they
-- are removed during periodic clean-up.
--
-- pg_cron schedules are UTC: 03:00 UTC is a quiet hour in Europe/Prague
-- (04:00 CET / 05:00 CEST). The job runs as the database owner, which is why
-- revoking EXECUTE from anon and authenticated in 0003 doesn't block it.
create extension if not exists pg_cron;

-- Re-running this migration must not stack duplicate jobs.
select cron.unschedule(jobid)
from cron.job
where jobname = 'prune-expired-oauth-rows';

select cron.schedule(
  'prune-expired-oauth-rows',
  '0 3 * * *',
  $$select public.prune_expired_oauth_rows()$$
);

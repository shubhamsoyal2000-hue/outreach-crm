-- Runs the CRM every 5 minutes from inside Supabase (works on Vercel's free plan,
-- whose own cron only runs once a day). Run this once in the Supabase SQL editor
-- after deploying, replacing the URL with your APP_URL.
--
-- The secret is read from Supabase Vault, so it never sits in this job's text.
-- Add it once in the dashboard: Project Settings > Vault > Add new secret,
-- name "cron_secret", value = the CRON_SECRET you set in Vercel.
-- Until that secret exists the job runs but sends nothing.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'outreach-crm-tick',
  '*/5 * * * *',
  $job$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  from vault.decrypted_secrets s
  where s.name = 'cron_secret';
  $job$
);

-- To stop it: select cron.unschedule('outreach-crm-tick');

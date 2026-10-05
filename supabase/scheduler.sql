-- Runs the CRM every 5 minutes from inside Supabase (works on Vercel's free plan,
-- whose own cron only runs once a day). Run this once in the Supabase SQL editor
-- after deploying, replacing the URL and the secret with your APP_URL and CRON_SECRET.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'outreach-crm-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron/tick',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- To stop it: select cron.unschedule('outreach-crm-tick');

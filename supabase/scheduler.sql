-- Runs the CRM every 5 minutes from inside Supabase (works on Vercel's free plan,
-- whose own cron only runs once a day). Run this once in the Supabase SQL editor
-- after deploying, replacing the URL with your APP_URL.
--
-- The secret is generated here and kept in Supabase Vault as "cron_secret".
-- The app checks it through cron_secret_matches() (migration 0002), so it is
-- never copied anywhere and nobody needs to see it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret')
where not exists (select 1 from vault.secrets where name = 'cron_secret');

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

-- Gmail history scan (Gmail history page): every minute, returns at once when no scan is running.
select cron.schedule(
  'outreach-crm-history',
  '* * * * *',
  $job$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron/history',
    headers := jsonb_build_object('Authorization', 'Bearer ' || s.decrypted_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  from vault.decrypted_secrets s
  where s.name = 'cron_secret';
  $job$
);

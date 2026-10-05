-- Lets the app check the scheduler's secret against the one in Supabase Vault
-- (named cron_secret, see scheduler.sql) without the value ever being copied
-- into Vercel. Only the server-side service role may call it, and it answers
-- yes or no: it never returns the secret.

create or replace function public.cron_secret_matches(token text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and length(decrypted_secret) >= 24 and decrypted_secret = token
  );
$$;

revoke all on function public.cron_secret_matches(text) from public, anon, authenticated;
grant execute on function public.cron_secret_matches(text) to service_role;

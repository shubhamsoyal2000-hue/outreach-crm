-- Outreach CRM: Phase 1 schema (sending MVP).
-- The app talks to the database only from the server with the service role key,
-- so every table has row level security on and no policies: the public anon key
-- can read or write nothing.

create extension if not exists pgcrypto;

-- One row of team-wide settings. Sending stays off until a human turns it on
-- and the CAN-SPAM postal address is filled in.
create table settings (
  id int primary key default 1 check (id = 1),
  sending_enabled boolean not null default false,
  company_name text not null default '',
  postal_address text not null default '',
  opt_out_line text not null default 'Not the right person or not interested? Click here and I won''t email again:',
  default_timezone text not null default 'America/New_York',
  send_window_start_hour int not null default 9 check (send_window_start_hour between 0 and 23),
  send_window_end_hour int not null default 16 check (send_window_end_hour between 1 and 24),
  ramp_start_per_day int not null default 10,
  ramp_step_per_business_day int not null default 2,
  catch_all_max_share numeric not null default 0.10 check (catch_all_max_share between 0 and 1),
  verification_max_age_days int not null default 30,
  bounce_pause_rate numeric not null default 0.03,
  bounce_window_sends int not null default 100,
  bounce_min_sends int not null default 20,
  out_of_office_hold_business_days int not null default 5,
  updated_at timestamptz not null default now(),
  check (send_window_end_hour > send_window_start_hour)
);
insert into settings (id) values (1);

create table inboxes (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  sender_name text not null default '',
  signature text not null default '',
  -- active: sending; paused: a human or a health rule stopped it; disconnected: OAuth broken
  status text not null default 'paused' check (status in ('active', 'paused', 'disconnected')),
  paused_reason text,
  -- First day this inbox may send cold email. The warm-up ramp counts from here.
  cold_start_date date,
  max_daily int not null default 40 check (max_daily between 0 and 60),
  refresh_token_enc text,
  last_synced_at timestamptz,
  last_sent_at timestamptz,
  next_send_after timestamptz,
  lock_until timestamptz,
  created_at timestamptz not null default now()
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text not null,
  domain text unique,
  city text,
  state text,
  country text,
  -- active: may be emailed; replied: someone replied, all sequences stop;
  -- do_not_contact: customer, competitor or asked to stop
  status text not null default 'active' check (status in ('active', 'replied', 'do_not_contact')),
  status_reason text,
  status_changed_at timestamptz,
  facts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index companies_name_key_idx on companies (name_key);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete set null,
  email text not null unique check (email = lower(email)),
  first_name text not null default '',
  last_name text not null default '',
  title text not null default '',
  timezone text,
  fields jsonb not null default '{}'::jsonb,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'valid', 'catch_all', 'risky', 'invalid', 'disposable', 'unknown')),
  verified_at timestamptz,
  verification_detail text,
  source text not null default 'csv',
  source_ref text,
  created_at timestamptz not null default now()
);
create index contacts_company_idx on contacts (company_id);

-- Global do-not-email list, by exact address or whole domain. Checked on every
-- import and every send, across all inboxes. Never deleted by imports.
create table suppressions (
  id uuid primary key default gen_random_uuid(),
  email text unique check (email = lower(email)),
  domain text unique check (domain = lower(domain)),
  reason text not null check (reason in ('unsubscribe', 'bounce', 'complaint', 'reply_opt_out', 'manual')),
  note text,
  created_at timestamptz not null default now(),
  check (email is not null or domain is not null)
);

create table sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused')),
  created_at timestamptz not null default now()
);

create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references sequences (id) on delete cascade,
  step_number int not null check (step_number >= 1),
  -- Business days to wait after the previous step. Ignored for step 1.
  delay_business_days int not null default 3 check (delay_business_days >= 0),
  -- Step 1 needs subject_a. Later steps with no subject reply in the same thread.
  subject_a text,
  subject_b text,
  body text not null,
  unique (sequence_id, step_number)
);

create table enrollments (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references sequences (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  inbox_id uuid not null references inboxes (id),
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  stop_reason text,
  next_step int not null default 1,
  next_send_at timestamptz not null default now(),
  subject_variant text not null default 'a' check (subject_variant in ('a', 'b')),
  thread_subject text,
  gmail_thread_id text,
  last_rfc_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sequence_id, contact_id)
);
create index enrollments_due_idx on enrollments (inbox_id, next_send_at) where status = 'active';
create index enrollments_contact_idx on enrollments (contact_id);
create index enrollments_thread_idx on enrollments (gmail_thread_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null references inboxes (id),
  enrollment_id uuid references enrollments (id) on delete set null,
  contact_id uuid references contacts (id) on delete set null,
  direction text not null check (direction in ('outbound', 'inbound')),
  -- outbound: sent. inbound: reply, auto_reply, bounce, unsubscribe_reply, other
  kind text not null check (kind in ('sent', 'reply', 'auto_reply', 'bounce', 'unsubscribe_reply', 'other')),
  step_number int,
  subject_variant text,
  catch_all boolean not null default false,
  -- Sending day in the team's default timezone, used for daily caps.
  send_day date,
  gmail_message_id text unique,
  gmail_thread_id text,
  rfc_message_id text,
  from_email text,
  subject text,
  snippet text,
  occurred_at timestamptz not null default now()
);
create index messages_inbox_day_idx on messages (inbox_id, send_day) where direction = 'outbound';
create index messages_inbox_time_idx on messages (inbox_id, occurred_at desc);

-- Per inbox and per sequence counts for the dashboard.
create view inbox_stats with (security_invoker = true) as
select
  i.id as inbox_id,
  i.email,
  i.status,
  count(*) filter (where m.kind = 'sent') as sent,
  count(*) filter (where m.kind = 'bounce') as bounced,
  count(*) filter (where m.kind = 'reply') as replied,
  count(*) filter (where m.kind = 'auto_reply') as auto_replies,
  count(*) filter (where m.kind = 'unsubscribe_reply') as unsubscribe_replies
from inboxes i
left join messages m on m.inbox_id = i.id
group by i.id;

create view sequence_stats with (security_invoker = true) as
select
  s.id as sequence_id,
  s.name,
  s.status,
  count(distinct e.id) as enrolled,
  count(distinct e.id) filter (where e.status = 'active') as active,
  count(m.id) filter (where m.kind = 'sent') as sent,
  count(m.id) filter (where m.kind = 'bounce') as bounced,
  count(m.id) filter (where m.kind = 'reply') as replied,
  count(distinct e.id) filter (where e.stop_reason = 'unsubscribed') as unsubscribed
from sequences s
left join enrollments e on e.sequence_id = s.id
left join messages m on m.enrollment_id = e.id
group by s.id;

alter table settings enable row level security;
alter table inboxes enable row level security;
alter table companies enable row level security;
alter table contacts enable row level security;
alter table suppressions enable row level security;
alter table sequences enable row level security;
alter table sequence_steps enable row level security;
alter table enrollments enable row level security;
alter table messages enable row level security;

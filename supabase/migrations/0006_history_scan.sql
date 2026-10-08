-- Gmail history scan: reads what each inbox sent since a date, and which of
-- those addresses replied, bounced or asked to stop. Headers only, read-only.
create table history_scans (
  inbox_id uuid primary key references inboxes (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'error')),
  phase text not null default 'sent' check (phase in ('sent', 'inbound', 'bounces', 'done')),
  since date not null,
  page_token text,
  messages_read int not null default 0,
  sent_estimate int,
  error text,
  lock_until timestamptz,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table history_messages (
  inbox_id uuid not null references inboxes (id) on delete cascade,
  gmail_message_id text not null,
  thread_id text not null,
  kind text not null check (kind in ('sent', 'reply', 'bounce', 'opt_out')),
  -- sent: recipients. reply / opt_out: the sender. bounce: the failed recipients.
  addresses text[] not null,
  names jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  primary key (inbox_id, gmail_message_id)
);
create index history_messages_thread_idx on history_messages (inbox_id, thread_id) where kind = 'sent';

-- One row per address we wrote to, with what happened next.
create view history_addresses with (security_invoker = true) as
with flat as (
  select m.kind, m.occurred_at, m.inbox_id, m.names, lower(a.email) as email
  from history_messages m cross join lateral unnest(m.addresses) as a (email)
),
sent as (
  select f.email, min(f.occurred_at) as first_sent, max(f.occurred_at) as last_sent, count(*)::int as sent_count,
    array_agg(distinct i.email) as inboxes, max(f.names ->> f.email) as name
  from flat f join inboxes i on i.id = f.inbox_id
  where f.kind = 'sent'
  group by f.email
),
after_sent as (
  select email,
    max(occurred_at) filter (where kind = 'bounce') as bounced_at,
    max(occurred_at) filter (where kind = 'reply') as replied_at,
    count(*) filter (where kind = 'reply')::int as reply_count,
    max(occurred_at) filter (where kind = 'opt_out') as opted_out_at
  from flat where kind <> 'sent'
  group by email
)
select s.email, s.name, s.first_sent, s.last_sent, s.sent_count, s.inboxes,
  x.bounced_at, x.replied_at, coalesce(x.reply_count, 0) as reply_count, x.opted_out_at,
  exists (select 1 from contacts c where c.email = s.email) as in_crm,
  exists (select 1 from suppressions p where p.email = s.email) as suppressed
from sent s left join after_sent x on x.email = s.email;

alter table history_scans enable row level security;
alter table history_messages enable row level security;


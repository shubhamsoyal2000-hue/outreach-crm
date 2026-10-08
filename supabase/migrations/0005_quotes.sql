-- One card per prospect conversation that needs a rate, from first reply to won or lost.
create table quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies (id) on delete set null,
  contact_id uuid references contacts (id) on delete set null,
  inbox_id uuid references inboxes (id) on delete set null,
  from_email text not null,
  gmail_thread_id text,
  status text not null default 'new' check (status in ('new', 'quoting', 'quoted', 'won', 'lost')),
  lane_from text not null default '',
  lane_to text not null default '',
  equipment text not null default '',
  rate_quoted numeric(10, 2),
  notes text not null default '',
  reply_count int not null default 1,
  last_reply_snippet text not null default '',
  first_reply_at timestamptz not null,
  last_reply_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index quotes_status_idx on quotes (status, last_reply_at desc);
-- A company (or, without one, a sender) has at most one open quote; more replies add to it.
create unique index quotes_open_company on quotes (company_id) where company_id is not null and status not in ('won', 'lost');
create unique index quotes_open_sender on quotes (from_email) where company_id is null and status not in ('won', 'lost');

alter table quotes enable row level security;

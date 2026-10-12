-- Website email finder: reads company websites (home, contact, about, team pages)
-- and adds the emails listed there to Leads. Sites come from business directories,
-- pasted lists and the companies already in the CRM.
create table finder_sites (
  domain text primary key check (domain = lower(domain)),
  name text not null default '',
  kind text check (kind in ('importer', 'forwarder', 'carrier', 'other')),
  source text not null,
  source_ref text,
  priority int not null default 0,
  status text not null default 'pending' check (status in ('pending', 'done', 'no_emails', 'failed', 'skipped')),
  emails_found int not null default 0,
  emails_added int not null default 0,
  pages_read int not null default 0,
  error text,
  lock_until timestamptz,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index finder_sites_queue_idx on finder_sites (priority desc, created_at) where status = 'pending';
create index finder_sites_checked_idx on finder_sites (checked_at);

-- Directory listings that link out to company websites, read one page at a time.
-- url_template has {page} where the page number goes.
create table finder_directories (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  url_template text not null unique check (url_template like '%{page}%'),
  kind text check (kind in ('importer', 'forwarder', 'carrier', 'other')),
  next_page int not null default 1,
  last_page int,
  status text not null default 'active' check (status in ('active', 'done', 'paused', 'failed')),
  sites_found int not null default 0,
  error text,
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table finder_sites enable row level security;
alter table finder_directories enable row level security;

alter table settings
  add column finder_enabled boolean not null default true,
  add column finder_daily_sites int not null default 600 check (finder_daily_sites between 0 and 5000);

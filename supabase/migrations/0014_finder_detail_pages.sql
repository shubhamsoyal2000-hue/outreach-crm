-- Directories whose listings link to their own profile pages (trade-market exhibitor
-- directories, for example) instead of straight to company websites. The listing,
-- or the site's sitemap, gives profile pages; each profile page gives one website.
alter table finder_directories drop constraint finder_directories_url_template_check;
alter table finder_directories
  add column mode text not null default 'list' check (mode in ('list', 'sitemap')),
  add column detail_prefix text,
  add constraint finder_directories_url_check check (mode = 'sitemap' or url_template like '%{page}%');

create table finder_pages (
  url text primary key,
  directory_id uuid not null references finder_directories (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'done', 'no_site', 'failed')),
  domain text,
  lock_until timestamptz,
  created_at timestamptz not null default now(),
  checked_at timestamptz
);
create index finder_pages_queue_idx on finder_pages (created_at) where status = 'pending';
alter table finder_pages enable row level security;

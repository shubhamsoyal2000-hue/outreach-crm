-- What the Gmail history scan saw, per inbox.
alter table history_scans add column if not exists stats jsonb not null default '{}'::jsonb;

-- Where reply and inbox-problem alerts go. Empty turns alerts off.
alter table settings add column if not exists alert_email text not null default '';

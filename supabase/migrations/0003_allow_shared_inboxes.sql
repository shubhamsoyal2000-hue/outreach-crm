-- Lets a team choose to email shared business inboxes (info@, sales@, orders@...).
-- Off by default; no-reply, abuse, HR and job inboxes stay blocked either way.
alter table settings add column allow_shared_inboxes boolean not null default false;

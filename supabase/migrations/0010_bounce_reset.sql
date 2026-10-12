-- Resuming an inbox after a bounce pause starts its bounce count fresh, so the
-- same old bounces do not pause it again on the next send.
alter table inboxes add column bounce_reset_at timestamptz;

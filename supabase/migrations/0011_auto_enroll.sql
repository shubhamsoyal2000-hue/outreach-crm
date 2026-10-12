-- A sequence with auto_enroll on picks up, every hour, importers whose opening
-- line has been written, without anyone clicking Enroll.
alter table sequences add column auto_enroll boolean not null default false;

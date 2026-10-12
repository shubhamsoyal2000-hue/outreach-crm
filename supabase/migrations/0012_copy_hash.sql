-- Fingerprint of each sent email's wording, so no two emails go out word for word the same.
alter table messages add column copy_hash text;
create index messages_copy_hash_idx on messages (copy_hash) where copy_hash is not null;

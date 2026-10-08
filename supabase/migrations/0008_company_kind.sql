-- Importer, forwarder, carrier or other: guessed from the domain on import
-- (src/lib/company-kind.ts), editable on the ImportInfo list page.
alter table companies add column if not exists kind text check (kind in ('importer', 'forwarder', 'carrier', 'other'));
-- Existing companies were tagged once with the same rules when this was added.

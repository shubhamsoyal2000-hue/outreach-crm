-- One row per company with contacts: what kind it is, whether ImportInfo data
-- (ports, routes) is in, and how many contacts it has. Drives the ImportInfo list.
create view company_lookup with (security_invoker = true) as
select co.id, co.name, co.domain, coalesce(co.kind, 'importer') as kind, co.status,
  (co.facts ? 'top_us_port' or co.facts ? 'top_route_from') as has_data,
  co.facts ->> 'top_us_port' as top_us_port,
  count(ct.id)::int as contacts,
  max(ct.fields ->> 'last_emailed') as last_emailed
from companies co join contacts ct on ct.company_id = co.id
group by co.id;

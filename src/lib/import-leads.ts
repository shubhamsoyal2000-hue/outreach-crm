import "server-only";
import type { LeadRow, Rejected } from "./csv-import";
import { guessCompanyKind } from "./company-kind";
import { domainAndParents } from "./email-rules";
import { db } from "./store/supabase";

export interface ImportSummary {
  added: number;
  alreadyInCrm: number;
  rejected: Rejected[];
}

const CHUNK = 200;

/**
 * Saves parsed leads. Opted-out addresses and domains are never re-imported,
 * existing contacts are left as they are, and companies are matched by
 * website domain (or by cleaned-up name when there is no domain).
 */
export async function saveLeads(rows: LeadRow[], rejected: Rejected[], source: string): Promise<ImportSummary> {
  const summary: ImportSummary = { added: 0, alreadyInCrm: 0, rejected: [...rejected] };

  for (let i = 0; i < rows.length; i += CHUNK) {
    let chunk = rows.slice(i, i + CHUNK);
    const emails = chunk.map((r) => r.email);
    const domains = [...new Set(chunk.flatMap((r) => domainAndParents(r.email.split("@")[1])))];

    const [supEmails, supDomains, existing] = await Promise.all([
      db().from("suppressions").select("email").in("email", emails),
      db().from("suppressions").select("domain").in("domain", domains),
      db().from("contacts").select("email").in("email", emails),
    ]);
    for (const r of [supEmails, supDomains, existing]) if (r.error) throw new Error(r.error.message);
    const blocked = new Set((supEmails.data ?? []).map((s) => s.email));
    const blockedDomains = new Set((supDomains.data ?? []).map((s) => s.domain));
    const known = new Set((existing.data ?? []).map((c) => c.email));

    const allowed = chunk.filter((r) => !blocked.has(r.email) && !domainAndParents(r.email.split("@")[1]).some((d) => blockedDomains.has(d)));
    chunk = chunk.filter((r) => {
      if (blocked.has(r.email) || domainAndParents(r.email.split("@")[1]).some((d) => blockedDomains.has(d))) {
        summary.rejected.push({ line: r.line, email: r.email, reason: "opted out or bounced before" });
        return false;
      }
      if (known.has(r.email)) {
        summary.alreadyInCrm++;
        return false;
      }
      return true;
    });
    if (!chunk.length) {
      await mergeCompanyFacts(allowed);
      continue;
    }

    const companyIds = await upsertCompanies(chunk);
    await mergeCompanyFacts(allowed);
    const contacts = chunk.map((r) => ({
      email: r.email,
      first_name: r.first_name,
      last_name: r.last_name,
      title: r.title,
      timezone: r.timezone,
      fields: r.fields,
      company_id: companyIds.get(companyKey(r)) ?? null,
      source,
      source_ref: `line ${r.line}`,
    }));
    const res = await db().from("contacts").upsert(contacts, { onConflict: "email", ignoreDuplicates: true }).select("id");
    if (res.error) throw new Error(`save contacts: ${res.error.message}`);
    summary.added += res.data?.length ?? 0;
  }
  return summary;
}

function companyKey(r: LeadRow): string {
  return r.company_domain ? `d:${r.company_domain}` : `n:${r.company_key}`;
}

async function upsertCompanies(rows: LeadRow[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const byKey = new Map<string, LeadRow>();
  for (const r of rows) if (r.company) byKey.set(companyKey(r), r);

  const withDomain = [...byKey.values()].filter((r) => r.company_domain);
  if (withDomain.length) {
    const res = await db()
      .from("companies")
      .upsert(
        withDomain.map((r) => ({
          name: r.company, name_key: r.company_key, domain: r.company_domain, city: r.city || null, state: r.state || null, country: r.country || null,
          kind: guessCompanyKind(r.company_domain),
        })),
        { onConflict: "domain", ignoreDuplicates: true },
      );
    if (res.error) throw new Error(`save companies: ${res.error.message}`);
    const found = await db().from("companies").select("id, domain").in("domain", withDomain.map((r) => r.company_domain!));
    if (found.error) throw new Error(found.error.message);
    for (const c of found.data ?? []) ids.set(`d:${c.domain}`, c.id);
  }

  const nameOnly = [...byKey.values()].filter((r) => !r.company_domain && r.company_key);
  if (nameOnly.length) {
    const found = await db().from("companies").select("id, name_key").is("domain", null).in("name_key", nameOnly.map((r) => r.company_key));
    if (found.error) throw new Error(found.error.message);
    for (const c of found.data ?? []) ids.set(`n:${c.name_key}`, c.id);
    const missing = nameOnly.filter((r) => !ids.has(`n:${r.company_key}`));
    if (missing.length) {
      const res = await db()
        .from("companies")
        .insert(missing.map((r) => ({ name: r.company, name_key: r.company_key, city: r.city || null, state: r.state || null, country: r.country || null })))
        .select("id, name_key");
      if (res.error) throw new Error(`save companies: ${res.error.message}`);
      for (const c of res.data ?? []) ids.set(`n:${c.name_key}`, c.id);
    }
  }
  return ids;
}

/** Company-level facts from the ImportInfo button (ports, routes, shipment counts). */
export const COMPANY_FACT_KEYS = [
  "shipments_30d", "shipments_90d", "shipments_year", "last_shipment", "top_us_port", "top_route_from", "top_route_to", "company_phone", "importinfo_page",
];

/**
 * Copies company facts from imported rows onto the company, including companies
 * already in the CRM, so every contact there can use them in emails. Newer
 * non-empty values replace older ones.
 */
async function mergeCompanyFacts(rows: LeadRow[]) {
  const byDomain = new Map<string, Record<string, string>>();
  for (const r of rows) {
    if (!r.company_domain) continue;
    const facts: Record<string, string> = {};
    for (const k of COMPANY_FACT_KEYS) if (r.fields[k]?.trim()) facts[k] = r.fields[k].trim();
    if (Object.keys(facts).length) byDomain.set(r.company_domain, { ...(byDomain.get(r.company_domain) ?? {}), ...facts });
  }
  if (!byDomain.size) return;
  const found = await db().from("companies").select("id, name, domain, facts, state").in("domain", [...byDomain.keys()]);
  if (found.error) throw new Error(found.error.message);
  for (const c of (found.data ?? []) as { id: string; name: string; domain: string; facts: Record<string, string> | null; state: string | null }[]) {
    const facts = { ...(c.facts ?? {}), ...byDomain.get(c.domain)! };
    const row = rows.find((r) => r.company_domain === c.domain && r.company && r.company !== c.domain);
    const state = c.state || rows.find((r) => r.company_domain === c.domain && r.state)?.state || null;
    // A company first saved from an email address is named after its domain; ImportInfo has the real name.
    const name = c.name === c.domain && row ? row.company : c.name;
    const res = await db().from("companies").update({ facts, state, name }).eq("id", c.id);
    if (res.error) throw new Error(`save company facts: ${res.error.message}`);
  }
}

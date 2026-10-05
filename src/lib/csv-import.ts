import Papa from "papaparse";
import { companyNameKey, domainFromWebsite, emailDomain, isFreemailDomain, normalizeEmail, precheck } from "./email-rules";
import { fieldKey } from "./template";
import { timezoneForState } from "./time";

export interface LeadRow {
  line: number;
  email: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  company_key: string;
  /** Company website domain, or the email's domain when it is not a free mailbox. */
  company_domain: string | null;
  city: string;
  state: string;
  country: string;
  timezone: string | null;
  /** Every other column (commodity, port, hs_code, shipments...), usable as {{fields}} in emails. */
  fields: Record<string, string>;
}

export interface Rejected {
  line: number;
  email: string;
  reason: string;
}

const ALIASES: Record<string, string[]> = {
  email: ["email", "e_mail", "email_address", "work_email", "contact_email", "business_email"],
  first_name: ["first_name", "firstname", "first", "given_name"],
  last_name: ["last_name", "lastname", "last", "surname", "family_name"],
  full_name: ["full_name", "name", "contact_name", "contact"],
  title: ["title", "job_title", "position", "role", "designation"],
  company: ["company", "company_name", "consignee", "consignee_name", "organization", "organisation", "account", "account_name", "importer"],
  website: ["website", "domain", "company_website", "company_domain", "web", "url"],
  city: ["city", "consignee_city"],
  state: ["state", "province", "region", "state_code", "consignee_state"],
  country: ["country", "consignee_country"],
};

function buildHeaderMap(headers: string[]) {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const key = fieldKey(h);
    const canonical = Object.entries(ALIASES).find(([, names]) => names.includes(key))?.[0];
    if (canonical && !Object.values(map).includes(canonical)) map[h] = canonical;
    else map[h] = key;
  }
  return map;
}

export function parseLeadsCsv(text: string, opts: { allowShared?: boolean } = {}): { rows: LeadRow[]; rejected: Rejected[]; columns: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  const headers = parsed.meta.fields ?? [];
  const map = buildHeaderMap(headers);
  const rows: LeadRow[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();

  parsed.data.forEach((raw, i) => {
    const line = i + 2; // header is line 1
    const rec: Record<string, string> = {};
    for (const [h, v] of Object.entries(raw)) if (map[h] && v != null) rec[map[h]] = String(v).trim();

    const email = normalizeEmail(rec.email ?? "");
    if (!email) return rejected.push({ line, email: "", reason: "no email" });
    const pre = precheck(email, opts);
    if (!pre.ok) return rejected.push({ line, email, reason: pre.reason === "role" ? "shared mailbox (info@, sales@...)" : pre.reason === "syntax" ? "not a valid email" : "disposable domain" });
    if (seen.has(email)) return rejected.push({ line, email, reason: "duplicate in this file" });
    seen.add(email);

    let first = rec.first_name ?? "";
    let last = rec.last_name ?? "";
    if (!first && rec.full_name) {
      const parts = rec.full_name.split(/\s+/);
      first = parts[0];
      last = last || parts.slice(1).join(" ");
    }

    const domainOfEmail = emailDomain(email);
    const company_domain = domainFromWebsite(rec.website) ?? (isFreemailDomain(domainOfEmail) ? null : domainOfEmail);
    const company = rec.company || company_domain || "";

    const fields: Record<string, string> = {};
    const known = new Set(["email", "first_name", "last_name", "full_name", "title", "company", "website", "city", "state", "country"]);
    for (const [k, v] of Object.entries(rec)) if (!known.has(k) && v) fields[k] = v;

    rows.push({
      line,
      email,
      first_name: first,
      last_name: last,
      title: rec.title ?? "",
      company,
      company_key: companyNameKey(company),
      company_domain,
      city: rec.city ?? "",
      state: rec.state ?? "",
      country: rec.country ?? "",
      timezone: timezoneForState(rec.state),
      fields,
    });
  });

  return { rows, rejected, columns: [...new Set(Object.values(map))] };
}

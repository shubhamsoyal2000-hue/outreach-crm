import "server-only";
import Papa from "papaparse";
import type { CompanyKind } from "../company-kind";
import { parseLeadsCsv } from "../csv-import";
import { domainFromWebsite } from "../email-rules";
import { saveLeads } from "../import-leads";
import { db } from "../store/supabase";
import { directorySites, extractEmails, pagesWorthReading, robotsAllows, robotsDisallows, siteName, type FoundEmail } from "./extract";

export interface FinderSite {
  domain: string;
  name: string;
  kind: CompanyKind | null;
  source: string;
  source_ref: string | null;
}

interface FinderDirectory {
  id: string;
  label: string;
  url_template: string;
  kind: CompanyKind | null;
  next_page: number;
  last_page: number | null;
  sites_found: number;
}

export interface FinderPassOutcome {
  sitesRead: number;
  emailsAdded: number;
  directoryPages: number;
  stopped?: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const PAGE_TIMEOUT_MS = 8_000;
const MAX_HTML = 1_500_000;
const PARALLEL = 4;
/** Directory pages are read only while fewer sites than this wait in the queue. */
const QUEUE_LOW = 40;

async function must<T extends { error: { message: string } | null }>(p: PromiseLike<T>): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(res.error.message);
  return res;
}

async function getPage(url: string, deadline: number): Promise<{ html: string; finalUrl: string } | null> {
  const left = deadline - Date.now();
  if (left < 1_500) return null;
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, left - 500)),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain/i.test(type)) return null;
    return { html: (await res.text()).slice(0, MAX_HTML), finalUrl: res.url || url };
  } catch {
    return null;
  }
}

async function getRobots(origin: string, deadline: number): Promise<string[]> {
  if (deadline - Date.now() < 2_000) return [];
  try {
    const res = await fetch(origin + "/robots.txt", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return [];
    return robotsDisallows((await res.text()).slice(0, 200_000));
  } catch {
    return [];
  }
}

export interface SiteResult {
  status: "done" | "no_emails" | "failed" | "skipped";
  name: string;
  emails: (FoundEmail & { found_on: string })[];
  pagesRead: number;
  error?: string;
}

/** Reads a company's home page and up to 4 contact/team/about pages, and collects the emails at its own domain. */
export async function readSite(domain: string, deadline: number): Promise<SiteResult> {
  let home = await getPage(`https://${domain}/`, deadline);
  if (!home) home = await getPage(`https://www.${domain}/`, deadline);
  if (!home) home = await getPage(`http://${domain}/`, deadline);
  if (!home) return { status: "failed", name: "", emails: [], pagesRead: 0, error: "website did not load" };

  const finalHost = new URL(home.finalUrl).host.replace(/^www\./, "").toLowerCase();
  const domains = [...new Set([domain, domainFromWebsite(finalHost) ?? domain])];
  const disallows = await getRobots(new URL(home.finalUrl).origin, deadline);
  if (!robotsAllows(disallows, "/")) return { status: "skipped", name: siteName(home.html), emails: [], pagesRead: 1, error: "site asks robots not to read it" };

  const found = new Map<string, FoundEmail & { found_on: string }>();
  const add = (html: string, url: string) => {
    for (const e of extractEmails(html, domains)) {
      const had = found.get(e.email);
      if (!had) found.set(e.email, { ...e, found_on: url });
      else if (!had.first_name && e.first_name) found.set(e.email, { ...had, first_name: e.first_name, last_name: e.last_name });
    }
  };
  add(home.html, home.finalUrl);

  let pages = pagesWorthReading(home.html, home.finalUrl, domains).filter((u) => robotsAllows(disallows, new URL(u).pathname));
  if (!pages.length) pages = [new URL("/contact", home.finalUrl).href, new URL("/contact-us", home.finalUrl).href];
  let pagesRead = 1;
  for (const url of pages) {
    if (deadline - Date.now() < 2_000) break;
    const page = await getPage(url, deadline);
    if (!page) continue;
    pagesRead++;
    add(page.html, page.finalUrl);
  }
  const emails = [...found.values()];
  return { status: emails.length ? "done" : "no_emails", name: siteName(home.html), emails, pagesRead };
}

async function settings(): Promise<{ enabled: boolean; dailySites: number; allowShared: boolean }> {
  const res = await must(db().from("settings").select("finder_enabled, finder_daily_sites, allow_shared_inboxes").eq("id", 1).single());
  const s = res.data as { finder_enabled: boolean; finder_daily_sites: number; allow_shared_inboxes: boolean };
  return { enabled: s.finder_enabled, dailySites: s.finder_daily_sites, allowShared: s.allow_shared_inboxes };
}

function startOfTodayUtc(): string {
  return new Date().toISOString().slice(0, 10) + "T00:00:00Z";
}

export async function sitesReadToday(): Promise<number> {
  const res = await must(db().from("finder_sites").select("domain", { count: "exact", head: true }).gte("checked_at", startOfTodayUtc()));
  return res.count ?? 0;
}

/** Saves a site's emails as leads, through the same path as a CSV import (Do-not-email and duplicates are skipped there). */
async function saveSiteEmails(site: FinderSite, result: SiteResult, allowShared: boolean): Promise<number> {
  if (!result.emails.length) return 0;
  const company = site.name || result.name || site.domain;
  const csv = Papa.unparse(
    result.emails.map((e) => ({
      email: e.email, first_name: e.first_name, last_name: e.last_name, company, website: site.domain, found_on: e.found_on,
    })),
  );
  const existing = await must(db().from("companies").select("id").eq("domain", site.domain).maybeSingle());
  const { rows, rejected } = parseLeadsCsv(csv, { allowShared });
  const summary = await saveLeads(rows, rejected, "website_finder");
  // A directory knows what kind of company it lists (forwarders, for example); the domain alone often doesn't say.
  if (!existing.data && site.kind) await must(db().from("companies").update({ kind: site.kind }).eq("domain", site.domain));
  return summary.added;
}

async function claimSites(n: number, lockMs: number): Promise<FinderSite[]> {
  const now = new Date().toISOString();
  const res = await must(
    db().from("finder_sites").select("domain, name, kind, source, source_ref")
      .eq("status", "pending").or(`lock_until.is.null,lock_until.lt.${now}`)
      .order("priority", { ascending: false }).order("created_at").limit(n),
  );
  const sites = (res.data ?? []) as FinderSite[];
  if (sites.length) {
    await must(db().from("finder_sites").update({ lock_until: new Date(Date.now() + lockMs).toISOString() }).in("domain", sites.map((s) => s.domain)));
  }
  return sites;
}

/** Adds websites to the queue; ones already queued or read are left alone. Returns how many were new. */
export async function queueSites(sites: FinderSite[], priority = 0): Promise<number> {
  const unique = new Map<string, FinderSite>();
  for (const s of sites) if (s.domain && !unique.has(s.domain)) unique.set(s.domain, s);
  let added = 0;
  const all = [...unique.values()];
  for (let i = 0; i < all.length; i += 500) {
    const res = await must(
      db().from("finder_sites")
        .upsert(all.slice(i, i + 500).map((s) => ({ ...s, priority })), { onConflict: "domain", ignoreDuplicates: true })
        .select("domain"),
    );
    added += res.data?.length ?? 0;
  }
  return added;
}

async function pendingCount(): Promise<number> {
  const res = await must(db().from("finder_sites").select("domain", { count: "exact", head: true }).eq("status", "pending"));
  return res.count ?? 0;
}

/** Reads the next page of one directory and queues the company websites it links to. */
async function readDirectoryPage(deadline: number): Promise<boolean> {
  const res = await must(
    db().from("finder_directories").select("id, label, url_template, kind, next_page, last_page, sites_found")
      .eq("status", "active").order("checked_at", { ascending: true, nullsFirst: true }).limit(1),
  );
  const dir = (res.data ?? [])[0] as FinderDirectory | undefined;
  if (!dir) return false;
  const url = dir.url_template.replace("{page}", String(dir.next_page));
  const page = await getPage(url, deadline);
  const now = new Date().toISOString();
  if (!page) {
    await must(db().from("finder_directories").update({ status: "failed", error: `page ${dir.next_page} did not load`, checked_at: now }).eq("id", dir.id));
    return true;
  }
  const sites = directorySites(page.html, url);
  const added = await queueSites(sites.map((s) => ({ domain: s.domain, name: s.name, kind: dir.kind, source: "directory", source_ref: `${dir.label} p${dir.next_page}` })), 1);
  const finished = !sites.length || (dir.last_page != null && dir.next_page >= dir.last_page);
  await must(
    db().from("finder_directories").update({
      next_page: dir.next_page + 1, sites_found: dir.sites_found + added, checked_at: now, error: null, status: finished ? "done" : "active",
    }).eq("id", dir.id),
  );
  return true;
}

/** One scheduler call: tops up the queue from directories when it runs low, then reads websites until the time budget is spent. */
export async function runFinderPass(budgetMs: number): Promise<FinderPassOutcome> {
  const deadline = Date.now() + budgetMs;
  const out: FinderPassOutcome = { sitesRead: 0, emailsAdded: 0, directoryPages: 0 };
  const s = await settings();
  if (!s.enabled) return { ...out, stopped: "turned off" };
  let room = s.dailySites - (await sitesReadToday());
  if (room <= 0) return { ...out, stopped: "daily limit reached" };

  if ((await pendingCount()) < QUEUE_LOW && (await readDirectoryPage(deadline))) out.directoryPages++;

  while (room > 0 && deadline - Date.now() > 12_000) {
    const sites = await claimSites(Math.min(PARALLEL, room), budgetMs + 30_000);
    if (!sites.length) break;
    const results = await Promise.all(sites.map(async (site) => {
      const result = await readSite(site.domain, deadline - 3_000);
      let added = 0;
      let error = result.error ?? null;
      try {
        added = await saveSiteEmails(site, result, s.allowShared);
      } catch (e) {
        error = `saving failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      await must(
        db().from("finder_sites").update({
          status: result.status, name: site.name || result.name, emails_found: result.emails.length, emails_added: added,
          pages_read: result.pagesRead, error, lock_until: null, checked_at: new Date().toISOString(),
        }).eq("domain", site.domain),
      );
      return added;
    }));
    out.sitesRead += sites.length;
    out.emailsAdded += results.reduce((a, b) => a + b, 0);
    room -= sites.length;
  }
  return out;
}

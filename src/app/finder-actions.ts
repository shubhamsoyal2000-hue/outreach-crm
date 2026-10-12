"use server";

import { redirect } from "next/navigation";
import type { CompanyKind } from "@/lib/company-kind";
import { domainFromWebsite } from "@/lib/email-rules";
import { queueSites } from "@/lib/finder/run";
import { db } from "@/lib/store/supabase";

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function done(msg: string): never {
  redirect(`/finder?msg=${encodeURIComponent(msg)}`);
}

async function must<T extends { error: { message: string } | null }>(p: PromiseLike<T>): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(res.error.message);
  return res;
}

function kindOf(fd: FormData): CompanyKind | null {
  const k = str(fd, "kind");
  return ["importer", "forwarder", "carrier", "other"].includes(k) ? (k as CompanyKind) : null;
}

export async function saveFinderSettings(fd: FormData) {
  const daily = Math.round(Number(str(fd, "finder_daily_sites")));
  if (!Number.isFinite(daily) || daily < 0 || daily > 5000) done("Websites per day must be between 0 and 5000.");
  await must(db().from("settings").update({ finder_enabled: fd.get("finder_enabled") === "on", finder_daily_sites: daily }).eq("id", 1));
  done("Saved.");
}

/** One website per line (or comma separated), optionally "Company name, website". */
export async function addFinderSites(fd: FormData) {
  const kind = kindOf(fd);
  const sites = str(fd, "sites").split(/\n+/).flatMap((line) => {
    const parts = line.split(/[,\t;]+/).map((p) => p.trim()).filter(Boolean);
    const site = parts.map((p) => domainFromWebsite(p)).find(Boolean);
    if (!site) return [];
    const name = parts.find((p) => !domainFromWebsite(p)) ?? "";
    return [{ domain: site, name, kind, source: "pasted", source_ref: null }];
  });
  if (!sites.length) done("No websites found. Put one website per line, like acme-imports.com.");
  const added = await queueSites(sites, 2);
  done(`Added ${added} new websites to the queue${sites.length > added ? ` (${sites.length - added} were already there)` : ""}.`);
}

/** Queues the websites of companies already in Leads, behind everything else, to find more people there. */
export async function queueKnownCompanies() {
  const res = await must(db().from("companies").select("domain, name, kind").eq("status", "active").not("domain", "is", null).limit(10000));
  const rows = (res.data ?? []) as { domain: string; name: string; kind: CompanyKind }[];
  const added = await queueSites(rows.filter((r) => r.kind === "importer" || r.kind === "forwarder").map((r) => ({
    domain: r.domain, name: r.name === r.domain ? "" : r.name, kind: null, source: "leads", source_ref: null,
  })), -1);
  done(`Queued ${added} company websites from Leads. New sources still go first.`);
}

export async function addFinderDirectory(fd: FormData) {
  const label = str(fd, "label");
  const url = str(fd, "url_template");
  if (!label || !/^https?:\/\/.+\{page\}/.test(url)) done("Give the directory a name and a web address with {page} where the page number goes.");
  const last = Number(str(fd, "last_page")) || null;
  await must(db().from("finder_directories").upsert({ label, url_template: url, kind: kindOf(fd), last_page: last, status: "active", error: null }, { onConflict: "url_template" }));
  done(`Added ${label}. It is read one page at a time whenever the queue runs low.`);
}

export async function setDirectoryStatus(fd: FormData) {
  const status = str(fd, "status");
  if (!["active", "paused"].includes(status)) done("Unknown status.");
  await must(db().from("finder_directories").update({ status, error: null }).eq("id", str(fd, "id")));
  done(status === "active" ? "Directory turned on." : "Directory paused.");
}

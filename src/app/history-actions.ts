"use server";

import Papa from "papaparse";
import { redirect } from "next/navigation";
import { parseLeadsCsv } from "@/lib/csv-import";
import { classifiedHistory } from "@/lib/history/classified";
import { splitName, type ClassifiedAddress, type HistoryGroup } from "@/lib/history/parse";
import { saveLeads } from "@/lib/import-leads";
import { db, SupabaseStore } from "@/lib/store/supabase";

function done(msg: string): never {
  redirect(`/history?msg=${encodeURIComponent(msg)}`);
}

async function must<T extends { error: { message: string } | null }>(p: PromiseLike<T>): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(res.error.message);
  return res;
}

export async function startHistoryScan(fd: FormData) {
  const since = String(fd.get("since") ?? "").trim() || "2026-01-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) done("Pick a start date.");
  const inboxes = (await new SupabaseStore().listInboxes()).filter((i) => i.status !== "disconnected" && i.refresh_token_enc);
  if (!inboxes.length) done("Connect an inbox first.");
  await must(
    db().from("history_scans").upsert(
      inboxes.map((i) => ({
        inbox_id: i.id, status: "queued", phase: "sent", since, page_token: null, messages_read: 0, sent_estimate: null, error: null,
        lock_until: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })),
      { onConflict: "inbox_id" },
    ),
  );
  done(`Scanning ${inboxes.length} inboxes back to ${since}. This page updates by itself; nothing in your mailboxes is changed.`);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

async function importAsLeads(rows: ClassifiedAddress[]) {
  const settings = await new SupabaseStore().getSettings();
  const csv = Papa.unparse(
    rows.map((r) => {
      const n = splitName(r.name);
      return { email: r.email, first_name: n.first, last_name: n.last, last_emailed: day(r.last_sent), emailed_from: r.inboxes.join(" ") };
    }),
  );
  const { rows: leads, rejected } = parseLeadsCsv(csv, { allowShared: settings.allow_shared_inboxes });
  return saveLeads(leads, rejected, "gmail_history");
}

async function suppress(rows: ClassifiedAddress[], reason: "bounce" | "reply_opt_out" | "manual", note: string) {
  const fresh = rows.filter((r) => !r.suppressed);
  for (let i = 0; i < fresh.length; i += 500) {
    await must(
      db().from("suppressions").upsert(fresh.slice(i, i + 500).map((r) => ({ email: r.email, reason, note })), { onConflict: "email", ignoreDuplicates: true }),
    );
  }
  return fresh.length;
}

const GROUPS: HistoryGroup[] = ["bounced", "opted_out", "replied", "recent", "older", "carrier"];

export async function importHistoryGroup(fd: FormData) {
  const group = String(fd.get("group")) as HistoryGroup;
  if (!GROUPS.includes(group)) done("Unknown group.");
  const skip = new Set(fd.getAll("skip").map(String));
  const pick = new Set(fd.getAll("pick").map(String));
  const rows = (await classifiedHistory()).filter((r) => r.group === group && (group === "carrier" ? pick.has(r.email) : !skip.has(r.email)));
  if (!rows.length) done(group === "carrier" ? "Tick the addresses you want to import first." : "Nothing to import in that group.");

  if (group === "bounced") done(`Added ${await suppress(rows, "bounce", "bounced (Gmail history scan)")} addresses to Do not email.`);
  if (group === "opted_out") done(`Added ${await suppress(rows, "reply_opt_out", "asked to stop (Gmail history scan)")} addresses to Do not email.`);

  const summary = await importAsLeads(rows);
  const emails = rows.map((r) => r.email);

  if (group === "replied") {
    // Existing relationships: keep them (and their company) out of cold sequences.
    for (let i = 0; i < emails.length; i += 200) {
      const contacts = await must(db().from("contacts").select("email, company_id").in("email", emails.slice(i, i + 200)));
      const list = (contacts.data ?? []) as { email: string; company_id: string | null }[];
      const companyIds = [...new Set(list.map((c) => c.company_id).filter((id): id is string => !!id))];
      if (companyIds.length) {
        await must(
          db().from("companies").update({ status: "replied", status_reason: "replied before (Gmail history)", status_changed_at: new Date().toISOString() })
            .in("id", companyIds).eq("status", "active"),
        );
      }
      const noCompany = new Set(list.filter((c) => !c.company_id).map((c) => c.email));
      await suppress(rows.filter((r) => noCompany.has(r.email)), "manual", "existing contact, replied before (Gmail history). Write personally, no cold emails.");
    }
    done(`Imported ${summary.added} existing contacts (${summary.alreadyInCrm} were already in Leads). They are kept out of cold sequences.`);
  }

  if (group === "recent") {
    const byDay = new Map<string, string[]>();
    for (const r of rows) byDay.set(day(r.last_sent), [...(byDay.get(day(r.last_sent)) ?? []), r.email]);
    for (const [d, list] of byDay) {
      for (let i = 0; i < list.length; i += 200) {
        await must(
          db().from("contacts")
            .update({ verification_status: "valid", verified_at: new Date().toISOString(), verification_detail: `delivered without a bounce on ${d} (Gmail history)` })
            .in("email", list.slice(i, i + 200)).eq("verification_status", "unverified"),
        );
      }
    }
    done(`Imported ${summary.added} leads as verified (${summary.alreadyInCrm} were already in Leads).`);
  }

  done(`Imported ${summary.added} leads (${summary.alreadyInCrm} were already in Leads). They get checked by the verifier before their first email.`);
}

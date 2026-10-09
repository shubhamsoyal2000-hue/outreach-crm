"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { parseLeadsCsv } from "@/lib/csv-import";
import { domainFromWebsite, normalizeEmail, isValidSyntax } from "@/lib/email-rules";
import { productionDeps } from "@/lib/engine";
import { enrollContacts } from "@/lib/engine/enroll";
import { runTick } from "@/lib/engine/tick";
import { saveLeads } from "@/lib/import-leads";
import { newSessionToken, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";
import { db, SupabaseStore } from "@/lib/store/supabase";
import { QUOTE_STATUSES, type Company, type Contact, type QuoteStatus } from "@/lib/types";

function str(fd: FormData, key: string): string {
  return String(fd.get(key) ?? "").trim();
}

function int(fd: FormData, key: string, fallback: number): number {
  const n = Number(str(fd, key));
  return Number.isFinite(n) && str(fd, key) !== "" ? Math.round(n) : fallback;
}

function done(path: string, msg: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}`);
}

async function must<T extends { data: unknown; error: { message: string } | null }>(
  p: PromiseLike<T>,
): Promise<T & { data: NonNullable<T["data"]> }> {
  const res = await p;
  if (res.error) throw new Error(res.error.message);
  return res as T & { data: NonNullable<T["data"]> };
}

// ---- Login ----

export async function login(fd: FormData) {
  if (!safeEqual(str(fd, "password"), env.appPassword)) redirect("/login?error=1");
  (await cookies()).set(SESSION_COOKIE, newSessionToken(env.sessionSecret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: sessionMaxAge,
    path: "/",
  });
  redirect("/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ---- Settings ----

export async function saveSettings(fd: FormData) {
  const start = int(fd, "send_window_start_hour", 9);
  const end = int(fd, "send_window_end_hour", 16);
  if (end <= start) done("/settings", "The sending window must end after it starts.");
  const postal = str(fd, "postal_address");
  if (postal && !looksLikePostalAddress(postal)) done("/settings", "Enter the full postal address (street, city, state and ZIP). US law requires a real mailing address, not just a ZIP code.");
  const alertEmail = normalizeEmail(str(fd, "alert_email"));
  if (alertEmail && !isValidSyntax(alertEmail)) done("/settings", "The alert email address doesn't look right.");
  await must(
    db().from("settings").update({
      company_name: str(fd, "company_name"),
      postal_address: str(fd, "postal_address"),
      opt_out_line: str(fd, "opt_out_line") || "Not the right person or not interested? Click here and I won't email again:",
      allow_shared_inboxes: str(fd, "allow_shared_inboxes") === "1",
      alert_email: alertEmail,
      default_timezone: str(fd, "default_timezone") || "America/New_York",
      send_window_start_hour: start,
      send_window_end_hour: end,
      updated_at: new Date().toISOString(),
    }).eq("id", 1),
  );
  done("/settings", "Settings saved.");
}

/** A street number, some words and a ZIP-like number: enough to catch "92335" on its own. */
function looksLikePostalAddress(s: string): boolean {
  const t = s.trim();
  return t.length >= 15 && /[a-z]{3,}/i.test(t) && (t.match(/\d+/g) ?? []).length >= 2;
}

export async function setSending(fd: FormData) {
  const on = str(fd, "on") === "1";
  if (on) {
    const s = await new SupabaseStore().getSettings();
    if (!looksLikePostalAddress(s.postal_address)) done("/settings", "Add the full postal address first (street, city, state and ZIP). US law requires it in every email.");
  }
  await must(db().from("settings").update({ sending_enabled: on, updated_at: new Date().toISOString() }).eq("id", 1));
  done("/", on ? "Sending is on." : "Sending is off. Nothing will go out until you turn it back on.");
}

// ---- Inboxes ----

export async function saveInbox(fd: FormData) {
  const id = str(fd, "id");
  const cold = str(fd, "cold_start_date");
  await must(
    db().from("inboxes").update({
      sender_name: str(fd, "sender_name"),
      signature: str(fd, "signature"),
      cold_start_date: cold || null,
      max_daily: Math.min(60, Math.max(0, int(fd, "max_daily", 40))),
    }).eq("id", id),
  );
  done("/inboxes", "Inbox saved.");
}

export async function setInboxStatus(fd: FormData) {
  const id = str(fd, "id");
  const status = str(fd, "status") === "active" ? "active" : "paused";
  if (status === "active") {
    const { data } = await must(db().from("inboxes").select("sender_name, cold_start_date, refresh_token_enc").eq("id", id).single());
    if (!data.refresh_token_enc) done("/inboxes", "Connect this inbox to Gmail first.");
    if (!data.sender_name || !data.cold_start_date) done("/inboxes", "Set the sender name and cold start date before resuming.");
  }
  await must(db().from("inboxes").update({ status, paused_reason: status === "paused" ? "Paused by a team member." : null }).eq("id", id));
  done("/inboxes", status === "active" ? "Inbox resumed." : "Inbox paused.");
}

// ---- Leads ----

export async function importCsv(fd: FormData) {
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) done("/contacts", "Choose a CSV file first.");
  const text = await (file as File).text();
  const settings = await new SupabaseStore().getSettings();
  const { rows, rejected } = parseLeadsCsv(text, { allowShared: settings.allow_shared_inboxes });
  const summary = await saveLeads(rows, rejected, `csv:${(file as File).name}`);
  const reasons = Object.entries(
    summary.rejected.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {}),
  ).map(([r, n]) => `${n} ${r}`);
  done(
    "/contacts",
    `Added ${summary.added} contacts. ${summary.alreadyInCrm} were already in the CRM.` +
      (reasons.length ? ` Skipped: ${reasons.join(", ")}.` : ""),
  );
}

export async function setCompanyDoNotContact(fd: FormData) {
  const store = new SupabaseStore();
  await store.stopCompany(str(fd, "company_id"), "do_not_contact", str(fd, "reason") || "marked by a team member", "company_do_not_contact");
  done("/contacts", "Company marked do-not-contact. Its sequences are stopped.");
}

export async function setCompanyKind(fd: FormData) {
  const kind = str(fd, "kind");
  if (!["importer", "forwarder", "carrier", "other"].includes(kind)) done("/lookup", "Pick a type.");
  await must(db().from("companies").update({ kind }).eq("id", str(fd, "company_id")));
  done(`/lookup?tab=${encodeURIComponent(str(fd, "tab") || "todo")}`, "Saved.");
}

// ---- Suppression ----

/** One entry per line (or comma separated): emails, domains or website addresses. */
export async function addSuppression(fd: FormData) {
  const entries = str(fd, "value").split(/[\n,;]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) done("/suppressions", "Enter at least one email address or domain.");
  const note = str(fd, "note") || undefined;
  const store = new SupabaseStore();
  const added: string[] = [];
  const unusable: string[] = [];
  for (const value of entries) {
    if (value.includes("@")) {
      const email = normalizeEmail(value);
      if (!isValidSyntax(email)) { unusable.push(value); continue; }
      await store.addSuppression({ email, reason: "manual", note });
      const contact = await store.findContactByEmail(email);
      if (contact) await store.stopContactEnrollments(contact.id, "suppressed");
      added.push(email);
    } else {
      const domain = domainFromWebsite(value);
      if (!domain) { unusable.push(value); continue; }
      await store.addSuppression({ domain, reason: "manual", note });
      added.push(domain);
    }
  }
  done(
    "/suppressions",
    (added.length ? `${added.length} added: they will never be emailed.` : "Nothing added.") +
      (unusable.length ? ` Not added (need an email or a website like acme.com): ${unusable.slice(0, 10).join(", ")}${unusable.length > 10 ? "..." : ""}.` : ""),
  );
}

/**
 * Takes a manual entry off the list, for example one added by mistake. Unsubscribes
 * and bounces stay: the law and sender reputation both need them kept.
 */
export async function removeSuppression(fd: FormData) {
  const id = str(fd, "id");
  const { data } = await must(db().from("suppressions").delete().eq("id", id).eq("reason", "manual").select("email, domain"));
  done("/suppressions", data?.length ? `${data[0].email ?? data[0].domain} can be emailed again.` : "Only entries added by hand or by the app's not-monitored check can be removed.");
}

// ---- Sequences ----

// Uses the fields the ImportInfo collector fills in, each with a fallback so a lead missing one still gets a sensible email.
const DEFAULT_STEPS = [
  {
    step_number: 1,
    delay_business_days: 0,
    subject_a: "trucks out of {{top_us_port|the port}}",
    subject_b: "{{top_route_from|import}} containers into {{top_us_port|your port}}",
    body:
      "Hi {{first_name|there}},\n\nI saw {{company|your team}} has containers coming from {{top_route_from|overseas}} into {{top_us_port|US ports}} regularly. We handle drayage and FTL from the port to warehouses across the country, and we usually beat the current rate on the first lane we quote.\n\nWould it be worth sending one lane over for a quick comparison quote?",
  },
  {
    step_number: 2,
    delay_business_days: 3,
    subject_a: null,
    subject_b: null,
    body: "Hi {{first_name|there}}, just bringing this back up. If you share one lane and a typical weekly volume, I will send a rate within the day. No contract or commitment needed.",
  },
  {
    step_number: 3,
    delay_business_days: 4,
    subject_a: null,
    subject_b: null,
    body: "Hi {{first_name|there}}, is trucking out of {{top_us_port|the port}} something you handle, or is there someone else at {{company|your company}} I should ask?",
  },
  {
    step_number: 4,
    delay_business_days: 7,
    subject_a: null,
    subject_b: null,
    body: "Hi {{first_name|there}}, I will stop following up after this one. If capacity or rates out of {{top_us_port|the port}} ever become a headache, reply with a lane and I will quote it the same day.",
  },
];

export async function createSequence(fd: FormData) {
  const name = str(fd, "name") || "Import shippers, first touch";
  const { data } = await must(db().from("sequences").insert({ name }).select("id").single());
  await must(db().from("sequence_steps").insert(DEFAULT_STEPS.map((s) => ({ ...s, sequence_id: data.id }))));
  redirect(`/sequences/${data.id}?msg=${encodeURIComponent("Sequence created from the starter template. Edit the copy before activating it.")}`);
}

export async function saveStep(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const stepNumber = int(fd, "step_number", 1);
  const subjectA = str(fd, "subject_a") || null;
  if (stepNumber === 1 && !subjectA) done(`/sequences/${sequenceId}`, "The first email needs a subject.");
  const body = str(fd, "body");
  if (!body) done(`/sequences/${sequenceId}`, "An email needs a body.");
  await must(
    db().from("sequence_steps").update({
      subject_a: subjectA,
      subject_b: str(fd, "subject_b") || null,
      body,
      delay_business_days: Math.max(stepNumber === 1 ? 0 : 1, int(fd, "delay_business_days", 3)),
    }).eq("sequence_id", sequenceId).eq("step_number", stepNumber),
  );
  done(`/sequences/${sequenceId}`, `Email ${stepNumber} saved.`);
}

export async function addStep(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const { data } = await must(db().from("sequence_steps").select("step_number").eq("sequence_id", sequenceId).order("step_number", { ascending: false }).limit(1));
  const next = (data?.[0]?.step_number ?? 0) + 1;
  await must(db().from("sequence_steps").insert({ sequence_id: sequenceId, step_number: next, delay_business_days: 5, body: "Hi {{first_name}}, ..." , subject_a: next === 1 ? "Subject" : null }));
  done(`/sequences/${sequenceId}`, `Email ${next} added.`);
}

export async function deleteLastStep(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const { data } = await must(db().from("sequence_steps").select("step_number").eq("sequence_id", sequenceId).order("step_number", { ascending: false }).limit(1));
  const last = data?.[0]?.step_number;
  if (!last || last === 1) done(`/sequences/${sequenceId}`, "A sequence needs at least one email.");
  await must(db().from("sequence_steps").delete().eq("sequence_id", sequenceId).eq("step_number", last));
  done(`/sequences/${sequenceId}`, `Email ${last} removed.`);
}

export async function setSequenceStatus(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const status = ["active", "paused", "draft"].includes(str(fd, "status")) ? str(fd, "status") : "paused";
  await must(db().from("sequences").update({ status }).eq("id", sequenceId));
  done(`/sequences/${sequenceId}`, status === "active" ? "Sequence is active." : "Sequence paused. No emails from it will go out.");
}

const ENROLL_WHO = ["importers_researched", "importers_with_data", "importers", "forwarders", "all"] as const;
type EnrollWho = (typeof ENROLL_WHO)[number];

function matchesWho(company: Company | null, who: EnrollWho): boolean {
  if (who === "all") return true;
  const kind = company?.kind ?? "importer";
  if (who === "forwarders") return kind === "forwarder";
  if (kind !== "importer") return false;
  if (who === "importers_researched") return !!company?.facts?.custom_line;
  return who === "importers" || !!company?.facts?.top_us_port || !!company?.facts?.top_route_from;
}

/** Enrolls up to `count` contacts of the chosen kind that are not yet in this sequence and are not blocked. */
export async function enrollBatch(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const count = Math.min(1000, Math.max(1, int(fd, "count", 50)));
  const who = (ENROLL_WHO as readonly string[]).includes(str(fd, "who")) ? (str(fd, "who") as EnrollWho) : "all";
  const store = new SupabaseStore();

  // Anyone already in any sequence (this one or another) is left alone, so nobody gets two cold threads.
  const already = new Set<string>();
  const elsewhere = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const page = await must(db().from("enrollments").select("contact_id, sequence_id").order("id").range(from, from + 999));
    const rows = (page.data ?? []) as { contact_id: string; sequence_id: string }[];
    for (const r of rows) (r.sequence_id === sequenceId ? already : elsewhere).add(r.contact_id);
    if (rows.length < 1000) break;
  }
  let inOther = 0;
  const candidates: { contact: Contact; company: Company | null; alreadyEnrolled: boolean }[] = [];
  for (let from = 0; candidates.length < count; from += 1000) {
    const page = await must(
      db()
        .from("contacts")
        .select("*, company:companies(*)")
        .in("verification_status", ["valid", "catch_all", "unverified"])
        .order("created_at")
        .range(from, from + 999),
    );
    const rows = (page.data ?? []) as (Contact & { company: Company | null })[];
    for (const { company, ...contact } of rows) {
      if (candidates.length >= count) break;
      if (already.has(contact.id) || !matchesWho(company, who)) continue;
      if (elsewhere.has(contact.id)) { inOther++; continue; }
      candidates.push({ contact: contact as Contact, company, alreadyEnrolled: false });
    }
    if (rows.length < 1000) break;
  }

  const summary = await enrollContacts(store, sequenceId, candidates, new Date());
  const skipped = Object.entries({ ...summary.skipped, ...(inOther ? { "already in another sequence": inOther } : {}) }).map(([k, n]) => `${n} ${k}`);
  done(
    `/sequences/${sequenceId}`,
    `Enrolled ${summary.enrolled} contacts.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}` +
      " Anyone you emailed by hand in the last 5 days waits until 5 days have passed.",
  );
}

// ---- Quotes ----

function quoteFields(fd: FormData) {
  const rate = str(fd, "rate_quoted").replace(/[$,\s]/g, "");
  const n = Number(rate);
  return {
    lane_from: str(fd, "lane_from"),
    lane_to: str(fd, "lane_to"),
    equipment: str(fd, "equipment"),
    notes: str(fd, "notes"),
    ...(fd.has("rate_quoted") ? { rate_quoted: rate && Number.isFinite(n) && n >= 0 ? n : null } : {}),
  };
}

export async function saveQuote(fd: FormData) {
  const id = str(fd, "id");
  const status = str(fd, "status") as QuoteStatus;
  if (!QUOTE_STATUSES.includes(status)) done(`/quotes/${id}`, "Pick a status.");
  const res = await db().from("quotes").update({ ...quoteFields(fd), status, updated_at: new Date().toISOString() }).eq("id", id);
  if (res.error?.code === "23505") done(`/quotes/${id}`, "This company already has another open quote. Close that one first.");
  if (res.error) throw new Error(res.error.message);
  done(`/quotes/${id}`, "Saved.");
}

export async function addQuote(fd: FormData) {
  const email = normalizeEmail(str(fd, "from_email"));
  if (!isValidSyntax(email)) done("/quotes", "Enter their email address.");
  const contact = await new SupabaseStore().findContactByEmail(email);
  const now = new Date().toISOString();
  const res = await db()
    .from("quotes")
    .insert({ ...quoteFields(fd), from_email: email, contact_id: contact?.id ?? null, company_id: contact?.company_id ?? null, reply_count: 0, first_reply_at: now, last_reply_at: now })
    .select("id")
    .single();
  if (res.error?.code === "23505") done("/quotes", "That company already has an open quote. Open it from the list to update it.");
  if (res.error) throw new Error(res.error.message);
  done(`/quotes/${res.data.id}`, "Quote added.");
}

// ---- Manual run ----

export async function runNow() {
  const store = new SupabaseStore();
  const deps = productionDeps();
  const { sync, send } = await runTick(store, deps, env.appUrl);
  const sent = send.filter((s) => s.result === "sent").length;
  const replies = sync.reduce((n, s) => n + s.replies, 0);
  const why = send.find((s) => s.result !== "sent");
  done("/", `Checked inboxes: ${replies} new replies. Sent ${sent} emails.${why && "reason" in why ? ` ${why.inbox}: ${why.reason}.` : ""}`);
}

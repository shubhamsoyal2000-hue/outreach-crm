"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { parseLeadsCsv } from "@/lib/csv-import";
import { domainFromWebsite, normalizeEmail, isValidSyntax } from "@/lib/email-rules";
import { productionDeps } from "@/lib/engine";
import { enrollContacts } from "@/lib/engine/enroll";
import { runSendPass } from "@/lib/engine/send";
import { runSyncPass } from "@/lib/engine/sync";
import { saveLeads } from "@/lib/import-leads";
import { newSessionToken, SESSION_COOKIE, sessionMaxAge } from "@/lib/session";
import { db, SupabaseStore } from "@/lib/store/supabase";
import type { Company, Contact } from "@/lib/types";

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
  await must(
    db().from("settings").update({
      company_name: str(fd, "company_name"),
      postal_address: str(fd, "postal_address"),
      opt_out_line: str(fd, "opt_out_line") || "Not the right person or not interested? Click here and I won't email again:",
      default_timezone: str(fd, "default_timezone") || "America/New_York",
      send_window_start_hour: start,
      send_window_end_hour: end,
      updated_at: new Date().toISOString(),
    }).eq("id", 1),
  );
  done("/settings", "Settings saved.");
}

export async function setSending(fd: FormData) {
  const on = str(fd, "on") === "1";
  if (on) {
    const s = await new SupabaseStore().getSettings();
    if (!s.postal_address) done("/settings", "Add the postal address first. US law requires it in every email.");
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
  const { rows, rejected } = parseLeadsCsv(text);
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

// ---- Suppression ----

export async function addSuppression(fd: FormData) {
  const value = str(fd, "value").toLowerCase();
  const store = new SupabaseStore();
  if (value.includes("@")) {
    const email = normalizeEmail(value);
    if (!isValidSyntax(email)) done("/suppressions", "That is not a valid email address.");
    await store.addSuppression({ email, reason: "manual", note: str(fd, "note") || undefined });
    const contact = await store.findContactByEmail(email);
    if (contact) await store.stopContactEnrollments(contact.id, "suppressed");
  } else {
    const domain = domainFromWebsite(value);
    if (!domain) done("/suppressions", "Enter an email address or a domain like acme.com.");
    await store.addSuppression({ domain: domain!, reason: "manual", note: str(fd, "note") || undefined });
  }
  done("/suppressions", `${value} will never be emailed.`);
}

// ---- Sequences ----

const DEFAULT_STEPS = [
  {
    step_number: 1,
    delay_business_days: 0,
    subject_a: "{{commodity}} into {{port}}",
    subject_b: "question about your {{port}} freight",
    body:
      "Hi {{first_name}},\n\nI saw {{company}} has been bringing {{commodity}} in through {{port}}. We move inbound containers from US ports to warehouses across the country, FTL and drayage, and we usually beat the incumbent rate on the first lane we quote.\n\nWould it be worth sending one lane over for a quick comparison quote?",
  },
  {
    step_number: 2,
    delay_business_days: 3,
    subject_a: null,
    subject_b: null,
    body: "Hi {{first_name}}, just bringing this back up. If you share one lane and a typical weekly volume, I will send a rate within the day. No contract or commitment needed.",
  },
  {
    step_number: 3,
    delay_business_days: 4,
    subject_a: null,
    subject_b: null,
    body: "{{first_name}}, is freight from {{port}} something you handle, or is there someone else at {{company}} I should ask?",
  },
  {
    step_number: 4,
    delay_business_days: 7,
    subject_a: null,
    subject_b: null,
    body: "Hi {{first_name}}, I will stop following up after this one. If capacity or rates out of {{port}} ever become a headache, reply with a lane and I will quote it the same day.",
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

/** Enrolls up to `count` contacts that are not yet in this sequence and are not blocked. */
export async function enrollBatch(fd: FormData) {
  const sequenceId = str(fd, "sequence_id");
  const count = Math.min(1000, Math.max(1, int(fd, "count", 50)));
  const store = new SupabaseStore();

  const enrolled = await must(db().from("enrollments").select("contact_id").eq("sequence_id", sequenceId));
  const already = new Set((enrolled.data ?? []).map((r) => r.contact_id));
  const pool = await must(
    db()
      .from("contacts")
      .select("*, company:companies(*)")
      .in("verification_status", ["valid", "catch_all", "unverified"])
      .order("created_at")
      .limit(count + already.size),
  );
  const candidates = (pool.data ?? [])
    .filter((c: { id: string }) => !already.has(c.id))
    .slice(0, count)
    .map(({ company, ...contact }: Contact & { company: Company | null }) => ({ contact: contact as Contact, company, alreadyEnrolled: false }));

  const summary = await enrollContacts(store, sequenceId, candidates, new Date());
  const skipped = Object.entries(summary.skipped).map(([k, n]) => `${n} ${k}`);
  done(`/sequences/${sequenceId}`, `Enrolled ${summary.enrolled} contacts.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}`);
}

// ---- Manual run ----

export async function runNow() {
  const store = new SupabaseStore();
  const deps = productionDeps();
  const sync = await runSyncPass(store, deps);
  const send = await runSendPass(store, deps);
  const sent = send.filter((s) => s.result === "sent").length;
  const replies = sync.reduce((n, s) => n + s.replies, 0);
  const why = send.find((s) => s.result !== "sent");
  done("/", `Checked inboxes: ${replies} new replies. Sent ${sent} emails.${why && "reason" in why ? ` ${why.inbox}: ${why.reason}.` : ""}`);
}

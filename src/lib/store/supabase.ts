import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config";
import { emailDomain } from "../email-rules";
import type { Company, Contact, DueItem, Enrollment, Inbox, SequenceStep, Settings, VerificationStatus } from "../types";
import type { NewEnrollment, NewMessage, Store } from "./types";

let client: SupabaseClient | null = null;

/** Server-only client with the service role key. Never import this from a client component. */
export function db(): SupabaseClient {
  client ??= createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false } });
  return client;
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

async function companyContactIds(companyId: string): Promise<string[]> {
  const rows = check(await db().from("contacts").select("id").eq("company_id", companyId), "company contacts");
  return (rows ?? []).map((r: { id: string }) => r.id);
}

export class SupabaseStore implements Store {
  async getSettings(): Promise<Settings> {
    const row = check(await db().from("settings").select("*").eq("id", 1).single(), "settings");
    return { ...row, catch_all_max_share: Number(row.catch_all_max_share), bounce_pause_rate: Number(row.bounce_pause_rate) };
  }

  async listInboxes(): Promise<Inbox[]> {
    return check(await db().from("inboxes").select("*").order("created_at"), "inboxes") ?? [];
  }

  async updateInbox(id: string, patch: Partial<Inbox>) {
    check(await db().from("inboxes").update(patch).eq("id", id), "update inbox");
  }

  async claimInbox(id: string, now: Date, lockMs: number) {
    const rows = check(
      await db()
        .from("inboxes")
        .update({ lock_until: new Date(now.getTime() + lockMs).toISOString() })
        .eq("id", id)
        .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
        .select("id"),
      "claim inbox",
    );
    return (rows ?? []).length > 0;
  }

  async releaseInbox(id: string) {
    check(await db().from("inboxes").update({ lock_until: null }).eq("id", id), "release inbox");
  }

  async countSentOnDay(inboxId: string, sendDay: string) {
    const base = () => db().from("messages").select("id", { count: "exact", head: true }).eq("inbox_id", inboxId).eq("kind", "sent").eq("send_day", sendDay);
    const total = await base();
    const catchAll = await base().eq("catch_all", true);
    if (total.error || catchAll.error) throw new Error(`count sent: ${(total.error ?? catchAll.error)!.message}`);
    return { total: total.count ?? 0, catchAll: catchAll.count ?? 0 };
  }

  async recentBounceStats(inboxId: string, n: number) {
    const sent = check(
      await db().from("messages").select("contact_id").eq("inbox_id", inboxId).eq("kind", "sent").order("occurred_at", { ascending: false }).limit(n),
      "recent sends",
    ) ?? [];
    const ids = [...new Set(sent.map((m: { contact_id: string | null }) => m.contact_id).filter(Boolean))] as string[];
    if (!ids.length) return { sent: 0, bounced: 0 };
    const bounced = await db().from("messages").select("id", { count: "exact", head: true }).eq("inbox_id", inboxId).eq("kind", "bounce").in("contact_id", ids);
    if (bounced.error) throw new Error(`recent bounces: ${bounced.error.message}`);
    return { sent: sent.length, bounced: bounced.count ?? 0 };
  }

  async dueItems(inboxId: string, now: Date, limit: number): Promise<DueItem[]> {
    const rows = check(
      await db()
        .from("enrollments")
        .select("*, contact:contacts(*, company:companies(*)), sequence:sequences(status, steps:sequence_steps(step_number, delay_business_days, subject_a, subject_b, body))")
        .eq("inbox_id", inboxId)
        .eq("status", "active")
        .lte("next_send_at", now.toISOString())
        .order("next_send_at")
        .limit(limit),
      "due enrollments",
    ) ?? [];
    return rows.map((r: Enrollment & { contact: Contact & { company: Company | null }; sequence: { status: DueItem["sequenceStatus"]; steps: SequenceStep[] } }) => {
      const { contact, sequence, ...enrollment } = r;
      const { company, ...c } = contact;
      return {
        enrollment,
        contact: c,
        company,
        sequenceStatus: sequence.status,
        steps: [...sequence.steps].sort((a, b) => a.step_number - b.step_number),
      };
    });
  }

  async isSuppressed(email: string) {
    const byEmail = check(await db().from("suppressions").select("id").eq("email", email).limit(1), "suppression");
    if (byEmail?.length) return true;
    const byDomain = check(await db().from("suppressions").select("id").eq("domain", emailDomain(email)).limit(1), "suppression");
    return !!byDomain?.length;
  }

  async companyFirstTouchOnDay(companyId: string, sendDay: string) {
    const ids = await companyContactIds(companyId);
    if (!ids.length) return false;
    const res = await db().from("messages").select("id", { count: "exact", head: true }).eq("kind", "sent").eq("step_number", 1).eq("send_day", sendDay).in("contact_id", ids);
    if (res.error) throw new Error(`company first touch: ${res.error.message}`);
    return (res.count ?? 0) > 0;
  }

  async updateEnrollment(id: string, patch: Partial<Enrollment>) {
    check(await db().from("enrollments").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id), "update enrollment");
  }

  async updateContactVerification(id: string, status: VerificationStatus, detail: string | null, at: Date) {
    check(
      await db().from("contacts").update({ verification_status: status, verification_detail: detail, verified_at: at.toISOString() }).eq("id", id),
      "update verification",
    );
  }

  async recordMessage(m: NewMessage) {
    const res = await db().from("messages").insert(m);
    if (res.error?.code === "23505") return false;
    if (res.error) throw new Error(`record message: ${res.error.message}`);
    return true;
  }

  async findEnrollmentByThread(inboxId: string, threadId: string) {
    const rows = check(await db().from("enrollments").select("*").eq("inbox_id", inboxId).eq("gmail_thread_id", threadId).limit(1), "thread lookup");
    return rows?.[0] ?? null;
  }

  async getContact(id: string) {
    return check(await db().from("contacts").select("*").eq("id", id).maybeSingle(), "contact");
  }

  async findContactByEmail(email: string) {
    return check(await db().from("contacts").select("*").eq("email", email).maybeSingle(), "contact by email");
  }

  async findCompanyByDomain(domain: string) {
    return check(await db().from("companies").select("*").eq("domain", domain).maybeSingle(), "company by domain");
  }

  async stopCompany(companyId: string, status: Company["status"], reason: string, stopReason: string) {
    check(
      await db().from("companies").update({ status, status_reason: reason, status_changed_at: new Date().toISOString() }).eq("id", companyId),
      "update company",
    );
    const ids = await companyContactIds(companyId);
    if (ids.length) {
      check(
        await db().from("enrollments").update({ status: "stopped", stop_reason: stopReason, updated_at: new Date().toISOString() }).eq("status", "active").in("contact_id", ids),
        "stop company enrollments",
      );
    }
  }

  async stopContactEnrollments(contactId: string, stopReason: string) {
    check(
      await db().from("enrollments").update({ status: "stopped", stop_reason: stopReason, updated_at: new Date().toISOString() }).eq("status", "active").eq("contact_id", contactId),
      "stop enrollments",
    );
  }

  async addSuppression(s: { email?: string; domain?: string; reason: string; note?: string }) {
    const onConflict = s.email ? "email" : "domain";
    check(await db().from("suppressions").upsert(s, { onConflict, ignoreDuplicates: true }), "add suppression");
  }

  async activeEnrollmentCounts() {
    const counts: Record<string, number> = {};
    for (const inbox of await this.listInboxes()) {
      const res = await db().from("enrollments").select("id", { count: "exact", head: true }).eq("inbox_id", inbox.id).eq("status", "active");
      counts[inbox.id] = res.count ?? 0;
    }
    return counts;
  }

  async createEnrollments(rows: NewEnrollment[]) {
    let created = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const res = await db()
        .from("enrollments")
        .upsert(rows.slice(i, i + 500), { onConflict: "sequence_id,contact_id", ignoreDuplicates: true })
        .select("id");
      created += check(res, "create enrollments")?.length ?? 0;
    }
    return created;
  }
}

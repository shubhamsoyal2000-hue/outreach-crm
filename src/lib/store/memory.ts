import { randomUUID } from "node:crypto";
import { domainAndParents, emailDomain } from "../email-rules";
import type { Company, Contact, DueItem, Enrollment, Inbox, Quote, SequenceStep, Settings, VerificationStatus } from "../types";
import type { EnrollCandidate, NewEnrollment, NewMessage, ReplyForQuote, Store } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  sending_enabled: false,
  company_name: "",
  postal_address: "",
  opt_out_line: "Not the right person or not interested? Click here and I won't email again:",
  allow_shared_inboxes: false,
  alert_email: "",
  default_timezone: "America/New_York",
  send_window_start_hour: 9,
  send_window_end_hour: 16,
  ramp_start_per_day: 10,
  ramp_step_per_business_day: 2,
  catch_all_max_share: 0.1,
  verification_max_age_days: 30,
  bounce_pause_rate: 0.03,
  bounce_window_sends: 100,
  bounce_min_sends: 20,
  out_of_office_hold_business_days: 5,
};

interface Sequence {
  id: string;
  status: "draft" | "active" | "paused";
  steps: SequenceStep[];
}

type StoredMessage = NewMessage & { id: string };

/** In-memory Store used by the tests and for trying the engine without a database. */
export class MemoryStore implements Store {
  settings: Settings = { ...DEFAULT_SETTINGS };
  inboxes: (Inbox & { lock_until?: string | null })[] = [];
  companies: Company[] = [];
  contacts: Contact[] = [];
  sequences: Sequence[] = [];
  enrollments: Enrollment[] = [];
  messages: StoredMessage[] = [];
  suppressions: { email?: string; domain?: string; reason: string }[] = [];
  quotes: Quote[] = [];

  async getSettings() { return this.settings; }
  async listInboxes() { return this.inboxes.map((i) => ({ ...i })); }
  async updateInbox(id: string, patch: Partial<Inbox>) { Object.assign(this.inboxes.find((i) => i.id === id)!, patch); }

  async claimInbox(id: string, now: Date, lockMs: number) {
    const inbox = this.inboxes.find((i) => i.id === id)!;
    if (inbox.lock_until && new Date(inbox.lock_until) > now) return false;
    inbox.lock_until = new Date(now.getTime() + lockMs).toISOString();
    return true;
  }
  async releaseInbox(id: string) { this.inboxes.find((i) => i.id === id)!.lock_until = null; }

  async countSentOnDay(inboxId: string, sendDay: string) {
    const sent = this.messages.filter((m) => m.inbox_id === inboxId && m.kind === "sent" && m.send_day === sendDay);
    return { total: sent.length, catchAll: sent.filter((m) => m.catch_all).length };
  }

  async recentBounceStats(inboxId: string, n: number) {
    const sent = this.messages.filter((m) => m.inbox_id === inboxId && m.kind === "sent").slice(-n);
    const contacts = new Set(sent.map((m) => m.contact_id));
    const bounced = this.messages.filter((m) => m.inbox_id === inboxId && m.kind === "bounce" && contacts.has(m.contact_id)).length;
    return { sent: sent.length, bounced };
  }

  async dueItems(inboxId: string, now: Date, limit: number): Promise<DueItem[]> {
    return this.enrollments
      .filter((e) => e.inbox_id === inboxId && e.status === "active" && new Date(e.next_send_at) <= now)
      .sort((a, b) => a.next_send_at.localeCompare(b.next_send_at))
      .slice(0, limit)
      .map((e) => {
        const contact = this.contacts.find((c) => c.id === e.contact_id)!;
        const seq = this.sequences.find((s) => s.id === e.sequence_id)!;
        return {
          enrollment: { ...e },
          contact: { ...contact },
          company: this.companies.find((c) => c.id === contact.company_id) ?? null,
          sequenceStatus: seq.status,
          steps: seq.steps,
        };
      });
  }

  async isSuppressed(email: string) {
    const domains = domainAndParents(emailDomain(email));
    return this.suppressions.some((s) => s.email === email || (!!s.domain && domains.includes(s.domain)));
  }

  async companyFirstTouchOnDay(companyId: string, sendDay: string) {
    const ids = new Set(this.contacts.filter((c) => c.company_id === companyId).map((c) => c.id));
    return this.messages.some((m) => m.kind === "sent" && m.step_number === 1 && m.send_day === sendDay && ids.has(m.contact_id!));
  }

  async updateEnrollment(id: string, patch: Partial<Enrollment>) { Object.assign(this.enrollments.find((e) => e.id === id)!, patch); }

  async updateContactVerification(id: string, status: VerificationStatus, detail: string | null, at: Date) {
    void detail;
    Object.assign(this.contacts.find((c) => c.id === id)!, { verification_status: status, verified_at: at.toISOString() });
  }

  async recordMessage(m: NewMessage) {
    if (m.gmail_message_id && this.messages.some((x) => x.gmail_message_id === m.gmail_message_id)) return false;
    this.messages.push({ ...m, id: randomUUID() });
    return true;
  }

  async findEnrollmentByThread(inboxId: string, threadId: string) {
    return this.enrollments.find((e) => e.inbox_id === inboxId && e.gmail_thread_id === threadId) ?? null;
  }
  async getContact(id: string) { return this.contacts.find((c) => c.id === id) ?? null; }
  async findContactByEmail(email: string) { return this.contacts.find((c) => c.email === email) ?? null; }
  async findCompanyByDomain(domain: string) { return this.companies.find((c) => c.domain === domain) ?? null; }

  async recordQuoteReply(r: ReplyForQuote) {
    const open = this.quotes.find(
      (q) => !["won", "lost"].includes(q.status) && (r.company_id ? q.company_id === r.company_id : !q.company_id && q.from_email === r.from_email),
    );
    if (!open) {
      this.quotes.push({
        id: randomUUID(), company_id: r.company_id, contact_id: r.contact_id, inbox_id: r.inbox_id, from_email: r.from_email,
        gmail_thread_id: r.gmail_thread_id, status: "new", lane_from: "", lane_to: "", equipment: "", rate_quoted: null, notes: "",
        reply_count: 1, last_reply_snippet: r.snippet, first_reply_at: r.at, last_reply_at: r.at,
      });
      return;
    }
    open.reply_count++;
    if (r.at >= open.last_reply_at) Object.assign(open, { last_reply_at: r.at, last_reply_snippet: r.snippet, gmail_thread_id: r.gmail_thread_id, inbox_id: r.inbox_id });
  }

  async stopCompany(companyId: string, status: Company["status"], reason: string, stopReason: string) {
    void reason;
    const company = this.companies.find((c) => c.id === companyId);
    if (company) company.status = status;
    const ids = new Set(this.contacts.filter((c) => c.company_id === companyId).map((c) => c.id));
    for (const e of this.enrollments) {
      if (ids.has(e.contact_id) && e.status === "active") Object.assign(e, { status: "stopped", stop_reason: stopReason });
    }
  }

  async stopContactEnrollments(contactId: string, stopReason: string) {
    for (const e of this.enrollments) {
      if (e.contact_id === contactId && e.status === "active") Object.assign(e, { status: "stopped", stop_reason: stopReason });
    }
  }

  async addSuppression(s: { email?: string; domain?: string; reason: string }) {
    if (!this.suppressions.some((x) => (s.email && x.email === s.email) || (s.domain && x.domain === s.domain))) this.suppressions.push(s);
  }

  async activeEnrollmentCounts() {
    const counts: Record<string, number> = {};
    for (const e of this.enrollments) if (e.status === "active") counts[e.inbox_id] = (counts[e.inbox_id] ?? 0) + 1;
    return counts;
  }

  async createEnrollments(rows: NewEnrollment[]) {
    for (const r of rows) {
      this.enrollments.push({
        ...r,
        id: randomUUID(),
        status: "active",
        stop_reason: null,
        next_step: 1,
        thread_subject: null,
        gmail_thread_id: null,
        last_rfc_message_id: null,
      });
    }
    return rows.length;
  }

  candidates(sequenceId: string, contactIds: string[]): EnrollCandidate[] {
    return contactIds.map((id) => {
      const contact = this.contacts.find((c) => c.id === id)!;
      return {
        contact,
        company: this.companies.find((c) => c.id === contact.company_id) ?? null,
        alreadyEnrolled: this.enrollments.some((e) => e.sequence_id === sequenceId && e.contact_id === id),
      };
    });
  }
}

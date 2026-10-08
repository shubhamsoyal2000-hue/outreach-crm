import type { Company, Contact, DueItem, Enrollment, InboundKind, Inbox, Settings, VerificationStatus } from "../types";

export interface NewMessage {
  inbox_id: string;
  enrollment_id: string | null;
  contact_id: string | null;
  direction: "outbound" | "inbound";
  kind: "sent" | InboundKind;
  step_number?: number | null;
  subject_variant?: string | null;
  catch_all?: boolean;
  send_day?: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  rfc_message_id?: string | null;
  from_email?: string | null;
  subject?: string | null;
  snippet?: string | null;
  occurred_at: string;
}

export interface ReplyForQuote {
  company_id: string | null;
  contact_id: string | null;
  inbox_id: string;
  from_email: string;
  gmail_thread_id: string;
  snippet: string;
  at: string;
}

export interface NewEnrollment {
  sequence_id: string;
  contact_id: string;
  inbox_id: string;
  subject_variant: "a" | "b";
  next_send_at: string;
}

export interface EnrollCandidate {
  contact: Contact;
  company: Company | null;
  alreadyEnrolled: boolean;
}

/** Everything the engine needs from the database. Supabase in production, memory in tests. */
export interface Store {
  getSettings(): Promise<Settings>;
  listInboxes(): Promise<Inbox[]>;
  updateInbox(id: string, patch: Partial<Inbox>): Promise<void>;
  /** Takes a short lock so two overlapping cron runs never send from one inbox at once. */
  claimInbox(id: string, now: Date, lockMs: number): Promise<boolean>;
  releaseInbox(id: string): Promise<void>;

  countSentOnDay(inboxId: string, sendDay: string): Promise<{ total: number; catchAll: number }>;
  /** Of this inbox's last `n` sends, how many have bounced. */
  recentBounceStats(inboxId: string, n: number): Promise<{ sent: number; bounced: number }>;
  dueItems(inboxId: string, now: Date, limit: number): Promise<DueItem[]>;
  isSuppressed(email: string): Promise<boolean>;
  /** True if any contact at this company got a first email on this day, from any inbox. */
  companyFirstTouchOnDay(companyId: string, sendDay: string): Promise<boolean>;

  updateEnrollment(id: string, patch: Partial<Enrollment>): Promise<void>;
  updateContactVerification(id: string, status: VerificationStatus, detail: string | null, at: Date): Promise<void>;
  /** Returns false when the Gmail message was already recorded. */
  recordMessage(m: NewMessage): Promise<boolean>;

  findEnrollmentByThread(inboxId: string, threadId: string): Promise<Enrollment | null>;
  getContact(id: string): Promise<Contact | null>;
  findContactByEmail(email: string): Promise<Contact | null>;
  findCompanyByDomain(domain: string): Promise<Company | null>;
  /** Marks the company and stops every active enrollment of its contacts. */
  stopCompany(companyId: string, status: Company["status"], reason: string, stopReason: string): Promise<void>;
  stopContactEnrollments(contactId: string, stopReason: string): Promise<void>;
  addSuppression(s: { email?: string; domain?: string; reason: string; note?: string }): Promise<void>;
  /** Opens a quote for the company (or sender), or adds the reply to its open one. */
  recordQuoteReply(r: ReplyForQuote): Promise<void>;

  activeEnrollmentCounts(): Promise<Record<string, number>>;
  createEnrollments(rows: NewEnrollment[]): Promise<number>;
}

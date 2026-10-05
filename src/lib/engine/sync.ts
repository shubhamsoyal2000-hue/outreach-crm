import { classifyInbound, parseAddress } from "../classify";
import { emailDomain, isFreemailDomain } from "../email-rules";
import type { Store } from "../store/types";
import { addBusinessDays, localDay, randomTimeInWindow } from "../time";
import type { Contact, Enrollment, Inbox, Settings } from "../types";
import { MailerError, type EngineDeps } from "./ports";
import { recipientTimezone } from "./send";

export interface SyncOutcome {
  inbox: string;
  replies: number;
  bounces: number;
  autoReplies: number;
  optOuts: number;
  error?: string;
}

const FIRST_SYNC_LOOKBACK_MS = 3 * 86_400_000;
const OVERLAP_MS = 10 * 60_000;

/**
 * Reads new mail in one inbox and acts on anything that answers our emails:
 * a reply or opt-out stops the sequence for the whole company, a hard bounce
 * suppresses the address, an out-of-office holds the sequence for a few days.
 * Mail that matches none of our contacts (including warm-up traffic) is ignored.
 */
export async function syncInbox(store: Store, deps: EngineDeps, settings: Settings, inbox: Inbox): Promise<SyncOutcome> {
  const out: SyncOutcome = { inbox: inbox.email, replies: 0, bounces: 0, autoReplies: 0, optOuts: 0 };
  if (inbox.status === "disconnected" || !inbox.refresh_token_enc) return out;
  const now = deps.now();
  const since = inbox.last_synced_at
    ? new Date(new Date(inbox.last_synced_at).getTime() - OVERLAP_MS)
    : new Date(now.getTime() - FIRST_SYNC_LOOKBACK_MS);

  let messages;
  try {
    messages = await deps.mailer.listInbound(inbox, since);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    if (err instanceof MailerError && err.code === "auth") {
      await store.updateInbox(inbox.id, { status: "disconnected", paused_reason: `Gmail connection lost, reconnect the inbox (${out.error})` });
    }
    return out;
  }

  for (const msg of messages) {
    const from = parseAddress(msg.from);
    if (from === inbox.email) continue;
    const cls = classifyInbound(msg);

    const enrollment = await store.findEnrollmentByThread(inbox.id, msg.threadId);
    let contact: Contact | null = enrollment ? await store.getContact(enrollment.contact_id) : null;
    if (!contact && cls.kind === "bounce" && cls.failedRecipient) contact = await store.findContactByEmail(cls.failedRecipient);
    if (!contact && cls.kind !== "bounce") contact = await store.findContactByEmail(from);

    // A colleague at the same company answering from their own address still counts.
    let companyId = contact?.company_id ?? null;
    if (!companyId && cls.kind !== "bounce") {
      const domain = emailDomain(from);
      if (!isFreemailDomain(domain)) companyId = (await store.findCompanyByDomain(domain))?.id ?? null;
    }
    if (!contact && !companyId) continue;

    const recorded = await store.recordMessage({
      inbox_id: inbox.id,
      enrollment_id: enrollment?.id ?? null,
      contact_id: contact?.id ?? null,
      direction: "inbound",
      // Soft bounces (mailbox full, delayed) are logged but do not count against the inbox.
      kind: cls.kind === "bounce" && !cls.hardBounce ? "other" : cls.kind,
      gmail_message_id: msg.id,
      gmail_thread_id: msg.threadId,
      from_email: from,
      subject: msg.subject,
      snippet: msg.snippet.slice(0, 500),
      occurred_at: msg.internalDate.toISOString(),
    });
    if (!recorded) continue;

    switch (cls.kind) {
      case "bounce":
        if (!cls.hardBounce || !contact) break;
        out.bounces++;
        await store.addSuppression({ email: contact.email, reason: "bounce", note: msg.snippet.slice(0, 200) });
        await store.updateContactVerification(contact.id, "invalid", "hard bounce", now);
        await store.stopContactEnrollments(contact.id, "bounced");
        break;
      case "auto_reply":
        out.autoReplies++;
        if (enrollment?.status === "active") await holdEnrollment(store, deps, settings, enrollment, contact, now);
        break;
      case "unsubscribe_reply":
        out.optOuts++;
        if (contact) {
          await store.addSuppression({ email: contact.email, reason: "reply_opt_out", note: msg.snippet.slice(0, 200) });
          await store.stopContactEnrollments(contact.id, "unsubscribed");
        } else {
          await store.addSuppression({ email: from, reason: "reply_opt_out", note: msg.snippet.slice(0, 200) });
        }
        if (companyId) await store.stopCompany(companyId, "replied", "asked to stop emails", "company_replied");
        break;
      case "reply":
        out.replies++;
        if (contact) await store.stopContactEnrollments(contact.id, "replied");
        if (companyId) await store.stopCompany(companyId, "replied", `reply from ${from}`, "company_replied");
        break;
    }
  }

  await store.updateInbox(inbox.id, { last_synced_at: now.toISOString() });
  return out;
}

async function holdEnrollment(
  store: Store,
  deps: EngineDeps,
  settings: Settings,
  e: Enrollment,
  contact: Contact | null,
  now: Date,
) {
  const tz = contact ? recipientTimezone({ contact, company: null }, settings) : settings.default_timezone;
  const day = addBusinessDays(localDay(now, tz), settings.out_of_office_hold_business_days);
  const until = randomTimeInWindow(day, tz, { startHour: settings.send_window_start_hour, endHour: settings.send_window_end_hour }, deps.rng);
  if (until > new Date(e.next_send_at)) await store.updateEnrollment(e.id, { next_send_at: until.toISOString() });
}

export async function runSyncPass(store: Store, deps: EngineDeps): Promise<SyncOutcome[]> {
  const settings = await store.getSettings();
  const inboxes = await store.listInboxes();
  const outcomes: SyncOutcome[] = [];
  for (const inbox of inboxes) outcomes.push(await syncInbox(store, deps, settings, inbox));
  return outcomes;
}

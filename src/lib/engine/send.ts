import { composeEmail } from "../compose";
import { buildRawMessage } from "../mime";
import type { Store } from "../store/types";
import {
  addBusinessDays,
  isWithinWindow,
  localDay,
  localParts,
  nextBusinessDay,
  nextWindowStart,
  randomTimeInWindow,
  timezoneForState,
  ymdToString,
  type Window,
} from "../time";
import type { DueItem, Inbox, Settings } from "../types";
import { dailyCap, nextGapMinutes } from "../warmup";
import { MailerError, type EngineDeps } from "./ports";

export type SendOutcome =
  | { inbox: string; result: "sent"; enrollmentId: string; step: number }
  | { inbox: string; result: "skipped"; reason: string }
  | { inbox: string; result: "paused"; reason: string }
  | { inbox: string; result: "error"; reason: string };

const LOCK_MS = 2 * 60 * 1000;
const DUE_BATCH = 25;

export function recipientTimezone(item: Pick<DueItem, "contact" | "company">, settings: Settings): string {
  return item.contact.timezone || timezoneForState(item.company?.state) || settings.default_timezone;
}

function windowOf(settings: Settings): Window {
  return { startHour: settings.send_window_start_hour, endHour: settings.send_window_end_hour };
}

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

/** Sending-wide reasons nothing may go out at all. */
export function globalBlock(settings: Settings): string | null {
  if (!settings.sending_enabled) return "sending is turned off in Settings";
  if (!settings.postal_address.trim()) return "the postal address required by CAN-SPAM is missing in Settings";
  return null;
}

/**
 * One pass for one inbox: sends at most one email, then schedules the inbox's
 * next send so the day's quota spreads across the sending window.
 */
export async function runInboxSend(store: Store, deps: EngineDeps, settings: Settings, inbox: Inbox): Promise<SendOutcome> {
  const now = deps.now();
  const skip = (reason: string): SendOutcome => ({ inbox: inbox.email, result: "skipped", reason });

  if (inbox.status !== "active") return skip(`inbox is ${inbox.status}`);
  if (inbox.next_send_after && new Date(inbox.next_send_after) > now) return skip("spacing between sends");

  const teamTz = settings.default_timezone;
  const today = localDay(now, teamTz);
  const sendDay = ymdToString(today);
  const cap = dailyCap(inbox, today, settings);
  if (cap === 0) return skip(inbox.cold_start_date ? "not a sending day" : "no cold start date set");
  const counts = await store.countSentOnDay(inbox.id, sendDay);
  if (counts.total >= cap) return skip(`daily cap of ${cap} reached`);

  const health = await store.recentBounceStats(inbox.id, settings.bounce_window_sends);
  if (health.sent >= settings.bounce_min_sends && health.bounced / health.sent > settings.bounce_pause_rate) {
    const pct = ((health.bounced / health.sent) * 100).toFixed(1);
    const reason = `bounce rate ${pct}% over the last ${health.sent} sends is above ${(settings.bounce_pause_rate * 100).toFixed(1)}%`;
    await store.updateInbox(inbox.id, { status: "paused", paused_reason: reason });
    return { inbox: inbox.email, result: "paused", reason };
  }

  if (!(await store.claimInbox(inbox.id, now, LOCK_MS))) return skip("another run holds this inbox");
  try {
    const items = await store.dueItems(inbox.id, now, DUE_BATCH);
    const w = windowOf(settings);
    for (const item of items) {
      const outcome = await tryItem(store, deps, settings, inbox, item, { now, w, sendDay, cap, counts });
      if (outcome) return outcome;
    }
    return skip(items.length ? "nothing sendable right now" : "no emails due");
  } finally {
    await store.releaseInbox(inbox.id);
  }
}

interface Ctx {
  now: Date;
  w: Window;
  sendDay: string;
  cap: number;
  counts: { total: number; catchAll: number };
}

/** Handles one due enrollment. Returns an outcome if this pass is done, null to try the next one. */
async function tryItem(
  store: Store,
  deps: EngineDeps,
  settings: Settings,
  inbox: Inbox,
  item: DueItem,
  ctx: Ctx,
): Promise<SendOutcome | null> {
  const { enrollment: e, contact, company } = item;
  const { now, w } = ctx;
  const stop = (reason: string) => store.updateEnrollment(e.id, { status: "stopped", stop_reason: reason });
  const tz = recipientTimezone(item, settings);

  if (item.sequenceStatus !== "active") return null;

  if (!isWithinWindow(now, tz, w)) {
    const start = nextWindowStart(now, tz, w);
    await store.updateEnrollment(e.id, { next_send_at: addMinutes(start, Math.floor(deps.rng() * 90)).toISOString() });
    return null;
  }

  if (await store.isSuppressed(contact.email)) {
    await stop("suppressed");
    return null;
  }
  if (company?.status === "replied") {
    await stop("company_replied");
    return null;
  }
  if (company?.status === "do_not_contact") {
    await stop("company_do_not_contact");
    return null;
  }

  const step = item.steps.find((s) => s.step_number === e.next_step);
  if (!step) {
    await store.updateEnrollment(e.id, { status: "completed" });
    return null;
  }

  let catchAll = false;
  if (e.next_step === 1) {
    // One first email per company per day, so a company never gets a burst.
    if (company && (await store.companyFirstTouchOnDay(company.id, ctx.sendDay))) {
      await deferToNextDay(store, deps, e.id, now, tz, w);
      return null;
    }
    // Verification gate: the first email only goes to an address checked recently.
    let status = contact.verification_status;
    const maxAgeMs = settings.verification_max_age_days * 86_400_000;
    const fresh = contact.verified_at && now.getTime() - new Date(contact.verified_at).getTime() <= maxAgeMs;
    if (status === "unverified" || !fresh) {
      if (!deps.verifier) return null; // waits until a verification API key is configured
      const result = await deps.verifier.verify(contact.email, { allowShared: settings.allow_shared_inboxes });
      status = result.status;
      await store.updateContactVerification(contact.id, result.status, result.detail, now);
    }
    if (status === "catch_all") {
      catchAll = true;
      if (ctx.counts.catchAll >= Math.floor(ctx.cap * settings.catch_all_max_share)) {
        await deferToNextDay(store, deps, e.id, now, tz, w);
        return null;
      }
    } else if (status !== "valid") {
      await stop("verification_failed");
      return null;
    }
  }

  const composed = composeEmail({
    settings,
    inbox,
    contact,
    company,
    enrollment: e,
    step,
    unsubscribeUrl: deps.unsubscribeUrl(contact.id),
  });
  if (!composed.ok) {
    await stop(`missing_field:${composed.missing.join(",")}`);
    return null;
  }

  const threaded = !composed.newThread && e.gmail_thread_id && e.last_rfc_message_id;
  const raw = buildRawMessage({
    fromName: inbox.sender_name,
    fromEmail: inbox.email,
    to: contact.email,
    subject: composed.subject,
    body: composed.body,
    inReplyTo: threaded ? e.last_rfc_message_id : null,
    references: threaded ? e.last_rfc_message_id : null,
    listUnsubscribeUrl: deps.unsubscribeUrl(contact.id),
    listUnsubscribeMailto: `mailto:${inbox.email}?subject=unsubscribe`,
  });

  let sent;
  try {
    sent = await deps.mailer.send(inbox, raw, threaded ? e.gmail_thread_id : null);
  } catch (err) {
    return handleSendError(store, inbox, err, now);
  }

  await store.recordMessage({
    inbox_id: inbox.id,
    enrollment_id: e.id,
    contact_id: contact.id,
    direction: "outbound",
    kind: "sent",
    step_number: step.step_number,
    subject_variant: e.subject_variant,
    catch_all: catchAll,
    send_day: ctx.sendDay,
    gmail_message_id: sent.messageId,
    gmail_thread_id: sent.threadId,
    rfc_message_id: sent.rfcMessageId,
    subject: composed.subject,
    occurred_at: now.toISOString(),
  });

  const nextStep = item.steps.find((s) => s.step_number === step.step_number + 1);
  const threadPatch = composed.newThread
    ? { thread_subject: composed.subject, gmail_thread_id: sent.threadId, last_rfc_message_id: sent.rfcMessageId }
    : { gmail_thread_id: sent.threadId, last_rfc_message_id: sent.rfcMessageId ?? e.last_rfc_message_id };
  if (nextStep) {
    const day = addBusinessDays(localDay(now, tz), Math.max(1, nextStep.delay_business_days));
    await store.updateEnrollment(e.id, {
      ...threadPatch,
      next_step: nextStep.step_number,
      next_send_at: randomTimeInWindow(day, tz, w, deps.rng).toISOString(),
    });
  } else {
    await store.updateEnrollment(e.id, { ...threadPatch, next_step: step.step_number + 1, status: "completed" });
  }

  const p = localParts(now, settings.default_timezone);
  const minutesLeft = Math.max(60, (settings.send_window_end_hour - p.hour) * 60 - p.minute);
  const gap = nextGapMinutes(minutesLeft, ctx.cap - ctx.counts.total - 1, deps.rng);
  await store.updateInbox(inbox.id, { last_sent_at: now.toISOString(), next_send_after: addMinutes(now, gap).toISOString() });

  return { inbox: inbox.email, result: "sent", enrollmentId: e.id, step: step.step_number };
}

async function deferToNextDay(store: Store, deps: EngineDeps, enrollmentId: string, now: Date, tz: string, w: Window) {
  const day = nextBusinessDay(localDay(now, tz));
  await store.updateEnrollment(enrollmentId, { next_send_at: randomTimeInWindow(day, tz, w, deps.rng).toISOString() });
}

async function handleSendError(store: Store, inbox: Inbox, err: unknown, now: Date): Promise<SendOutcome> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof MailerError && err.code === "auth") {
    const reason = `Gmail connection lost, reconnect the inbox (${message})`;
    await store.updateInbox(inbox.id, { status: "disconnected", paused_reason: reason });
    return { inbox: inbox.email, result: "paused", reason };
  }
  if (err instanceof MailerError && (err.code === "rate_limit" || err.code === "suspended")) {
    const reason = `Gmail refused to send (${message}); check the account before resuming`;
    await store.updateInbox(inbox.id, { status: "paused", paused_reason: reason });
    return { inbox: inbox.email, result: "paused", reason };
  }
  await store.updateInbox(inbox.id, { next_send_after: addMinutes(now, 15).toISOString() });
  return { inbox: inbox.email, result: "error", reason: message };
}

export async function runSendPass(store: Store, deps: EngineDeps): Promise<SendOutcome[]> {
  const settings = await store.getSettings();
  const blocked = globalBlock(settings);
  if (blocked) return [{ inbox: "*", result: "skipped", reason: blocked }];
  const inboxes = await store.listInboxes();
  const outcomes: SendOutcome[] = [];
  for (const inbox of inboxes) outcomes.push(await runInboxSend(store, deps, settings, inbox));
  return outcomes;
}

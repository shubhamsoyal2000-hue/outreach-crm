import { buildRawMessage } from "../mime";
import type { Store } from "../store/types";
import type { Inbox, Settings } from "../types";
import type { EngineDeps } from "./ports";
import type { ReplyEvent, SyncOutcome } from "./sync";

export interface InboxProblem {
  inbox: string;
  status: Inbox["status"];
  reason: string;
}

export interface AlertOutcome {
  sent: boolean;
  from?: string;
  error?: string;
}

/** Inboxes that were active before this pass and are not any more. */
export function newInboxProblems(before: Inbox[], after: Inbox[]): InboxProblem[] {
  const wasActive = new Set(before.filter((i) => i.status === "active").map((i) => i.id));
  return after
    .filter((i) => wasActive.has(i.id) && i.status !== "active")
    .map((i) => ({ inbox: i.email, status: i.status, reason: i.paused_reason ?? "" }));
}

export function buildAlert(replies: ReplyEvent[], problems: InboxProblem[], appUrl: string): { subject: string; body: string } | null {
  if (!replies.length && !problems.length) return null;
  const parts: string[] = [];
  if (replies.length) {
    parts.push(`${replies.length === 1 ? "A prospect replied" : `${replies.length} prospects replied`}. Their follow-ups are stopped.`);
    for (const r of replies) {
      parts.push([`From: ${r.from}`, `To inbox: ${r.inbox}`, `Subject: ${r.subject}`, `"${r.snippet}"`].join("\n"));
    }
    parts.push("Answer them from the inbox they wrote to, so it stays in the same thread.");
  }
  if (problems.length) {
    parts.push(problems.length === 1 ? "An inbox stopped sending:" : "These inboxes stopped sending:");
    for (const p of problems) {
      parts.push(`${p.inbox} is ${p.status}. ${p.reason}`);
    }
    parts.push(`Fix it on the Inboxes page: ${appUrl}/inboxes`);
  }
  parts.push(`Dashboard: ${appUrl}`);

  const subjectBits: string[] = [];
  if (replies.length === 1) subjectBits.push(`Reply from ${replies[0].from}`);
  else if (replies.length) subjectBits.push(`${replies.length} new replies`);
  if (problems.length === 1) subjectBits.push(`${problems[0].inbox} is ${problems[0].status}`);
  else if (problems.length) subjectBits.push(`${problems.length} inboxes stopped`);
  return { subject: `[Outreach CRM] ${subjectBits.join(", ")}`, body: parts.join("\n\n") };
}

/**
 * Emails the team about new replies and inboxes that just stopped, from any
 * inbox that still works. Alerts are internal mail to our own address, so they
 * do not count toward an inbox's cold-email limit. A failure here never stops
 * the scheduler; the dashboard still shows everything.
 */
export async function sendAlerts(
  store: Store,
  deps: EngineDeps,
  settings: Settings,
  sync: SyncOutcome[],
  problems: InboxProblem[],
  appUrl: string,
): Promise<AlertOutcome> {
  const to = settings.alert_email.trim();
  if (!to) return { sent: false };
  const alert = buildAlert(sync.flatMap((s) => s.newReplies), problems, appUrl);
  if (!alert) return { sent: false };

  const senders = (await store.listInboxes()).filter((i) => i.status !== "disconnected" && i.refresh_token_enc);
  for (const inbox of senders) {
    const raw = buildRawMessage({ fromName: "Outreach CRM", fromEmail: inbox.email, to, subject: alert.subject, body: alert.body });
    try {
      await deps.mailer.send(inbox, raw, null);
      return { sent: true, from: inbox.email };
    } catch (err) {
      // Try the next inbox; this one may have just lost its connection.
      if (inbox === senders[senders.length - 1]) return { sent: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { sent: false, error: "no connected inbox to send the alert from" };
}

import { classifyInbound, parseAddress } from "../classify";
import { MailerError } from "../engine/ports";
import type { Inbox } from "../types";
import { bounceTargets, parseAddressList } from "./parse";

export type ScanPhase = "sent" | "inbound" | "bounces" | "done";

export interface HistoryScan {
  inbox_id: string;
  status: "queued" | "running" | "done" | "error";
  phase: ScanPhase;
  since: string; // YYYY-MM-DD
  page_token: string | null;
  messages_read: number;
  sent_estimate: number | null;
  error: string | null;
  /** What the scan saw, for the progress table: messages listed, opened, and how each was read. */
  stats?: Record<string, number>;
}

export interface ListedMessage {
  id: string;
  threadId: string;
}

export interface HistoryMessage {
  id: string;
  threadId: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  snippet: string;
  internalDate: Date;
}

/** Read-only Gmail access the scan needs. */
export interface HistoryReader {
  list(inbox: Inbox, q: string, pageToken: string | null, max: number): Promise<{ messages: ListedMessage[]; next: string | null; estimate: number }>;
  get(inbox: Inbox, ids: string[]): Promise<HistoryMessage[]>;
}

export interface StoredHistoryMessage {
  inbox_id: string;
  gmail_message_id: string;
  thread_id: string;
  kind: "sent" | "reply" | "bounce" | "opt_out";
  /** sent: recipients. reply / opt_out: the sender. bounce: the failed recipients. */
  addresses: string[];
  names: Record<string, string>;
  occurred_at: string;
}

export interface HistoryStore {
  saveMessages(rows: StoredHistoryMessage[]): Promise<void>;
  /** Of these threads, the ones we wrote in, with everyone we wrote to there. */
  sentThreads(inboxId: string, threadIds: string[]): Promise<Map<string, string[]>>;
  updateScan(inboxId: string, patch: Partial<HistoryScan>): Promise<void>;
}

/** Gmail search date, e.g. 2026/01/01. */
function gmailDate(ymd: string): string {
  return ymd.replace(/-/g, "/");
}

const QUERIES: Record<Exclude<ScanPhase, "done">, (since: string) => string> = {
  sent: (since) => `in:sent after:${gmailDate(since)}`,
  // Everything that came in; only messages in threads we wrote in are opened.
  inbound: (since) => `after:${gmailDate(since)} -in:sent -in:chats -in:drafts`,
  // Bounces that Gmail did not file in the original thread.
  bounces: (since) => `after:${gmailDate(since)} from:(mailer-daemon OR postmaster)`,
};

const NEXT: Record<Exclude<ScanPhase, "done">, ScanPhase> = { sent: "inbound", inbound: "bounces", bounces: "done" };
const PAGE: Record<Exclude<ScanPhase, "done">, number> = { sent: 100, inbound: 500, bounces: 100 };

function sentRow(inbox: Inbox, m: HistoryMessage): StoredHistoryMessage | null {
  const recipients = [...parseAddressList(m.headers["to"]), ...parseAddressList(m.headers["cc"]), ...parseAddressList(m.headers["bcc"])].filter(
    (a) => a.email !== inbox.email,
  );
  if (!recipients.length) return null;
  const names: Record<string, string> = {};
  for (const a of recipients) if (a.name) names[a.email] = a.name;
  return {
    inbox_id: inbox.id,
    gmail_message_id: m.id,
    thread_id: m.threadId,
    kind: "sent",
    addresses: [...new Set(recipients.map((a) => a.email))],
    names,
    occurred_at: m.internalDate.toISOString(),
  };
}

function inboundRow(inbox: Inbox, m: HistoryMessage, threadRecipients: string[]): { row: StoredHistoryMessage | null; seen: string } {
  const from = m.headers["from"] ?? "";
  const cls = classifyInbound({ from, subject: m.headers["subject"] ?? "", snippet: m.snippet, headers: m.headers });
  const base = { inbox_id: inbox.id, gmail_message_id: m.id, thread_id: m.threadId, names: {}, occurred_at: m.internalDate.toISOString() };
  if (cls.kind === "bounce") {
    if (!cls.hardBounce) return { row: null, seen: "soft_bounce" };
    const targets = bounceTargets(m.headers["x-failed-recipients"], `${m.headers["subject"] ?? ""}\n${m.snippet}`, threadRecipients);
    return targets.length ? { row: { ...base, kind: "bounce", addresses: targets }, seen: "bounce" } : { row: null, seen: "bounce_unmatched" };
  }
  const sender = parseAddress(from);
  if (!sender || sender === inbox.email) return { row: null, seen: "own" };
  if (cls.kind === "reply") return { row: { ...base, kind: "reply", addresses: [sender] }, seen: "reply" };
  if (cls.kind === "unsubscribe_reply") return { row: { ...base, kind: "opt_out", addresses: [sender] }, seen: "opt_out" };
  return { row: null, seen: cls.kind }; // out-of-office and the like say nothing about the address
}

/**
 * Reads one inbox's mail since `scan.since`, a page at a time, until the
 * deadline. Progress is saved after every page, so the next run picks up
 * where this one stopped, and re-reading a page never double counts.
 * Nothing in the mailbox is changed.
 */
export async function runScanStep(store: HistoryStore, reader: HistoryReader, inbox: Inbox, scan: HistoryScan, deadline: number): Promise<HistoryScan> {
  const s = { ...scan, stats: { ...(scan.stats ?? {}) } };
  const count = (k: string, n = 1) => (s.stats[k] = (s.stats[k] ?? 0) + n);
  if (s.status === "queued") {
    s.status = "running";
    await store.updateScan(inbox.id, { status: "running" });
  }
  try {
    while (s.phase !== "done" && Date.now() < deadline) {
      const phase = s.phase;
      const page = await reader.list(inbox, QUERIES[phase](s.since), s.page_token, PAGE[phase]);
      let rows: StoredHistoryMessage[] = [];

      if (phase === "sent") {
        const msgs = await reader.get(inbox, page.messages.map((m) => m.id));
        rows = msgs.map((m) => sentRow(inbox, m)).filter((r): r is StoredHistoryMessage => !!r);
        count("sent", rows.length);
      } else {
        const threads = await store.sentThreads(inbox.id, [...new Set(page.messages.map((m) => m.threadId))]);
        const wanted = phase === "bounces" ? page.messages : page.messages.filter((m) => threads.has(m.threadId));
        const msgs = await reader.get(inbox, wanted.map((m) => m.id));
        count(`${phase}_listed`, page.messages.length);
        count(`${phase}_opened`, msgs.length);
        for (const m of msgs) {
          const { row, seen } = inboundRow(inbox, m, threads.get(m.threadId) ?? []);
          count(`${phase}_${seen}`);
          if (row) rows.push(row);
        }
      }
      await store.saveMessages(rows);

      s.messages_read += page.messages.length;
      if (phase === "sent" && !s.page_token) s.sent_estimate = page.estimate;
      if (page.next) {
        s.page_token = page.next;
      } else {
        s.phase = NEXT[phase];
        s.page_token = null;
      }
      await store.updateScan(inbox.id, { phase: s.phase, page_token: s.page_token, messages_read: s.messages_read, sent_estimate: s.sent_estimate, stats: s.stats });
    }
    if (s.phase === "done") {
      s.status = "done";
      await store.updateScan(inbox.id, { status: "done" });
    }
  } catch (err) {
    // Gmail's rate limit just means "later": keep the saved page and carry on next run.
    if (err instanceof MailerError && err.code === "rate_limit") return s;
    const message = err instanceof Error ? err.message : String(err);
    s.status = "error";
    s.error = err instanceof MailerError && err.code === "auth" ? `Gmail connection lost, reconnect the inbox and scan again (${message})` : message;
    await store.updateScan(inbox.id, { status: "error", error: s.error });
  }
  return s;
}

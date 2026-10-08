import "server-only";
import { gmailHistoryReader } from "../gmail";
import { SupabaseStore } from "../store/supabase";
import { runScanStep, type HistoryScan } from "./scan";
import { claimScan, listScans, releaseScan, supabaseHistoryStore } from "./supabase";

export interface HistoryPassOutcome {
  inbox: string;
  phase: string;
  status: string;
  messagesRead: number;
}

/** Moves every unfinished scan forward until the time budget runs out. */
export async function runHistoryPass(budgetMs: number): Promise<HistoryPassOutcome[]> {
  const deadline = Date.now() + budgetMs;
  const scans = (await listScans()).filter((s) => s.status === "queued" || s.status === "running");
  if (!scans.length) return [];
  const inboxes = await new SupabaseStore().listInboxes();
  const out: HistoryPassOutcome[] = [];

  for (const scan of scans) {
    if (Date.now() >= deadline) break;
    const inbox = inboxes.find((i) => i.id === scan.inbox_id);
    if (!inbox) continue;
    if (inbox.status === "disconnected" || !inbox.refresh_token_enc) {
      await supabaseHistoryStore.updateScan(scan.inbox_id, { status: "error", error: "Inbox is disconnected. Reconnect it, then scan again." });
      continue;
    }
    if (!(await claimScan(scan.inbox_id, budgetMs + 30_000))) continue;
    try {
      const s: HistoryScan = await runScanStep(supabaseHistoryStore, gmailHistoryReader, inbox, scan, deadline);
      out.push({ inbox: inbox.email, phase: s.phase, status: s.status, messagesRead: s.messages_read });
    } finally {
      await releaseScan(scan.inbox_id);
    }
  }
  return out;
}

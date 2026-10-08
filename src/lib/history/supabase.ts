import "server-only";
import { db } from "../store/supabase";
import type { HistoryAddressRow } from "./parse";
import type { HistoryScan, HistoryStore, StoredHistoryMessage } from "./scan";

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

export const supabaseHistoryStore: HistoryStore = {
  async saveMessages(rows: StoredHistoryMessage[]) {
    if (!rows.length) return;
    check(await db().from("history_messages").upsert(rows, { onConflict: "inbox_id,gmail_message_id", ignoreDuplicates: true }), "save history");
  },

  async sentThreads(inboxId: string, threadIds: string[]) {
    const out = new Map<string, string[]>();
    for (let i = 0; i < threadIds.length; i += 200) {
      const rows = check(
        await db().from("history_messages").select("thread_id, addresses").eq("inbox_id", inboxId).eq("kind", "sent").in("thread_id", threadIds.slice(i, i + 200)),
        "history threads",
      ) as { thread_id: string; addresses: string[] }[];
      for (const r of rows) out.set(r.thread_id, [...new Set([...(out.get(r.thread_id) ?? []), ...r.addresses])]);
    }
    return out;
  },

  async updateScan(inboxId: string, patch: Partial<HistoryScan>) {
    check(await db().from("history_scans").update({ ...patch, updated_at: new Date().toISOString() }).eq("inbox_id", inboxId), "update scan");
  },
};

export async function listScans(): Promise<(HistoryScan & { updated_at: string; started_at: string })[]> {
  return check(await db().from("history_scans").select("*"), "scans") ?? [];
}

export async function claimScan(inboxId: string, lockMs: number): Promise<boolean> {
  const now = new Date();
  const rows = check(
    await db()
      .from("history_scans")
      .update({ lock_until: new Date(now.getTime() + lockMs).toISOString() })
      .eq("inbox_id", inboxId)
      .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
      .select("inbox_id"),
    "claim scan",
  );
  return (rows ?? []).length > 0;
}

export async function releaseScan(inboxId: string) {
  check(await db().from("history_scans").update({ lock_until: null }).eq("inbox_id", inboxId), "release scan");
}

/** Every address the scan found, read in pages (Supabase returns at most 1000 rows per call). */
export async function loadHistoryAddresses(): Promise<HistoryAddressRow[]> {
  const out: HistoryAddressRow[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await db().from("history_addresses").select("*").order("email").range(from, from + 999), "history addresses") as HistoryAddressRow[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

import { describe, expect, it } from "vitest";
import { bounceTargets, carrierReason, classifyHistory, companyToken, parseAddressList, splitName, type HistoryAddressRow } from "@/lib/history/parse";
import { runScanStep, type HistoryMessage, type HistoryReader, type HistoryScan, type HistoryStore, type StoredHistoryMessage } from "@/lib/history/scan";
import type { Inbox } from "@/lib/types";

describe("history parsing", () => {
  it("reads To/Cc lists with names, quotes and commas", () => {
    expect(parseAddressList('"Smith, Bob" <Bob@Acme.com>, Jane Doe <jane@acme.com>, carl@zeta.io, jane@acme.com')).toEqual([
      { email: "bob@acme.com", name: "Smith, Bob" },
      { email: "jane@acme.com", name: "Jane Doe" },
      { email: "carl@zeta.io", name: "" },
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  it("works out who a bounce is about", () => {
    expect(bounceTargets("jane@acme.com", "", ["jane@acme.com", "bob@acme.com"])).toEqual(["jane@acme.com"]);
    expect(bounceTargets(undefined, "Your message to bob@acme.com couldn't be delivered", ["jane@acme.com", "bob@acme.com"])).toEqual(["bob@acme.com"]);
    expect(bounceTargets(undefined, "Address not found", ["jane@acme.com"])).toEqual(["jane@acme.com"]);
    expect(bounceTargets(undefined, "Address not found", ["jane@acme.com", "bob@acme.com"])).toEqual([]);
  });

  it("flags carrier-looking addresses but not shippers or forwarders", () => {
    expect(carrierReason("dispatch@fastlane.com")).toMatch(/carrier-style/);
    expect(carrierReason("ops@bigrigtrucking.com")).toMatch(/sounds like a carrier/);
    expect(carrierReason("mike.trucking22@gmail.com")).toMatch(/trucking-style/);
    expect(carrierReason("jane@gmail.com")).toMatch(/personal address/);
    expect(carrierReason("agent@qq.com")).toMatch(/personal address/);
    expect(carrierReason("jane@acmeimports.com")).toBeNull();
    expect(carrierReason("ops@globallogistics.com")).toBeNull();
  });

  it("names and company token", () => {
    expect(splitName("Jane Doe")).toEqual({ first: "Jane", last: "Doe" });
    expect(splitName("Doe, Jane")).toEqual({ first: "Jane", last: "Doe" });
    expect(splitName("jane@acme.com")).toEqual({ first: "", last: "" });
    expect(companyToken("Cargo Solution brokerage")).toBe("cargosolution");
  });
});

const NOW = new Date("2026-10-08T12:00:00Z");
const row = (email: string, over: Partial<HistoryAddressRow> = {}): HistoryAddressRow => ({
  email, name: null, first_sent: "2026-09-01T00:00:00Z", last_sent: "2026-09-01T00:00:00Z", sent_count: 1, inboxes: ["sales@x.com"],
  bounced_at: null, replied_at: null, reply_count: 0, opted_out_at: null, in_crm: false, suppressed: false, ...over,
});

describe("history groups", () => {
  const opts = { now: NOW, recentDays: 92, ownEmails: ["sales.cargosolutionllc@gmail.com", "me@gmail.com"], ownDomains: ["cargosolutionllc.com"], companyToken: "cargosolution", allowShared: true, blockedDomains: ["expeditors.com"] };

  it("sorts every address into the right group", () => {
    const out = classifyHistory(
      [
        row("gone@acme.com", { bounced_at: "2026-09-02T00:00:00Z" }),
        row("back@acme.com", { bounced_at: "2026-03-02T00:00:00Z", replied_at: "2026-04-01T00:00:00Z", reply_count: 1 }),
        row("stop@beta.com", { opted_out_at: "2026-09-02T00:00:00Z" }),
        row("colleague@acme.com"),
        row("fresh@gamma.com"),
        row("old@gamma.com", { last_sent: "2026-02-01T00:00:00Z" }),
        row("dispatch@fastlane.com"),
        row("marcus@cargosolution.net"),
        row("me@gmail.com"),
        row("noreply@delta.com"),
        row("ops@us.expeditors.com"),
      ],
      opts,
    );
    expect(Object.fromEntries(out.map((r) => [r.email, r.group]))).toEqual({
      "gone@acme.com": "bounced",
      "back@acme.com": "replied",
      "stop@beta.com": "opted_out",
      "colleague@acme.com": "replied",
      "fresh@gamma.com": "recent",
      "old@gamma.com": "older",
      "dispatch@fastlane.com": "carrier",
      "marcus@cargosolution.net": "internal",
      "me@gmail.com": "internal",
      "noreply@delta.com": "internal",
      "ops@us.expeditors.com": "internal",
    });
  });
});

describe("history scan", () => {
  const inbox = { id: "i1", email: "sales@x.com" } as Inbox;
  const msg = (id: string, threadId: string, headers: Record<string, string>, snippet = "", at = "2026-05-01T00:00:00Z"): HistoryMessage => ({ id, threadId, headers, snippet, internalDate: new Date(at) });

  function fakes(mail: Record<string, HistoryMessage[]>) {
    const saved = new Map<string, StoredHistoryMessage>();
    const scan: Partial<HistoryScan>[] = [];
    const store: HistoryStore = {
      async saveMessages(rows) { for (const r of rows) if (!saved.has(r.gmail_message_id)) saved.set(r.gmail_message_id, r); },
      async sentThreads(_inbox, threadIds) {
        const m = new Map<string, string[]>();
        for (const r of saved.values()) if (r.kind === "sent" && threadIds.includes(r.thread_id)) m.set(r.thread_id, [...(m.get(r.thread_id) ?? []), ...r.addresses]);
        return m;
      },
      async updateScan(_id, patch) { scan.push(patch); },
    };
    const all = Object.values(mail).flat();
    const reader: HistoryReader = {
      // One message per page, to exercise paging.
      async list(_i, q, pageToken) {
        const list = q.startsWith("in:sent") ? mail.sent : q.includes("mailer-daemon") ? mail.bounces : mail.inbound;
        const at = pageToken ? Number(pageToken) : 0;
        return { messages: list.slice(at, at + 1).map((m) => ({ id: m.id, threadId: m.threadId })), next: at + 1 < list.length ? String(at + 1) : null, estimate: list.length };
      },
      async get(_i, ids) { return ids.map((id) => all.find((m) => m.id === id)!); },
    };
    return { store, reader, saved, scan };
  }

  it("records sends, replies and bounces, skipping mail in threads we never wrote in", async () => {
    const { store, reader, saved } = fakes({
      sent: [
        msg("s1", "t1", { to: "Jane Doe <jane@acme.com>", cc: "sales@x.com" }),
        msg("s2", "t2", { to: "bob@beta.com" }),
      ],
      inbound: [
        msg("r1", "t1", { from: "Jane Doe <jane@acme.com>", subject: "Re: rates" }, "Yes send me a quote"),
        msg("n1", "t9", { from: "news@shop.com", subject: "Sale" }),
        msg("b1", "t2", { from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" }, "Address not found"),
      ],
      bounces: [msg("b1", "t2", { from: "mailer-daemon@googlemail.com", subject: "Delivery Status Notification (Failure)" }, "Address not found")],
    });
    const start: HistoryScan = { inbox_id: "i1", status: "queued", phase: "sent", since: "2026-01-01", page_token: null, messages_read: 0, sent_estimate: null, error: null };
    const out = await runScanStep(store, reader, inbox, start, Date.now() + 5_000);
    expect(out.status).toBe("done");
    expect(saved.get("s1")).toMatchObject({ kind: "sent", addresses: ["jane@acme.com"], names: { "jane@acme.com": "Jane Doe" } });
    expect(saved.get("r1")).toMatchObject({ kind: "reply", addresses: ["jane@acme.com"] });
    expect(saved.get("b1")).toMatchObject({ kind: "bounce", addresses: ["bob@beta.com"] });
    expect(saved.has("n1")).toBe(false);
  });

  it("stops at the deadline and resumes from the saved page", async () => {
    const { store, reader, saved } = fakes({ sent: [msg("s1", "t1", { to: "a@a.com" }), msg("s2", "t2", { to: "b@b.com" })], inbound: [], bounces: [] });
    const start: HistoryScan = { inbox_id: "i1", status: "queued", phase: "sent", since: "2026-01-01", page_token: "1", messages_read: 1, sent_estimate: 2, error: null };
    const out = await runScanStep(store, reader, inbox, start, Date.now() - 1);
    expect(out).toMatchObject({ status: "running", phase: "sent", page_token: "1" });
    const done = await runScanStep(store, reader, inbox, out, Date.now() + 5_000);
    expect(done.status).toBe("done");
    expect([...saved.keys()]).toEqual(["s2"]);
  });
});
